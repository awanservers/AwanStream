// One-time transcode to a stream-ready file so live streaming can run with
// -c:v copy (0% CPU at stream time).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// videoId -> { process, progress }
const jobs = new Map();

const PRESETS = {
  // Bitrates aligned with YouTube Live recommendation (2026):
  //   https://support.google.com/youtube/answer/2853702
  // 720p30:  3000–6000 kbps  → 4500
  // 720p60:  4500–9000 kbps  → 7500
  // 1080p30: 3000–6000 kbps  → 8000  (push above the range; YouTube Studio
  //                                   warns at "recommended 6800k" otherwise)
  // 1080p60: 4500–9000 kbps  → 12000 (1080p60 recommended is 6800–10000;
  //                                   we cap above to dodge the warning).
  '720p30':  { w: 1280, h: 720,  fps: 30, br: '4500k',  kf: 2 },
  '720p60':  { w: 1280, h: 720,  fps: 60, br: '7500k',  kf: 2 },
  '1080p30': { w: 1920, h: 1080, fps: 30, br: '8000k',  kf: 2 },
  '1080p60': { w: 1920, h: 1080, fps: 60, br: '12000k', kf: 2 },

  // Low-bitrate variants for limited bandwidth (Indonesia rural / mobile
  // tethering). Preserves the previous defaults so existing workflows
  // can opt in by name. Will trigger YouTube Studio bitrate warning.
  '720p30-low':  { w: 1280, h: 720,  fps: 30, br: '2500k', kf: 2 },
  '1080p30-low': { w: 1920, h: 1080, fps: 30, br: '4500k', kf: 2 },
};

function presets() { return PRESETS; }
function isRunning(videoId) { return jobs.has(Number(videoId)); }

// Parse "HH:MM:SS.xx" → seconds (float).
function parseTime(s) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// Synchronously probe container duration via ffprobe. Returns seconds (float)
// or null on failure. Used at upload time and as a fallback before transcode.
function probeDuration(filePath) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;
  const d = parseFloat(String(r.stdout).trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

// Probe width, height, fps, and duration in one ffprobe call.
// Returns { width, height, fps, duration } — any field may be null on failure.
function probeVideoInfo(filePath) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name,bit_rate',
    '-show_entries', 'format=duration,bit_rate',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', timeout: 30000 });

  const out = {
    width: null, height: null, fps: null, duration: null,
    videoCodec: null, audioCodec: null,
    videoBitrateKbps: null, gopSeconds: null,
  };
  if (r.status !== 0) return out;

  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams && j.streams[0];
    if (s) {
      out.width = s.width || null;
      out.height = s.height || null;
      out.videoCodec = s.codec_name || null;
      if (s.bit_rate) {
        const br = Number(s.bit_rate);
        if (Number.isFinite(br) && br > 0) out.videoBitrateKbps = Math.round(br / 1000);
      }
      if (s.r_frame_rate) {
        const [num, den] = s.r_frame_rate.split('/').map(Number);
        if (den && den > 0) {
          const fps = num / den;
          out.fps = Number.isFinite(fps) ? Math.round(fps * 100) / 100 : null;
        }
      }
    }
    if (j.format && j.format.duration) {
      const d = parseFloat(j.format.duration);
      out.duration = Number.isFinite(d) && d > 0 ? d : null;
    }
    // Fallback to format-level bitrate if stream-level was missing.
    if (!out.videoBitrateKbps && j.format && j.format.bit_rate) {
      const br = Number(j.format.bit_rate);
      if (Number.isFinite(br) && br > 0) out.videoBitrateKbps = Math.round(br / 1000);
    }
  } catch (_) {}

  // Probe audio codec separately (select_streams a:0).
  const ra = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { encoding: 'utf8', timeout: 15000 });
  if (ra.status === 0 && ra.stdout.trim()) {
    out.audioCodec = ra.stdout.trim();
  }

  // Measure GOP interval by sampling keyframe positions in the first
  // ~30 seconds of video. Cheap because we read packet metadata only,
  // not decode. Returns the *largest* gap between consecutive keyframes,
  // which is what RTMP platforms use to validate keyframe interval.
  out.gopSeconds = measureGopSeconds(filePath);

  return out;
}

/**
 * Measure the largest gap between consecutive keyframes in the first
 * ~30 seconds of the file. Returns seconds (float) or null if probing
 * fails / can't find at least 2 keyframes.
 */
function measureGopSeconds(filePath) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-read_intervals', '%+30',  // first 30 seconds only
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags',
    '-of', 'csv=print_section=0',
    filePath,
  ], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return null;

  const keyframeTimes = [];
  for (const line of r.stdout.split('\n')) {
    // Format: "pts_time,flags" e.g. "0.000000,K_" or "1.040000,__"
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const t = parseFloat(parts[0]);
    const flags = parts[1] || '';
    if (Number.isFinite(t) && /K/.test(flags)) {
      keyframeTimes.push(t);
    }
  }
  if (keyframeTimes.length < 2) return null;

  let maxGap = 0;
  for (let i = 1; i < keyframeTimes.length; i++) {
    const gap = keyframeTimes[i] - keyframeTimes[i - 1];
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap > 0 ? Math.round(maxGap * 100) / 100 : null;
}

// Validate whether a video file is stream-ready (H.264 + AAC).
// Returns { ok, issues[] }. If ok=false, issues explains what's wrong.
function validateCodec(filePath) {
  const info = probeVideoInfo(filePath);
  const issues = [];

  if (!info.videoCodec) {
    issues.push('Tidak bisa detect video codec. File mungkin corrupt.');
  } else if (info.videoCodec !== 'h264') {
    issues.push(`Video codec "${info.videoCodec}" — butuh h264. Jalankan Prepare dulu.`);
  }

  if (!info.audioCodec) {
    // No audio track is acceptable (some videos are silent).
  } else if (info.audioCodec !== 'aac') {
    issues.push(`Audio codec "${info.audioCodec}" — butuh aac. Jalankan Prepare dulu.`);
  }

  return { ok: issues.length === 0, issues, info };
}

/**
 * Assess how stream-ready a video is, based on cached probe data from the
 * `videos` table (no disk I/O). Used by the UI to surface a transparent
 * compliance badge so users know whether they can stream as-is.
 *
 * Levels:
 *   'ready'    — fully compliant, can stream in Copy mode without warnings
 *   'ok'       — codec ok but GOP/bitrate suboptimal; will work, may warn
 *   'needs-prepare' — wrong codec or huge GOP; Copy mode will fail / look bad
 *   'unknown'  — probe data missing; safe default is to require Prepare
 *
 * @param {object} video - row from `videos` table
 * @returns {{ level, reasons: string[] }}
 */
function assessStreamReadiness(video) {
  if (!video) return { level: 'unknown', reasons: ['data tidak tersedia'] };

  // No probe data yet (legacy row or upload still in flight).
  const noProbe = !video.duration_seconds && video.gop_seconds == null;
  if (noProbe) return { level: 'unknown', reasons: ['belum di-probe'] };

  const reasons = [];
  let level = 'ready';

  // GOP check (most-flagged warning by RTMP platforms).
  const gop = Number(video.gop_seconds);
  if (Number.isFinite(gop) && gop > 0) {
    if (gop > 4) {
      level = 'needs-prepare';
      reasons.push(`keyframe interval ${gop}s (butuh ≤ 2s untuk YouTube/Twitch)`);
    } else if (gop > 2.5) {
      if (level === 'ready') level = 'ok';
      reasons.push(`keyframe interval ${gop}s (suboptimal, ideal 2s)`);
    }
  }

  // Bitrate sanity check — way too low or way too high.
  const br = Number(video.video_bitrate_kbps);
  if (Number.isFinite(br) && br > 0) {
    if (br > 15000) {
      if (level === 'ready') level = 'ok';
      reasons.push(`bitrate ${br}k (over-encoded, bandwidth waste)`);
    } else if (br < 1000) {
      if (level === 'ready') level = 'ok';
      reasons.push(`bitrate ${br}k (very low, kualitas kurang)`);
    }
  }

  if (reasons.length === 0) reasons.push('codec H.264 + AAC, keyframe ok');
  return { level, reasons };
}

function getProgress(videoId) {
  const job = jobs.get(Number(videoId));
  if (!job) return null;
  return {
    percent: job.progress.percent,
    time: job.progress.time,
    duration: job.progress.duration,
    speed: job.progress.speed,
    fps: job.progress.fps,
  };
}

function start(videoId, presetName, x264Preset = 'medium') {
  const id = Number(videoId);
  if (jobs.has(id)) throw new Error('Transcode already running for this video');

  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  if (!video) throw new Error('Video not found');
  const preset = PRESETS[presetName];
  if (!preset) throw new Error('Unknown preset: ' + presetName);

  const srcPath = path.join(uploadDir, video.filename);
  if (!fs.existsSync(srcPath)) throw new Error('Source file missing');

  // Ensure we have a duration for percentage calc. Prefer DB value, fall back
  // to a fresh probe, else percent stays null.
  let duration = video.duration_seconds;
  if (!duration) {
    duration = probeDuration(srcPath);
    if (duration) {
      db.prepare('UPDATE videos SET duration_seconds=? WHERE id=?').run(duration, id);
    }
  }

  const base = video.filename.replace(/\.[^.]+$/, '');
  const outName = `${base}__${presetName}_ready.mp4`;
  const outPath = path.join(uploadDir, outName);

  const gop = preset.kf * preset.fps;
  const bufsize = `${parseInt(preset.br, 10) * 2}k`;

  const args = [
    '-hide_banner', '-y',
    '-nostats',                 // stats disabled, rely on -progress parsing
    '-progress', 'pipe:1',      // machine-readable progress → stdout
    '-i', srcPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=${preset.w}:${preset.h}:force_original_aspect_ratio=decrease,pad=${preset.w}:${preset.h}:(ow-iw)/2:(oh-ih)/2,fps=${preset.fps}`,
    '-c:v', 'libx264',
    '-preset', x264Preset,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-b:v', preset.br,
    '-maxrate', preset.br,
    '-bufsize', bufsize,
    '-g', String(gop),
    '-keyint_min', String(gop),
    '-sc_threshold', '0',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-movflags', '+faststart',
    outPath,
  ];

  const logPath = path.join(logsDir, `transcode-${id}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} starting transcode ${args.join(' ')}\n`);
  logStream.write(`=== source duration: ${duration || 'unknown'}s\n`);

  db.prepare("UPDATE videos SET status='transcoding', last_error=NULL WHERE id=?").run(id);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const progress = { percent: null, time: 0, duration, speed: null, fps: null };

  // FFmpeg -progress writes key=value pairs to stdout.
  let stdoutBuf = '';
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq);
      const v = line.slice(eq + 1);
      if (k === 'out_time') {
        const t = parseTime(v);
        if (t != null) {
          progress.time = t;
          if (duration) progress.percent = Math.min(100, Math.round((t / duration) * 100));
        }
      } else if (k === 'out_time_ms') {
        const ms = Number(v);
        if (Number.isFinite(ms) && ms > 0) progress.time = ms / 1_000_000;
        if (duration && progress.time) {
          progress.percent = Math.min(100, Math.round((progress.time / duration) * 100));
        }
      } else if (k === 'speed') {
        const s = parseFloat(String(v).replace('x', ''));
        if (Number.isFinite(s)) progress.speed = s;
      } else if (k === 'fps') {
        const f = parseFloat(v);
        if (Number.isFinite(f)) progress.fps = f;
      }
    }
  });

  // Stderr is the normal warnings/info output (we disabled stats). Keep it in log.
  proc.stderr.on('data', (c) => logStream.write(c));

  jobs.set(id, { process: proc, progress });

  proc.on('exit', (code, signal) => {
    logStream.write(`\n=== ${new Date().toISOString()} transcode exit code=${code} signal=${signal}\n`);
    logStream.end();
    jobs.delete(id);

    if (code === 0) {
      try {
        const srcSize = fs.statSync(outPath).size;
        try { fs.unlinkSync(srcPath); } catch (_) {}
        fs.renameSync(outPath, srcPath);
        // Re-probe the new file for accurate duration on the prepared output.
        const newDur = probeDuration(srcPath) || duration || null;
        db.prepare(`UPDATE videos
          SET status='ready', size_bytes=?, duration_seconds=?, last_error=NULL
          WHERE id=?`).run(srcSize, newDur, id);
        // Regenerate thumbnail from the prepared file.
        const thumb = generateThumbnail(srcPath, id);
        if (thumb) {
          db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, id);
        }
      } catch (e) {
        db.prepare("UPDATE videos SET status='error', last_error=? WHERE id=?")
          .run('replace failed: ' + e.message, id);
      }
    } else {
      if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch (_) {}
      db.prepare("UPDATE videos SET status='error', last_error=? WHERE id=?")
        .run(`ffmpeg exited with code ${code} (see logs/transcode-${id}.log)`, id);
    }
  });

  proc.on('error', (err) => {
    logStream.write(`\n=== spawn error: ${err.message}\n`);
    db.prepare("UPDATE videos SET status='error', last_error=? WHERE id=?")
      .run(err.message, id);
    jobs.delete(id);
  });
}

function cancel(videoId) {
  const id = Number(videoId);
  const job = jobs.get(id);
  if (!job) return false;
  try { job.process.kill('SIGTERM'); } catch (_) {}
  return true;
}

function reconcileOnBoot() {
  db.prepare(`UPDATE videos SET status='error',
    last_error='transcoding interrupted by server restart'
    WHERE status='transcoding'`).run();
}

function tailLog(videoId, lines = 60) {
  const logPath = path.join(logsDir, `transcode-${videoId}.log`);
  if (!fs.existsSync(logPath)) return '';
  const data = fs.readFileSync(logPath, 'utf8').split('\n');
  return data.slice(-lines).join('\n');
}

/**
 * Generate a thumbnail image from a video file.
 *
 * @param {string}  videoPath - absolute path to the source video
 * @param {number}  videoId   - video row id (used for output filename)
 * @param {object}  [opts]
 * @param {number}  [opts.atSecond] - explicit time in seconds to capture
 *                                    the frame. If omitted, uses ~10% of
 *                                    the duration (min 1s, max 30s).
 * @returns {string|null} thumbnail filename (in thumbs/) or null on failure.
 */
function generateThumbnail(videoPath, videoId, opts = {}) {
  const { spawnSync } = require('child_process');
  const thumbsDir = path.join(__dirname, '..', 'public', 'uploads', 'thumbs');
  if (!fs.existsSync(thumbsDir)) fs.mkdirSync(thumbsDir, { recursive: true });

  // Determine seek position:
  //   - If opts.atSecond is given, clamp to [0, duration] and use it.
  //   - Otherwise: 10% of duration, min 1s, max 30s.
  const duration = probeDuration(videoPath);
  let seekSec;
  if (Number.isFinite(opts.atSecond) && opts.atSecond >= 0) {
    seekSec = duration ? Math.min(opts.atSecond, Math.max(0, duration - 0.1)) : opts.atSecond;
  } else if (duration) {
    seekSec = Math.max(1, Math.min(30, Math.round(duration * 0.1)));
  } else {
    seekSec = 2;
  }

  const thumbFilename = `thumb_${videoId}.jpg`;
  const thumbPath = path.join(thumbsDir, thumbFilename);

  // Generate 1280×720 thumbnail (YouTube-style). Keep aspect ratio, pad with black if needed.
  const r = spawnSync('ffmpeg', [
    '-v', 'error',
    '-ss', String(seekSec),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black',
    '-q:v', '3',
    '-y',
    thumbPath,
  ], { encoding: 'utf8', timeout: 20000 });

  if (r.status === 0 && fs.existsSync(thumbPath)) {
    return thumbFilename;
  }

  // Fallback: try at 0s if seeking failed (very short video).
  const r2 = spawnSync('ffmpeg', [
    '-v', 'error',
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black',
    '-q:v', '3',
    '-y',
    thumbPath,
  ], { encoding: 'utf8', timeout: 20000 });

  if (r2.status === 0 && fs.existsSync(thumbPath)) {
    return thumbFilename;
  }

  return null;
}

module.exports = {
  presets, start, cancel, isRunning, reconcileOnBoot, tailLog,
  getProgress, probeDuration, probeVideoInfo, validateCodec,
  generateThumbnail, assessStreamReadiness, measureGopSeconds,
};
