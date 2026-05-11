# Architecture

## Overview

AwanStream adalah server-rendered web app (Express + EJS) dengan SQLite sebagai single source of truth dan **FFmpeg child process** sebagai eksekutor kerja berat (transcode & RTMP push).

Tidak ada message queue, tidak ada worker terpisah. Setiap stream aktif = 1 `ffmpeg` process yang di-spawn Node. Setiap Prepare = 1 `ffmpeg` process juga. Setiap URL import = 1 async download (axios/megajs).

## Request flow

```
Browser
  ↓ HTML form (POST) / XHR (upload progress) / fetch (polling)
Express route (src/routes/*.js)
  ↓ validate + db.prepare(...).run()
SQLite (better-sqlite3, sync)
  ↓ kalau perlu background work
streamManager / transcoder / downloader
  ↓ spawn('ffmpeg', args, ...) atau axios/megajs stream
FFmpeg child process / HTTP download
  ↓ stdout/stderr → logs/<kind>-<id>.log (stream key di-redact)
  ↓ .on('exit') → update DB status row
```

Form POST selalu redirect ke halaman yang sama dengan `?notice=` / `?error=`. Toast notification auto-dismiss + URL cleanup via `history.replaceState`.

JSON endpoints untuk polling:
- `GET /videos/:id/progress` — transcode progress (percent, speed, fps)
- `GET /videos/:id/status` — transcode progress + log tail + ETA (untuk job detail modal)
- `GET /videos/download/:jobId/progress` — URL import progress
- `GET /api/system` — CPU/RAM/Uptime (polled setiap 3 detik oleh dashboard)

## Komponen

### `app.js` (entry)
- Load `.env`
- `ensureSchema()` — buat / migrate tabel
- `streamManager.reconcileOnBoot()` — set row `status='running'` stale → `idle` (proses child sudah hilang setelah restart)
- `transcoder.reconcileOnBoot()` — set row `status='transcoding'` stale → `error`
- `downloader.reconcileOnBoot()` — set row `status='downloading'` stale → `error`
- `scheduler.reconcileOnBoot()` — set row `status='started'` stale → `error`, lalu `scheduler.start()` mulai polling tiap 15 detik
- Configure session (cookie `secure` di production, `sameSite: 'lax'`, 7 hari)
- Expose `app.locals.formatTime` dan `app.locals.formatTimeShort` (TZ-aware, dari env `TZ` / `TZ_LABEL`)
- Mount routes: `/` dashboard, `/login`, `/logout`, `/videos/*`, `/streams/*`, `/schedules/*`, `/playlists/*`
- `GET /api/system` — real-time system stats (CPU%, RAM%, Uptime)
- Listen port (default 7575)

### `src/db.js`
- Single `Database` instance dengan `journal_mode = WAL`
- `ensureSchema()` idempotent: `CREATE TABLE IF NOT EXISTS` + manual migrations via `PRAGMA table_info` guard
- 6 tabel: `users`, `videos`, `streams`, `schedules`, `playlists`, `playlist_items`
- Pattern migrasi:
  ```js
  const cols = db.prepare('PRAGMA table_info(streams)').all().map(c => c.name);
  if (!cols.includes('new_column')) db.exec(`ALTER TABLE streams ADD COLUMN ...`);
  ```

### `src/streamManager.js` (live streaming)
- State: `running: Map<streamId, { process, logStream }>`
- `startStream(stream, videoPath)`:
  - Build FFmpeg args berdasarkan `stream.re_encode`:
    - **Copy mode:** `-c:v copy -c:a aac -b:a 128k -ar 44100`
    - **Re-encode mode:** `libx264` + preset user + bitrate + enforced GOP via `-g`, `-keyint_min`, `-sc_threshold 0`, `-force_key_frames`
  - `spawn('ffmpeg', args)`
  - Pipe stdout/stderr → redacting log writer → `logs/stream-<id>.log`
  - UPDATE streams SET status='running', started_at=CURRENT_TIMESTAMP
  - On exit (normal): cek `advancePlaylist(stream)` — kalau playlist, start video berikutnya. Kalau bukan playlist atau playlist habis, set status idle.
  - On exit (error): set status error + stopped_at
- `stopStream(id)`: set status idle di DB dulu, lalu `SIGTERM` ke child
- `advancePlaylist(stream)`: internal helper — cek playlist items, find next video, update `video_id`, start next. Kalau `loop_playlist=1` dan sudah di akhir, wrap ke posisi 0.
- `tailLog(id, n)`: baca tail file + redact stream key lagi (defense in depth)

### `src/transcoder.js` (Prepare + Codec Validation)
- State: `jobs: Map<videoId, { process, progress }>`
- 4 preset: `720p30`, `720p60`, `1080p30`, `1080p60` + pilihan x264 preset
- Proses:
  1. Probe duration (`ffprobe`) kalau belum ada di DB, cache ke `videos.duration_seconds`
  2. UPDATE videos SET status='transcoding'
  3. FFmpeg dijalankan dengan `-progress pipe:1 -nostats` → parse key=value pairs dari stdout (`out_time_ms`, `speed`, `fps`) untuk update in-memory `progress`
  4. Tulis ke `<basename>__<preset>_ready.mp4`
  5. On success: `unlink(source)` + `rename(ready, source)` → source file sekarang stream-ready, re-probe duration, UPDATE status='ready'
- On failure: hapus file partial, set status='error', last_error=pesan
- `reconcileOnBoot()` → status='transcoding' stale → status='error'
- `getProgress(videoId)` → `{percent, time, duration, speed, fps}` atau null
- `probeDuration(path)` → float seconds atau null
- `probeVideoInfo(path)` → `{width, height, fps, duration, videoCodec, audioCodec}` — full media probe dalam satu call
- `validateCodec(path)` → `{ok, issues[], info}` — cek H.264 + AAC, return issues kalau tidak comply

### `src/downloader.js` (URL import)
- State: `jobs: Map<jobId, { progress, cancel }>`
- Source detection: `detectSource(url)` → `'gdrive'` | `'mega'` | `'mediafire'` | `'direct'`
- `start(url, title)`:
  1. Detect source, extract file ID / key
  2. INSERT video row dengan `status='downloading'`
  3. Download async (Google Drive: multi-URL fallback + cookie handling, Mega: megajs stream, MediaFire: scrape download link, Direct: axios stream)
  4. On success: update `size_bytes`, `status='uploaded'`, probe video info
  5. On failure: set `status='error'`, cleanup partial file
  6. Job stays in Map 30 detik setelah selesai (supaya client bisa baca final status)
- `getProgress(jobId)` → `{percent, downloaded, total, status, error}`
- `reconcileOnBoot()` → status='downloading' stale → status='error'

### `src/scheduler.js` (scheduled streaming)
- State: tidak ada in-memory; semua dibaca dari tabel `schedules`.
- `setInterval(tick, 15000)` dimulai di `app.js` startup.
- Setiap tick:
  1. Start semua row `pending` yang `start_at <= now` (UTC) via `streamManager.startStream(...)` → status `started`.
  2. Stop semua row `started` yang punya `stop_at <= now` via `streamManager.stopStream(...)` → status `done`.
  3. Auto-mark `done` untuk row `started` tanpa `stop_at` kalau stream-nya sudah exit sendiri (video non-loop selesai).
  4. Error dari start/stop → status `error`, last_error=pesan.
- `reconcileOnBoot()` → row `started` stale dianggap tidak reliable setelah restart, di-set ke `error` dengan pesan eksplisit.
- Polling 15 detik = akurasi trigger maksimal 15 detik di belakang target (cukup untuk streaming, bukan HFT).

### `src/auth.js`
- `requireAuth` — cek `req.session.userId`, kalau tidak ada: redirect `/login` (HTML) atau 401 JSON
- `injectUser` — isi `res.locals.currentUser` biar view bisa conditional

### Views (`views/`)
- `partials/header.ejs` — sidebar nav (brand + nav items dengan sub-menus + user block) + topbar (page title + action slot) + open `<main>`
- `partials/footer.ejs` — toast root + custom confirm modal script + close `<main>`
- `partials/flash.ejs` — render toast notifications (auto-dismiss 4 detik, URL cleanup)
- `login.ejs` — form login
- `dashboard.ejs` — stat cards + system monitor widget (CPU/RAM/Uptime polling) + recent streams + next schedule
- `videos.ejs` — library table + upload modal (XHR progress) + import URL modal + prepare modal + job detail modal (progress + log + ETA) + inline polling script
- `streams-single.ejs` — single video stream management (create modal + stream table)
- `streams-playlist.ejs` — playlist stream management (create modal + stream table)
- `playlists.ejs` — playlist list + create modal
- `playlist-detail.ejs` — playlist items (add video, remove, move up/down)
- `schedules.ejs` — schedule management (create modal + schedule table)
- `error.ejs` — generic error page

## Data model

6 tabel application + 1 session table. Main data di `db/awanstream.db`, session terpisah di `db/sessions.db` (dikelola `connect-sqlite3`).

```sql
users (
  id, username UNIQUE, password_hash, created_at
)

videos (
  id, title, filename, size_bytes,
  duration_seconds REAL,             -- nullable; populated by ffprobe
  src_width INTEGER,                 -- source video width (pixels)
  src_height INTEGER,                -- source video height (pixels)
  src_fps REAL,                      -- source framerate
  status TEXT DEFAULT 'uploaded',    -- uploaded | downloading | transcoding | ready | error
  last_error, created_at
)

streams (
  id, name, video_id FK,
  playlist_id INTEGER FK playlists,  -- nullable; set for playlist streams
  platform, rtmp_url, stream_key,    -- stream_key = secret
  loop_video BOOL,
  re_encode BOOL DEFAULT 1,
  video_bitrate TEXT DEFAULT '2500k',
  keyframe_interval INT DEFAULT 2,
  preset TEXT DEFAULT 'veryfast',
  status TEXT DEFAULT 'idle',        -- idle | running | error
  started_at, stopped_at, last_error, created_at
)

schedules (
  id, stream_id FK,
  start_at DATETIME NOT NULL,         -- UTC ISO string
  stop_at  DATETIME,                  -- UTC ISO string, optional
  status TEXT DEFAULT 'pending',      -- pending | started | done | error | cancelled
  last_error, created_at
)

playlists (
  id, name,
  loop_playlist BOOL DEFAULT 1,       -- wrap around to first video after last
  created_at
)

playlist_items (
  id, playlist_id FK, video_id FK,
  position INTEGER DEFAULT 0          -- ordering (1-based, ascending)
)
```

### Time storage convention

- `users/videos/streams.created_at`, `streams.started_at`, `streams.stopped_at` = SQLite `CURRENT_TIMESTAMP` string (UTC tanpa suffix). Di-render ke zona lokal via `formatTime()`.
- `schedules.start_at` dan `schedules.stop_at` = UTC **ISO 8601** string (dengan `Z` suffix), dihasilkan dari `parseLocalToUTC(input, TZ)` di route handler. Disimpan UTC supaya DST dan ganti zona tidak mengubah trigger absolute.

## State machines

### Video
```
(new row after upload)  → uploaded
(new row after import)  → downloading  --ok→  uploaded  --fail→  error
uploaded   --Prepare→  transcoding  --ok→      ready
                                     --fail→    error
transcoding  --restart→  error (via reconcileOnBoot)
downloading  --restart→  error (via downloader.reconcileOnBoot)
ready        --re-Prepare→  transcoding  (diperbolehkan)
error        --re-Prepare→  transcoding
```

### Stream
```
(new row) → idle
idle       --Start→    running   --user Stop→    idle
                                 --ffmpeg exit 0 (no playlist)→ idle
                                 --ffmpeg exit 0 (playlist next)→ running (next video)
                                 --ffmpeg exit 0 (playlist done)→ idle
                                 --ffmpeg crash → error
running    --restart→  idle (via reconcileOnBoot)
error      --Start→    running
```

### Schedule
```
(new row) → pending
pending   --cancel (user)→       cancelled
pending   --start_at <= now→     started (scheduler starts stream)
pending   --stream / video hilang saat tick→  error
started   --stop_at <= now→      done (scheduler stops stream)
started   --stream exit sendiri (stop_at=NULL)→ done
started   --restart (uptime gap)→ error (via reconcileOnBoot)
```

Perbedaan penting:
- `pending` bisa dihapus bebas (`Delete`) atau dibatalkan (`Cancel`).
- Setelah `started`, cancel tidak tersedia — user harus Stop stream-nya manual atau tunggu `stop_at`.
- `error` adalah terminal (scheduler tidak retry); user harus buat schedule baru.

## Routing & sub-menu structure

```
/                       Dashboard (stats + system monitor)
/login                  Login form
/logout                 Destroy session
/videos                 Video Library (upload, import, prepare, delete)
/playlists              Playlist list (create, delete)
/playlists/:id          Playlist detail (add/remove/reorder videos)
/streams/single         Single Video streams (create, start, stop, delete)
/streams/playlist       Playlist streams (create, start, stop, delete)
/schedules              Scheduled streaming (create, cancel, delete)
/api/system             System monitor JSON (polled by dashboard)
```

Sidebar nav groups:
- **Dashboard** → `/`
- **Videos** (sub-menu): Library → `/videos`, Playlists → `/playlists`
- **Streams** (sub-menu): Single Video → `/streams/single`, Playlist → `/streams/playlist`
- **Schedules** → `/schedules`

## Security boundaries

- **Session cookie:** httpOnly, sameSite=lax, secure di production. Signed dengan `SESSION_SECRET` dari env.
- **Auth:** semua route kecuali `/login` dilindungi `requireAuth`.
- **Stream key redaction:** tulisan ke log selalu melewati `makeRedactingStream`. `tailLog()` juga redact saat baca — double defense.
- **Path traversal:** filename di-sanitize di multer (`replace(/[^a-zA-Z0-9._-]/g, '_')`).
- **Command injection:** FFmpeg selalu di-`spawn` dengan args array (bukan shell string).
- **File size limit:** multer 5 GB / file.
- **Password:** bcrypt cost 10.
- **Codec validation:** `validateCodec()` mencegah start stream dengan file yang tidak compatible (Copy mode).

## Non-goals

Yang sengaja TIDAK ada:
- Multi-tenant / multi-user (single admin)
- RBAC
- API publik (ini UI-only app, JSON endpoints hanya untuk internal polling)
- ORM (pakai SQL langsung via better-sqlite3 prepared statements)
- TypeScript
- Frontend framework (React/Vue/dll)
- Container orchestration (bisa ditambah nanti)

## Performance notes

- SQLite WAL mode: read paralel dengan write, cukup untuk single-admin workload.
- `better-sqlite3` sync API lebih cepat untuk queries kecil dibanding async. Tidak cocok untuk long queries.
- FFmpeg CPU: `-c:v copy` ~0%, re-encode `veryfast` ~1 core per 1080p30 stream.
- Prepare adalah trade-off: CPU sekali di awal, lalu streaming 0% CPU. Cocok untuk VPS 1-2 core.
- File upload streaming langsung ke disk lewat multer (`diskStorage`), tidak buffer ke memory.
- URL import: axios/megajs stream langsung ke disk, progress tracking via `data` event counting.
- Scheduler poll 15 detik — cost DB query sangat kecil (tabel `schedules` jarang besar, query index by `status` + `start_at`). Bisa diturunkan ke 5 detik kalau butuh akurasi lebih tinggi.
- System monitor poll 3 detik — `os.cpus()` + `os.loadavg()` + `os.totalmem()/freemem()` sangat ringan.
- Progress polling UI 2 detik — query cepat (`SELECT id, status FROM videos WHERE id=?` + memory lookup). Job detail modal poll `/videos/:id/status` yang include log tail.
- Playlist advance: 1 detik delay antara video selesai dan video berikutnya start (mencegah rapid restart loop on error).
