const express = require('express');
const path = require('path');
const fs = require('fs');
const { db } = require('../db');
const streamManager = require('../streamManager');
const transcoder = require('../transcoder');
const audioManager = require('../audioManager');
const { parseLocalToUTC } = require('../timezone');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');

const PRESETS = {
  youtube:  { label: 'YouTube',  url: 'rtmp://x.rtmp.youtube.com/live2' },
  facebook: { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  twitch:   { label: 'Twitch',   url: 'rtmp://live.twitch.tv/app' },
  custom:   { label: 'Custom',   url: '' },
};

function parseScheduleInput(body) {
  if (body.schedule_enabled !== '1') {
    return { enabled: false };
  }

  const { start_at, stop_at } = body;
  if (!start_at) {
    return { enabled: true, error: 'Start+time+is+required+when+scheduling' };
  }

  const tz = process.env.TZ || 'Asia/Jakarta';
  const startIso = parseLocalToUTC(start_at, tz);
  if (!startIso) {
    return { enabled: true, error: 'Invalid+start+time' };
  }

  const stopIso = stop_at ? parseLocalToUTC(stop_at, tz) : null;
  if (stopIso && stopIso <= startIso) {
    return { enabled: true, error: 'Stop+time+must+be+after+start+time' };
  }

  return { enabled: true, startIso, stopIso };
}

function insertSchedule(streamId, schedule) {
  if (!schedule || !schedule.enabled) return false;
  db.prepare(`INSERT INTO schedules (stream_id, start_at, stop_at, status)
    VALUES (?, ?, ?, 'pending')`).run(streamId, schedule.startIso, schedule.stopIso);
  return true;
}

router.get('/', (req, res) => {
  res.redirect('/streams/single');
});

router.get('/single', (req, res) => {
  const streams = db.prepare(`
    SELECT s.*, v.title AS video_title, at.title AS audio_title,
           (SELECT sc.start_at FROM schedules sc
            WHERE sc.stream_id=s.id AND sc.status='pending'
            ORDER BY sc.start_at ASC LIMIT 1) AS next_start_at,
           (SELECT sc.stop_at FROM schedules sc
            WHERE sc.stream_id=s.id AND sc.status='pending'
            ORDER BY sc.start_at ASC LIMIT 1) AS next_stop_at
    FROM streams s
    LEFT JOIN videos v ON v.id = s.video_id
    LEFT JOIN audio_tracks at ON at.id = s.audio_id
    WHERE s.playlist_id IS NULL
    ORDER BY s.created_at DESC
  `).all();
  const videos = db.prepare("SELECT id, title, thumbnail FROM videos WHERE status='ready' ORDER BY title").all();
  const audioFiles = audioManager.listReady();
  res.render('streams-single', {
    streams, videos, audioFiles, presets: PRESETS,
    tzLabel: process.env.TZ_LABEL || 'WIB',
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.get('/playlist', (req, res) => {
  const streams = db.prepare(`
    SELECT s.*, v.title AS video_title, p.name AS playlist_name, at.title AS audio_title,
           (SELECT sc.start_at FROM schedules sc
            WHERE sc.stream_id=s.id AND sc.status='pending'
            ORDER BY sc.start_at ASC LIMIT 1) AS next_start_at,
           (SELECT sc.stop_at FROM schedules sc
            WHERE sc.stream_id=s.id AND sc.status='pending'
            ORDER BY sc.start_at ASC LIMIT 1) AS next_stop_at
    FROM streams s
    LEFT JOIN videos v ON v.id = s.video_id
    LEFT JOIN playlists p ON p.id = s.playlist_id
    LEFT JOIN audio_tracks at ON at.id = s.audio_id
    WHERE s.playlist_id IS NOT NULL
    ORDER BY s.created_at DESC
  `).all();
  const playlists = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id=p.id) AS item_count
    FROM playlists p ORDER BY p.name
  `).all();
  const audioFiles = audioManager.listReady();
  res.render('streams-playlist', {
    streams, playlists, audioFiles, presets: PRESETS,
    tzLabel: process.env.TZ_LABEL || 'WIB',
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/', (req, res) => {
  const { name, video_id, playlist_id, platform, rtmp_url, stream_key, loop_video,
          re_encode, video_bitrate, keyframe_interval, preset, audio_id, audio_volume, audio_mode } = req.body;
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
  const audioId = Number(audio_id) || null;
  const vol = parseFloat(audio_volume);
  const safeVol = (Number.isFinite(vol) && vol >= 0 && vol <= 10) ? String(vol) : '0.3';
  const safeMode = (audio_mode === 'replace') ? 'replace' : 'mix';
  const schedule = parseScheduleInput(req.body);
  const back = plid ? '/streams/playlist' : '/streams/single';
  if (schedule.error) {
    return res.redirect(back + '?error=' + schedule.error);
  }
  const insert = db.prepare(`INSERT INTO streams
    (name, video_id, playlist_id, platform, rtmp_url, stream_key, loop_video,
     re_encode, video_bitrate, keyframe_interval, preset, audio_id, audio_volume, audio_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
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
    audioId,
    safeVol,
    safeMode,
  );
  const scheduleCreated = insertSchedule(Number(insert.lastInsertRowid), schedule);
  const notice = scheduleCreated ? 'Stream+created+and+scheduled' : 'Stream+created';
  res.redirect(back + '?notice=' + notice);
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
    // Resolve audio overlay path if configured.
    let audioPath = null;
    if (stream.audio_id) {
      audioPath = audioManager.getFilePath(stream.audio_id);
    }
    streamManager.startStream(stream, path.join(uploadDir, video.filename), audioPath);
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

router.post('/:id/schedule', (req, res) => {
  const stream = db.prepare('SELECT id, name, playlist_id FROM streams WHERE id=?').get(req.params.id);
  const back = stream && stream.playlist_id ? '/streams/playlist' : '/streams/single';
  if (!stream) return res.redirect(back + '?error=Stream+not+found');

  const { start_at, stop_at } = req.body;
  if (!start_at) {
    return res.redirect(back + '?error=Start+time+is+required');
  }

  const tz = process.env.TZ || 'Asia/Jakarta';
  const startIso = parseLocalToUTC(start_at, tz);
  if (!startIso) {
    return res.redirect(back + '?error=Invalid+start+time');
  }

  const stopIso = stop_at ? parseLocalToUTC(stop_at, tz) : null;
  if (stopIso && stopIso <= startIso) {
    return res.redirect(back + '?error=Stop+time+must+be+after+start+time');
  }

  db.prepare(`INSERT INTO schedules (stream_id, start_at, stop_at, status)
    VALUES (?, ?, ?, 'pending')`).run(stream.id, startIso, stopIso);

  res.redirect(back + '?notice=' + encodeURIComponent('Schedule created for ' + stream.name));
});

router.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const stream = db.prepare('SELECT playlist_id FROM streams WHERE id=?').get(id);
  const back = stream && stream.playlist_id ? '/streams/playlist' : '/streams/single';
  if (streamManager.isRunning(id)) streamManager.stopStream(id);
  db.prepare('DELETE FROM streams WHERE id=?').run(id);
  // Cleanup log files for this stream.
  const logPath = path.join(__dirname, '..', 'logs', `stream-${id}.log`);
  try { fs.unlinkSync(logPath); } catch (_) {}
  try { fs.unlinkSync(logPath + '.old'); } catch (_) {}
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
          re_encode, video_bitrate, keyframe_interval, preset, audio_id, audio_volume, audio_mode } = req.body;
  if (!name || !rtmp_url) {
    return res.redirect(back + '?error=All+fields+are+required');
  }
  const nextStreamKey = String(stream_key || '').trim() || stream.stream_key;
  const vid = Number(video_id) || null;
  const plid = Number(playlist_id) || null;
  let effectiveVideoId = vid;
  if (plid && !vid) {
    const first = db.prepare(`SELECT video_id FROM playlist_items
      WHERE playlist_id=? ORDER BY position ASC LIMIT 1`).get(plid);
    if (first) effectiveVideoId = first.video_id;
  }
  const audioId = Number(audio_id) || null;
  const vol = parseFloat(audio_volume);
  const safeVol = (Number.isFinite(vol) && vol >= 0 && vol <= 10) ? String(vol) : '0.3';
  const safeMode = (audio_mode === 'replace') ? 'replace' : 'mix';
  db.prepare(`UPDATE streams SET
    name=?, video_id=?, playlist_id=?, platform=?, rtmp_url=?, stream_key=?,
    loop_video=?, re_encode=?, video_bitrate=?, keyframe_interval=?, preset=?,
    audio_id=?, audio_volume=?, audio_mode=?
    WHERE id=?`).run(
    name.trim(),
    effectiveVideoId,
    plid,
    (platform || 'custom').trim(),
    rtmp_url.trim(),
    nextStreamKey,
    loop_video ? 1 : 0,
    re_encode === '1' ? 1 : 0,
    (video_bitrate || '4500k').trim(),
    Math.max(1, Math.min(10, Number(keyframe_interval) || 2)),
    (preset || 'veryfast').trim(),
    audioId,
    safeVol,
    safeMode,
    id,
  );

  const schedule = parseScheduleInput(req.body);
  if (schedule.error) {
    return res.redirect(back + '?error=' + schedule.error);
  }
  const pending = db.prepare("SELECT id FROM schedules WHERE stream_id=? AND status='pending'").get(id);
  if (schedule.enabled) {
    if (pending) {
      db.prepare("UPDATE schedules SET start_at=?, stop_at=? WHERE id=?")
        .run(schedule.startIso, schedule.stopIso, pending.id);
    } else {
      db.prepare("INSERT INTO schedules (stream_id, start_at, stop_at, status) VALUES (?, ?, ?, 'pending')")
        .run(id, schedule.startIso, schedule.stopIso);
    }
  } else {
    db.prepare("DELETE FROM schedules WHERE stream_id=? AND status='pending'").run(id);
  }
  res.redirect(back + '?notice=Stream+updated');
});

router.get('/:id/log', (req, res) => {
  const lines = Math.max(10, Math.min(500, Number(req.query.lines) || 80));
  res.type('text/plain').send(streamManager.tailLog(Number(req.params.id), lines));
});

module.exports = router;
