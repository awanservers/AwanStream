const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const audioManager = require('../audioManager');

const router = express.Router();

// Multer storage for audio files — separate dir from videos.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, audioManager.audioDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB — audio files are much smaller than video
  fileFilter: (_req, file, cb) => {
    if (!audioManager.isSupportedFilename(file.originalname)) {
      return cb(new Error('Unsupported audio format (use mp3/m4a/aac/wav/ogg/opus/flac/wma)'));
    }
    cb(null, true);
  },
});

router.get('/', (req, res) => {
  const tracks = audioManager.list();
  res.render('audio', {
    title: 'Audio Library',
    activeNav: 'audio',
    tracks,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/upload', (req, res) => {
  upload.single('audio')(req, res, (err) => {
    if (err) return res.redirect('/audio?error=' + encodeURIComponent(err.message));
    if (!req.file) return res.redirect('/audio?error=No+file+uploaded');
    const title = (req.body.title || req.file.originalname).trim();
    try {
      audioManager.register({
        title,
        filename: req.file.filename,
        size: req.file.size,
      });
      res.redirect('/audio?notice=Audio+uploaded');
    } catch (e) {
      // Best-effort cleanup if register fails.
      try { fs.unlinkSync(path.join(audioManager.audioDir, req.file.filename)); } catch (_) {}
      res.redirect('/audio?error=' + encodeURIComponent(e.message));
    }
  });
});

router.post('/:id/delete', (req, res) => {
  const result = audioManager.remove(req.params.id);
  if (!result.ok) {
    return res.redirect('/audio?error=' + encodeURIComponent(result.error));
  }
  res.redirect('/audio?notice=Audio+deleted');
});

router.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  const newTitle = (req.body.title || '').trim();
  if (!newTitle) return res.redirect('/audio?error=Title+required');
  const track = audioManager.get(id);
  if (!track) return res.redirect('/audio?error=Track+not+found');
  // Check for duplicate title (excluding current row).
  const { db } = require('../db');
  const dup = db.prepare('SELECT 1 FROM audio_tracks WHERE title=? AND id<>?').get(newTitle, id);
  if (dup) return res.redirect('/audio?error=Title+already+exists');
  db.prepare('UPDATE audio_tracks SET title=? WHERE id=?').run(newTitle, id);
  res.redirect('/audio?notice=Audio+renamed');
});

// -- Media serving (auth-protected) ---------------------------------------

function safeDownloadName(title, fallbackExt = 'mp3') {
  const clean = String(title || 'audio')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/\.[a-z0-9]{2,5}$/i.test(clean)) return `${clean || 'audio'}.${fallbackExt}`;
  return clean;
}

// Download an audio track with a friendly filename.
router.get('/:id/download', (req, res) => {
  const track = audioManager.get(req.params.id);
  if (!track) return res.status(404).send('Not found');
  const filePath = audioManager.getFilePath(req.params.id);
  if (!filePath) return res.status(404).send('File missing');
  const ext = path.extname(track.filename).replace('.', '') || 'mp3';
  const downloadName = safeDownloadName(track.title, ext);
  res.download(filePath, downloadName);
});

module.exports = router;
