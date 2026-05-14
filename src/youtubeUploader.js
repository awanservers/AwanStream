// YouTube uploader — handles resumable upload via googleapis.
//
// Pattern mirrors transcoder.js / looper.js / downloader.js:
//   - in-memory `jobs` Map for active uploads
//   - DB row in `youtube_uploads` persists state across restarts
//   - reconcileOnBoot() resets stale 'uploading' rows on server start
//   - getProgress(jobId) for polling
//   - cancel(jobId) aborts the upload
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { db } = require('./db');
const youtubeManager = require('./youtubeManager');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// jobId (string) -> { jobState, abortController, logStream }
const jobs = new Map();

// Default video category — 10 = Music, 22 = People & Blogs, 24 = Entertainment.
const DEFAULT_CATEGORY = '10';
const VALID_PRIVACY = new Set(['private', 'unlisted', 'public']);

function genJobId() {
  return `yt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Start a YouTube upload job.
 *
 * @param {number} videoId
 * @param {object} [opts]
 * @param {string} [opts.title]       — default: videos.title
 * @param {string} [opts.description] — default: empty
 * @param {string} [opts.privacy]     — 'private' | 'unlisted' (default) | 'public'
 * @param {string[]} [opts.tags]      — default: []
 * @param {string} [opts.categoryId]  — default: '10' (Music)
 * @returns {{ jobId: string, uploadId: number }}
 */
function start(videoId, opts = {}) {
  const id = Number(videoId);
  const video = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  if (!video) throw new Error('Video not found');

  const filePath = path.join(uploadDir, video.filename);
  if (!fs.existsSync(filePath)) throw new Error('Video file missing on disk');

  const account = youtubeManager.getAccount();
  if (!account) throw new Error('No YouTube account connected. Visit /youtube to connect first.');

  const auth = youtubeManager.getAuthedClient();
  if (!auth) throw new Error('Failed to build YouTube auth client');

  const title = (opts.title && String(opts.title).trim()) || video.title;
  const description = (opts.description && String(opts.description)) || '';
  const privacy = VALID_PRIVACY.has(opts.privacy) ? opts.privacy : 'unlisted';
  const categoryId = (opts.categoryId && String(opts.categoryId)) || DEFAULT_CATEGORY;
  const tags = Array.isArray(opts.tags) ? opts.tags.slice(0, 30) : [];

  const stat = fs.statSync(filePath);
  const totalBytes = stat.size;

  // Check if there's already a running upload for this video.
  for (const [, j] of jobs) {
    if (j.jobState.videoId === id && (j.jobState.status === 'pending' || j.jobState.status === 'uploading')) {
      throw new Error('An upload for this video is already in progress');
    }
  }

  // Insert DB row up-front.
  const insertResult = db.prepare(`INSERT INTO youtube_uploads
    (video_id, title, privacy, category_id, status, total_bytes, started_at)
    VALUES (?, ?, ?, ?, 'pending', ?, CURRENT_TIMESTAMP)`)
    .run(id, title, privacy, categoryId, totalBytes);
  const uploadId = Number(insertResult.lastInsertRowid);

  const jobId = genJobId();
  const logPath = path.join(logsDir, `youtube-upload-${uploadId}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(
    `\n=== ${new Date().toISOString()} starting upload job=${jobId} uploadId=${uploadId} ` +
    `video=${id} (${video.filename}, ${(totalBytes / (1024*1024)).toFixed(1)} MB) ` +
    `privacy=${privacy} title="${title}"\n`
  );

  const jobState = {
    jobId,
    uploadId,
    videoId: id,
    title,
    privacy,
    categoryId,
    status: 'pending',
    bytesSent: 0,
    totalBytes,
    percent: 0,
    youtubeVideoId: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };

  // Cancellation: googleapis accepts an AbortSignal via options.
  const abortController = new AbortController();

  jobs.set(jobId, { jobState, abortController, logStream });

  // Kick off upload in background — caller doesn't wait for completion.
  performUpload({ auth, filePath, video, jobState, abortController, logStream }).catch((err) => {
    // Catch-all safety net; performUpload already handles its own errors.
    logStream.write(`\n=== unexpected error: ${err && err.message}\n`);
  });

  return { jobId, uploadId };
}

async function performUpload({ auth, filePath, video, jobState, abortController, logStream }) {
  const youtube = google.youtube({ version: 'v3', auth });

  jobState.status = 'uploading';
  db.prepare(`UPDATE youtube_uploads SET status='uploading' WHERE id=?`).run(jobState.uploadId);

  try {
    const requestOpts = {
      onUploadProgress: (evt) => {
        const sent = Number(evt.bytesRead) || 0;
        const total = jobState.totalBytes || 1;
        jobState.bytesSent = sent;
        jobState.percent = Math.min(100, Math.round((sent / total) * 100));
        // Persist every ~5% to avoid hammering DB on every chunk.
        if (
          jobState.percent !== jobState._lastPersistPercent &&
          (jobState.percent % 5 === 0 || jobState.percent === 100)
        ) {
          try {
            db.prepare(`UPDATE youtube_uploads SET bytes_sent=?, percent=? WHERE id=?`)
              .run(sent, jobState.percent, jobState.uploadId);
          } catch (_) {}
          jobState._lastPersistPercent = jobState.percent;
        }
      },
      // Pass abort signal so cancel() can stop the request.
      signal: abortController.signal,
    };

    const resp = await youtube.videos.insert(
      {
        part: ['snippet', 'status'],
        notifySubscribers: false,
        requestBody: {
          snippet: {
            title: jobState.title,
            description: '',
            categoryId: jobState.categoryId,
            tags: [],
          },
          status: {
            privacyStatus: jobState.privacy,
            selfDeclaredMadeForKids: false,
          },
        },
        media: {
          body: fs.createReadStream(filePath),
        },
      },
      requestOpts,
    );

    const ytId = resp && resp.data && resp.data.id;
    if (!ytId) throw new Error('Upload completed but no video ID returned');

    jobState.status = 'done';
    jobState.youtubeVideoId = ytId;
    jobState.percent = 100;
    jobState.finishedAt = Date.now();

    db.prepare(`UPDATE youtube_uploads SET
      status='done', youtube_video_id=?, percent=100,
      bytes_sent=total_bytes, finished_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(ytId, jobState.uploadId);

    logStream.write(`\n=== ${new Date().toISOString()} upload done youtube_id=${ytId}\n`);
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR' ||
                            (err.message && /aborted|cancel/i.test(err.message)));
    if (isAbort || abortController.signal.aborted) {
      jobState.status = 'cancelled';
      jobState.error = 'Upload cancelled';
      jobState.finishedAt = Date.now();
      db.prepare(`UPDATE youtube_uploads SET status='cancelled', last_error='Cancelled by user',
        finished_at=CURRENT_TIMESTAMP WHERE id=?`).run(jobState.uploadId);
      logStream.write(`\n=== ${new Date().toISOString()} upload cancelled\n`);
    } else {
      jobState.status = 'error';
      jobState.error = err && err.message ? err.message : String(err);
      jobState.finishedAt = Date.now();
      db.prepare(`UPDATE youtube_uploads SET status='error', last_error=?,
        finished_at=CURRENT_TIMESTAMP WHERE id=?`).run(jobState.error, jobState.uploadId);
      logStream.write(`\n=== ${new Date().toISOString()} upload error: ${jobState.error}\n`);
      if (err && err.response && err.response.data) {
        try { logStream.write('=== response data: ' + JSON.stringify(err.response.data) + '\n'); } catch (_) {}
      }
    }
  } finally {
    logStream.end();
    // Keep job in Map briefly so client can poll final status.
    setTimeout(() => jobs.delete(jobState.jobId), 30000);
  }
}

/**
 * Get current progress snapshot for a job.
 */
function getProgress(jobId) {
  const j = jobs.get(String(jobId));
  if (!j) {
    // Maybe expired from Map; check DB by uploadId or youtube_video_id (fallback).
    return null;
  }
  return { ...j.jobState };
}

/**
 * Cancel an in-flight upload.
 */
function cancel(jobId) {
  const j = jobs.get(String(jobId));
  if (!j) return false;
  if (j.jobState.status === 'done' || j.jobState.status === 'error' || j.jobState.status === 'cancelled') {
    return false;
  }
  try { j.abortController.abort(); } catch (_) {}
  return true;
}

/**
 * List all currently-tracked jobs (in-memory).
 */
function listJobs() {
  return Array.from(jobs.values()).map((j) => ({ ...j.jobState }));
}

/**
 * Get the persisted upload row for a given video.
 * Returns the most recent successful upload (or any if no successful one).
 */
function getLatestUploadForVideo(videoId) {
  const id = Number(videoId);
  const done = db.prepare(`
    SELECT * FROM youtube_uploads
    WHERE video_id=? AND status='done' AND youtube_video_id IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).get(id);
  if (done) return done;
  return db.prepare(`
    SELECT * FROM youtube_uploads WHERE video_id=? ORDER BY id DESC LIMIT 1
  `).get(id) || null;
}

function reconcileOnBoot() {
  // Any 'uploading' or 'pending' rows from a previous run are stale.
  // googleapis doesn't expose the resumable upload URL, so we can't truly
  // resume across server restarts — user has to start over.
  db.prepare(`UPDATE youtube_uploads
    SET status='error', last_error='Upload interrupted by server restart. Click Retry to upload again.'
    WHERE status IN ('pending', 'uploading')`).run();
}

function tailLog(uploadId, lines = 100) {
  const logPath = path.join(logsDir, `youtube-upload-${uploadId}.log`);
  if (!fs.existsSync(logPath)) return '';
  const data = fs.readFileSync(logPath, 'utf8').split('\n');
  return data.slice(-lines).join('\n');
}

module.exports = {
  start,
  cancel,
  getProgress,
  listJobs,
  getLatestUploadForVideo,
  reconcileOnBoot,
  tailLog,
};
