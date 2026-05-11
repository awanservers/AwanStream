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
}

module.exports = { db, ensureSchema };
