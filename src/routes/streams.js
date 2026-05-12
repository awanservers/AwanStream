const express = require('express');
const path = require('path');
const { db } = require('../db');
const streamManager = require('../streamManager');
const transcoder = require('../transcoder');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');

const PRESETS = {
  youtube:  { label: 'YouTube',  url: 'rtmp://x.rtmp.youtube.com/live2' },
  facebook: { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  twitch:   { label: 'Twitch',   url: 'rtmp://live.twitch.tv/app' },
  custom:   { label: 'Custom',   url: '' },
};

router.get('/', (req, res) => {
  res.redirect('/streams/single');
});

router.get('/single', (req, res) => {
  const streams = db.prepare(`
    SELECT s.*, v.title AS video_title
    FROM streams s
    LEFT JOIN videos v ON v.id = s.video_id
    WHERE s.playlist_id IS NULL
    ORDER BY s.created_at DESC
  `).all();
  const videos = db.prepare("SELECT id, title FROM videos WHERE status='ready' ORDER BY title").all();
  res.render('streams-single', {
    streams, videos, presets: PRESETS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/playlist', (req, res) => {
  const streams = db.prepare(`
    SELECT s.*, v.title AS video_title, p.name AS playlist_name
    FROM streams s
    LEFT JOIN videos v ON v.id = s.video_id
    LEFT JOIN playlists p ON p.id = s.playlist_id
    WHERE s.playlist_id IS NOT NULL
    ORDER BY s.created_at DESC
  `).all();
  const playlists = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id=p.id) AS item_count
    FROM playlists p ORDER BY p.name
  `).all();
  res.render('streams-playlist', {
    streams, playlists, presets: PRESETS,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', (req, res) => {
  const { name, video_id, playlist_id, platform, rtmp_url, stream_key, loop_video,
          re_encode, video_bitrate, keyframe_interval, preset } = req.body;
  if (!name || !rtmp_url || !stream_key) {
    const back = playlist_id ? '/streams/playlist' : '/streams/single';
    return res.redirect(back + '?error=All+fields+are+required');
  }
  const vid = Number(video_id) || null;
  const plid = Number(playlist_id) || null;
  if (!vid && !plid) {
    return res.redirect('/streams/single?error=Select+a+video+or+playlist');
  }
  let effectiveVideoId = vid;
  if (plid && !vid) {
    const first = db.prepare(`SELECT video_id FROM playlist_items
      WHERE playlist_id=? ORDER BY position ASC LIMIT 1`).get(plid);
    if (!first) return res.redirect('/streams/playlist?error=Playlist+is+empty');
    effectiveVideoId = first.video_id;
  }
  db.prepare(`INSERT INTO streams
    (name, video_id, playlist_id, platform, rtmp_url, stream_key, loop_video,
     re_encode, video_bitrate, keyframe_interval, preset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name.trim(),
    effectiveVideoId,
    plid,
    (platform || 'custom').trim(),
    rtmp_url.trim(),
    stream_key.trim(),
    loop_video ? 1 : 0,
    re_encode === '1' ? 1 : 0,
    (video_bitrate || '4500k').trim(),
    Math.max(1, Math.min(10, Number(keyframe_interval) || 2)),
    (preset || 'veryfast').trim(),
  );
  const back = plid ? '/streams/playlist' : '/streams/single';
  res.redirect(back + '?notice=Stream+created');
});

router.post('/:id/start', (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id=?').get(req.params.id);
  const back = stream && stream.playlist_id ? '/streams/playlist' : '/streams/single';
  if (!stream) return res.redirect(back + '?error=Stream+not+found');
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(stream.video_id);
  if (!video) return res.redirect(back + '?error=Video+missing');

  // Codec validation — only for Copy mode (re_encode=0). Re-encode mode will
  // transcode anyway so codec doesn't matter.
  if (!stream.re_encode) {
    const videoPath = path.join(uploadDir, video.filename);
    const check = transcoder.validateCodec(videoPath);
    if (!check.ok) {
      const msg = check.issues.join(' ');
      return res.redirect(back + '?error=' + encodeURIComponent(msg));
    }
  }

  try {
    streamManager.startStream(stream, path.join(uploadDir, video.filename));
    res.redirect(back + '?notice=Stream+started');
  } catch (e) {
    res.redirect(back + '?error=' + encodeURIComponent(e.message));
  }
});

router.post('/:id/stop', (req, res) => {
  const stream = db.prepare('SELECT playlist_id FROM streams WHERE id=?').get(req.params.id);
  const back = stream && stream.playlist_id ? '/streams/playlist' : '/streams/single';
  streamManager.stopStream(Number(req.params.id));
  res.redirect(back + '?notice=Stream+stopped');
});

router.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const stream = db.prepare('SELECT playlist_id FROM streams WHERE id=?').get(id);
  const back = stream && stream.playlist_id ? '/streams/playlist' : '/streams/single';
  if (streamManager.isRunning(id)) streamManager.stopStream(id);
  db.prepare('DELETE FROM streams WHERE id=?').run(id);
  res.redirect(back + '?notice=Stream+deleted');
});

router.post('/:id/edit', (req, res) => {
  const id = Number(req.params.id);
  const stream = db.prepare('SELECT * FROM streams WHERE id=?').get(id);
  if (!stream) return res.redirect('/streams/single?error=Stream+not+found');
  const back = stream.playlist_id ? '/streams/playlist' : '/streams/single';
  if (streamManager.isRunning(id)) {
    return res.redirect(back + '?error=Stop+stream+first+before+editing');
  }
  const { name, video_id, playlist_id, platform, rtmp_url, stream_key, loop_video,
          re_encode, video_bitrate, keyframe_interval, preset } = req.body;
  if (!name || !rtmp_url || !stream_key) {
    return res.redirect(back + '?error=All+fields+are+required');
  }
  const vid = Number(video_id) || null;
  const plid = Number(playlist_id) || null;
  let effectiveVideoId = vid;
  if (plid && !vid) {
    const first = db.prepare(`SELECT video_id FROM playlist_items
      WHERE playlist_id=? ORDER BY position ASC LIMIT 1`).get(plid);
    if (first) effectiveVideoId = first.video_id;
  }
  db.prepare(`UPDATE streams SET
    name=?, video_id=?, playlist_id=?, platform=?, rtmp_url=?, stream_key=?,
    loop_video=?, re_encode=?, video_bitrate=?, keyframe_interval=?, preset=?
    WHERE id=?`).run(
    name.trim(),
    effectiveVideoId,
    plid,
    (platform || 'custom').trim(),
    rtmp_url.trim(),
    stream_key.trim(),
    loop_video ? 1 : 0,
    re_encode === '1' ? 1 : 0,
    (video_bitrate || '4500k').trim(),
    Math.max(1, Math.min(10, Number(keyframe_interval) || 2)),
    (preset || 'veryfast').trim(),
    id,
  );
  res.redirect(back + '?notice=Stream+updated');
});

router.get('/:id/log', (req, res) => {
  const lines = Math.max(10, Math.min(500, Number(req.query.lines) || 80));
  res.type('text/plain').send(streamManager.tailLog(Number(req.params.id), lines));
});

module.exports = router;
