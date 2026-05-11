const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const playlists = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count
    FROM playlists p ORDER BY p.created_at DESC
  `).all();
  const videos = db.prepare("SELECT id, title FROM videos WHERE status='ready' ORDER BY title").all();
  res.render('playlists', {
    playlists, videos,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', (req, res) => {
  const { name, loop_playlist } = req.body;
  if (!name || !name.trim()) return res.redirect('/playlists?error=Name+is+required');
  db.prepare('INSERT INTO playlists (name, loop_playlist) VALUES (?, ?)')
    .run(name.trim(), loop_playlist ? 1 : 0);
  res.redirect('/playlists?notice=Playlist+created');
});

router.get('/:id', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id);
  if (!playlist) return res.redirect('/playlists?error=Playlist+not+found');
  const items = db.prepare(`
    SELECT pi.id AS item_id, pi.position, v.id AS video_id, v.title, v.duration_seconds
    FROM playlist_items pi JOIN videos v ON v.id = pi.video_id
    WHERE pi.playlist_id = ? ORDER BY pi.position ASC
  `).all(playlist.id);
  const videos = db.prepare("SELECT id, title FROM videos WHERE status='ready' ORDER BY title").all();
  res.render('playlist-detail', {
    playlist, items, videos,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/:id/add-video', (req, res) => {
  const { video_id } = req.body;
  if (!video_id) return res.redirect(`/playlists/${req.params.id}?error=Select+a+video`);
  const maxPos = db.prepare('SELECT MAX(position) AS m FROM playlist_items WHERE playlist_id=?')
    .get(req.params.id).m || 0;
  db.prepare('INSERT INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)')
    .run(Number(req.params.id), Number(video_id), maxPos + 1);
  res.redirect(`/playlists/${req.params.id}?notice=Video+added`);
});

router.post('/:id/remove-item/:itemId', (req, res) => {
  db.prepare('DELETE FROM playlist_items WHERE id=? AND playlist_id=?')
    .run(req.params.itemId, req.params.id);
  res.redirect(`/playlists/${req.params.id}?notice=Video+removed`);
});

router.post('/:id/move-up/:itemId', (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id=?').get(req.params.itemId);
  if (item && item.position > 1) {
    const above = db.prepare('SELECT * FROM playlist_items WHERE playlist_id=? AND position=?')
      .get(item.playlist_id, item.position - 1);
    if (above) {
      db.prepare('UPDATE playlist_items SET position=? WHERE id=?').run(item.position, above.id);
      db.prepare('UPDATE playlist_items SET position=? WHERE id=?').run(item.position - 1, item.id);
    }
  }
  res.redirect(`/playlists/${req.params.id}`);
});

router.post('/:id/move-down/:itemId', (req, res) => {
  const item = db.prepare('SELECT * FROM playlist_items WHERE id=?').get(req.params.itemId);
  if (item) {
    const below = db.prepare('SELECT * FROM playlist_items WHERE playlist_id=? AND position=?')
      .get(item.playlist_id, item.position + 1);
    if (below) {
      db.prepare('UPDATE playlist_items SET position=? WHERE id=?').run(item.position, below.id);
      db.prepare('UPDATE playlist_items SET position=? WHERE id=?').run(item.position + 1, item.id);
    }
  }
  res.redirect(`/playlists/${req.params.id}`);
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(req.params.id);
  db.prepare('DELETE FROM playlists WHERE id=?').run(req.params.id);
  res.redirect('/playlists?notice=Playlist+deleted');
});

module.exports = router;
