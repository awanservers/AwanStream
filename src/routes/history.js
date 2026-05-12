const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const history = db.prepare(`
    SELECT * FROM stream_history
    ORDER BY stopped_at DESC
    LIMIT 100
  `).all();
  res.render('history', {
    history,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM stream_history WHERE id=?').run(Number(req.params.id));
  res.redirect('/history?notice=Entry+deleted');
});

router.post('/clear', (req, res) => {
  db.prepare('DELETE FROM stream_history').run();
  res.redirect('/history?notice=History+cleared');
});

module.exports = router;
