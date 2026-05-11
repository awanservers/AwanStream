const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const transcoder = require('../transcoder');
const downloader = require('../downloader');

const router = express.Router();
const uploadDir = path.join(__dirname, '..', '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5 GB
  fileFilter: (_req, file, cb) => {
    if (!/\.(mp4|mkv|mov|flv|ts|webm)$/i.test(file.originalname)) {
      return cb(new Error('Unsupported video format'));
    }
    cb(null, true);
  },
});

router.get('/', (req, res) => {
  const videos = db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all();
  res.render('videos', {
    videos,
    presets: transcoder.presets(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) return res.redirect('/videos?error=' + encodeURIComponent(err.message));
    if (!req.file) return res.redirect('/videos?error=No+file+uploaded');
    const rawTitle = (req.body.title || req.file.originalname).trim();
    const title = uniqueTitle(rawTitle);
    const uploadedPath = path.join(uploadDir, req.file.filename);
    const info = transcoder.probeVideoInfo(uploadedPath);
    db.prepare(`INSERT INTO videos
      (title, filename, size_bytes, status, duration_seconds, src_width, src_height, src_fps)
      VALUES (?, ?, ?, 'uploaded', ?, ?, ?, ?)`)
      .run(title, req.file.filename, req.file.size,
        info.duration, info.width, info.height, info.fps);
    res.redirect('/videos?notice=Upload+complete.+Use+Prepare+to+make+it+stream-ready.');
  });
});

// Ensure the title is unique by appending " (2)", " (3)", ... if needed.
function uniqueTitle(base) {
  const exists = (t) => db.prepare('SELECT 1 FROM videos WHERE title=?').get(t);
  if (!exists(base)) return base;
  // Strip any existing " (N)" suffix so we don't append on top of one.
  const stripped = base.replace(/\s*\(\d+\)\s*$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stripped} (${i})`;
    if (!exists(candidate)) return candidate;
  }
  return `${stripped} (${Date.now()})`;
}

router.get('/:id/progress', (req, res) => {
  const id = Number(req.params.id);
  const video = db.prepare('SELECT id, status, last_error, duration_seconds FROM videos WHERE id=?').get(id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  const progress = transcoder.getProgress(id);
  res.json({
    status: video.status,
    last_error: video.last_error,
    duration: video.duration_seconds,
    running: Boolean(progress),
    percent: progress ? progress.percent : (video.status === 'ready' ? 100 : null),
    time: progress ? progress.time : null,
    speed: progress ? progress.speed : null,
    fps: progress ? progress.fps : null,
  });
});

// Unified status endpoint used by the transcode detail modal. Combines the
// per-job progress snapshot with a log tail so the modal only needs one poll
// per interval.
router.get('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const video = db.prepare(`SELECT id, title, status, last_error, duration_seconds,
    src_width, src_height, src_fps FROM videos WHERE id=?`).get(id);
  if (!video) return res.status(404).json({ error: 'not_found' });
  const progress = transcoder.getProgress(id);
  // Estimate remaining seconds when we have both duration and current time+speed.
  let eta = null;
  if (progress && progress.duration && progress.time && progress.speed) {
    const remainingVideo = Math.max(0, progress.duration - progress.time);
    eta = progress.speed > 0 ? remainingVideo / progress.speed : null;
  }
  res.json({
    id: video.id,
    title: video.title,
    status: video.status,
    last_error: video.last_error,
    duration: video.duration_seconds,
    src_width: video.src_width,
    src_height: video.src_height,
    src_fps: video.src_fps,
    running: Boolean(progress),
    percent: progress ? progress.percent : (video.status === 'ready' ? 100 : null),
    time: progress ? progress.time : null,
    speed: progress ? progress.speed : null,
    fps: progress ? progress.fps : null,
    eta_seconds: eta,
    log_tail: transcoder.tailLog(id, 60),
  });
});

// Import video from URL (Google Drive, Mega, MediaFire, direct link).
router.post('/import-url', (req, res) => {
  const { url, title } = req.body;
  if (!url || !url.trim()) {
    return res.redirect('/videos?error=URL+is+required');
  }
  try {
    const result = downloader.start(url.trim(), title);
    res.redirect('/videos?notice=Download+started+in+background');
  } catch (e) {
    res.redirect('/videos?error=' + encodeURIComponent(e.message));
  }
});

// Download progress for import jobs.
router.get('/download/:jobId/progress', (req, res) => {
  const progress = downloader.getProgress(req.params.jobId);
  if (!progress) return res.json({ status: 'unknown', percent: null });
  res.json(progress);
});

router.post('/:id/prepare', (req, res) => {
  try {
    const preset = (req.body.preset || '1080p30').trim();
    const x264Preset = (req.body.x264_preset || 'medium').trim();
    transcoder.start(req.params.id, preset, x264Preset);
    res.redirect('/videos?notice=Transcoding+started+in+background');
  } catch (e) {
    res.redirect('/videos?error=' + encodeURIComponent(e.message));
  }
});

router.post('/:id/cancel-prepare', (req, res) => {
  transcoder.cancel(req.params.id);
  db.prepare(`UPDATE videos SET status='uploaded', last_error='cancelled by user'
    WHERE id=? AND status='transcoding'`).run(req.params.id);
  res.redirect('/videos?notice=Transcode+cancelled');
});

router.get('/:id/prepare-log', (req, res) => {
  res.type('text/plain').send(transcoder.tailLog(Number(req.params.id)));
});

router.post('/:id/delete', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.redirect('/videos');
  if (transcoder.isRunning(video.id)) transcoder.cancel(video.id);
  const inUse = db.prepare(`SELECT COUNT(*) AS c FROM streams
    WHERE video_id=? AND status='running'`).get(video.id).c;
  if (inUse > 0) {
    return res.redirect('/videos?error=Video+is+used+by+a+running+stream');
  }
  db.prepare('DELETE FROM streams WHERE video_id=?').run(video.id);
  db.prepare('DELETE FROM videos WHERE id=?').run(video.id);
  const p = path.join(uploadDir, video.filename);
  if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
  res.redirect('/videos');
});

module.exports = router;
