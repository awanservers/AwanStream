const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const audioManager = require('../audioManager');
const diskCheck = require('../diskCheck');

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
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
  fileFilter: (_req, file, cb) => {
    if (!audioManager.isSupportedFilename(file.originalname)) {
      return cb(new Error('Unsupported audio format (use mp3/m4a/aac/wav/ogg/opus/flac/wma)'));
    }
    cb(null, true);
  },
});

router.get('/', (req, res) => {
  const tracks = audioManager.list().map(t => {
    t._readiness = audioManager.assessStreamReadiness(t);
    return t;
  });
  res.render('audio', {
    title: 'Audio Library',
    activeNav: 'audio',
    tracks,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/upload', (req, res) => {
  // Pre-check disk before letting multer drain to disk.
  const cl = Number(req.headers['content-length']) || 0;
  if (cl > 0) {
    try { diskCheck.ensureSpace(cl, 'Audio upload'); }
    catch (e) {
      return res.redirect('/audio?error=' + encodeURIComponent(e.message));
    }
  }
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

router.post('/:id/normalize', (req, res) => {
  const id = Number(req.params.id);
  const track = audioManager.get(id);
  if (!track) return res.redirect('/audio?error=Track+not+found');
  const filePath = audioManager.getFilePath(id);
  if (!filePath) return res.redirect('/audio?error=File+missing+on+disk');

  const { db } = require('../db');
  
  // Format localized time for status log
  const logTime = () => `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;

  // Update status to normalizing, clear error, write starting log
  db.prepare(`UPDATE audio_tracks SET status='normalizing', status_log=?, last_error=NULL WHERE id=?`)
    .run(`${logTime()} Starting manual loudness normalization...\n`, id);

  // Run normalize in background so response isn't blocked.
  setImmediate(async () => {
    const appendLog = (msg) => {
      db.prepare(`UPDATE audio_tracks SET status_log = COALESCE(status_log, '') || ? WHERE id=?`)
        .run(`${logTime()} ${msg}\n`, id);
    };

    audioManager.activeJobs.set(id, { percent: 0 });

    try {
      appendLog('Running loudness analysis pass (Pass 1 of 2)...');
      
      const measured = await audioManager.analyzeLoudness(
        filePath,
        (time) => {
          if (track.duration_seconds) {
            const pct = Math.min(49, Math.round((time / track.duration_seconds) * 50));
            const job = audioManager.activeJobs.get(id);
            if (job) job.percent = pct;
          }
        },
        (child) => {
          const job = audioManager.activeJobs.get(id);
          if (job) job.process = child;
        }
      );
      if (!measured) {
        const activeJob = audioManager.getActiveJob(id);
        if (activeJob && activeJob.cancelled) {
          db.prepare(`UPDATE audio_tracks SET status='uploaded', status_log = COALESCE(status_log, '') || ? WHERE id=?`)
            .run(`${logTime()} Normalization cancelled by user.\n`, id);
          return;
        }
        const errMsg = 'Loudness analysis failed (Pass 1)';
        db.prepare(`UPDATE audio_tracks SET status='error', last_error=?, normalized=0, status_log = COALESCE(status_log, '') || ? WHERE id=?`)
          .run(errMsg, `${logTime()} Error: ${errMsg}. Check logs/audio-normalize.log for details.\n`, id);
        return;
      }

      appendLog(`Loudness analyzed: Input = ${measured.input_i.toFixed(1)} LUFS, True Peak = ${measured.input_tp.toFixed(1)} dBFS, LRA = ${measured.input_lra.toFixed(1)} LU.`);
      appendLog('Applying loudness normalization and brick-wall limiting to -14 LUFS (Pass 2 of 2)...');

      const ok = await audioManager.applyLoudnessNormalization(
        filePath,
        measured,
        (time) => {
          if (track.duration_seconds) {
            const pct = Math.min(99, Math.round(50 + (time / track.duration_seconds) * 50));
            const job = audioManager.activeJobs.get(id);
            if (job) job.percent = pct;
          }
        },
        (child) => {
          const job = audioManager.activeJobs.get(id);
          if (job) job.process = child;
        }
      );
      if (!ok) {
        const activeJob = audioManager.getActiveJob(id);
        if (activeJob && activeJob.cancelled) {
          db.prepare(`UPDATE audio_tracks SET status='uploaded', status_log = COALESCE(status_log, '') || ? WHERE id=?`)
            .run(`${logTime()} Normalization cancelled by user.\n`, id);
          return;
        }
        const errMsg = 'Loudness normalization failed (Pass 2)';
        db.prepare(`UPDATE audio_tracks SET status='error', last_error=?, normalized=0, status_log = COALESCE(status_log, '') || ? WHERE id=?`)
          .run(errMsg, `${logTime()} Error: ${errMsg}. Check logs/audio-normalize.log for details.\n`, id);
        return;
      }

      appendLog('Loudness normalization complete! File updated.');
      appendLog('Probing updated file metadata...');

      const fs = require('fs');
      const stat = fs.statSync(filePath);
      const newInfo = audioManager.probe(filePath);
      
      db.prepare(`UPDATE audio_tracks SET
        size_bytes=?,
        codec=COALESCE(?, codec),
        bitrate=COALESCE(?, bitrate),
        sample_rate=COALESCE(?, sample_rate),
        integrated_lufs=?,
        true_peak_db=?,
        loudness_range=?,
        normalized=1,
        status='uploaded',
        last_error=NULL,
        status_log = COALESCE(status_log, '') || ?
        WHERE id=?`).run(
        stat.size,
        newInfo.codec, newInfo.bitrate, newInfo.sampleRate,
        audioManager.LOUDNESS_TARGET.I, // -14
        audioManager.LOUDNESS_TARGET.TP, // -1.5
        measured.input_lra,
        `${logTime()} Finished! Audio normalized successfully.\n`,
        id,
      );
    } catch (e) {
      db.prepare(`UPDATE audio_tracks SET status='error', last_error=?, status_log = COALESCE(status_log, '') || ? WHERE id=?`)
        .run('Normalization crashed: ' + e.message, `${logTime()} Crash: ${e.message}\n`, id);
    } finally {
      audioManager.activeJobs.delete(id);
    }
  });

  res.redirect('/audio?notice=Normalization+started+in+background');
});

// POST /audio/:id/analyze -> Start background loudness analysis (without normalising/transcoding)
router.post('/:id/analyze', (req, res) => {
  const id = Number(req.params.id);
  const track = audioManager.get(id);
  if (!track) return res.redirect('/audio?error=Track+not+found');
  const filePath = audioManager.getFilePath(id);
  if (!filePath) return res.redirect('/audio?error=File+missing+on+disk');

  const { db } = require('../db');
  const logTime = () => `[${new Date().toLocaleTimeString('en-US', { hour12: false })}]`;

  db.prepare(`UPDATE audio_tracks SET status='analyzing', status_log=?, last_error=NULL WHERE id=?`)
    .run(`${logTime()} Starting manual loudness analysis...\n`, id);

  audioManager.activeJobs.set(id, { percent: 0 });

  setImmediate(async () => {
    const appendLog = (msg) => {
      db.prepare(`UPDATE audio_tracks SET status_log = COALESCE(status_log, '') || ? WHERE id=?`)
        .run(`${logTime()} ${msg}\n`, id);
    };

    try {
      appendLog('Analyzing loudness...');
      const measured = await audioManager.analyzeLoudness(
        filePath,
        (time) => {
          if (track.duration_seconds) {
            const pct = Math.min(99, Math.round((time / track.duration_seconds) * 100));
            const job = audioManager.activeJobs.get(id);
            if (job) job.percent = pct;
          }
        },
        (child) => {
          const job = audioManager.activeJobs.get(id);
          if (job) job.process = child;
        }
      );

      if (!measured) {
        const job = audioManager.activeJobs.get(id);
        const wasCancelled = job && job.cancelled;
        db.prepare(`UPDATE audio_tracks SET status='uploaded', last_error=?, status_log = COALESCE(status_log, '') || ? WHERE id=?`)
          .run(
            wasCancelled ? null : 'Analysis failed',
            wasCancelled ? `${logTime()} Analysis cancelled by user.\n` : `${logTime()} Error: Loudness analysis failed. Check logs/audio-normalize.log for details.\n`,
            id
          );
        return;
      }

      const isAlreadyAac = track.codec && track.codec.toLowerCase() === 'aac';
      const isAlready48k = track.sample_rate === 48000;
      const isLoudnessOk = Math.abs(measured.input_i - audioManager.LOUDNESS_TARGET.I) <= 1.5;
      const isPeakOk = measured.input_tp <= -1.0;
      const autoReady = isAlreadyAac && isAlready48k && isLoudnessOk && isPeakOk;

      db.prepare(`UPDATE audio_tracks SET
        integrated_lufs=?,
        true_peak_db=?,
        loudness_range=?,
        normalized=?,
        status='uploaded',
        last_error=NULL,
        status_log = COALESCE(status_log, '') || ?
        WHERE id=?`).run(
        measured.input_i,
        measured.input_tp,
        measured.input_lra,
        autoReady ? 1 : 0,
        `${logTime()} Analysis complete! LUFS: ${measured.input_i.toFixed(1)}, Peak: ${measured.input_tp.toFixed(1)}. ${autoReady ? 'File matches standards, marked as ready.' : 'Analysis finished.'}\n`,
        id
      );
    } catch (e) {
      db.prepare(`UPDATE audio_tracks SET status='uploaded', last_error=?, status_log = COALESCE(status_log, '') || ? WHERE id=?`)
        .run('Analysis crashed: ' + e.message, `${logTime()} Crash: ${e.message}\n`, id);
    } finally {
      audioManager.activeJobs.delete(id);
    }
  });

  res.redirect('/audio?notice=Loudness+analysis+started');
});

// GET /audio/:id/status -> Polling endpoint for status & logs
router.get('/:id/status', (req, res) => {
  const track = audioManager.get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  const activeJob = audioManager.getActiveJob(track.id);
  res.json({
    ok: true,
    id: track.id,
    title: track.title,
    status: track.status,
    percent: activeJob ? activeJob.percent : null,
    normalized: track.normalized,
    last_error: track.last_error,
    log_tail: track.status_log,
  });
});

// POST /audio/:id/cancel -> Cancel running normalization/analysis
router.post('/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  const track = audioManager.get(id);
  const wasAnalyzing = track && track.status === 'analyzing';

  audioManager.cancel(id);

  if (wasAnalyzing) {
    res.redirect('/audio?notice=Loudness+analysis+cancelled');
  } else {
    res.redirect('/audio?notice=Normalization+cancelled');
  }
});

// GET /audio/:id/metadata -> Detail info endpoint
router.get('/:id/metadata', (req, res) => {
  const track = audioManager.get(req.params.id);
  if (!track) return res.status(404).json({ error: 'Track not found' });
  res.json({
    ok: true,
    track,
  });
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
