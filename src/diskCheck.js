// Disk space pre-check utility.
// Used by upload, transcode, loop, and import flows to fail fast with a
// helpful error message instead of letting FFmpeg/multer crash mid-job
// when the filesystem fills up.
const fs = require('fs');
const path = require('path');

const uploadsPath = path.join(__dirname, '..', 'public', 'uploads');

// Always keep this much free regardless of operation size — protects DB,
// logs, and OS-level activity (tmpfs, journal, etc.).
const ABSOLUTE_MIN_FREE = 1 * 1024 * 1024 * 1024; // 1 GB

// Always keep at least this percent of disk free (proportional buffer for
// filesystem health: ext4/btrfs degrade badly when ~95% full).
const MIN_FREE_PERCENT = 5;

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * Get current disk stats for the uploads directory's filesystem.
 * @returns {{ total, free, used, percentUsed } | null}
 */
function getStats() {
  try {
    const st = fs.statfsSync(uploadsPath);
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    const used = total - free;
    return {
      total,
      free,
      used,
      percentUsed: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Throw a user-facing error if the filesystem cannot accommodate `neededBytes`
 * with our safety margins. Use this BEFORE starting an operation.
 *
 * @param {number} neededBytes - Estimated peak disk space the operation will use.
 * @param {string} [label='Operation'] - Human-readable name for the error message.
 *
 * @throws {Error} with a descriptive message if disk would be too full.
 */
function ensureSpace(neededBytes, label = 'Operation') {
  if (!Number.isFinite(neededBytes) || neededBytes < 0) return; // unknown size — skip
  const stats = getStats();
  if (!stats) return; // statfs unavailable (Windows dev?) — don't block

  const required = Math.max(neededBytes + ABSOLUTE_MIN_FREE,
    Math.ceil(stats.total * MIN_FREE_PERCENT / 100));

  if (stats.free < required) {
    const shortBy = required - stats.free;
    throw new Error(
      `${label} dibatalkan: disk hampir penuh. ` +
      `Butuh ~${fmtBytes(neededBytes)} (+ ${fmtBytes(ABSOLUTE_MIN_FREE)} buffer), ` +
      `tersedia ${fmtBytes(stats.free)}. ` +
      `Kurang ${fmtBytes(shortBy)}. Hapus video lama atau tambah storage.`
    );
  }
}

/**
 * Non-throwing variant — returns { ok, reason, stats } so callers (e.g. UI
 * indicators on the dashboard) can show a warning without aborting.
 */
function checkSpace(neededBytes) {
  const stats = getStats();
  if (!stats) return { ok: true, stats: null, reason: null };
  if (!Number.isFinite(neededBytes) || neededBytes < 0) {
    return { ok: true, stats, reason: null };
  }
  const required = Math.max(neededBytes + ABSOLUTE_MIN_FREE,
    Math.ceil(stats.total * MIN_FREE_PERCENT / 100));
  if (stats.free < required) {
    return {
      ok: false,
      stats,
      reason: `kurang ${fmtBytes(required - stats.free)} dari yang dibutuhkan`,
    };
  }
  return { ok: true, stats, reason: null };
}

module.exports = {
  getStats,
  ensureSpace,
  checkSpace,
  fmtBytes,
  ABSOLUTE_MIN_FREE,
  MIN_FREE_PERCENT,
};
