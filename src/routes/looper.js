const express = require('express');
const { db } = require('../db');
const looper = require('../looper');
const audioManager = require('../audioManager');
const diskCheck = require('../diskCheck');
const youtubeManager = require('../youtubeManager');
const youtubeUploader = require('../youtubeUploader');

const router = express.Router();

// Preset target durations in seconds, displayed on the form.
const PRESETS = [
  { key: '30m',  label: '30 menit', seconds: 30 * 60 },
  { key: '1h',   label: '1 jam',     seconds: 1 * 3600 },
  { key: '3h',   label: '3 jam',    seconds: 3 * 3600 },
  { key: '10h',  label: '10 jam',   seconds: 10 * 3600 },
];

router.get('/', (req, res) => {
  // Eligible source videos: must be status = 'ready' and loop_job_id IS NULL (main library only)
  const videos = db.prepare(`
    SELECT id, title, filename, duration_seconds, src_width, src_height,
           size_bytes, thumbnail, status, folder_id, created_at
    FROM videos
    WHERE status = 'ready'
      AND loop_job_id IS NULL
      AND duration_seconds IS NOT NULL
      AND duration_seconds > 0
    ORDER BY created_at DESC
  `).all();

  // Paginate completed loop videos
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 20;
  const offset = (page - 1) * perPage;

  const totalCount = db.prepare('SELECT COUNT(*) AS c FROM videos WHERE loop_job_id IS NOT NULL').get().c;
  const loopedVideos = db.prepare(
    'SELECT * FROM videos WHERE loop_job_id IS NOT NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(perPage, offset);

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  const folders = db.prepare('SELECT * FROM folders ORDER BY name ASC').all();
  const youtubeConnected = !!youtubeManager.getAccount();

  // Annotate each loop video with its latest YouTube upload state (if any).
  const activeJobsYt = youtubeUploader.listJobs();
  const activeByVideoId = new Map();
  activeJobsYt.forEach((j) => {
    if (j.status === 'pending' || j.status === 'uploading') {
      activeByVideoId.set(j.videoId, j);
    }
  });

  loopedVideos.forEach((v) => {
    const active = activeByVideoId.get(v.id);
    if (active) {
      v.youtube_status = active.status;
      v.youtube_percent = active.percent;
      v.youtube_job_id = active.jobId;
      v.youtube_video_id = null;
    } else {
      const last = youtubeUploader.getLatestUploadForVideo(v.id);
      if (last) {
        v.youtube_status = last.status;
        v.youtube_percent = last.percent;
        v.youtube_video_id = last.youtube_video_id;
        v.youtube_last_error = last.last_error;
        v.youtube_interrupted = last.status === 'error' &&
          last.last_error && /interrupted by server restart/i.test(last.last_error);
      }
    }
  });

  const activeJobs = looper.listJobs().map((j) => {
    const src = db.prepare('SELECT title FROM videos WHERE id=?').get(j.sourceVideoId);
    const out = db.prepare('SELECT title FROM videos WHERE id=?').get(j.outputVideoId);
    return {
      ...j,
      sourceTitle: src ? src.title : '(deleted)',
      outputTitle: out ? out.title : '(deleted)',
    };
  });

  // Recent loop errors (videos created by looper that ended in error).
  const recentErrors = db.prepare(`
    SELECT id, title, status, last_error, loop_job_id, created_at
    FROM videos
    WHERE loop_job_id IS NOT NULL AND status = 'error'
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const audioTracks = audioManager.listReady();

  res.render('looper', {
    title: 'Loop',
    activeNav: 'looper',
    videos,
    presets: PRESETS,
    loopedVideos,
    folders,
    youtubeConnected,
    page,
    perPage,
    totalPages,
    totalCount,
    activeJobs,
    recentErrors,
    audioTracks,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/start', (req, res) => {
  const sourceVideoId = Number(req.body.source_video_id);
  const targetPreset = req.body.target_preset;
  const customMinutes = Number(req.body.custom_minutes);
  const customTitle = (req.body.title || '').trim() || null;
  // Checkbox: absent (unchecked) = fast mode, present = smooth mode. Default smooth.
  const smooth = req.body.smooth === undefined ? true : req.body.smooth === 'on' || req.body.smooth === '1' || req.body.smooth === 'true';
  // Crossfade duration (smooth mode). Default 1.5s, clamped to safe range.
  // Recommended 0.5-3.0s. Less than 0.5 too short to hide boundary; more than
  // 3.0 eats too much content for 8-12s source clips.
  let crossfadeSeconds = parseFloat(req.body.crossfade_seconds);
  if (!Number.isFinite(crossfadeSeconds) || crossfadeSeconds <= 0) crossfadeSeconds = 1.5;
  crossfadeSeconds = Math.max(0.3, Math.min(3.0, crossfadeSeconds));

  // Optional audio overlay.
  const audioId = Number(req.body.audio_id) || null;
  const audioVolume = parseFloat(req.body.audio_volume);
  const audioMode = (req.body.audio_mode === 'replace') ? 'replace' : 'mix';

  if (!sourceVideoId) {
    return res.redirect('/looper?error=' + encodeURIComponent('Pilih video sumber dulu.'));
  }

  let targetSeconds;
  if (targetPreset === 'custom') {
    if (!Number.isFinite(customMinutes) || customMinutes <= 0) {
      return res.redirect('/looper?error=' + encodeURIComponent('Custom duration harus angka menit > 0.'));
    }
    targetSeconds = Math.round(customMinutes * 60);
  } else {
    const preset = PRESETS.find((p) => p.key === targetPreset);
    if (!preset) {
      return res.redirect('/looper?error=' + encodeURIComponent('Preset tidak valid.'));
    }
    targetSeconds = preset.seconds;
  }

  try {
    // Disk pre-check: estimate output size from source bitrate × target seconds.
    // Looper writes the full output file before completing, so peak usage =
    // estimated output size. For smooth mode, transient unit file adds another
    // ~source size during phase 1, but it's deleted before phase 2 finalizes —
    // we still budget for it via the +20% margin.
    const src = db.prepare(
      'SELECT size_bytes, duration_seconds FROM videos WHERE id=?'
    ).get(sourceVideoId);
    if (src && src.size_bytes && src.duration_seconds && src.duration_seconds > 0) {
      const bytesPerSec = Number(src.size_bytes) / Number(src.duration_seconds);
      const estimated = Math.ceil(bytesPerSec * targetSeconds * 1.2);
      try { diskCheck.ensureSpace(estimated, 'Loop'); }
      catch (e) {
        return res.redirect('/looper?error=' + encodeURIComponent(e.message));
      }
    }
    const { jobId, mode } = looper.start(sourceVideoId, targetSeconds, customTitle, {
      smooth,
      crossfadeSeconds,
      audioId,
      audioVolume: Number.isFinite(audioVolume) ? audioVolume : 0.3,
      audioMode,
    });
    const modeLabel = mode === 'smooth' ? 'Smooth mode (seamless crossfade)' : 'Fast mode';
    const audioLabel = audioId ? ` + audio overlay (${audioMode})` : '';
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.json({ ok: true, jobId });
    }
    return res.redirect('/looper?notice=' + encodeURIComponent(
      `${modeLabel}${audioLabel} — job #${jobId} started. Video baru akan muncul di menu Looping setelah selesai.`
    ));
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(400).json({ error: err.message });
    }
    return res.redirect('/looper?error=' + encodeURIComponent(err.message));
  }
});

// JSON progress endpoint for live polling from the page.
router.get('/progress', (req, res) => {
  const jobs = looper.listJobs().map((j) => {
    const src = db.prepare('SELECT title FROM videos WHERE id=?').get(j.sourceVideoId);
    const out = db.prepare('SELECT title, status FROM videos WHERE id=?').get(j.outputVideoId);
    const elapsed = Math.max(0, Math.round((Date.now() - j.startedAt) / 1000));
    // Rough ETA: assume constant speed. progress.speed is ffmpeg speed factor
    // (how many output-seconds produced per real second).
    let etaSec = null;
    if (j.progress.speed && j.progress.speed > 0 && j.target && j.progress.time) {
      const remaining = Math.max(0, j.target - j.progress.time);
      etaSec = Math.round(remaining / j.progress.speed);
    }
    return {
      jobId: j.jobId,
      mode: j.mode,
      sourceVideoId: j.sourceVideoId,
      sourceTitle: src ? src.title : '(deleted)',
      outputVideoId: j.outputVideoId,
      outputTitle: out ? out.title : '(deleted)',
      outputStatus: out ? out.status : null,
      targetSeconds: j.target,
      percent: j.progress.percent,
      phase: j.progress.phase,
      phaseLabel: j.progress.phaseLabel,
      elapsedSec: elapsed,
      speed: j.progress.speed,
      etaSec,
    };
  });
  res.json({ jobs });
});

router.post('/:jobId/cancel', (req, res) => {
  const ok = looper.cancel(req.params.jobId);
  if (!ok) {
    if (req.xhr || req.headers.accept?.includes('json')) {
      return res.status(404).json({ error: 'Job tidak ditemukan atau sudah selesai.' });
    }
    return res.redirect('/looper?error=' + encodeURIComponent('Job tidak ditemukan atau sudah selesai.'));
  }
  if (req.xhr || req.headers.accept?.includes('json')) {
    return res.json({ ok: true });
  }
  return res.redirect('/looper?notice=' + encodeURIComponent('Loop job cancelled.'));
});

// View log for an active or completed loop job.
router.get('/:jobId/log', (req, res) => {
  const log = looper.tailLog(req.params.jobId, 200);
  if (!log) {
    return res.status(404).type('text/plain').send('Log not found for job ' + req.params.jobId);
  }
  res.type('text/plain').send(log);
});

// View log by video ID (for completed jobs where jobId is stored in DB).
router.get('/video/:videoId/log', (req, res) => {
  const video = db.prepare('SELECT loop_job_id FROM videos WHERE id=?').get(Number(req.params.videoId));
  if (!video || !video.loop_job_id) {
    return res.status(404).type('text/plain').send('No loop log found for this video.');
  }
  const log = looper.tailLog(video.loop_job_id, 200);
  if (!log) {
    return res.status(404).type('text/plain').send('Log file not found (logs/loop-' + video.loop_job_id + '.log).');
  }
  res.type('text/plain').send(log);
});

module.exports = router;
