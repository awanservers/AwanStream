const express = require('express');
const { db } = require('../db');
const { parseLocalToUTC } = require('../timezone');

const router = express.Router();

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
