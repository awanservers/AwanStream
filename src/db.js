const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbDir = path.join(__dirname, '..', 'db');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'awanstream.db'));
db.pragma('journal_mode = WAL');

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_seconds REAL,
      src_width INTEGER,
      src_height INTEGER,
      src_fps REAL,
      status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | transcoding | ready | error
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      video_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      rtmp_url TEXT NOT NULL,
      stream_key TEXT NOT NULL,
      loop_video INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'idle', -- idle | running | error
      started_at DATETIME,
      stopped_at DATETIME,
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id INTEGER NOT NULL,
      start_at DATETIME NOT NULL,            -- UTC ISO string
      stop_at DATETIME,                       -- optional; null = manual stop
      status TEXT NOT NULL DEFAULT 'pending', -- pending | started | done | error | cancelled
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (stream_id) REFERENCES streams(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      loop_playlist INTEGER NOT NULL DEFAULT 1,
      shuffle INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      video_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stream_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id INTEGER,
      stream_name TEXT NOT NULL,
      video_title TEXT,
      platform TEXT,
      started_at DATETIME,
      stopped_at DATETIME,
      duration_seconds INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'completed',
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audio_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      duration_seconds REAL,
      codec TEXT,                       -- aac | mp3 | opus | ...
      bitrate INTEGER,                  -- bits per second
      sample_rate INTEGER,              -- Hz
      channels INTEGER,                 -- 1 = mono, 2 = stereo
      status TEXT NOT NULL DEFAULT 'uploaded', -- uploaded | downloading | error
      last_error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT,                  -- YouTube channel ID (UC...)
      channel_title TEXT,               -- channel display name
      access_token TEXT,                -- short-lived (1 hour)
      refresh_token TEXT NOT NULL,      -- long-lived, used to get new access_token
      token_type TEXT DEFAULT 'Bearer',
      scope TEXT,                       -- granted scopes
      expiry_date INTEGER,              -- unix ms timestamp when access_token expires
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS youtube_uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      youtube_video_id TEXT,            -- populated after upload completes
      title TEXT,                       -- title used at upload time
      privacy TEXT DEFAULT 'unlisted',  -- private | unlisted | public
      category_id TEXT DEFAULT '10',    -- 10 = Music
      status TEXT DEFAULT 'pending',    -- pending | uploading | done | error | cancelled
      bytes_sent INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0,
      percent INTEGER DEFAULT 0,
      last_error TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
  `);

  // Lightweight migrations: add encode-related columns to existing installs.
  const cols = db.prepare('PRAGMA table_info(streams)').all().map((c) => c.name);
  const add = (name, type, def) => {
    if (!cols.includes(name)) {
      db.exec(`ALTER TABLE streams ADD COLUMN ${name} ${type} DEFAULT ${def}`);
    }
  };
  add('re_encode', 'INTEGER NOT NULL', '1');
  add('video_bitrate', 'TEXT', "'2500k'");
  add('keyframe_interval', 'INTEGER NOT NULL', '2');
  add('preset', 'TEXT', "'veryfast'");
  add('playlist_id', 'INTEGER', 'NULL');
  add('audio_id', 'INTEGER', 'NULL');
  add('audio_volume', 'TEXT', "'0.3'");
  add('audio_mode', 'TEXT', "'mix'");

  const vcols = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
  const addv = (name, type, def) => {
    if (!vcols.includes(name)) {
      db.exec(`ALTER TABLE videos ADD COLUMN ${name} ${type} DEFAULT ${def}`);
    }
  };
  // New column. Existing rows are raw uploads that have NOT been prepared yet,
  // so mark them as 'uploaded' (not 'ready') to reflect the actual file state.
  addv('status', 'TEXT NOT NULL', "'uploaded'");
  addv('last_error', 'TEXT', 'NULL');
  addv('duration_seconds', 'REAL', 'NULL');
  addv('src_width', 'INTEGER', 'NULL');
  addv('src_height', 'INTEGER', 'NULL');
  addv('src_fps', 'REAL', 'NULL');
  addv('folder_id', 'INTEGER', 'NULL');
  addv('thumbnail', 'TEXT', 'NULL');
  addv('loop_job_id', 'TEXT', 'NULL');
  addv('has_audio', 'INTEGER', 'NULL');
  addv('gop_seconds', 'REAL', 'NULL');         // measured keyframe interval (sec)
  addv('video_bitrate_kbps', 'INTEGER', 'NULL'); // measured average video bitrate

  // Playlist migrations.
  const pcols = db.prepare('PRAGMA table_info(playlists)').all().map((c) => c.name);
  if (!pcols.includes('shuffle')) {
    db.exec(`ALTER TABLE playlists ADD COLUMN shuffle INTEGER NOT NULL DEFAULT 0`);
  }

  // Audio tracks migrations: loudness metadata (EBU R128 / ITU BS.1770).
  const acols = db.prepare('PRAGMA table_info(audio_tracks)').all().map((c) => c.name);
  const adda = (name, type, def) => {
    if (!acols.includes(name)) {
      db.exec(`ALTER TABLE audio_tracks ADD COLUMN ${name} ${type} DEFAULT ${def}`);
    }
  };
  adda('integrated_lufs', 'REAL', 'NULL');     // measured integrated loudness (LUFS)
  adda('true_peak_db', 'REAL', 'NULL');        // measured true peak (dBFS)
  adda('loudness_range', 'REAL', 'NULL');      // measured LRA (LU)
  adda('normalized', 'INTEGER NOT NULL', '0'); // 1 if file has been loudness-normalized
  adda('status_log', 'TEXT', 'NULL');          // normalization log for real-time progress modal

  // Users migrations: track last successful login for the profile page.
  const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const addu = (name, type, def) => {
    if (!ucols.includes(name)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type} DEFAULT ${def}`);
    }
  };
  addu('last_login_at', 'DATETIME', 'NULL');
  addu('last_login_ip', 'TEXT', 'NULL');

  // One-time cleanup: streams.audio_id used to reference videos(id) during
  // early development of the Audio Overlay feature. It now references
  // audio_tracks(id). Clear any stale values that would point to videos which
  // aren't audio tracks (the audio_tracks table is empty on upgrade anyway).
  try {
    db.prepare(`UPDATE streams SET audio_id=NULL
      WHERE audio_id IS NOT NULL
      AND audio_id NOT IN (SELECT id FROM audio_tracks)`).run();
  } catch (_) { /* audio_tracks table might not exist yet on first run */ }
}

module.exports = { db, ensureSchema };
