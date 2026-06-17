const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const playlists = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id) AS item_count,
      (SELECT COALESCE(SUM(v.duration_seconds), 0) FROM playlist_items pi2
        JOIN videos v ON v.id = pi2.video_id WHERE pi2.playlist_id = p.id) AS total_duration
    FROM playlists p ORDER BY p.created_at DESC
  `).all();
  // Fetch up to 4 thumbnails per playlist for the collage.
  const thumbsStmt = db.prepare(`
    SELECT v.id AS video_id, v.thumbnail FROM playlist_items pi
    JOIN videos v ON v.id = pi.video_id
    WHERE pi.playlist_id = ? AND v.thumbnail IS NOT NULL
    ORDER BY pi.position ASC LIMIT 4
  `);
  for (const p of playlists) {
    p.thumbs = thumbsStmt.all(p.id);
  }
  const videos = db.prepare(
    "SELECT id, title, thumbnail, duration_seconds, size_bytes FROM videos WHERE status='ready' ORDER BY title"
  ).all();
  res.render('playlists', {
    playlists, videos,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', (req, res) => {
  const { name, loop_playlist, shuffle } = req.body;
  if (!name || !name.trim()) return res.redirect('/playlists?error=Name+is+required');
  const result = db.prepare('INSERT INTO playlists (name, loop_playlist, shuffle) VALUES (?, ?, ?)')
    .run(name.trim(), loop_playlist ? 1 : 0, shuffle ? 1 : 0);
  const playlistId = result.lastInsertRowid;
  // Optional: add multiple videos at creation time.
  // `video_ids` can be string "1,2,3" or array (form checkbox collects as array).
  let videoIds = req.body.video_ids;
  if (!Array.isArray(videoIds)) videoIds = videoIds ? [videoIds] : [];
  const ids = videoIds.map(Number).filter(n => n > 0);
  if (ids.length > 0) {
    const insertItem = db.prepare(
      'INSERT INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)'
    );
    ids.forEach((vid, idx) => insertItem.run(playlistId, vid, idx + 1));
    return res.redirect('/playlists?notice=Playlist+created+with+' + ids.length + '+videos');
  }
  res.redirect('/playlists?notice=Playlist+created');
});

router.get('/:id', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id);
  if (!playlist) return res.redirect('/playlists?error=Playlist+not+found');
  const items = db.prepare(`
    SELECT pi.id AS item_id, pi.position, v.id AS video_id, v.title,
           v.duration_seconds, v.thumbnail, v.status
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

// JSON state endpoint for Manage modal.
router.get('/:id/state.json', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id=?').get(req.params.id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  const itemIds = db.prepare(
    'SELECT video_id FROM playlist_items WHERE playlist_id=? ORDER BY position ASC'
  ).all(playlist.id).map(r => r.video_id);
  const videos = db.prepare(
    "SELECT id, title, thumbnail, duration_seconds, size_bytes FROM videos WHERE status='ready' ORDER BY title"
  ).all();
  res.json({ playlist, itemIds, videos });
});

// Sync playlist items with submitted list — adds missing, removes extras.
// Preserves order/position of videos that stay.
router.post('/:id/sync', express.json(), (req, res) => {
  const id = Number(req.params.id);
  const playlist = db.prepare('SELECT id FROM playlists WHERE id=?').get(id);
  if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
  const requested = Array.isArray(req.body.video_ids)
    ? req.body.video_ids.map(Number).filter(n => n > 0)
    : [];
  const current = db.prepare(
    'SELECT video_id FROM playlist_items WHERE playlist_id=? ORDER BY position ASC'
  ).all(id).map(r => r.video_id);
  const currentSet = new Set(current);
  const requestedSet = new Set(requested);
  const toRemove = current.filter(v => !requestedSet.has(v));
  const toAdd = requested.filter(v => !currentSet.has(v));
  if (toRemove.length > 0) {
    const placeholders = toRemove.map(() => '?').join(',');
    db.prepare(`DELETE FROM playlist_items WHERE playlist_id=? AND video_id IN (${placeholders})`)
      .run(id, ...toRemove);
  }
  if (toAdd.length > 0) {
    const maxPos = db.prepare(
      'SELECT COALESCE(MAX(position), 0) AS m FROM playlist_items WHERE playlist_id=?'
    ).get(id).m;
    const insertStmt = db.prepare(
      'INSERT INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)'
    );
    toAdd.forEach((vid, idx) => insertStmt.run(id, vid, maxPos + idx + 1));
  }
  res.json({ ok: true, added: toAdd.length, removed: toRemove.length });
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

router.post('/:id/settings', (req, res) => {
  const { name, loop_playlist, shuffle } = req.body;
  const updates = { loop_playlist: loop_playlist ? 1 : 0, shuffle: shuffle ? 1 : 0 };
  if (name && name.trim()) updates.name = name.trim();
  const sets = Object.keys(updates).map(k => `${k}=?`).join(', ');
  const vals = Object.values(updates);
  vals.push(Number(req.params.id));
  db.prepare(`UPDATE playlists SET ${sets} WHERE id=?`).run(...vals);
  const back = req.headers.referer || '/playlists';
  res.redirect(back.includes('?') ? back + '&notice=Settings+saved' : back + '?notice=Settings+saved');
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
  res.redirect(`/playlists/${req.params.id}?notice=Video+moved`);
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
  res.redirect(`/playlists/${req.params.id}?notice=Video+moved`);
});

router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM playlist_items WHERE playlist_id=?').run(req.params.id);
  db.prepare('DELETE FROM playlists WHERE id=?').run(req.params.id);
  res.redirect('/playlists?notice=Playlist+deleted');
});

module.exports = router;
