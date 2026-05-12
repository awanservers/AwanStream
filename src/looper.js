// Video looper: take a short clip and produce a long looped version by
// repeating it in the container (no re-encode, -c copy). Very fast because
// the source is never decoded.
//
// Output is inserted as a new video row (not overwriting source).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const transcoder = require('./transcoder');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// jobId (string) -> { process, progress, sourceVideoId, outputVideoId, target, startedAt }
const jobs = new Map();
let nextJobId = 1;

// Parse "HH:MM:SS.xx" → seconds (float).
function parseTime(s) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function isRunning(jobId) {
  return jobs.has(String(jobId));
}

function getJob(jobId) {
  return jobs.get(String(jobId)) || null;
}

function listJobs() {
  const out = [];
  for (const [id, j] of jobs.entries()) {
    out.push({
      jobId: id,
      sourceVideoId: j.sourceVideoId,
      outputVideoId: j.outputVideoId,
      target: j.target,
      progress: j.progress,
      startedAt: j.startedAt,
    });
  }
  return out;
}

function getProgress(jobId) {
  const j = jobs.get(String(jobId));
  if (!j) return null;
  return {
    jobId: String(jobId),
    sourceVideoId: j.sourceVideoId,
    outputVideoId: j.outputVideoId,
    target: j.target,
    percent: j.progress.percent,
    time: j.progress.time,
    duration: j.progress.duration,
    speed: j.progress.speed,
    startedAt: j.startedAt,
  };
}

/**
 * Start a loop job.
 *
 * @param {number} sourceVideoId   The source video row id.
 * @param {number} targetSeconds   Desired output length in seconds.
 * @param {string} [title]         Optional title for the output row.
 * @returns {{ jobId: string, outputVideoId: number, outputFilename: string }}
 */
function start(sourceVideoId, targetSeconds, title) {
  const src = db.prepare('SELECT * FROM videos WHERE id=?').get(Number(sourceVideoId));
  if (!src) throw new Error('Source video not found');

  const srcPath = path.join(uploadDir, src.filename);
  if (!fs.existsSync(srcPath)) throw new Error('Source file missing on disk');

  const target = Number(targetSeconds);
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('Target duration must be a positive number of seconds');
  }
  if (target > 24 * 3600) {
    throw new Error('Target duration cannot exceed 24 hours');
  }

  // Ensure we know source duration so we can estimate loop count + warn if
  // target < source (which would be a trim, not a loop).
  let srcDuration = src.duration_seconds;
  if (!srcDuration) {
    srcDuration = transcoder.probeDuration(srcPath);
    if (srcDuration) {
      db.prepare('UPDATE videos SET duration_seconds=? WHERE id=?').run(srcDuration, src.id);
    }
  }
  if (srcDuration && target < srcDuration) {
    throw new Error(`Target (${target}s) is shorter than source (${Math.round(srcDuration)}s). Pick a longer target.`);
  }

  // Output filename: <timestamp>_<basename>_loop.mp4 (always mp4 container so
  // -c copy works predictably across input formats).
  const base = src.filename.replace(/\.[^.]+$/, '');
  const outFilename = `${Date.now()}_${base}_loop.mp4`;
  const outPath = path.join(uploadDir, outFilename);

  // Resolve output title with auto-suffix if it clashes.
  const baseTitle = (title && String(title).trim()) || `${src.title} (loop ${formatTargetLabel(target)})`;
  const finalTitle = uniqueVideoTitle(baseTitle);

  // Insert output video row up-front with status='transcoding' so it shows
  // up in library immediately. Copy folder + size=0 (updated after finish).
  const insert = db.prepare(`INSERT INTO videos
    (title, filename, size_bytes, duration_seconds, status, folder_id,
     src_width, src_height, src_fps)
    VALUES (?, ?, 0, ?, 'transcoding', ?, ?, ?, ?)`);
  const result = insert.run(
    finalTitle,
    outFilename,
    target,
    src.folder_id || null,
    src.src_width || null,
    src.src_height || null,
    src.src_fps || null
  );
  const outputVideoId = Number(result.lastInsertRowid);

  // FFmpeg args — stream_loop repeats the input forever, -t caps output, -c
  // copy avoids any decode/encode. Very fast regardless of target length.
  const args = [
    '-hide_banner', '-y',
    '-nostats',
    '-progress', 'pipe:1',
    '-stream_loop', '-1',
    '-i', srcPath,
    '-c', 'copy',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-t', String(target),
    '-movflags', '+faststart',
    outPath,
  ];

  const jobId = String(nextJobId++);
  const logPath = path.join(logsDir, `loop-${jobId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n=== ${new Date().toISOString()} starting loop job=${jobId} src=${src.id} target=${target}s\n`);
  logStream.write(`=== cmd: ffmpeg ${args.join(' ')}\n`);

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const progress = {
    percent: 0,
    time: 0,
    duration: target,
    speed: null,
  };
  const startedAt = Date.now();

  jobs.set(jobId, {
    process: proc,
    progress,
    sourceVideoId: src.id,
    outputVideoId,
    target,
    startedAt,
  });

  // Parse -progress key=value pairs from stdout.
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
      if (k === 'out_time_ms') {
        const ms = Number(v);
        if (Number.isFinite(ms) && ms > 0) {
          progress.time = ms / 1_000_000;
          progress.percent = Math.min(100, Math.round((progress.time / target) * 100));
        }
      } else if (k === 'out_time') {
        const t = parseTime(v);
        if (t != null) {
          progress.time = t;
          progress.percent = Math.min(100, Math.round((t / target) * 100));
        }
      } else if (k === 'speed') {
        const s = parseFloat(String(v).replace('x', ''));
        if (Number.isFinite(s)) progress.speed = s;
      }
    }
  });

  proc.stderr.on('data', (c) => logStream.write(c));

  proc.on('exit', (code, signal) => {
    logStream.write(`\n=== ${new Date().toISOString()} loop exit code=${code} signal=${signal}\n`);
    logStream.end();
    jobs.delete(jobId);

    if (code === 0 && fs.existsSync(outPath)) {
      try {
        const size = fs.statSync(outPath).size;
        const actualDuration = transcoder.probeDuration(outPath) || target;
        db.prepare(`UPDATE videos
          SET status='ready', size_bytes=?, duration_seconds=?, last_error=NULL
          WHERE id=?`).run(size, actualDuration, outputVideoId);
        // Generate thumbnail for the new looped video.
        try {
          const thumb = transcoder.generateThumbnail(outPath, outputVideoId);
          if (thumb) {
            db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, outputVideoId);
          }
        } catch (_) {}
        // If source already had an h264+aac codec (stream-ready), the copy is
        // also stream-ready — status 'ready' is accurate. Otherwise, user will
        // still need to run Prepare on it; the file is copied as-is.
      } catch (e) {
        db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
          .run('post-process failed: ' + e.message, outputVideoId);
      }
    } else {
      if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch (_) {}
      const msg = signal
        ? `loop cancelled (signal=${signal})`
        : `ffmpeg exited with code ${code} (see logs/loop-${jobId}.log)`;
      db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
        .run(msg, outputVideoId);
    }
  });

  proc.on('error', (err) => {
    logStream.write(`\n=== spawn error: ${err.message}\n`);
    db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
      .run(err.message, outputVideoId);
    jobs.delete(jobId);
  });

  return { jobId, outputVideoId, outputFilename: outFilename };
}

function cancel(jobId) {
  const j = jobs.get(String(jobId));
  if (!j) return false;
  try { j.process.kill('SIGTERM'); } catch (_) {}
  return true;
}

// On boot, any video row still marked 'transcoding' that came from a loop job
// (we can't perfectly distinguish from prepare, but transcoder.reconcileOnBoot
// already handles its own rows — this is a second sweep to catch anything left
// behind after a crash during loop). Safe because both pipelines mark rows the
// same way on failure.
function reconcileOnBoot() {
  // No-op: transcoder.reconcileOnBoot() already flips stale 'transcoding' →
  // 'error'. We don't double up. This function exists so app.js can call it
  // symmetrically with the other managers.
}

function tailLog(jobId, lines = 100) {
  const logPath = path.join(logsDir, `loop-${jobId}.log`);
  if (!fs.existsSync(logPath)) return '';
  const data = fs.readFileSync(logPath, 'utf8').split('\n');
  return data.slice(-lines).join('\n');
}

// Helpers -------------------------------------------------------------------

function uniqueVideoTitle(base) {
  const exists = (t) => db.prepare('SELECT 1 FROM videos WHERE title=?').get(t);
  if (!exists(base)) return base;
  const stripped = base.replace(/\s*\(\d+\)\s*$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stripped} (${i})`;
    if (!exists(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function formatTargetLabel(seconds) {
  if (seconds >= 3600) {
    const h = seconds / 3600;
    return (Number.isInteger(h) ? h : h.toFixed(1)) + 'h';
  }
  if (seconds >= 60) {
    const m = seconds / 60;
    return (Number.isInteger(m) ? m : m.toFixed(1)) + 'm';
  }
  return seconds + 's';
}

module.exports = {
  start,
  cancel,
  getProgress,
  isRunning,
  listJobs,
  getJob,
  reconcileOnBoot,
  tailLog,
};
