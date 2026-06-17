// Audio tracks manager — separate from videos.
// Handles ffprobe for audio files, stores metadata, cleanup on delete,
// and EBU R128 loudness normalization (target -14 LUFS = YouTube standard).
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { db } = require('./db');

const audioDir = path.join(__dirname, '..', 'public', 'uploads', 'audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// activeJobs map for tracking progress percentage of loudness normalization.
// Key: audioId (number) -> Value: { percent: number }
const activeJobs = new Map();

function getActiveJob(id) {
  return activeJobs.get(Number(id)) || null;
}

/**
 * Assess how stream-ready an audio file is.
 *
 * Levels:
 *   'ready'           - Normalized (-14 LUFS) AND codec is AAC (100% standard).
 *   'ok'              - Normalized but codec is NOT AAC (e.g. MP3/Opus). Works, but transcode is needed / suboptimal.
 *   'needs-normalize' - Not normalized (normalized = 0).
 */
function assessStreamReadiness(track) {
  if (!track) return { level: 'unknown', reasons: ['data tidak tersedia'] };

  const reasons = [];
  let level = 'ready';

  // 1. Loudness normalization check
  if (!track.normalized) {
    level = 'needs-normalize';
    reasons.push('Loudness belum dinormalisasi ke standar -14 LUFS');
  } else {
    reasons.push(`Loudness ok: ${track.integrated_lufs ? track.integrated_lufs.toFixed(1) : '-14'} LUFS`);
  }

  // 2. Codec check
  if (track.codec && track.codec.toLowerCase() !== 'aac') {
    if (level === 'ready') {
      level = 'ok'; // Normalized but suboptimal codec
    }
    reasons.push(`Codec "${track.codec.toUpperCase()}" (Disarankan AAC untuk live streaming tanpa transcode audio)`);
  } else {
    reasons.push('Codec AAC (standar streaming)');
  }

  return { level, reasons };
}

// Loudness normalization defaults — YouTube standard.
const LOUDNESS_TARGET = {
  I: -14,    // integrated loudness (LUFS)
  TP: -1.5,  // true peak limit (dBFS)
  LRA: 11,   // loudness range (LU)
};

// Supported audio extensions for the upload filter.
const SUPPORTED_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac|wma)$/i;

function isSupportedFilename(filename) {
  return SUPPORTED_EXT.test(filename);
}

/**
 * Pass 1 of two-pass loudness normalization: analyze.
 * Runs `loudnorm` filter with `print_format=json` and parses the resulting
 * measurements from FFmpeg's stderr.
 *
 * Returns measurement object on success, null on failure.
 *   { input_i, input_tp, input_lra, input_thresh, target_offset }
 */
function analyzeLoudness(filePath, onProgress) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-nostats',
      '-progress', 'pipe:1',
      '-i', filePath,
      '-af', `loudnorm=I=${LOUDNESS_TARGET.I}:TP=${LOUDNESS_TARGET.TP}:LRA=${LOUDNESS_TARGET.LRA}:print_format=json`,
      '-f', 'null', '-',
    ];
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
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
            const time = ms / 1_000_000;
            if (onProgress) onProgress(time);
          }
        }
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        try {
          const logPath = path.join(logsDir, 'audio-normalize.log');
          const tail = stderr.split('\n').slice(-30).join('\n');
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] analyzeLoudness failed (exit ${code}) for ${filePath}\n=== stderr tail ===\n${tail}\n=== end ===\n`);
        } catch (_) {}
        return resolve(null);
      }

      // FFmpeg prints the JSON block at the end of stderr. Find it.
      const start = stderr.lastIndexOf('{');
      const end = stderr.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) {
        try {
          const logPath = path.join(logsDir, 'audio-normalize.log');
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] analyzeLoudness JSON parse failed (braces not found) for ${filePath}\n=== stderr tail ===\n${stderr.slice(-500)}\n=== end ===\n`);
        } catch (_) {}
        return resolve(null);
      }

      try {
        const json = JSON.parse(stderr.slice(start, end + 1));
        resolve({
          input_i: parseFloat(json.input_i),
          input_tp: parseFloat(json.input_tp),
          input_lra: parseFloat(json.input_lra),
          input_thresh: parseFloat(json.input_thresh),
          target_offset: parseFloat(json.target_offset),
        });
      } catch (err) {
        try {
          const logPath = path.join(logsDir, 'audio-normalize.log');
          fs.appendFileSync(logPath, `[${new Date().toISOString()}] analyzeLoudness JSON parse error: ${err.message} for ${filePath}\n=== JSON text ===\n${stderr.slice(start, end + 1)}\n=== end ===\n`);
        } catch (_) {}
        resolve(null);
      }
    });
    child.on('error', (err) => {
      try {
        const logPath = path.join(logsDir, 'audio-normalize.log');
        fs.appendFileSync(logPath, `[${new Date().toISOString()}] analyzeLoudness spawned child error: ${err.message} for ${filePath}\n`);
      } catch (_) {}
      resolve(null);
    });
  });
}

/**
 * Pass 2 of two-pass loudness normalization: apply with measured values.
 * Re-encodes the audio file to the input file path (overwrites). Returns
 * true on success, false on failure.
 */
function applyLoudnessNormalization(filePath, measured, onProgress) {
  return new Promise((resolve) => {
    // Force the standard streaming audio codec (AAC) for all normalized files
    const outCodec = 'aac';
    const outExt = '.m4a';
    const tmpPath = filePath + '.norm-tmp' + outExt;

    const af = [
      'loudnorm',
      `I=${LOUDNESS_TARGET.I}`,
      `TP=${LOUDNESS_TARGET.TP}`,
      `LRA=${LOUDNESS_TARGET.LRA}`,
      `measured_I=${measured.input_i}`,
      `measured_TP=${measured.input_tp}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      'print_format=summary',
    ];
    const afStr = af[0] + '=' + af.slice(1).join(':') + ',alimiter=limit=-1.5dB:level=disabled';

    const args = [
      '-hide_banner', '-nostats', '-y',
      '-progress', 'pipe:1',
      '-i', filePath,
      '-vn',           // drop any video stream (MP3 album art etc.) — audio only
      '-map', '0:a',   // explicitly map only audio stream
      '-af', afStr,
      '-c:a', outCodec,
      '-ar', '48000',  // resample to 48k for consistency (loudnorm requires 192k internally anyway)
      tmpPath,
    ];

    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
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
            const time = ms / 1_000_000;
            if (onProgress) onProgress(time);
          }
        }
      }
    });

    child.on('close', (code) => {
      if (code !== 0) {
        try {
          const errLog = path.join(logsDir, 'audio-normalize.log');
          const stderrTail = stderr.split('\n').slice(-30).join('\n');
          fs.appendFileSync(errLog,
            `[${new Date().toISOString()}]   pass 2 ffmpeg failed (exit ${code})\n` +
            `=== stderr tail ===\n${stderrTail}\n=== end ===\n`
          );
        } catch (_) {}
        if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
        return resolve(false);
      }

      // Replace original with normalized version. If extension changed (e.g. .wav → .flac),
      // we keep the original filename but the actual content is the new format.
      try {
        fs.unlinkSync(filePath);
        fs.renameSync(tmpPath, filePath);
        resolve(true);
      } catch (e) {
        if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
        resolve(false);
      }
    });
    child.on('error', () => {
      if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
      resolve(false);
    });
  });
}

/**
 * Run the full two-pass normalization pipeline on an audio file.
 * Returns { ok, measured, error }.
 */
function normalize(filePath) {
  const logPath = path.join(logsDir, 'audio-normalize.log');
  const log = (msg) => {
    try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
  };

  log(`normalize start: ${filePath}`);
  const measured = analyzeLoudness(filePath);
  if (!measured) {
    log(`  pass 1 failed (analyze)`);
    return { ok: false, error: 'Loudness analysis failed (pass 1)' };
  }
  log(`  pass 1: I=${measured.input_i} TP=${measured.input_tp} LRA=${measured.input_lra}`);

  const ok = applyLoudnessNormalization(filePath, measured);
  if (!ok) {
    log(`  pass 2 failed (apply)`);
    return { ok: false, error: 'Loudness normalization failed (pass 2)', measured };
  }
  log(`  pass 2: applied successfully → ${LOUDNESS_TARGET.I} LUFS target`);
  return { ok: true, measured };
}


function probe(filePath) {
  const out = { duration: null, codec: null, bitrate: null, sampleRate: null, channels: null };
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name,bit_rate,sample_rate,channels',
    '-show_entries', 'format=duration,bit_rate',
    '-of', 'json',
    filePath,
  ], { encoding: 'utf8', timeout: 30000 });

  if (r.status !== 0) return out;

  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams && j.streams[0];
    if (s) {
      out.codec = s.codec_name || null;
      out.sampleRate = s.sample_rate ? Number(s.sample_rate) : null;
      out.channels = s.channels || null;
      if (s.bit_rate) out.bitrate = Number(s.bit_rate);
    }
    if (j.format) {
      if (j.format.duration) {
        const d = parseFloat(j.format.duration);
        out.duration = Number.isFinite(d) && d > 0 ? d : null;
      }
      // Prefer format bitrate if stream bitrate missing.
      if (!out.bitrate && j.format.bit_rate) out.bitrate = Number(j.format.bit_rate);
    }
  } catch (_) {}

  return out;
}

/**
 * Ensure title is unique by appending " (2)", " (3)", ... if needed.
 */
function uniqueTitle(base) {
  const exists = (t) => db.prepare('SELECT 1 FROM audio_tracks WHERE title=?').get(t);
  if (!exists(base)) return base;
  const stripped = base.replace(/\s*\(\d+\)\s*$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stripped} (${i})`;
    if (!exists(candidate)) return candidate;
  }
  return `${stripped} (${Date.now()})`;
}

/**
 * Register an uploaded audio file. Inserts DB row + probes metadata + runs
 * EBU R128 loudness normalization to -14 LUFS (YouTube standard).
 * Returns the audio track id.
 */
function register({ title, filename, size }) {
  const finalTitle = uniqueTitle((title || filename).trim());
  const result = db.prepare(`INSERT INTO audio_tracks
    (title, filename, size_bytes, status)
    VALUES (?, ?, ?, 'uploaded')`).run(finalTitle, filename, size || 0);
  const id = Number(result.lastInsertRowid);

  // Probe in background so response isn't blocked.
  setImmediate(async () => {
    try {
      const filePath = path.join(audioDir, filename);
      const info = probe(filePath);
      if (!info.codec && !info.duration) {
        // Probe found no audio stream — mark as error.
        db.prepare(`UPDATE audio_tracks SET status='error', last_error=?
          WHERE id=?`).run('No audio stream detected (file may be corrupt or unsupported)', id);
        return;
      }

      // Persist initial probe metadata first.
      db.prepare(`UPDATE audio_tracks SET
        duration_seconds=?,
        codec=?,
        bitrate=?,
        sample_rate=?,
        channels=?,
        status='analyzing',
        normalized=0,
        last_error=NULL,
        status_log='[Uploaded] Metadata probed successfully.'
        WHERE id=?`).run(
        info.duration, info.codec, info.bitrate, info.sampleRate, info.channels, id
      );

      activeJobs.set(id, { percent: 0 });

      // Analyze loudness in background so details (LUFS, True Peak, LRA) are populated immediately
      const measured = await analyzeLoudness(
        filePath,
        (time) => {
          if (info.duration) {
            const pct = Math.min(99, Math.round((time / info.duration) * 100));
            const job = activeJobs.get(id);
            if (job) job.percent = pct;
          }
        },
        (child) => {
          const job = activeJobs.get(id);
          if (job) job.process = child;
        }
      );

      if (measured) {
        // If codec is already AAC, sample rate is 48000 Hz, and loudness is close to -14 LUFS (+/- 1.5),
        // we can auto-normalize/mark as ready!
        const isAlreadyAac = info.codec && info.codec.toLowerCase() === 'aac';
        const isAlready48k = info.sampleRate === 48000;
        const isLoudnessOk = Math.abs(measured.input_i - LOUDNESS_TARGET.I) <= 1.5;
        const isPeakOk = measured.input_tp <= -1.0;
        const autoReady = isAlreadyAac && isAlready48k && isLoudnessOk && isPeakOk;

        db.prepare(`UPDATE audio_tracks SET
          integrated_lufs=?,
          true_peak_db=?,
          loudness_range=?,
          normalized=?,
          status='uploaded',
          status_log = status_log || ?
          WHERE id=?`).run(
          measured.input_i,
          measured.input_tp,
          measured.input_lra,
          autoReady ? 1 : 0,
          `\n[Analysis] Loudness: ${measured.input_i.toFixed(1)} LUFS (target: -14.0), True Peak: ${measured.input_tp.toFixed(1)} dBFS, LRA: ${measured.input_lra.toFixed(1)} LU. ${autoReady ? 'File matches streaming standards, auto-ready!' : 'Normalisation recommended to match AAC + -14 LUFS standard.'}`,
          id
        );
      } else {
        db.prepare(`UPDATE audio_tracks SET
          status='uploaded',
          last_error='Loudness analysis failed',
          status_log = status_log || '\n[Analysis Failed] Loudness analysis failed. You can retry manually.'
          WHERE id=?`).run(id);
      }
    } catch (e) {
      db.prepare(`UPDATE audio_tracks SET status='error', last_error=?
        WHERE id=?`).run(e.message, id);
    } finally {
      activeJobs.delete(id);
    }
  });

  return id;
}

/**
 * Get absolute path to audio file, or null if missing on disk.
 */
function getFilePath(audioId) {
  const row = db.prepare('SELECT filename FROM audio_tracks WHERE id=?').get(Number(audioId));
  if (!row) return null;
  const p = path.join(audioDir, row.filename);
  return fs.existsSync(p) ? p : null;
}

/**
 * Delete an audio track. Verifies no running stream uses it before deleting.
 * Returns { ok: boolean, error?: string }.
 */
function remove(audioId) {
  const id = Number(audioId);
  const track = db.prepare('SELECT * FROM audio_tracks WHERE id=?').get(id);
  if (!track) return { ok: false, error: 'Track not found' };

  // Cancel active job if running.
  cancel(id);

  // Check if any running stream uses this audio.
  const inUse = db.prepare(`
    SELECT id, name FROM streams WHERE audio_id=? AND status='running' LIMIT 1
  `).get(id);
  if (inUse) {
    return { ok: false, error: `Used by running stream "${inUse.name}". Stop it first.` };
  }

  // Null out audio_id in any stream referencing this track.
  db.prepare('UPDATE streams SET audio_id=NULL WHERE audio_id=?').run(id);

  // Delete DB row.
  db.prepare('DELETE FROM audio_tracks WHERE id=?').run(id);

  // Delete file from disk.
  const filePath = path.join(audioDir, track.filename);
  try { fs.unlinkSync(filePath); } catch (_) {}

  return { ok: true };
}

function list() {
  return db.prepare(`
    SELECT * FROM audio_tracks ORDER BY created_at DESC
  `).all();
}

function listReady() {
  return db.prepare(`
    SELECT id, title, duration_seconds, codec, channels, size_bytes
    FROM audio_tracks
    WHERE status='uploaded'
    ORDER BY title ASC
  `).all();
}

function get(audioId) {
  return db.prepare('SELECT * FROM audio_tracks WHERE id=?').get(Number(audioId));
}

function cancel(id) {
  const job = activeJobs.get(Number(id));
  if (!job) return false;
  job.cancelled = true;
  if (job.process) {
    try {
      job.process.kill('SIGTERM');
    } catch (_) {}
  }
  return true;
}

function reconcileOnBoot() {
  // Reset any audio stuck in 'normalizing' status to 'uploaded' on boot,
  // since background jobs would have been terminated if the process was killed.
  try {
    db.prepare("UPDATE audio_tracks SET status='uploaded' WHERE status='normalizing'").run();
  } catch (_) {}
}

module.exports = {
  audioDir,
  isSupportedFilename,
  probe,
  register,
  getFilePath,
  remove,
  list,
  listReady,
  get,
  reconcileOnBoot,
  normalize,
  analyzeLoudness,
  applyLoudnessNormalization,
  LOUDNESS_TARGET,
  activeJobs,
  getActiveJob,
  cancel,
  assessStreamReadiness,
};
