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
function analyzeLoudness(filePath) {
  const args = [
    '-hide_banner', '-nostats',
    '-i', filePath,
    '-af', `loudnorm=I=${LOUDNESS_TARGET.I}:TP=${LOUDNESS_TARGET.TP}:LRA=${LOUDNESS_TARGET.LRA}:print_format=json`,
    '-f', 'null', '-',
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (r.status !== 0) return null;

  // FFmpeg prints the JSON block at the end of stderr. Find it.
  const stderr = String(r.stderr || '');
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    const json = JSON.parse(stderr.slice(start, end + 1));
    return {
      input_i: parseFloat(json.input_i),
      input_tp: parseFloat(json.input_tp),
      input_lra: parseFloat(json.input_lra),
      input_thresh: parseFloat(json.input_thresh),
      target_offset: parseFloat(json.target_offset),
    };
  } catch (_) {
    return null;
  }
}

/**
 * Pass 2 of two-pass loudness normalization: apply with measured values.
 * Re-encodes the audio file to the input file path (overwrites). Returns
 * true on success, false on failure.
 *
 * Output codec is preserved when possible:
 *   - .mp3   → libmp3lame
 *   - .m4a/.aac → aac
 *   - .ogg/.opus → libopus
 *   - .wav/.flac → flac (lossless)
 *   - else → aac (safe fallback)
 */
function applyLoudnessNormalization(filePath, measured) {
  const ext = path.extname(filePath).toLowerCase();
  let outCodec, outExt;
  switch (ext) {
    case '.mp3':           outCodec = 'libmp3lame'; outExt = '.mp3'; break;
    case '.m4a': case '.aac': outCodec = 'aac';     outExt = ext;    break;
    case '.opus': case '.ogg': outCodec = 'libopus'; outExt = ext;   break;
    case '.flac': case '.wav': outCodec = 'flac';   outExt = '.flac'; break;
    default:               outCodec = 'aac';        outExt = '.m4a'; break;
  }

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
    // Note: we deliberately don't use linear=true. While linear is slightly
    // more accurate, it requires measured values to fall within strict bounds
    // and rejects otherwise. Dynamic mode (the default) handles edge cases
    // better and is already very accurate for two-pass normalization.
    'print_format=summary',
  ];
  // FFmpeg filter syntax: filtername=key=value:key=value (= after name, : between params)
  // Chain alimiter after loudnorm as brick-wall safety against peaks that
  // loudnorm's internal limiter might miss.
  const afStr = af[0] + '=' + af.slice(1).join(':') + ',alimiter=limit=-1.5dB:level=disabled';

  const args = [
    '-hide_banner', '-nostats', '-y',
    '-i', filePath,
    '-vn',           // drop any video stream (MP3 album art etc.) — audio only
    '-map', '0:a',   // explicitly map only audio stream
    '-af', afStr,
    '-c:a', outCodec,
    '-ar', '48000',  // resample to 48k for consistency (loudnorm requires 192k internally anyway)
    tmpPath,
  ];

  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r.status !== 0) {
    // Log the actual ffmpeg error to disk so we can diagnose next time.
    try {
      const errLog = path.join(logsDir, 'audio-normalize.log');
      const stderrTail = String(r.stderr || '').split('\n').slice(-30).join('\n');
      fs.appendFileSync(errLog,
        `[${new Date().toISOString()}]   pass 2 ffmpeg failed (exit ${r.status})\n` +
        `=== stderr tail ===\n${stderrTail}\n=== end ===\n`
      );
    } catch (_) {}
    if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }

  // Replace original with normalized version. If extension changed (e.g. .wav → .flac),
  // we keep the original filename but the actual content is the new format. This is
  // a minor inconsistency we accept — alternative is to track new filename in DB.
  try {
    fs.unlinkSync(filePath);
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (e) {
    if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }
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

  // Probe + normalize in background so response isn't blocked.
  setImmediate(() => {
    try {
      const filePath = path.join(audioDir, filename);
      const info = probe(filePath);
      if (!info.codec && !info.duration) {
        // Probe found no audio stream — mark as error, skip normalization.
        db.prepare(`UPDATE audio_tracks SET status='error', last_error=?
          WHERE id=?`).run('No audio stream detected (file may be corrupt or unsupported)', id);
        return;
      }

      // Persist initial probe metadata first so user sees something while normalize runs.
      db.prepare(`UPDATE audio_tracks
        SET duration_seconds=?, codec=?, bitrate=?, sample_rate=?, channels=?
        WHERE id=?`).run(
        info.duration, info.codec, info.bitrate, info.sampleRate, info.channels, id
      );

      // Normalize loudness (two-pass, EBU R128 → -14 LUFS).
      // This is destructive: overwrites the file in place.
      const result = normalize(filePath);
      if (!result.ok) {
        // Soft fail: keep file as-is, mark normalized=0, log error.
        // Track is still usable, just not loudness-consistent.
        db.prepare(`UPDATE audio_tracks
          SET last_error=?, normalized=0
          WHERE id=?`).run('Loudness normalization failed: ' + result.error, id);
        return;
      }

      // Re-probe the normalized file to refresh size + bitrate (codec may have changed).
      const newInfo = probe(filePath);
      const stat = fs.statSync(filePath);

      db.prepare(`UPDATE audio_tracks SET
        size_bytes=?,
        codec=COALESCE(?, codec),
        bitrate=COALESCE(?, bitrate),
        sample_rate=COALESCE(?, sample_rate),
        integrated_lufs=?,
        true_peak_db=?,
        loudness_range=?,
        normalized=1,
        last_error=NULL
        WHERE id=?`).run(
        stat.size,
        newInfo.codec, newInfo.bitrate, newInfo.sampleRate,
        result.measured.input_i,
        result.measured.input_tp,
        result.measured.input_lra,
        id,
      );
    } catch (e) {
      db.prepare(`UPDATE audio_tracks SET status='error', last_error=?
        WHERE id=?`).run(e.message, id);
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

function reconcileOnBoot() {
  // Nothing to reconcile right now — upload is synchronous (no stale jobs).
  // Future: if we add download-from-URL for audio, reset 'downloading' here.
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
};
