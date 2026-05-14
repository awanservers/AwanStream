const express = require('express');
const youtubeManager = require('../youtubeManager');
const youtubeUploader = require('../youtubeUploader');

const router = express.Router();

router.get('/', (req, res) => {
  const configured = youtubeManager.isConfigured();
  const status = youtubeManager.getStatus();

  res.render('youtube', {
    title: 'YouTube',
    activeNav: 'youtube',
    configured,
    status,
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

// Step 1 of OAuth: redirect to Google consent screen.
router.get('/connect', (req, res) => {
  if (!youtubeManager.isConfigured()) {
    return res.redirect('/youtube?error=' + encodeURIComponent(
      'YouTube credentials not configured. See docs/youtube-setup.md.'
    ));
  }
  try {
    const url = youtubeManager.getAuthUrl();
    res.redirect(url);
  } catch (e) {
    res.redirect('/youtube?error=' + encodeURIComponent(e.message));
  }
});

// Step 2 of OAuth: callback from Google with the auth code.
// The redirect URI registered in Google Cloud Console must be:
//   <YOUR_APP_URL>/youtube/callback
router.get('/callback', async (req, res) => {
  const { code, error: oauthError, error_description } = req.query;

  if (oauthError) {
    return res.redirect('/youtube?error=' + encodeURIComponent(
      `OAuth declined: ${oauthError}${error_description ? ' — ' + error_description : ''}`
    ));
  }
  if (!code) {
    return res.redirect('/youtube?error=' + encodeURIComponent('No authorization code received'));
  }

  try {
    const { channelTitle } = await youtubeManager.exchangeCodeAndStore(String(code));
    const label = channelTitle ? ` as "${channelTitle}"` : '';
    res.redirect('/youtube?notice=' + encodeURIComponent('Connected to YouTube' + label));
  } catch (e) {
    res.redirect('/youtube?error=' + encodeURIComponent(
      'OAuth exchange failed: ' + (e.message || 'unknown error')
    ));
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    const result = await youtubeManager.disconnect();
    const note = result.alreadyDisconnected
      ? 'Already disconnected'
      : (result.revokeError
          ? 'Disconnected locally (token revocation warning: ' + result.revokeError + ')'
          : 'YouTube disconnected');
    res.redirect('/youtube?notice=' + encodeURIComponent(note));
  } catch (e) {
    res.redirect('/youtube?error=' + encodeURIComponent(e.message));
  }
});

// -- Upload routes --------------------------------------------------------

// Start an upload for a video.
router.post('/upload/:videoId', (req, res) => {
  const videoId = Number(req.params.videoId);
  const { title, privacy, category_id } = req.body;

  try {
    const result = youtubeUploader.start(videoId, {
      title,
      privacy,
      categoryId: category_id,
    });
    // AJAX form? Return JSON.
    if (req.xhr || (req.headers.accept || '').includes('application/json')) {
      return res.json({ ok: true, jobId: result.jobId, uploadId: result.uploadId });
    }
    res.redirect('/videos?notice=' + encodeURIComponent(
      `YouTube upload started — check progress in video row (job ${result.jobId})`
    ));
  } catch (e) {
    if (req.xhr || (req.headers.accept || '').includes('application/json')) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    res.redirect('/videos?error=' + encodeURIComponent(e.message));
  }
});

// Poll progress for a specific job.
router.get('/upload/:jobId/progress', (req, res) => {
  const p = youtubeUploader.getProgress(req.params.jobId);
  if (!p) return res.status(404).json({ ok: false, error: 'Job not found or expired' });
  res.json({ ok: true, ...p });
});

// Cancel an in-flight upload.
router.post('/upload/:jobId/cancel', (req, res) => {
  const ok = youtubeUploader.cancel(req.params.jobId);
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.json({ ok });
  }
  return res.redirect('/videos?' + (ok ? 'notice=Upload+cancelled' : 'error=Job+not+found+or+already+finished'));
});

// List active jobs (used for video library badges).
router.get('/uploads/active', (req, res) => {
  res.json({ jobs: youtubeUploader.listJobs() });
});

module.exports = router;
