// Schedule runner: polls the `schedules` table and auto-starts / auto-stops
// streams at the configured times. Works entirely in UTC; views convert to TZ.
const path = require('path');
const { db } = require('./db');
const streamManager = require('./streamManager');

const POLL_MS = 15 * 1000; // 15 seconds — good balance between accuracy and load
let timer = null;

function tick() {
  const nowIso = new Date().toISOString();

  // Start any pending schedule whose start_at has arrived.
  const toStart = db.prepare(`
    SELECT s.*, st.video_id, st.status AS stream_status
    FROM schedules s
    JOIN streams st ON st.id = s.stream_id
    WHERE s.status = 'pending' AND s.start_at <= ?
  `).all(nowIso);

  for (const sch of toStart) {
    const stream = db.prepare('SELECT * FROM streams WHERE id=?').get(sch.stream_id);
    if (!stream) {
      db.prepare(`UPDATE schedules SET status='error', last_error='stream not found' WHERE id=?`)
        .run(sch.id);
      continue;
    }
    const video = db.prepare('SELECT * FROM videos WHERE id=?').get(stream.video_id);
    if (!video) {
      db.prepare(`UPDATE schedules SET status='error', last_error='video not found' WHERE id=?`)
        .run(sch.id);
      continue;
    }
    if (streamManager.isRunning(stream.id)) {
      // Already running (maybe started manually earlier); just mark schedule started.
      db.prepare(`UPDATE schedules SET status='started' WHERE id=?`).run(sch.id);
      continue;
    }
    try {
      streamManager.startStream(
        stream,
        path.join(__dirname, '..', 'public', 'uploads', video.filename)
      );
      db.prepare(`UPDATE schedules SET status='started', last_error=NULL WHERE id=?`).run(sch.id);
    } catch (e) {
      db.prepare(`UPDATE schedules SET status='error', last_error=? WHERE id=?`)
        .run(e.message, sch.id);
    }
  }

  // Stop any started schedule whose stop_at has passed.
  const toStop = db.prepare(`
    SELECT * FROM schedules
    WHERE status='started' AND stop_at IS NOT NULL AND stop_at <= ?
  `).all(nowIso);

  for (const sch of toStop) {
    try {
      streamManager.stopStream(sch.stream_id);
      db.prepare(`UPDATE schedules SET status='done' WHERE id=?`).run(sch.id);
    } catch (e) {
      db.prepare(`UPDATE schedules SET status='error', last_error=? WHERE id=?`)
        .run(e.message, sch.id);
    }
  }

  // Mark open-ended schedules (no stop_at) as done once their stream has exited on its own.
  db.prepare(`UPDATE schedules SET status='done'
    WHERE status='started' AND stop_at IS NULL
    AND stream_id IN (SELECT id FROM streams WHERE status != 'running')
  `).run();
}

function start() {
  if (timer) return;
  tick(); // immediate first tick
  timer = setInterval(tick, POLL_MS);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

// Any schedule left 'started' when the server was down couldn't have been
// managed correctly — mark them so the operator knows to re-check.
function reconcileOnBoot() {
  db.prepare(`UPDATE schedules SET status='error',
    last_error='server restart during scheduled run'
    WHERE status='started'`).run();
}

module.exports = { start, stop, tick, reconcileOnBoot };
