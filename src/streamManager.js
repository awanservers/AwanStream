// Manages FFmpeg child processes that push video files to RTMP endpoints.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// streamId -> { process, logStream, lastActivity }
const running = new Map();

// Auto-retry state
const retryCount = new Map();       // streamId -> number
const retryStopped = new Set();     // streamIds where user explicitly stopped (no retry)
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY = 3000;      // 3 seconds
const MAX_RETRY_DELAY = 60000;      // 60 seconds

// Health check interval (detect stale streams)
const HEALTH_CHECK_INTERVAL = 60000;   // 60 seconds (polling)
const STALE_THRESHOLD = 10 * 60 * 1000; // 10 minutes no activity = stale
let healthCheckTimer = null;

function buildRtmpTarget(rtmpUrl, key) {
  const trimmed = rtmpUrl.replace(/\/+$/, '');
  return `${trimmed}/${key}`;
}

function redact(text, secret) {
  if (!secret) return text;
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '***REDACTED***');
}

function makeRedactingStream(logStream, secret) {
  return {
    write(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      logStream.write(redact(text, secret));
    },
    end() { logStream.end(); },
  };
}

/**
 * Calculate retry delay with exponential backoff + jitter.
 */
function getRetryDelay(attempt) {
  const delay = Math.min(BASE_RETRY_DELAY * Math.pow(2, attempt), MAX_RETRY_DELAY);
  // Add jitter: ±25%
  const jitter = delay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(delay + jitter);
}

function startStream(stream, videoPath, audioPath) {
  if (running.has(stream.id)) {
    throw new Error('Stream already running');
  }
  if (!fs.existsSync(videoPath)) {
    throw new Error('Video file not found: ' + videoPath);
  }
  if (audioPath && !fs.existsSync(audioPath)) {
    throw new Error('Audio overlay file not found: ' + audioPath);
  }

  // Clear retry-stopped flag on fresh manual start.
  retryStopped.delete(stream.id);

  const target = buildRtmpTarget(stream.rtmp_url, stream.stream_key);
  const args = [
    '-hide_banner',
    // `info` level supaya FFmpeg print stats periodically ke stderr (bitrate, speed, dll).
    // Dengan `warning`, FFmpeg diam saat streaming lancar → health check salah deteksi stale.
    '-loglevel', 'info',
    // Emit stats setiap 10 detik (default 0.5s terlalu verbose; ini cukup untuk health check).
    '-stats_period', '10',
    '-stats',
    '-re',
  ];
  if (stream.loop_video) args.push('-stream_loop', '-1');
  args.push('-i', videoPath);

  // Audio overlay: add second input (looped independently) and mix with video's audio.
  const hasAudioOverlay = !!audioPath;
  if (hasAudioOverlay) {
    args.push('-stream_loop', '-1', '-i', audioPath);
  }

  if (hasAudioOverlay) {
    // Mix video audio (input 0) with overlay audio (input 1).
    // Volume of overlay is configurable (default 0.3 = 30%).
    const vol = stream.audio_volume || '0.3';
    const mode = stream.audio_mode || 'mix';

    // Determine if video has audio. Prefer cached `videos.has_audio` column;
    // fall back to a one-time probe (cached back to DB) for older rows.
    let videoHasAudio = null;
    const vidRow = db.prepare('SELECT id, has_audio FROM videos WHERE id=?').get(stream.video_id);
    if (vidRow && vidRow.has_audio !== null && vidRow.has_audio !== undefined) {
      videoHasAudio = vidRow.has_audio === 1;
    } else {
      try {
        const transcoder = require('./transcoder');
        const info = transcoder.probeVideoInfo(videoPath);
        videoHasAudio = !!info.audioCodec;
        // Cache result so subsequent starts skip the probe.
        if (vidRow) {
          db.prepare('UPDATE videos SET has_audio=? WHERE id=?')
            .run(videoHasAudio ? 1 : 0, vidRow.id);
        }
      } catch (_) {
        videoHasAudio = true; // safer default on probe failure
      }
    }

    if (videoHasAudio && mode === 'mix') {
      // Both video and overlay have audio → mix them.
      args.push(
        '-filter_complex',
        `[0:a]volume=1.0[va];[1:a]volume=${vol}[oa];[va][oa]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
      );
    } else {
      // Video has no audio or mode is 'replace' → use overlay audio directly at configured volume.
      args.push(
        '-filter_complex',
        `[1:a]volume=${vol}[aout]`,
        '-map', '0:v:0',
        '-map', '[aout]',
      );
    }
  } else {
    args.push(
      '-map', '0:v:0',
      '-map', '0:a:0?',
    );
  }

  if (stream.re_encode) {
    const kf = Math.max(1, Number(stream.keyframe_interval) || 2);
    const gop = kf * 60;
    const vb = stream.video_bitrate || '2500k';
    const m = /^(\d+)\s*([kKmM]?)$/.exec(vb);
    let bufsize = '5000k';
    if (m) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase() || 'k';
      bufsize = `${n * 2}${unit}`;
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', stream.preset || 'veryfast',
      '-tune', 'zerolatency',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-b:v', vb,
      '-maxrate', vb,
      '-bufsize', bufsize,
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${kf})`,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',
    );
  } else {
    args.push(
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
    );
  }

  args.push(
    '-max_muxing_queue_size', '1024',
    '-f', 'flv',
    target,
  );

  const logPath = path.join(logsDir, `stream-${stream.id}.log`);
  // Log rotation: if file > 5 MB, rotate to .old (keep 1 backup, cap ~10 MB total).
  try {
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath);
      if (stat.size > 5 * 1024 * 1024) {
        const oldPath = logPath + '.old';
        try { fs.unlinkSync(oldPath); } catch (_) {}
        fs.renameSync(logPath, oldPath);
      }
    }
  } catch (_) {}
  const rawLog = fs.createWriteStream(logPath, { flags: 'a' });
  const safeLog = makeRedactingStream(rawLog, stream.stream_key);

  const safeArgs = args.map((a) => redact(a, stream.stream_key));
  safeLog.write(`\n=== ${new Date().toISOString()} starting ffmpeg ${safeArgs.join(' ')}\n`);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => {
    safeLog.write(c);
    updateActivity(stream.id);
  });
  proc.stderr.on('data', (c) => {
    safeLog.write(c);
    updateActivity(stream.id);
  });

  db.prepare(`UPDATE streams
    SET status='running', started_at=CURRENT_TIMESTAMP, stopped_at=NULL, last_error=NULL
    WHERE id=?`).run(stream.id);

  running.set(stream.id, { process: proc, logStream: safeLog, lastActivity: Date.now() });

  proc.on('exit', (code, signal) => {
    safeLog.write(`\n=== ${new Date().toISOString()} ffmpeg exit code=${code} signal=${signal}\n`);
    safeLog.end();
    running.delete(stream.id);
    const info = db.prepare('SELECT status FROM streams WHERE id=?').get(stream.id);

    // If the user stopped it we already set status to idle; only overwrite when still marked running.
    if (info && info.status === 'running') {
      const failed = code !== 0 && signal !== 'SIGTERM';
      if (failed) {
        // Check if we should auto-retry.
        if (!retryStopped.has(stream.id) && shouldRetry(stream.id)) {
          scheduleRetry(stream, videoPath, code);
        } else {
          // Max retries reached or user stopped — mark as error.
          const errMsg = `ffmpeg exited with code ${code}`;
          db.prepare(`UPDATE streams
            SET status='error', stopped_at=CURRENT_TIMESTAMP, last_error=?
            WHERE id=?`).run(errMsg, stream.id);
          const fullStream = db.prepare('SELECT * FROM streams WHERE id=?').get(stream.id);
          if (fullStream) saveHistory(fullStream, 'error', errMsg);
          retryCount.delete(stream.id);
        }
      } else {
        // Normal exit (video finished, non-loop). Check if playlist has next video.
        const advanced = advancePlaylist(stream);
        if (!advanced) {
          db.prepare(`UPDATE streams
            SET status='idle', stopped_at=CURRENT_TIMESTAMP
            WHERE id=?`).run(stream.id);
          const fullStream = db.prepare('SELECT * FROM streams WHERE id=?').get(stream.id);
          if (fullStream) saveHistory(fullStream, 'completed', null);
        }
        // Reset retry count on successful completion.
        retryCount.delete(stream.id);
      }
    }
  });

  proc.on('error', (err) => {
    safeLog.write(`\n=== spawn error: ${err.message}\n`);
  });
}

/**
 * Check if we should retry this stream.
 */
function shouldRetry(streamId) {
  const count = retryCount.get(streamId) || 0;
  return count < MAX_RETRIES;
}

/**
 * Schedule a retry with exponential backoff.
 */
function scheduleRetry(stream, videoPath, exitCode) {
  const count = retryCount.get(stream.id) || 0;
  const delay = getRetryDelay(count);
  retryCount.set(stream.id, count + 1);

  const attempt = count + 1;
  const errMsg = `ffmpeg crashed (code ${exitCode}), retry ${attempt}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s`;
  db.prepare(`UPDATE streams SET last_error=? WHERE id=?`).run(errMsg, stream.id);

  // Log the retry attempt.
  const logPath = path.join(logsDir, `stream-${stream.id}.log`);
  try {
    fs.appendFileSync(logPath, `\n=== ${new Date().toISOString()} ${errMsg}\n`);
  } catch (_) {}

  setTimeout(() => {
    // Re-check: user might have stopped or deleted the stream during the delay.
    if (retryStopped.has(stream.id)) {
      retryCount.delete(stream.id);
      return;
    }
    const current = db.prepare('SELECT * FROM streams WHERE id=?').get(stream.id);
    if (!current || current.status === 'idle') {
      retryCount.delete(stream.id);
      return;
    }
    // Re-read video path in case it changed.
    const video = db.prepare('SELECT filename FROM videos WHERE id=?').get(current.video_id);
    if (!video) {
      db.prepare(`UPDATE streams SET status='error', last_error=? WHERE id=?`)
        .run('Retry failed: video not found', stream.id);
      retryCount.delete(stream.id);
      return;
    }
    const newVideoPath = path.join(__dirname, '..', 'public', 'uploads', video.filename);
    // Resolve audio overlay path if configured.
    let audioPath = null;
    if (current.audio_id) {
      const audioManager = require('./audioManager');
      audioPath = audioManager.getFilePath(current.audio_id);
    }
    try {
      startStream(current, newVideoPath, audioPath);
    } catch (e) {
      db.prepare(`UPDATE streams SET status='error', stopped_at=CURRENT_TIMESTAMP, last_error=? WHERE id=?`)
        .run('Retry failed: ' + e.message, stream.id);
      const fullStream = db.prepare('SELECT * FROM streams WHERE id=?').get(stream.id);
      if (fullStream) saveHistory(fullStream, 'error', 'Retry failed: ' + e.message);
      retryCount.delete(stream.id);
    }
  }, delay);
}

function saveHistory(stream, status, errorMsg) {
  try {
    const video = db.prepare('SELECT title FROM videos WHERE id=?').get(stream.video_id);
    const startedAt = stream.started_at || null;
    const stoppedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    let durationSeconds = 0;
    if (startedAt) {
      const startIso = startedAt.includes('T') ? startedAt : startedAt.replace(' ', 'T') + 'Z';
      const startMs = new Date(startIso).getTime();
      const stopMs = Date.now();
      if (!Number.isNaN(startMs)) {
        durationSeconds = Math.max(0, Math.round((stopMs - startMs) / 1000));
      }
    }
    // Only save history if stream ran for at least 10 seconds.
    if (durationSeconds < 10) return;
    db.prepare(`INSERT INTO stream_history
      (stream_id, stream_name, video_title, platform, started_at, stopped_at, duration_seconds, status, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      stream.id,
      stream.name,
      video ? video.title : '(deleted)',
      stream.platform || 'custom',
      startedAt,
      stoppedAt,
      durationSeconds,
      status,
      errorMsg || null,
    );
  } catch (_) { /* non-critical — don't break stream lifecycle */ }
}

function stopStream(streamId) {
  const entry = running.get(streamId);
  // Mark as user-stopped so retry logic won't kick in.
  retryStopped.add(streamId);
  retryCount.delete(streamId);
  // Read stream info before updating status (we need started_at for duration calc).
  const stream = db.prepare('SELECT * FROM streams WHERE id=?').get(streamId);
  db.prepare(`UPDATE streams
    SET status='idle', stopped_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(streamId);
  if (stream) saveHistory(stream, 'completed', null);
  if (!entry) return false;
  try { entry.process.kill('SIGTERM'); } catch (_) {}
  return true;
}

function isRunning(streamId) {
  return running.has(streamId);
}

/**
 * Get retry info for a stream (used by UI to show retry status).
 */
function getRetryInfo(streamId) {
  const count = retryCount.get(streamId);
  if (count === undefined) return null;
  return { attempt: count, maxRetries: MAX_RETRIES };
}

function reconcileOnBoot() {
  // Any stream marked running from a previous process is no longer actually running.
  db.prepare(`UPDATE streams SET status='idle', stopped_at=CURRENT_TIMESTAMP
    WHERE status='running'`).run();
  // Start health check timer.
  startHealthCheck();
}

/**
 * Update last activity timestamp for a stream (called on FFmpeg output).
 */
function updateActivity(streamId) {
  const entry = running.get(streamId);
  if (entry) entry.lastActivity = Date.now();
}

/**
 * Periodic health check: detect stale streams (no FFmpeg output for STALE_THRESHOLD).
 * A stale stream likely means FFmpeg is hung — kill and let retry logic handle it.
 */
function healthCheck() {
  const now = Date.now();
  for (const [streamId, entry] of running) {
    if (entry.lastActivity && (now - entry.lastActivity) > STALE_THRESHOLD) {
      // Stream is stale — FFmpeg hasn't produced output in 5 minutes.
      const logPath = path.join(logsDir, `stream-${streamId}.log`);
      try {
        fs.appendFileSync(logPath, `\n=== ${new Date().toISOString()} health check: stream stale (no output for ${Math.round(STALE_THRESHOLD / 1000)}s), killing process\n`);
      } catch (_) {}
      try { entry.process.kill('SIGKILL'); } catch (_) {}
      // The exit handler will fire and trigger retry logic.
    }
  }
}

function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(healthCheck, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// Playlist advancement: when a video finishes (non-loop), check if the stream
// uses a playlist and start the next video automatically.
function advancePlaylist(stream) {
  if (!stream.playlist_id) return false;

  const items = db.prepare(`
    SELECT pi.video_id, pi.position, v.filename
    FROM playlist_items pi JOIN videos v ON v.id = pi.video_id
    WHERE pi.playlist_id = ? ORDER BY pi.position ASC
  `).all(stream.playlist_id);

  if (items.length === 0) return false;

  const playlist = db.prepare('SELECT * FROM playlists WHERE id=?').get(stream.playlist_id);
  if (!playlist) return false;

  // Find current video position.
  const currentIdx = items.findIndex(i => i.video_id === stream.video_id);
  let nextIdx;

  if (playlist.shuffle) {
    // Shuffle mode: pick a random video that isn't the current one.
    if (items.length === 1) {
      nextIdx = 0;
    } else {
      do {
        nextIdx = Math.floor(Math.random() * items.length);
      } while (nextIdx === currentIdx);
    }
  } else {
    // Sequential mode.
    nextIdx = currentIdx + 1;
    if (nextIdx >= items.length) {
      if (playlist.loop_playlist) {
        nextIdx = 0; // wrap around
      } else {
        return false; // playlist finished
      }
    }
  }

  const nextItem = items[nextIdx];
  const videoPath = path.join(__dirname, '..', 'public', 'uploads', nextItem.filename);

  if (!fs.existsSync(videoPath)) return false;

  // Update stream's current video_id to the next one.
  db.prepare('UPDATE streams SET video_id=? WHERE id=?').run(nextItem.video_id, stream.id);

  // Re-read stream with updated video_id.
  const updatedStream = db.prepare('SELECT * FROM streams WHERE id=?').get(stream.id);

  // Small delay to avoid rapid restart loops on error.
  setTimeout(() => {
    try {
      // Resolve audio overlay path if configured.
      let audioPath = null;
      if (updatedStream.audio_id) {
        const audioManager = require('./audioManager');
        audioPath = audioManager.getFilePath(updatedStream.audio_id);
      }
      startStream(updatedStream, videoPath, audioPath);
    } catch (e) {
      db.prepare(`UPDATE streams SET status='error', last_error=? WHERE id=?`)
        .run('Playlist advance failed: ' + e.message, stream.id);
    }
  }, 1000);

  return true;
}

function tailLog(streamId, lines = 80) {
  const logPath = path.join(logsDir, `stream-${streamId}.log`);
  if (!fs.existsSync(logPath)) return '';
  const data = fs.readFileSync(logPath, 'utf8').split(/\r\n|\n|\r/);
  let text = data.slice(-lines).join('\n');
  try {
    const s = db.prepare('SELECT stream_key FROM streams WHERE id=?').get(streamId);
    if (s && s.stream_key) {
      const escaped = s.stream_key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'g'), '***REDACTED***');
    }
  } catch (_) {}
  return text;
}

module.exports = { startStream, stopStream, isRunning, getRetryInfo, reconcileOnBoot, tailLog };
