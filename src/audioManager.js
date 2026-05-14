// Audio tracks manager — separate from videos.
// Handles ffprobe for audio files, stores metadata, cleanup on delete.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { db } = require('./db');

const audioDir = path.join(__dirname, '..', 'public', 'uploads', 'audio');
if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });

// Supported audio extensions for the upload filter.
const SUPPORTED_EXT = /\.(mp3|m4a|aac|wav|ogg|opus|flac|wma)$/i;

function isSupportedFilename(filename) {
  return SUPPORTED_EXT.test(filename);
}

/**
 * Probe an audio file with ffprobe. Returns metadata or nulls on failure.
 */
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
 * Register an uploaded audio file. Inserts DB row + probes metadata.
 * Returns the audio track id.
 */
function register({ title, filename, size }) {
  const finalTitle = uniqueTitle((title || filename).trim());
  const result = db.prepare(`INSERT INTO audio_tracks
    (title, filename, size_bytes, status)
    VALUES (?, ?, ?, 'uploaded')`).run(finalTitle, filename, size || 0);
  const id = Number(result.lastInsertRowid);

  // Probe in background so response isn't blocked.
  setImmediate(() => {
    try {
      const filePath = path.join(audioDir, filename);
      const info = probe(filePath);
      if (info.codec || info.duration) {
        db.prepare(`UPDATE audio_tracks
          SET duration_seconds=?, codec=?, bitrate=?, sample_rate=?, channels=?
          WHERE id=?`).run(
          info.duration, info.codec, info.bitrate, info.sampleRate, info.channels, id
        );
      } else {
        // Probe found no audio stream — mark as error.
        db.prepare(`UPDATE audio_tracks SET status='error', last_error=?
          WHERE id=?`).run('No audio stream detected (file may be corrupt or unsupported)', id);
      }
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
};
