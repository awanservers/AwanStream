// Manages FFmpeg child processes that push video files to RTMP endpoints.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// streamId -> { process, logStream }
const running = new Map();

function buildRtmpTarget(rtmpUrl, key) {
  const trimmed = rtmpUrl.replace(/\/+$/, '');
  return `${trimmed}/${key}`;
}

function redact(text, secret) {
  if (!secret) return text;
  // Escape regex special chars in the secret and replace all occurrences.
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '***REDACTED***');
}

function makeRedactingStream(logStream, secret) {
  // Wraps writes so we never persist the stream key to disk.
  return {
    write(chunk) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      logStream.write(redact(text, secret));
    },
    end() { logStream.end(); },
  };
}

function startStream(stream, videoPath) {
  if (running.has(stream.id)) {
    throw new Error('Stream already running');
  }
  if (!fs.existsSync(videoPath)) {
    throw new Error('Video file not found: ' + videoPath);
  }

  const target = buildRtmpTarget(stream.rtmp_url, stream.stream_key);
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-re',
  ];
  if (stream.loop_video) args.push('-stream_loop', '-1');
  args.push(
    '-i', videoPath,
    // Only take the first video + (optional) first audio track.
    // Skips cover-art / attachment streams that cause "Unknown cover type" warnings.
    '-map', '0:v:0',
    '-map', '0:a:0?',
  );

  if (stream.re_encode) {
    // Re-encode to enforce keyframe interval. YouTube wants <= 4s keyframes;
    // default 2s gives good seek and rebuffer behavior.
    const kf = Math.max(1, Number(stream.keyframe_interval) || 2);
    // Assume source ~30fps; GOP = kf * fps. We don't probe fps here so we use 60
    // as a safe upper bound (it clamps effectively via -force_key_frames).
    const gop = kf * 60;
    const vb = stream.video_bitrate || '2500k';
    // bufsize = 2x bitrate is a common default. Parse "NNNNk" / "NNNNNN".
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
    // Stream-copy (no CPU cost, but keyframe interval depends on source file).
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
  const rawLog = fs.createWriteStream(logPath, { flags: 'a' });
  const safeLog = makeRedactingStream(rawLog, stream.stream_key);

  const safeArgs = args.map((a) => redact(a, stream.stream_key));
  safeLog.write(`\n=== ${new Date().toISOString()} starting ffmpeg ${safeArgs.join(' ')}\n`);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => safeLog.write(c));
  proc.stderr.on('data', (c) => safeLog.write(c));

  db.prepare(`UPDATE streams
    SET status='running', started_at=CURRENT_TIMESTAMP, stopped_at=NULL, last_error=NULL
    WHERE id=?`).run(stream.id);

  running.set(stream.id, { process: proc, logStream: safeLog });

  proc.on('exit', (code, signal) => {
    safeLog.write(`\n=== ${new Date().toISOString()} ffmpeg exit code=${code} signal=${signal}\n`);
    safeLog.end();
    running.delete(stream.id);
    const info = db.prepare('SELECT status FROM streams WHERE id=?').get(stream.id);
    // If the user stopped it we already set status to idle; only overwrite when still marked running.
    if (info && info.status === 'running') {
      const failed = code !== 0 && signal !== 'SIGTERM';
      if (failed) {
        db.prepare(`UPDATE streams
          SET status='error', stopped_at=CURRENT_TIMESTAMP, last_error=?
          WHERE id=?`).run(`ffmpeg exited with code ${code}`, stream.id);
      } else {
        // Normal exit (video finished, non-loop). Check if playlist has next video.
        const advanced = advancePlaylist(stream);
        if (!advanced) {
          db.prepare(`UPDATE streams
            SET status='idle', stopped_at=CURRENT_TIMESTAMP
            WHERE id=?`).run(stream.id);
        }
      }
    }
  });

  proc.on('error', (err) => {
    safeLog.write(`\n=== spawn error: ${err.message}\n`);
  });
}

function stopStream(streamId) {
  const entry = running.get(streamId);
  db.prepare(`UPDATE streams
    SET status='idle', stopped_at=CURRENT_TIMESTAMP
    WHERE id=?`).run(streamId);
  if (!entry) return false;
  try { entry.process.kill('SIGTERM'); } catch (_) {}
  return true;
}

function isRunning(streamId) {
  return running.has(streamId);
}

function reconcileOnBoot() {
  // Any stream marked running from a previous process is no longer actually running.
  db.prepare(`UPDATE streams SET status='idle', stopped_at=CURRENT_TIMESTAMP
    WHERE status='running'`).run();
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
  let nextIdx = currentIdx + 1;

  if (nextIdx >= items.length) {
    if (playlist.loop_playlist) {
      nextIdx = 0; // wrap around
    } else {
      return false; // playlist finished
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
      startStream(updatedStream, videoPath);
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
  const data = fs.readFileSync(logPath, 'utf8').split('\n');
  let text = data.slice(-lines).join('\n');
  // Defense in depth: redact this stream's current key if it somehow slipped into
  // the log file (e.g. from a pre-redaction run).
  try {
    const s = db.prepare('SELECT stream_key FROM streams WHERE id=?').get(streamId);
    if (s && s.stream_key) {
      const escaped = s.stream_key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'g'), '***REDACTED***');
    }
  } catch (_) {}
  return text;
}

module.exports = { startStream, stopStream, isRunning, reconcileOnBoot, tailLog };
