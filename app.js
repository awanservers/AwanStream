require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const fs = require('fs');

const { ensureSchema, db } = require('./src/db');
const streamManager = require('./src/streamManager');
const transcoder = require('./src/transcoder');
const downloader = require('./src/downloader');
const scheduler = require('./src/scheduler');
const { requireAuth, injectUser } = require('./src/auth');

const authRoutes = require('./src/routes/auth');
const videoRoutes = require('./src/routes/videos');
const streamRoutes = require('./src/routes/streams');
const scheduleRoutes = require('./src/routes/schedules');
const playlistRoutes = require('./src/routes/playlists');

ensureSchema();
streamManager.reconcileOnBoot();
transcoder.reconcileOnBoot();
downloader.reconcileOnBoot();
scheduler.reconcileOnBoot();
scheduler.start();

const app = express();
const PORT = Number(process.env.PORT) || 7575;

if (!process.env.SESSION_SECRET) {
  console.warn('WARN: SESSION_SECRET not set. Run `node generate-secret.js` first.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

  // Total disk usage of uploaded files (sum of size_bytes).
  const totalBytes = db.prepare('SELECT COALESCE(SUM(size_bytes),0) s FROM videos').get().s;

  const recentStreams = db.prepare(`
    SELECT s.*, v.title AS video_title
    FROM streams s LEFT JOIN videos v ON v.id=s.video_id
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

  res.render('dashboard', {
    videoCount, readyCount, streamCount, runningCount,
    pendingSchedules, totalBytes, recentStreams, nextSchedule,
    system: { cpuPercent, cpuCount, loadAvg, totalMem, usedMem, memPercent, uptime },
  });
});

// Real-time system stats endpoint (polled by dashboard JS).
app.get('/api/system', requireAuth, (req, res) => {
  const os = require('os');
  const cpus = os.cpus();
  const cpuCount = cpus.length;
  const loadAvg = os.loadavg();
  const cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = Math.round((usedMem / totalMem) * 100);
  const uptime = os.uptime();
  res.json({ cpuPercent, cpuCount, loadAvg, totalMem, usedMem, memPercent, uptime });
});

app.use('/videos', requireAuth, videoRoutes);
app.use('/streams', requireAuth, streamRoutes);
app.use('/schedules', requireAuth, scheduleRoutes);
app.use('/playlists', requireAuth, playlistRoutes);

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { message: err.message });
});

app.listen(PORT, () => {
  console.log(`AwanStream running on http://localhost:${PORT}`);
});
