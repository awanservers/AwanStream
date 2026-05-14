require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const { ensureSchema, db } = require('./src/db');
const streamManager = require('./src/streamManager');
const transcoder = require('./src/transcoder');
const downloader = require('./src/downloader');
const scheduler = require('./src/scheduler');
const looper = require('./src/looper');
const audioManager = require('./src/audioManager');
const youtubeManager = require('./src/youtubeManager');
const youtubeUploader = require('./src/youtubeUploader');
const { requireAuth, injectUser } = require('./src/auth');

const authRoutes = require('./src/routes/auth');
const videoRoutes = require('./src/routes/videos');
const streamRoutes = require('./src/routes/streams');
const scheduleRoutes = require('./src/routes/schedules');
const playlistRoutes = require('./src/routes/playlists');
const historyRoutes = require('./src/routes/history');
const looperRoutes = require('./src/routes/looper');
const audioRoutes = require('./src/routes/audio');
const youtubeRoutes = require('./src/routes/youtube');

ensureSchema();
streamManager.reconcileOnBoot();
transcoder.reconcileOnBoot();
downloader.reconcileOnBoot();
scheduler.reconcileOnBoot();
looper.reconcileOnBoot();
audioManager.reconcileOnBoot();
youtubeManager.reconcileOnBoot();
youtubeUploader.reconcileOnBoot();
scheduler.start();

const app = express();
const PORT = Number(process.env.PORT) || 7575;

if (!process.env.SESSION_SECRET) {
  console.warn('WARN: SESSION_SECRET not set. Run `node generate-secret.js` first.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));

// HTTP request logger — NestJS-style format.
// Example: [AwanStream] - 05/11/2026, 08:30:22 PM   LOG  GET /videos 200 - 13ms - IP: 127.0.0.1
(function setupMorgan() {
  // Custom tokens.
  morgan.token('awanstream-date', () => {
    const d = new Date();
    const opts = {
      month: '2-digit', day: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: true,
    };
    return d.toLocaleString('en-US', opts).replace(',', ',');
  });
  morgan.token('latency-int', (req, res) => {
    const t = morgan['response-time'](req, res, 0);
    return t ? Math.round(Number(t)).toString() : '0';
  });
  morgan.token('client-ip', (req) => {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    return (req.ip || req.connection?.remoteAddress || '-').replace(/^::ffff:/, '');
  });

  // ANSI colors.
  const y = '\x1b[33m', g = '\x1b[32m', c = '\x1b[36m', r = '\x1b[31m', gray = '\x1b[90m', reset = '\x1b[0m';

  app.use(morgan((tokens, req, res) => {
    const status = res.statusCode;
    const statusColor = status >= 500 ? r : status >= 400 ? y : status >= 300 ? c : c;
    return [
      y + '[AwanStream]' + reset + gray + ' - ' + reset +
      tokens['awanstream-date'](req, res) + '   ' +
      g + 'LOG' + reset + '  ' +
      tokens.method(req, res) + ' ' +
      tokens.url(req, res) + ' ' +
      statusColor + status + reset + ' - ' +
      tokens['latency-int'](req, res) + 'ms' + gray + ' - IP: ' + reset +
      r + tokens['client-ip'](req, res) + reset
    ].join('');
  }, {
    skip: (req) => /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)(\?.*)?$/i.test(req.path),
  }));
})();

// Serve CSS/JS assets publicly (no auth needed for styling).
// NOTE: we deliberately do NOT serve `public/uploads` via static middleware.
// Uploads (videos, thumbnails, audio) require authentication — accessed via
// protected routes like /videos/:id/file, /videos/:id/thumb, /audio/:id/download.
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: dbDir }),
  secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// Format any UTC-ish timestamp string (SQLite "YYYY-MM-DD HH:MM:SS") into the
// configured timezone. TZ and TZ_LABEL come from .env (defaults: WIB / Jakarta).
const TZ = process.env.TZ || 'Asia/Jakarta';
const TZ_LABEL = process.env.TZ_LABEL || 'WIB';
let wibFormatter;
try {
  wibFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
} catch (e) {
  console.warn(`WARN: invalid TZ="${TZ}", falling back to Asia/Jakarta`);
  wibFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}
app.locals.formatTime = (value) => {
  if (!value) return '-';
  const iso = typeof value === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${wibFormatter.format(d)} ${TZ_LABEL}`;
};

// Short format: "11/05 14.46 WIB" — for table cells where space is tight.
app.locals.formatTimeShort = (value) => {
  if (!value) return '-';
  const iso = typeof value === 'string' && !/[zZ]|[+-]\d\d:?\d\d$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(value);
  const shortFmt = new Intl.DateTimeFormat('id-ID', {
    timeZone: TZ,
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  return `${shortFmt.format(d)} ${TZ_LABEL}`;
};

app.use(injectUser);

app.use('/', authRoutes);

app.get('/', requireAuth, (req, res) => {
  const videoCount   = db.prepare('SELECT COUNT(*) c FROM videos').get().c;
  const readyCount   = db.prepare("SELECT COUNT(*) c FROM videos WHERE status='ready'").get().c;
  const streamCount  = db.prepare('SELECT COUNT(*) c FROM streams').get().c;
  const runningCount = db.prepare("SELECT COUNT(*) c FROM streams WHERE status='running'").get().c;
  const pendingSchedules = db.prepare("SELECT COUNT(*) c FROM schedules WHERE status='pending'").get().c;
  const historyCount = db.prepare('SELECT COUNT(*) c FROM stream_history').get().c;

  // Total disk usage of uploaded files (sum of size_bytes).
  const totalBytes = db.prepare('SELECT COALESCE(SUM(size_bytes),0) s FROM videos').get().s;

  const recentStreams = db.prepare(`
    SELECT s.*, v.title AS video_title, v.thumbnail AS video_thumb,
           p.name AS playlist_name
    FROM streams s
    LEFT JOIN videos v ON v.id=s.video_id
    LEFT JOIN playlists p ON p.id=s.playlist_id
    ORDER BY s.created_at DESC LIMIT 5
  `).all();

  // Next pending schedule.
  const nextSchedule = db.prepare(`
    SELECT sc.start_at, s.name AS stream_name
    FROM schedules sc JOIN streams s ON s.id=sc.stream_id
    WHERE sc.status='pending'
    ORDER BY sc.start_at ASC LIMIT 1
  `).get();

  // System monitor.
  const os = require('os');
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const loadAvg = os.loadavg(); // [1min, 5min, 15min]
  const cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const uptime = os.uptime();

  // Disk usage for uploads directory.
  let disk = { total: 0, used: 0, free: 0, percent: 0 };
  try {
    const uploadsPath = path.join(__dirname, 'public', 'uploads');
    const st = fs.statfsSync(uploadsPath);
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    const used = total - free;
    disk = {
      total, used, free,
      percent: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch (_) {}

  res.render('dashboard', {
    videoCount, readyCount, streamCount, runningCount,
    pendingSchedules, historyCount, totalBytes, recentStreams, nextSchedule,
    system: { cpuPercent, cpuCount, loadAvg, totalMem, usedMem, memPercent, uptime, disk },
  });
});

// Real-time system stats — accurate CPU via /proc/stat delta (like htop).
let prevCpuIdle = 0, prevCpuTotal = 0;
function readCpuUsage() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const line = stat.split('\n')[0]; // "cpu  user nice system idle iowait irq softirq steal"
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    const diffIdle = idle - prevCpuIdle;
    const diffTotal = total - prevCpuTotal;
    prevCpuIdle = idle;
    prevCpuTotal = total;
    if (diffTotal === 0) return 0;
    return Math.round(((diffTotal - diffIdle) / diffTotal) * 100);
  } catch (_) {
    // Fallback for non-Linux (e.g., macOS dev)
    const os = require('os');
    return Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
  }
}
// Prime the first sample so first real read has a delta.
readCpuUsage();

let lastNetSample = null;
app.get('/api/system', requireAuth, (req, res) => {
  const os = require('os');
  const cpuCount = os.cpus().length;
  const cpuPercent = readCpuUsage();
  const loadAvg = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const uptime = os.uptime();

  let disk = { total: 0, used: 0, free: 0, percent: 0 };
  try {
    const uploadsPath = path.join(__dirname, 'public', 'uploads');
    const st = fs.statfsSync(uploadsPath);
    const total = st.blocks * st.bsize;
    const free = st.bfree * st.bsize;
    const used = total - free;
    disk = {
      total, used, free,
      percent: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } catch (_) {}

  // Network throughput delta.
  let net = { upload: 0, download: 0, available: false };
  try {
    const netData = fs.readFileSync('/proc/net/dev', 'utf8');
    const lines = netData.split('\n').slice(2);
    let rxBytes = 0, txBytes = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0]) continue;
      const iface = parts[0].replace(':', '');
      if (iface === 'lo') continue;
      rxBytes += Number(parts[1]) || 0;
      txBytes += Number(parts[9]) || 0;
    }
    const current = { rxBytes, txBytes, ts: Date.now() };
    if (lastNetSample) {
      const elapsed = (current.ts - lastNetSample.ts) / 1000;
      if (elapsed > 0) {
        net = {
          download: Math.round(Math.max(0, current.rxBytes - lastNetSample.rxBytes) / elapsed),
          upload: Math.round(Math.max(0, current.txBytes - lastNetSample.txBytes) / elapsed),
          available: true,
        };
      }
    }
    lastNetSample = current;
  } catch (_) {}

  res.json({
    cpuPercent, cpuCount, loadAvg,
    totalMem, usedMem, memPercent,
    uptime, disk, net,
    serverTime: new Date().toISOString(),
  });
});

// SSE endpoint — push system stats every 3 seconds.
// NOTE: Placed before session middleware to avoid session store locking issues
// with long-lived connections. Auth checked via cookie manually.
app.get('/api/events', (req, res) => {
  // Quick auth check without full session middleware — just verify cookie exists.
  // If not authenticated, SSE will simply not connect (browser handles gracefully).
  if (!req.headers.cookie || !req.headers.cookie.includes('connect.sid')) {
    return res.status(401).end();
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Per-connection state for network throughput delta calculation.
  let lastNet = null;

  function readNetBytes() {
    try {
      const netData = fs.readFileSync('/proc/net/dev', 'utf8');
      const lines = netData.split('\n').slice(2); // skip header
      let rxBytes = 0, txBytes = 0;
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (!parts[0]) continue;
        const iface = parts[0].replace(':', '');
        if (iface === 'lo') continue; // skip loopback
        rxBytes += Number(parts[1]) || 0;
        txBytes += Number(parts[9]) || 0;
      }
      return { rxBytes, txBytes, ts: Date.now() };
    } catch (_) {
      return null;
    }
  }

  function getStats() {
    const os = require('os');
    const cpuCount = os.cpus().length;
    const cpuPercent = readCpuUsage();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);
    const uptime = os.uptime();

    let disk = { total: 0, used: 0, free: 0, percent: 0 };
    try {
      const uploadsPath = path.join(__dirname, 'public', 'uploads');
      const st = fs.statfsSync(uploadsPath);
      const total = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      const used = total - free;
      disk = { total, used, free, percent: total > 0 ? Math.round((used / total) * 100) : 0 };
    } catch (_) {}

    // Network throughput: calculate delta from last sample.
    let net = { upload: 0, download: 0, available: false };
    const current = readNetBytes();
    if (current && lastNet) {
      const elapsedSec = (current.ts - lastNet.ts) / 1000;
      if (elapsedSec > 0) {
        const rxDelta = Math.max(0, current.rxBytes - lastNet.rxBytes);
        const txDelta = Math.max(0, current.txBytes - lastNet.txBytes);
        net = {
          download: Math.round(rxDelta / elapsedSec), // bytes/sec
          upload: Math.round(txDelta / elapsedSec),
          available: true,
        };
      }
    }
    if (current) lastNet = current;

    return { cpuPercent, cpuCount, loadAvg, totalMem, usedMem, memPercent, uptime, disk, net };
  }

  function send(data) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) {}
  }

  // Send immediately (first sample has no net delta yet — will populate on 2nd tick).
  send(getStats());
  const interval = setInterval(() => send(getStats()), 2000);

  // Heartbeat every 20s to keep alive through proxies.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

app.use('/videos', requireAuth, videoRoutes);
app.use('/streams', requireAuth, streamRoutes);
app.use('/schedules', requireAuth, scheduleRoutes);
app.use('/playlists', requireAuth, playlistRoutes);
app.use('/history', requireAuth, historyRoutes);
app.use('/looper', requireAuth, looperRoutes);
app.use('/audio', requireAuth, audioRoutes);
app.use('/youtube', requireAuth, youtubeRoutes);

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { message: err.message });
});

app.listen(PORT, () => {
  console.log(`AwanStream running on http://localhost:${PORT}`);
});
