const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { db } = require('../db');
const transcoder = require('../transcoder');
const downloader = require('../downloader');
const chunkUpload = require('../chunkUpload');

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
  const folderId = req.query.folder ? Number(req.query.folder) : null;
  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = 20;
  const offset = (page - 1) * perPage;

  const folders = db.prepare(`
    SELECT f.*, (SELECT COUNT(*) FROM videos v WHERE v.folder_id = f.id) AS video_count
    FROM folders f ORDER BY f.name ASC
  `).all();
  // Count videos without a folder.
  const unfolderedCount = db.prepare('SELECT COUNT(*) AS c FROM videos WHERE folder_id IS NULL').get().c;

  let videos;
  let totalCount;
  if (folderId) {
    totalCount = db.prepare('SELECT COUNT(*) AS c FROM videos WHERE folder_id=?').get(folderId).c;
    videos = db.prepare(
      'SELECT * FROM videos WHERE folder_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(folderId, perPage, offset);
  } else if (req.query.folder === '0') {
    // Explicitly show "unfiled" videos only.
    totalCount = db.prepare('SELECT COUNT(*) AS c FROM videos WHERE folder_id IS NULL').get().c;
    videos = db.prepare(
      'SELECT * FROM videos WHERE folder_id IS NULL ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(perPage, offset);
  } else {
    // Show all videos.
    totalCount = db.prepare('SELECT COUNT(*) AS c FROM videos').get().c;
    videos = db.prepare(
      'SELECT * FROM videos ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(perPage, offset);
  }

  const currentFolder = folderId ? db.prepare('SELECT * FROM folders WHERE id=?').get(folderId) : null;
  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  res.render('videos', {
    videos, folders, currentFolder, unfolderedCount,
    page, perPage, totalPages, totalCount,
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
    const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
    // Insert row immediately — don't block on ffprobe.
    const result = db.prepare(`INSERT INTO videos
      (title, filename, size_bytes, status, folder_id)
      VALUES (?, ?, ?, 'uploaded', ?)`)
      .run(title, req.file.filename, req.file.size, folderId);
    const videoId = result.lastInsertRowid;
    const uploadedPath = path.join(uploadDir, req.file.filename);
    // Probe + thumbnail in background after response is sent.
    setImmediate(() => {
      try {
        const info = transcoder.probeVideoInfo(uploadedPath);
        if (info.duration || info.width || info.height || info.fps) {
          db.prepare(`UPDATE videos SET duration_seconds=?, src_width=?, src_height=?, src_fps=? WHERE id=?`)
            .run(info.duration, info.width, info.height, info.fps, videoId);
        }
      } catch (_) {}
      try {
        const thumb = transcoder.generateThumbnail(uploadedPath, videoId);
        if (thumb) db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, videoId);
      } catch (_) {}
    });
    const back = folderId ? '/videos?folder=' + folderId + '&notice=Upload+complete.+Use+Prepare+to+make+it+stream-ready.' : '/videos?notice=Upload+complete.+Use+Prepare+to+make+it+stream-ready.';
    res.redirect(back);
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

// --- Chunked upload API (JSON) ---

// Initialize chunked upload session.
router.post('/chunked/init', express.json(), (req, res) => {
  const { filename, fileSize } = req.body;
  if (!filename || !fileSize) {
    return res.status(400).json({ error: 'filename and fileSize required' });
  }
  if (!/\.(mp4|mkv|mov|flv|ts|webm)$/i.test(filename)) {
    return res.status(400).json({ error: 'Unsupported video format' });
  }
  const session = chunkUpload.initSession(filename, Number(fileSize));
  res.json(session);
});

// Get session status (for resume).
router.get('/chunked/:uploadId/status', (req, res) => {
  const session = chunkUpload.getSession(req.params.uploadId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// Upload a single chunk (raw binary body).
router.put('/chunked/:uploadId/:chunkIndex', (req, res) => {
  const uploadId = req.params.uploadId;
  const chunkIndex = Number(req.params.chunkIndex);
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const data = Buffer.concat(chunks);
      const result = chunkUpload.saveChunk(uploadId, chunkIndex, data);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  req.on('error', (e) => {
    res.status(500).json({ error: e.message });
  });
});

// Finalize: merge chunks, create video record.
router.post('/chunked/:uploadId/finalize', express.json(), (req, res) => {
  const uploadId = req.params.uploadId;
  const title = (req.body.title || '').trim();
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
  try {
    const { filename, filePath, fileSize } = chunkUpload.finalize(uploadId);
    const rawTitle = title || filename;
    const finalTitle = uniqueTitle(rawTitle);
    // Insert row immediately — probe in background.
    const result = db.prepare(`INSERT INTO videos
      (title, filename, size_bytes, status, folder_id)
      VALUES (?, ?, ?, 'uploaded', ?)`)
      .run(finalTitle, filename, fileSize, folderId);
    const videoId = result.lastInsertRowid;
    // Probe + thumbnail in background.
    setImmediate(() => {
      try {
        const info = transcoder.probeVideoInfo(filePath);
        if (info.duration || info.width || info.height || info.fps) {
          db.prepare(`UPDATE videos SET duration_seconds=?, src_width=?, src_height=?, src_fps=? WHERE id=?`)
            .run(info.duration, info.width, info.height, info.fps, videoId);
        }
      } catch (_) {}
      try {
        const thumb = transcoder.generateThumbnail(filePath, videoId);
        if (thumb) db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, videoId);
      } catch (_) {}
    });
    res.json({ ok: true, videoId, title: finalTitle });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cancel/abort chunked upload.
router.delete('/chunked/:uploadId', (req, res) => {
  chunkUpload.cleanup(req.params.uploadId);
  res.json({ ok: true });
});

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

// --- Folder management ---

router.post('/folders/create', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.redirect('/videos?error=Folder+name+is+required');
  db.prepare('INSERT INTO folders (name) VALUES (?)').run(name.trim());
  res.redirect('/videos?notice=Folder+created');
});

router.post('/folders/:id/rename', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.redirect('/videos?error=Name+is+required');
  db.prepare('UPDATE folders SET name=? WHERE id=?').run(name.trim(), Number(req.params.id));
  res.redirect('/videos?folder=' + req.params.id + '&notice=Folder+renamed');
});

router.post('/folders/:id/delete', (req, res) => {
  const folderId = Number(req.params.id);
  // Move videos back to unfiled (don't delete them).
  db.prepare('UPDATE videos SET folder_id=NULL WHERE folder_id=?').run(folderId);
  db.prepare('DELETE FROM folders WHERE id=?').run(folderId);
  res.redirect('/videos?notice=Folder+deleted');
});

// Bulk: prepare all 'uploaded' videos in a folder.
router.post('/folders/:id/prepare-all', (req, res) => {
  const folderId = Number(req.params.id);
  const preset = (req.body.preset || '1080p30').trim();
  const x264Preset = (req.body.x264_preset || 'medium').trim();
  const videos = db.prepare(
    "SELECT id FROM videos WHERE folder_id=? AND status='uploaded'"
  ).all(folderId);
  let started = 0;
  let skipped = 0;
  for (const v of videos) {
    try {
      transcoder.start(v.id, preset, x264Preset);
      started++;
    } catch (e) {
      // Skip if already running or other error.
      skipped++;
    }
  }
  const msg = `Started ${started} transcode job${started !== 1 ? 's' : ''}` +
    (skipped > 0 ? ` (${skipped} skipped)` : '');
  res.redirect('/videos?folder=' + folderId + '&notice=' + encodeURIComponent(msg));
});

// Bulk: delete all videos in a folder.
router.post('/folders/:id/delete-videos', (req, res) => {
  const folderId = Number(req.params.id);
  const videos = db.prepare('SELECT * FROM videos WHERE folder_id=?').all(folderId);
  let deleted = 0;
  let skipped = 0;
  for (const video of videos) {
    // Skip if currently transcoding or streaming.
    if (transcoder.isRunning(video.id)) { skipped++; continue; }
    const inUse = db.prepare(
      "SELECT COUNT(*) AS c FROM streams WHERE video_id=? AND status='running'"
    ).get(video.id).c;
    if (inUse > 0) { skipped++; continue; }
    db.prepare('DELETE FROM streams WHERE video_id=?').run(video.id);
    db.prepare('DELETE FROM videos WHERE id=?').run(video.id);
    const p = path.join(uploadDir, video.filename);
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {}
    // Cleanup thumbnail too.
    if (video.thumbnail) {
      const thumbPath = path.join(uploadDir, 'thumbs', video.thumbnail);
      if (fs.existsSync(thumbPath)) try { fs.unlinkSync(thumbPath); } catch (_) {}
    }
    deleted++;
  }
  const msg = `Deleted ${deleted} video${deleted !== 1 ? 's' : ''}` +
    (skipped > 0 ? ` (${skipped} skipped — in use)` : '');
  res.redirect('/videos?folder=' + folderId + '&notice=' + encodeURIComponent(msg));
});

// Convert folder to playlist — creates a new playlist with all 'ready' videos.
router.post('/folders/:id/create-playlist', (req, res) => {
  const folderId = Number(req.params.id);
  const folder = db.prepare('SELECT * FROM folders WHERE id=?').get(folderId);
  if (!folder) return res.redirect('/videos?error=Folder+not+found');
  const videos = db.prepare(
    "SELECT id FROM videos WHERE folder_id=? AND status='ready' ORDER BY created_at ASC"
  ).all(folderId);
  if (videos.length === 0) {
    return res.redirect('/videos?folder=' + folderId +
      '&error=No+ready+videos+in+this+folder.+Prepare+videos+first.');
  }
  // Create playlist with folder name.
  const result = db.prepare(
    'INSERT INTO playlists (name, loop_playlist, shuffle) VALUES (?, 1, 0)'
  ).run(folder.name);
  const playlistId = result.lastInsertRowid;
  // Add all ready videos.
  const insertItem = db.prepare(
    'INSERT INTO playlist_items (playlist_id, video_id, position) VALUES (?, ?, ?)'
  );
  videos.forEach((v, idx) => insertItem.run(playlistId, v.id, idx + 1));
  res.redirect('/playlists/' + playlistId +
    '?notice=Playlist+created+with+' + videos.length + '+videos');
});

router.post('/:id/move-folder', (req, res) => {
  const videoId = Number(req.params.id);
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
  db.prepare('UPDATE videos SET folder_id=? WHERE id=?').run(folderId, videoId);
  const back = req.body.back || '/videos';
  res.redirect(back + (back.includes('?') ? '&' : '?') + 'notice=Video+moved');
});

// Combined edit endpoint: rename title + optionally move folder.
router.post('/:id/edit', (req, res) => {
  const videoId = Number(req.params.id);
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(videoId);
  if (!video) return res.redirect('/videos?error=Video+not+found');
  const newTitle = (req.body.title || '').trim();
  const folderId = req.body.folder_id ? Number(req.body.folder_id) : null;
  if (!newTitle) return res.redirect('/videos?error=Title+is+required');
  // Check title uniqueness (only if changed).
  if (newTitle !== video.title) {
    const exists = db.prepare('SELECT 1 FROM videos WHERE title=? AND id<>?').get(newTitle, videoId);
    if (exists) return res.redirect('/videos?error=Title+already+exists');
  }
  db.prepare('UPDATE videos SET title=?, folder_id=? WHERE id=?')
    .run(newTitle, folderId, videoId);
  const back = req.body.back || '/videos';
  res.redirect(back + (back.includes('?') ? '&' : '?') + 'notice=Video+updated');
});

router.post('/:id/regen-thumb', (req, res) => {
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(req.params.id);
  if (!video) return res.redirect('/videos?error=Video+not+found');
  const videoPath = path.join(uploadDir, video.filename);
  if (!fs.existsSync(videoPath)) return res.redirect('/videos?error=File+not+found');
  const thumb = transcoder.generateThumbnail(videoPath, video.id);
  if (thumb) {
    db.prepare('UPDATE videos SET thumbnail=? WHERE id=?').run(thumb, video.id);
    res.redirect('/videos?notice=Thumbnail+generated');
  } else {
    res.redirect('/videos?error=Failed+to+generate+thumbnail');
  }
});

module.exports = router;
