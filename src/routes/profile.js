// Profile page — read-only personal dashboard. Account management
// (edit username, change password, manage other users) lives at /users
// to keep a single source of truth.
const express = require('express');
const { db } = require('../db');
const youtubeManager = require('../youtubeManager');

const router = express.Router();

router.get('/', (req, res) => {
  const user = db.prepare(`SELECT id, username, created_at, last_login_at, last_login_ip
    FROM users WHERE id=?`).get(req.session.userId);
  if (!user) return res.redirect('/logout');

  // Activity stats — shared across all admins (single-tenant model).
  const stats = {
    videos: db.prepare('SELECT COUNT(*) AS n FROM videos').get().n,
    streamSessions: db.prepare('SELECT COUNT(*) AS n FROM stream_history').get().n,
    streamSeconds: db.prepare(
      'SELECT COALESCE(SUM(duration_seconds), 0) AS s FROM stream_history'
    ).get().s,
    runningStreams: db.prepare(
      "SELECT COUNT(*) AS n FROM streams WHERE status='running'"
    ).get().n,
    storageBytes: db.prepare(
      'SELECT COALESCE(SUM(size_bytes), 0) AS s FROM videos'
    ).get().s,
  };

  // Linked YouTube account (if any).
  let youtube = { connected: false };
  try {
    const acc = youtubeManager.getAccount();
    if (acc) {
      youtube = {
        connected: true,
        channelTitle: acc.channel_title,
        channelId: acc.channel_id,
        connectedAt: acc.created_at,
      };
    }
  } catch (_) {}

  res.render('profile', {
    user,
    stats,
    youtube,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Backward-compat: any old form/link posting to /profile or
// /profile/password is forwarded to the canonical /users/me handlers.
router.post('/', (req, res, next) => {
  req.url = '/me';
  res.redirect(307, '/users/me');
});
router.post('/password', (req, res) => {
  res.redirect(307, '/users/me/password');
});

module.exports = router;
