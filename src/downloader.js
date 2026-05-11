// Unified URL downloader. Detects source (Google Drive, Mega, MediaFire, direct)
// and downloads to public/uploads/. Pattern mirrors transcoder.js (Map jobs, progress).
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { db } = require('./db');
const transcoder = require('./transcoder');

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// jobId -> { progress, cancel }
const jobs = new Map();

// ─── Source detection ───────────────────────────────────────────────────────

function detectSource(url) {
  if (/drive\.google\.com|docs\.google\.com.*\/d\//.test(url)) return 'gdrive';
  if (/mega\.nz|mega\.co\.nz/.test(url)) return 'mega';
  if (/mediafire\.com/.test(url)) return 'mediafire';
  return 'direct';
}

// ─── Google Drive ───────────────────────────────────────────────────────────

function extractGDriveFileId(url) {
  let m = url.match(/\/file\/d\/([^/]+)/);
  if (m) return m[1];
  m = url.match(/[?&]id=([^&]+)/);
  if (m) return m[1];
  m = url.match(/\/d\/([^/]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{25,}$/.test(url.trim())) return url.trim();
  return null;
}

async function fetchGDriveFilename(fileId) {
  try {
    const r = await axios.get(`https://drive.google.com/file/d/${fileId}/view`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const m = r.data.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)
           || r.data.match(/"title":"([^"]+)"/);
    return m ? m[1].replace(/\s*-\s*Google Drive$/, '').trim() : null;
  } catch (_) { return null; }
}

async function downloadGDrive(fileId, destPath, onProgress) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const headers = { 'User-Agent': UA };

  // Try direct download first.
  const urls = [
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
  ];

  // Attempt initial request to get cookies / confirmation.
  try {
    const init = await axios.get(`https://drive.google.com/uc?export=download&id=${fileId}`, {
      timeout: 30000, headers, maxRedirects: 5, validateStatus: (s) => s < 500,
    });
    const cookies = (init.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    if (typeof init.data === 'string' && init.data.includes('confirm=')) {
      const cm = init.data.match(/confirm=([0-9A-Za-z_-]+)/);
      if (cm) urls.unshift(`https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=${cm[1]}`);
    }
    headers.Cookie = cookies;
  } catch (_) {}

  for (const url of urls) {
    try {
      const r = await axios({ method: 'GET', url, responseType: 'stream', timeout: 600000, maxRedirects: 10, headers });
      const ct = r.headers['content-type'] || '';
      if (ct.includes('text/html')) continue; // got confirmation page, try next
      const total = parseInt(r.headers['content-length'] || '0', 10);
      await streamToFile(r.data, destPath, total, onProgress);
      return;
    } catch (_) {}
  }
  throw new Error('Google Drive download failed. File mungkin private atau terlalu besar.');
}

// ─── Mega ───────────────────────────────────────────────────────────────────

async function downloadMega(url, destPath, onProgress) {
  const { File } = await import('megajs');
  const file = File.fromURL(url);
  await file.loadAttributes();
  const total = file.size || 0;
  const stream = file.download();
  await streamToFile(stream, destPath, total, onProgress);
}

// ─── MediaFire ──────────────────────────────────────────────────────────────

function extractMediaFireKey(url) {
  const m = url.match(/mediafire\.com\/(?:file|download|\?)\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

async function downloadMediaFire(fileKey, destPath, onProgress) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const pageUrl = `https://www.mediafire.com/file/${fileKey}`;
  const page = await axios.get(pageUrl, { timeout: 30000, headers: { 'User-Agent': UA } });
  const html = page.data;
  const dm = html.match(/href="(https:\/\/download[^"]+mediafire\.com[^"]+)"/i)
          || html.match(/id="downloadButton"[^>]*href="([^"]+)"/i);
  if (!dm) throw new Error('MediaFire: download link not found. File mungkin private atau dihapus.');
  const dlUrl = dm[1].replace(/&amp;/g, '&');
  const r = await axios({ method: 'GET', url: dlUrl, responseType: 'stream', timeout: 600000, maxRedirects: 10, headers: { 'User-Agent': UA } });
  const total = parseInt(r.headers['content-length'] || '0', 10);
  await streamToFile(r.data, destPath, total, onProgress);
}

// ─── Direct URL ─────────────────────────────────────────────────────────────

async function downloadDirect(url, destPath, onProgress) {
  const r = await axios({ method: 'GET', url, responseType: 'stream', timeout: 600000, maxRedirects: 10 });
  const total = parseInt(r.headers['content-length'] || '0', 10);
  await streamToFile(r.data, destPath, total, onProgress);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function streamToFile(readable, destPath, totalBytes, onProgress) {
  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    let downloaded = 0;
    readable.on('data', (chunk) => {
      downloaded += chunk.length;
      if (onProgress) {
        const pct = totalBytes > 0 ? Math.min(100, Math.round((downloaded / totalBytes) * 100)) : null;
        onProgress({ downloaded, total: totalBytes, percent: pct });
      }
    });
    readable.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    readable.on('error', reject);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

function getProgress(jobId) {
  const j = jobs.get(jobId);
  return j ? j.progress : null;
}

function isRunning(jobId) { return jobs.has(jobId); }

async function start(url, title) {
  const source = detectSource(url);
  const jobId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Determine filename.
  let filename = null;
  if (source === 'gdrive') {
    const fid = extractGDriveFileId(url);
    if (!fid) throw new Error('Invalid Google Drive URL');
    filename = await fetchGDriveFilename(fid) || `gdrive_${fid}.mp4`;
  } else if (source === 'mega') {
    filename = `mega_${Date.now()}.mp4`; // will be updated after loadAttributes
  } else if (source === 'mediafire') {
    filename = `mediafire_${Date.now()}.mp4`;
  } else {
    const urlPath = new URL(url).pathname;
    filename = path.basename(urlPath) || `download_${Date.now()}.mp4`;
  }

  // Sanitize + make unique on disk.
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const destFilename = `${Date.now()}_${safe}`;
  const destPath = path.join(uploadDir, destFilename);

  const progress = { percent: null, downloaded: 0, total: 0, status: 'downloading', error: null };
  jobs.set(jobId, { progress });

  // Insert DB row immediately so user sees it in the list.
  const videoTitle = (title || filename).trim();
  db.prepare(`INSERT INTO videos (title, filename, size_bytes, status)
    VALUES (?, ?, 0, 'downloading')`)
    .run(videoTitle, destFilename);
  const videoRow = db.prepare('SELECT id FROM videos WHERE filename=?').get(destFilename);
  const videoId = videoRow.id;

  // Run download in background.
  (async () => {
    try {
      const onProgress = (p) => {
        progress.downloaded = p.downloaded;
        progress.total = p.total;
        progress.percent = p.percent;
      };

      if (source === 'gdrive') {
        await downloadGDrive(extractGDriveFileId(url), destPath, onProgress);
      } else if (source === 'mega') {
        await downloadMega(url, destPath, onProgress);
      } else if (source === 'mediafire') {
        const key = extractMediaFireKey(url);
        if (!key) throw new Error('Invalid MediaFire URL');
        await downloadMediaFire(key, destPath, onProgress);
      } else {
        await downloadDirect(url, destPath, onProgress);
      }

      // Success — update DB.
      const stats = fs.statSync(destPath);
      const info = transcoder.probeVideoInfo(destPath);
      db.prepare(`UPDATE videos
        SET size_bytes=?, status='uploaded', duration_seconds=?,
            src_width=?, src_height=?, src_fps=?
        WHERE id=?`)
        .run(stats.size, info.duration, info.width, info.height, info.fps, videoId);
      progress.status = 'done';
      progress.percent = 100;
    } catch (err) {
      progress.status = 'error';
      progress.error = err.message;
      db.prepare(`UPDATE videos SET status='error', last_error=? WHERE id=?`)
        .run(err.message, videoId);
      // Cleanup partial file.
      if (fs.existsSync(destPath)) try { fs.unlinkSync(destPath); } catch (_) {}
    } finally {
      // Keep job in map for 30s so client can read final status, then cleanup.
      setTimeout(() => jobs.delete(jobId), 30000);
    }
  })();

  return { jobId, videoId, source };
}

function reconcileOnBoot() {
  // Any video stuck in 'downloading' from a previous run is stale.
  db.prepare(`UPDATE videos SET status='error',
    last_error='download interrupted by server restart'
    WHERE status='downloading'`).run();
}

module.exports = { start, getProgress, isRunning, detectSource, reconcileOnBoot };
