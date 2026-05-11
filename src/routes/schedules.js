const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Parse a "YYYY-MM-DDTHH:MM" value from <input type="datetime-local"> into a
// UTC ISO string, interpreting the local time in the given IANA timezone.
function parseLocalToUTC(localStr, tz) {
  if (!localStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(localStr);
  if (!m) return null;
  const [, Y, Mo, D, H, Mi, S] = m.map((v, i) => (i === 0 ? v : Number(v)));
  // Strategy: build a UTC Date from the pieces, compute the offset that the
  // target timezone was at that moment, and subtract it. One iteration is
  // enough across DST boundaries because we snap to the target zone's offset.
  const guessUTC = Date.UTC(Y, Mo - 1, D, H, Mi, S || 0);
  const tzDate = new Date(guessUTC);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(tzDate).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asIfUTC = Date.UTC(parts.year, parts.month - 1, parts.day,
    parts.hour, parts.minute, parts.second);
  const offset = asIfUTC - guessUTC; // tz offset in ms
  return new Date(guessUTC - offset).toISOString();
}

router.get('/', (req, res) => {
  const schedules = db.prepare(`
    SELECT sc.*, s.name AS stream_name, v.title AS video_title
    FROM schedules sc
    JOIN streams s ON s.id = sc.stream_id
    LEFT JOIN videos v ON v.id = s.video_id
    ORDER BY sc.start_at DESC
  `).all();
  const streams = db.prepare(`SELECT id, name FROM streams ORDER BY name`).all();
  res.render('schedules', {
    schedules, streams,
    tzLabel: process.env.TZ_LABEL || 'WIB',
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', (req, res) => {
  const { stream_id, start_at, stop_at } = req.body;
  if (!stream_id || !start_at) {
    return res.redirect('/schedules?error=Stream+and+start+time+are+required');
  }
  const tz = process.env.TZ || 'Asia/Jakarta';
  const startIso = parseLocalToUTC(start_at, tz);
  if (!startIso) {
    return res.redirect('/schedules?error=Invalid+start+time');
  }
  const stopIso = stop_at ? parseLocalToUTC(stop_at, tz) : null;
  if (stopIso && stopIso <= startIso) {
    return res.redirect('/schedules?error=Stop+time+must+be+after+start+time');
  }
  db.prepare(`INSERT INTO schedules (stream_id, start_at, stop_at, status)
    VALUES (?, ?, ?, 'pending')`).run(Number(stream_id), startIso, stopIso);
  res.redirect('/schedules?notice=Schedule+created');
});

router.post('/:id/cancel', (req, res) => {
  db.prepare(`UPDATE schedules SET status='cancelled'
    WHERE id=? AND status='pending'`).run(req.params.id);
  res.redirect('/schedules?notice=Schedule+cancelled');
});

router.post('/:id/delete', (req, res) => {
  db.prepare(`DELETE FROM schedules WHERE id=?`).run(req.params.id);
  res.redirect('/schedules?notice=Schedule+deleted');
});

module.exports = router;
