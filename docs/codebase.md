# Codebase map

Peta detail tiap file. Pakai ini untuk memutuskan file mana yang perlu disentuh saat menambah / mengubah fitur.

## Root

### `app.js`
Entry Express. Urutan startup:
1. `require('dotenv').config()` — load `.env`
2. `ensureSchema()` — buat / migrate tabel SQLite
3. `streamManager.reconcileOnBoot()` + `transcoder.reconcileOnBoot()` + `downloader.reconcileOnBoot()` + `scheduler.reconcileOnBoot()` — reset row stale
4. `scheduler.start()` — mulai polling loop 15 detik
5. Configure session (cookie settings, SQLite session store)
6. Build `app.locals.formatTime(value)` dan `app.locals.formatTimeShort(value)` dari env `TZ` / `TZ_LABEL`
7. Mount routes: `/` (dashboard), `/login`, `/videos/*`, `/streams/*`, `/schedules/*`, `/playlists/*`
8. `GET /api/system` — JSON endpoint untuk system monitor (CPU%, RAM%, Uptime)
9. Global error handler → render `views/error.ejs`
10. `app.listen(PORT)` (default 7575 dari env `PORT`)

**Kalau mau tambah global middleware / locals / route top-level, sentuh file ini.**

### `generate-secret.js`
Generate random hex 48 bytes, tulis ke `.env` sebagai `SESSION_SECRET`. Idempotent (replace jika sudah ada key-nya, append jika belum, copy dari `.env.example` jika `.env` belum ada).

### `reset-password.js`
Interaktif via stdin (`readline`). Tanya username (default `admin`) & password, hash dengan bcrypt, insert atau update row di tabel `users`. Jalankan ini sekali setelah install.

### `package.json`
Scripts: `start`, `dev`, `generate-secret`, `reset-password`. 10 runtime deps (termasuk axios, megajs), no devDeps.

### `.env.example`
Template env: `PORT`, `SESSION_SECRET`, `NODE_ENV`, `TZ`, `TZ_LABEL`.

### `.gitignore`
Ignore `node_modules/`, `db/`, `logs/`, `public/uploads/`, `.env`, `*.log`.

## `src/`

### `src/db.js`
- Single `Database` instance dengan WAL
- `ensureSchema()` idempotent — 6 tabel: `users`, `videos`, `streams`, `schedules`, `playlists`, `playlist_items`
- Dua helper migrasi inline: `add(name, type, def)` untuk `streams` kolom baru, `addv(...)` untuk `videos`

**Sentuh file ini kalau:** tambah tabel, tambah kolom, ubah default.
**Jangan hapus kolom atau drop tabel** tanpa data migration story.

### `src/auth.js`
Dua export kecil:
- `requireAuth(req, res, next)` — redirect ke `/login` (HTML) atau 401 JSON
- `injectUser(req, res, next)` — isi `res.locals.currentUser` dari session

### `src/streamManager.js`
Live RTMP push + playlist auto-advance. API publik:
- `startStream(stream, videoPath)` — throw kalau sudah running
- `stopStream(streamId)` — SIGTERM child, update DB
- `isRunning(streamId)` → boolean
- `reconcileOnBoot()` — panggil dari `app.js` sekali saat startup
- `tailLog(streamId, lines=80)` → string (redact stream key)

Internal helpers:
- `buildRtmpTarget(url, key)` — gabung URL + key
- `redact(text, secret)` — regex replace semua occurrence key → `***REDACTED***`
- `makeRedactingStream(logStream, secret)` — wrapper writer untuk semua tulisan log
- `advancePlaylist(stream)` — cek playlist items, find next video, auto-start. Kalau `loop_playlist=1` dan sudah di akhir, wrap ke posisi 0. Return `true` kalau berhasil advance, `false` kalau playlist selesai.

**Sentuh file ini kalau:** ubah FFmpeg flag live streaming, tambah encoding option, ubah playlist advance logic, tambah mode baru (misal multi-target tee muxer).

### `src/transcoder.js`
One-shot Prepare + codec validation + media probe. API publik:
- `presets()` → object preset (720p30, 720p60, 1080p30, 1080p60)
- `start(videoId, presetName, x264Preset='medium')` — throw kalau job sudah running atau preset invalid
- `cancel(videoId)` → boolean
- `isRunning(videoId)` → boolean
- `reconcileOnBoot()` — panggil dari `app.js`
- `tailLog(videoId, lines=60)` → string (tidak ada secret yang perlu diredact di sini)
- `getProgress(videoId)` → `{percent, time, duration, speed, fps}` atau null
- `probeDuration(filePath)` → float seconds atau null (ffprobe sync)
- `probeVideoInfo(filePath)` → `{width, height, fps, duration, videoCodec, audioCodec}` — full media probe
- `validateCodec(filePath)` → `{ok, issues[], info}` — cek H.264 video + AAC audio

Behavior penting:
- Output file: `<basename>__<preset>_ready.mp4`
- Setelah success: `unlink(source)` + `rename(ready, source)` — **source file ditimpa**
- Pakai `fps=<n>`, scale-pad filter agar preset konsisten
- `-movflags +faststart` supaya file bisa di-seek cepat
- FFmpeg dijalankan dengan `-progress pipe:1 -nostats` → stdout emits key=value pairs yang di-parse ke `progress` in-memory

**Sentuh file ini kalau:** tambah preset baru, ganti strategi overwrite, tambah progress reporting, ubah codec validation logic.

### `src/downloader.js`
URL import module. Pattern mirrors transcoder.js (Map jobs, progress). API publik:
- `start(url, title)` → `{jobId, videoId, source}` — detect source, insert DB row `status='downloading'`, download async
- `getProgress(jobId)` → `{percent, downloaded, total, status, error}` atau null
- `isRunning(jobId)` → boolean
- `detectSource(url)` → `'gdrive'` | `'mega'` | `'mediafire'` | `'direct'`
- `reconcileOnBoot()` — panggil dari `app.js`

Source handlers:
- **Google Drive:** extract file ID, fetch filename dari og:title, multi-URL fallback (drive.usercontent.google.com + drive.google.com/uc), cookie handling untuk large files
- **Mega.nz:** `megajs` File.fromURL → loadAttributes → download stream
- **MediaFire:** scrape page untuk download link, follow redirect
- **Direct URL:** axios GET stream

Behavior penting:
- Insert video row immediately (user sees it in library with `downloading` status)
- On success: update `size_bytes`, probe video info (width/height/fps/duration), set `status='uploaded'`
- On failure: set `status='error'`, cleanup partial file
- Job stays in Map 30 detik setelah selesai (supaya client bisa poll final status)

**Sentuh file ini kalau:** tambah source baru (misal Dropbox, OneDrive), ubah download strategy, tambah retry logic.

### `src/scheduler.js`
Scheduled streaming runner. API publik:
- `start()` — idempotent, mulai `setInterval(tick, 15000)` + immediate first tick
- `stop()` — clear interval (dipakai untuk test atau graceful shutdown)
- `tick()` — satu iterasi logic, safe dipanggil manual
- `reconcileOnBoot()` — row `started` stale → `error`

Tidak ada state in-memory — semua di tabel `schedules`. Ini penting supaya perubahan di DB (cancel, delete, insert manual) langsung diikuti tick berikutnya.

Logic per tick:
1. SELECT pending yang `start_at <= now UTC ISO` → `streamManager.startStream(...)`, update status `started` atau `error`
2. SELECT started yang `stop_at <= now` → `streamManager.stopStream(...)`, update status `done` atau `error`
3. UPDATE open-ended `started` (stop_at IS NULL) kalau stream-nya sudah tidak running → `done`

**Sentuh file ini kalau:** ubah interval polling, tambah recurring schedule (daily/weekly), tambah retry logic.

## `src/routes/`

### `src/routes/auth.js`
- `GET /login` → render `views/login.ejs`
- `POST /login` → bcrypt compare, set `req.session`
- `POST /logout` → destroy session

### `src/routes/videos.js`
- `GET /videos` → render library (query semua + presets)
- `POST /videos/upload` → multer single file (XHR), probe video info via ffprobe, auto-suffix duplicate title, insert row `status='uploaded'`
- `POST /videos/import-url` → `downloader.start(url, title)`, redirect with notice
- `GET /videos/download/:jobId/progress` → JSON download progress
- `GET /videos/:id/progress` → JSON `{status, running, percent, time, duration, speed, fps, last_error}` (dipakai polling UI)
- `GET /videos/:id/status` → JSON gabungan progress + log tail + ETA (dipakai job detail modal)
- `POST /videos/:id/prepare` → `transcoder.start(...)`
- `POST /videos/:id/cancel-prepare` → `transcoder.cancel(...)`, set status balik
- `GET /videos/:id/prepare-log` → `text/plain` log tail
- `POST /videos/:id/delete` → cancel transcode kalau running, guard "in use by running stream", delete file

Helper internal:
- `uniqueTitle(base)` — auto-suffix ` (2)`, ` (3)`, ... kalau title sudah ada di DB

Multer config: `diskStorage`, filename `<timestamp>_<sanitized>`, 5 GB limit, ekstensi whitelist.

### `src/routes/streams.js`
- `GET /streams` → redirect ke `/streams/single`
- `GET /streams/single` → list single-video streams + presets RTMP URL
- `GET /streams/playlist` → list playlist streams + available playlists
- `POST /streams` → insert row (auto-detect single vs playlist dari body `playlist_id`)
- `POST /streams/:id/start` → codec validation (Copy mode) + `streamManager.startStream(...)`
- `POST /streams/:id/stop` → `streamManager.stopStream(...)`
- `POST /streams/:id/delete` → stop kalau running, delete row
- `GET /streams/:id/log` → `text/plain` log tail (redacted)

`PRESETS` = map platform → RTMP URL (YouTube, Facebook, Twitch, custom).

Codec validation: kalau `stream.re_encode === 0` (Copy mode), panggil `transcoder.validateCodec(videoPath)`. Kalau `check.ok === false`, redirect dengan error message dari `check.issues`.

### `src/routes/playlists.js`
- `GET /playlists` → list playlists + item count + available videos
- `POST /playlists` → insert playlist (name + loop_playlist option)
- `GET /playlists/:id` → playlist detail (items ordered by position + available videos)
- `POST /playlists/:id/add-video` → insert playlist_item di posisi terakhir + 1
- `POST /playlists/:id/remove-item/:itemId` → delete playlist_item
- `POST /playlists/:id/move-up/:itemId` → swap position dengan item di atasnya
- `POST /playlists/:id/move-down/:itemId` → swap position dengan item di bawahnya
- `POST /playlists/:id/delete` → delete semua items + delete playlist

### `src/routes/schedules.js`
- `GET /schedules` → list schedules (join streams + videos) + form opsi
- `POST /schedules` → parse datetime-local input dari zona `TZ` env ke UTC ISO, insert row `status='pending'`
- `POST /schedules/:id/cancel` → `UPDATE status='cancelled'` (hanya efektif saat `pending`)
- `POST /schedules/:id/delete` → DELETE row (bebas di status apapun)

Helper internal `parseLocalToUTC(str, tz)` handle DST & cross-day — diuji via `scripts/test-tz.js`.

## `views/`

EJS templates. Semua render melalui `include('partials/header', { title: ... })` + `include('partials/footer')`. Flash messages via `include('partials/flash', { error, notice })`.

- `partials/header.ejs` — sidebar nav (brand, nav items dengan sub-menus, user block) + topbar (page title, action slot, user pill) + open `<main>`. Mobile: hamburger toggle.
- `partials/footer.ejs` — toast root (`<div id="toast-root">`) + custom confirm modal script + close tags
- `partials/flash.ejs` — toast notification renderer (auto-dismiss 4 detik, URL cleanup via `history.replaceState`)
- `login.ejs` — form login (special: `currentUser: null` di-override)
- `dashboard.ejs` — stat cards (videos, streams, running, disk usage, next schedule) + system monitor widget (CPU/RAM/Uptime, polling `/api/system` setiap 3 detik) + recent streams table
- `videos.ejs` — upload modal (XHR progress bar) + import URL modal + library table + prepare modal (preset selector + x264 preset + source info note) + job detail modal (progress + log + ETA) + inline `<script>` untuk polling progress
- `streams-single.ejs` — new stream modal (video selector, platform preset, RTMP config) + single-video streams table
- `streams-playlist.ejs` — new stream modal (playlist selector, platform preset, RTMP config) + playlist streams table
- `playlists.ejs` — create playlist modal + playlists table (name, item count, loop status)
- `playlist-detail.ejs` — add video form + items table (position, title, duration, move up/down, remove)
- `schedules.ejs` — new schedule modal (datetime-local di zona user, stream selector) + schedules table
- `error.ejs` — generic error page

## `public/`

- `public/css/app.css` — single CSS file, dark theme, CSS variables, sidebar layout, modal styles, toast animations, progress bar, responsive (hamburger mobile)
- `public/uploads/` — runtime video files (gitignored)

## `scripts/`

One-shot / utility scripts yang **bukan** bagian dari route app:

- `smoke.js` — load test, dijalankan setelah edit. Verifies semua modul load + `ensureSchema()` sukses.
- `test-codec.js` — standalone codec validation test. Jalankan dengan path ke video file untuk cek H.264 + AAC compliance.
- `render-check.js` — verify EJS templates render tanpa error (basic syntax check).
- `ensure-tz-env.js` — tambah `TZ` / `TZ_LABEL` ke `.env` existing tanpa overwrite nilai lain.
- `fix-video-status.js` — legacy: reset baris `status='ready'` yang salah dari migrasi lama → `'uploaded'`.
- `test-tz.js` — sanity check `parseLocalToUTC` dengan 5 case (WIB, WITA, UTC, DST).

**Kalau bikin one-shot fix / migration, taruh di `scripts/`.**

## `db/` & `logs/`

Runtime directories, gitignored:
- `db/awanstream.db` — schema: users, videos, streams, schedules, playlists, playlist_items
- `db/sessions.db` — session store (dikelola `connect-sqlite3`)
- `logs/stream-<id>.log` — FFmpeg output per stream (redacted)
- `logs/transcode-<id>.log` — FFmpeg output per Prepare job

## Decision table: dimana menambah fitur

| Fitur yang mau ditambah | File yang disentuh |
|---|---|
| Route baru / halaman baru | `src/routes/<name>.js` + `views/<name>.ejs` + mount di `app.js` + link di `views/partials/header.ejs` |
| Kolom baru di tabel existing | `src/db.js` (migrasi inline) + route yang insert/update + view yang render |
| Tabel baru | `src/db.js` + biasanya module manager baru di `src/` |
| Flag FFmpeg baru untuk live | `src/streamManager.js` |
| Flag FFmpeg baru untuk Prepare | `src/transcoder.js` |
| Preset baru (resolusi/fps) | `src/transcoder.js` (`PRESETS`) + `views/videos.ejs` (dropdown) |
| Platform streaming baru | `src/routes/streams.js` (`PRESETS`) |
| Schedule trigger baru (recurring, cron) | `src/scheduler.js` + schema `schedules` |
| Login / session logic | `src/auth.js` + `src/routes/auth.js` + `app.js` session config |
| Styling | `public/css/app.css` |
| Helper untuk view | `app.js` (`app.locals.xxx`) |
| Polling UI / background JS | Inline `<script>` di view yang relevan (pattern lihat `views/videos.ejs`, `views/dashboard.ejs`) |
| CLI one-shot tool | `scripts/<name>.js` |
| URL import source baru | `src/downloader.js` (tambah handler + update `detectSource`) |
| Playlist logic | `src/routes/playlists.js` + `views/playlists.ejs` / `views/playlist-detail.ejs` |
| Playlist streaming behavior | `src/streamManager.js` (`advancePlaylist`) |
| Codec validation rules | `src/transcoder.js` (`validateCodec`) |
| System monitor metrics | `app.js` (`GET /api/system`) + `views/dashboard.ejs` (polling script) |
