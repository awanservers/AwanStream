# Codebase map

Peta detail tiap file. Pakai ini untuk memutuskan file mana yang perlu disentuh saat menambah / mengubah fitur.

## Root

### `app.js`
Entry Express. Urutan startup:
1. `require('dotenv').config()` — load `.env`
2. `ensureSchema()` — buat / migrate tabel SQLite
3. `streamManager.reconcileOnBoot()` + `transcoder.reconcileOnBoot()` + `downloader.reconcileOnBoot()` + `scheduler.reconcileOnBoot()` — reset row stale
4. `scheduler.start()` — mulai polling loop 15 detik
5. `streamManager.startHealthCheck()` — mulai polling 30 detik untuk stale stream detection + auto-retry
6. Configure session (cookie settings, SQLite session store)
7. **Morgan HTTP request logger** — NestJS-style format, colored, integer latency, skip static assets
8. Build `app.locals.formatTime(value)` dan `app.locals.formatTimeShort(value)` dari env `TZ` / `TZ_LABEL`
9. Mount routes: `/` (dashboard), `/login`, `/videos/*`, `/streams/*`, `/schedules/*`, `/playlists/*`, `/history/*`
10. `GET /api/system` — JSON endpoint untuk system monitor (CPU%, RAM%, Uptime, Net throughput, Disk)
11. `GET /api/events` — SSE endpoint real-time (auth via session cookie check, bukan requireAuth middleware)
12. Global error handler → render `views/error.ejs`
13. `app.listen(PORT)` (default 7575 dari env `PORT`)

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
- `ensureSchema()` idempotent — 8 tabel: `users`, `videos`, `streams`, `schedules`, `playlists`, `playlist_items`, `folders`, `stream_history`
- Dua helper migrasi inline: `add(name, type, def)` untuk `streams` kolom baru, `addv(...)` untuk `videos`

**Sentuh file ini kalau:** tambah tabel, tambah kolom, ubah default.
**Jangan hapus kolom atau drop tabel** tanpa data migration story.

### `src/auth.js`
Dua export kecil:
- `requireAuth(req, res, next)` — redirect ke `/login` (HTML) atau 401 JSON
- `injectUser(req, res, next)` — isi `res.locals.currentUser` dari session

### `src/streamManager.js`
Live RTMP push + playlist auto-advance + auto-retry + health check + stream history. API publik:
- `startStream(stream, videoPath)` — throw kalau sudah running
- `stopStream(streamId)` — SIGTERM child, update DB, mark `retryStopped` agar tidak di-retry
- `isRunning(streamId)` → boolean
- `reconcileOnBoot()` — panggil dari `app.js` sekali saat startup
- `tailLog(streamId, lines=80)` → string (redact stream key)
- `startHealthCheck()` / `stopHealthCheck()` — polling 30 detik detect stream stale (no FFmpeg output 5 menit), idempotent

Internal helpers:
- `buildRtmpTarget(url, key)` — gabung URL + key
- `redact(text, secret)` — regex replace semua occurrence key → `***REDACTED***`
- `makeRedactingStream(logStream, secret)` — wrapper writer untuk semua tulisan log
- `advancePlaylist(stream)` — cek playlist items, find next video (sequential atau shuffle tergantung `playlists.shuffle`), auto-start. Kalau `loop_playlist=1` dan sudah di akhir, wrap ke posisi 0. Return `true` kalau berhasil advance, `false` kalau playlist selesai.
- `saveHistory(stream, status, errorMsg)` — insert row ke `stream_history` kalau durasi >= 10 detik. Dipanggil di `stopStream()` dan di exit handler.
- `getRetryDelay(attempt)` — exponential backoff: `min(3000 * 2^n, 60000) + jitter`
- `scheduleRetry(streamId, videoPath)` — setTimeout retry sampai max 5 attempts. Reset ke 0 setelah stream berhasil jalan.

**Sentuh file ini kalau:** ubah FFmpeg flag live streaming, tambah encoding option, ubah playlist advance logic, ubah retry strategy, tambah mode baru (misal multi-target tee muxer).

### `src/transcoder.js`
One-shot Prepare + codec validation + media probe + thumbnail generation. API publik:
- `presets()` → object preset (720p30, 720p60, 1080p30, 1080p60)
- `start(videoId, presetName, x264Preset='medium')` — throw kalau job sudah running atau preset invalid
- `cancel(videoId)` → boolean
- `isRunning(videoId)` → boolean
- `reconcileOnBoot()` — panggil dari `app.js`
- `tailLog(videoId, lines=60)` → string (tidak ada secret yang perlu diredact di sini)
- `getProgress(videoId)` → `{percent, time, duration, speed, fps}` atau null
- `probeDuration(filePath)` → float seconds atau null (ffprobe sync)
- `probeVideoInfo(filePath)` → `{width, height, fps, duration, videoCodec, audioCodec}` — full media probe
- `validateCodec(filePath)` → `{ok, issues[], info}` — cek H.264 video + AAC audio, timeout 30s
- `generateThumbnail(videoPath, videoId)` — extract frame ~10% durasi → JPEG 1280×720 di `public/uploads/thumbs/thumb_<id>.jpg`. Update kolom `videos.thumbnail`. Timeout 20s, fallback ke frame 0 kalau seek gagal.

Behavior penting:
- Output file: `<basename>__<preset>_ready.mp4`
- Setelah success: `unlink(source)` + `rename(ready, source)` — **source file ditimpa**
- Pakai `fps=<n>`, scale-pad filter agar preset konsisten
- `-movflags +faststart` supaya file bisa di-seek cepat
- FFmpeg dijalankan dengan `-progress pipe:1 -nostats` → stdout emits key=value pairs yang di-parse ke `progress` in-memory
- Setelah transcode sukses, thumbnail otomatis di-regenerate (karena file source ditimpa)

**Sentuh file ini kalau:** tambah preset baru, ganti strategi overwrite, tambah progress reporting, ubah codec validation logic, ubah thumbnail size/timing.

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

### `src/chunkUpload.js`
Chunked upload manager untuk file > 50 MB (currently disabled di client-side, backend endpoints masih aktif).

State:
- `sessions: Map<sessionId, { title, fileName, totalSize, totalChunks, receivedChunks: Set, createdAt }>`

Flow:
1. Client `POST /videos/chunked/init` dengan `{ title, fileName, totalSize, chunkSize }` → server bikin session + folder `public/uploads/chunks/<sessionId>/`
2. Client `PUT /videos/chunked/:sessionId/:chunkIndex` per chunk (10 MB each)
3. Client `POST /videos/chunked/:sessionId/finalize` → server merge semua chunk jadi file final di `public/uploads/`, insert row `videos`, cleanup folder chunks

API publik:
- `initSession({ title, fileName, totalSize, chunkSize })` → `{ sessionId, totalChunks }`
- `saveChunk(sessionId, chunkIndex, buffer)` → `{ received, total }`
- `getStatus(sessionId)` → `{ received, total, receivedChunks: number[] }` untuk resume
- `finalize(sessionId)` → `{ videoId, filename }` — merge + insert DB
- `cancel(sessionId)` → delete folder chunks
- `reconcileOnBoot()` — cleanup session stale > 24 jam

**Sentuh file ini kalau:** re-enable chunked upload di client (UI di `views/videos.ejs`), tambah resume logic, ubah chunk size.

### `src/looper.js`
Video Loop tool — perpanjang clip pendek jadi video panjang dengan smooth crossfade atau fast copy. API publik:
- `start(sourceVideoId, targetSeconds, title, options)` → `{ jobId, outputVideoId, outputFilename, mode }`
  - `options.smooth` — boolean, default true (crossfade seamless di loop boundary)
  - `options.crossfadeSeconds` — number, default 1.0
  - `options.audioId` — number, optional (audio overlay dari audio_tracks)
  - `options.audioVolume` — number 0.0-1.0, default 0.3
  - `options.audioMode` — `'mix'` (default) atau `'replace'`
- `cancel(jobId)` → boolean
- `getProgress(jobId)` / `listJobs()` / `getJob(jobId)`
- `tailLog(jobId, lines)` → string
- `reconcileOnBoot()`

State: `jobs: Map<jobId, jobState>`. Job ID pakai `Date.now()` (tidak reset setelah restart).

Two-phase pipeline (smooth mode):
1. **Phase 1** — bikin seamless unit pakai `xfade` + `acrossfade` filter. Re-encode (libx264 + aac).
2. **Phase 2** — `-stream_loop -1 -i seamless -c copy -t target` + optional audio overlay via `amix`.

Output video baru di-insert ke tabel `videos` dengan status `transcoding` → `ready` setelah selesai. `loop_job_id` di-track supaya log file (`logs/loop-<jobId>.log`) bisa di-akses dari UI.

**Sentuh file ini kalau:** tambah preset durasi, ubah crossfade strategy, tambah filter video (zoom/crop untuk hide watermark), ubah audio mix logic.

### `src/audioManager.js`
Audio Library manager — terpisah dari videos. API publik:
- `register({ title, filename, size })` — insert DB row + probe async, return audio id
- `getFilePath(audioId)` → absolute path atau null
- `remove(audioId)` → `{ ok, error? }` — guard against running streams
- `list()` / `listReady()` / `get(audioId)`
- `probe(filePath)` → `{ duration, codec, bitrate, sampleRate, channels }`
- `isSupportedFilename(name)` — check ekstensi (mp3/m4a/aac/wav/ogg/opus/flac/wma)
- `reconcileOnBoot()` — placeholder untuk future download-from-URL feature

Storage: `public/uploads/audio/` (terpisah dari video `public/uploads/`).

Probe dilakukan async via `setImmediate()` setelah upload — non-blocking response.

**Sentuh file ini kalau:** tambah format audio baru, tambah download-from-URL untuk audio, tambah preview player.

### `src/youtubeManager.js`
YouTube OAuth manager — Phase 1 dari YouTube integration. API publik:
- `isConfigured()` → boolean (cek env vars)
- `getAuthUrl()` → string (URL untuk consent screen)
- `exchangeCodeAndStore(code)` → `{ channelId, channelTitle }` — exchange auth code, fetch channel info, persist ke DB
- `getAccount()` → row dari `youtube_accounts` atau null
- `getAuthedClient()` → OAuth2 client object (auto-refresh via `oauth2.on('tokens')`) atau null
- `getStatus()` → `{ connected, configured, channelTitle?, channelId?, connectedAt? }`
- `disconnect()` → `{ ok, alreadyDisconnected?, revokeError? }` — revoke di Google + clear DB
- `reconcileOnBoot()`

Single-account model — `DELETE FROM youtube_accounts` sebelum INSERT supaya cuma 1 row.

OAuth scopes: `youtube.upload` + `youtube.readonly`.

**Sentuh file ini kalau:** tambah multi-account support (jadi tabel `youtube_accounts` punya banyak row), tambah encrypt token at rest (pakai SESSION_SECRET sebagai key).

### `src/youtubeUploader.js`
YouTube upload manager — Phase 2 dari YouTube integration. API publik:
- `start(videoId, options)` → `{ jobId, uploadId }`
  - `options.title` — default `videos.title`
  - `options.privacy` — `'private'` | `'unlisted'` (default) | `'public'`
  - `options.categoryId` — default `'10'` (Music)
- `cancel(jobId)` → boolean
- `getProgress(jobId)` → jobState atau null
- `listJobs()` → array of in-memory jobs
- `getLatestUploadForVideo(videoId)` → row dari `youtube_uploads` atau null (priority: status='done' first)
- `tailLog(uploadId, lines)` → string
- `reconcileOnBoot()` — reset stale `pending`/`uploading` rows

State: `jobs: Map<jobId, { jobState, abortController, logStream }>`.

Resumable upload via `googleapis` library — `youtube.videos.insert({ media: { body: fs.createReadStream(...) } }, { signal })`. Library handle chunked transfer + auto-retry transparently. AbortController untuk cancel.

Progress tracking via `onUploadProgress` callback — persist ke DB tiap 5% (avoid hammering DB).

Tabel `youtube_uploads` track full lifecycle: status, bytes_sent, total_bytes, percent, last_error, started_at, finished_at, youtube_video_id (set saat selesai).

**Sentuh file ini kalau:** tambah set thumbnail via API, tambah set tags/description templates, tambah schedule publish via API, tambah resume across server restarts.

## `src/routes/`

### `src/routes/auth.js`
- `GET /login` → render `views/login.ejs`
- `POST /login` → bcrypt compare, set `req.session`
- `POST /logout` → destroy session

### `src/routes/videos.js`
- `GET /videos` → render library dengan pagination 20/page (query param `page`, `folder`). Annotate setiap video dengan YouTube upload state (active job atau latest DB row).
- `POST /videos/upload` → multer single file (XHR), probe video info via ffprobe (termasuk `has_audio`), generate thumbnail async via `setImmediate()`, auto-suffix duplicate title
- `POST /videos/import-url` → `downloader.start(url, title)`
- `GET /videos/download/:jobId/progress` → JSON download progress
- `GET /videos/:id/progress` → JSON polling
- `GET /videos/:id/status` → JSON progress + log tail + ETA (job detail modal)
- `POST /videos/:id/prepare` / `cancel-prepare` / `GET /videos/:id/prepare-log`
- `POST /videos/:id/edit` → rename + move folder (dengan guard: tidak boleh duplicate title)
- `POST /videos/:id/regen-thumb` → manual trigger `generateThumbnail()`
- `POST /videos/:id/move-folder` → single-video folder change
- `POST /videos/:id/delete` → cancel transcode kalau running, guard "in use by running stream", delete file + thumbnail
- **Folder CRUD:**
  - `POST /videos/folders/create` — buat folder
  - `POST /videos/folders/:id/rename` — rename
  - `POST /videos/folders/:id/delete` — hapus folder (video di dalamnya dipindah ke unfiled, tidak ikut terhapus)
  - `POST /videos/folders/:id/prepare-all` — bulk prepare semua video `uploaded` di folder
  - `POST /videos/folders/:id/create-playlist` — create playlist dengan nama folder + isi semua video `ready`
  - `POST /videos/folders/:id/delete-videos` — hapus semua video di folder (skip yang sedang dipakai running stream)
- **Chunked upload:**
  - `POST /videos/chunked/init` → init session
  - `GET /videos/chunked/:id/status` → status untuk resume
  - `PUT /videos/chunked/:id/:chunkIndex` → save chunk (raw body via `express.raw`)
  - `POST /videos/chunked/:id/finalize` → merge + insert row
  - `DELETE /videos/chunked/:id` → cancel + cleanup

Helper internal:
- `uniqueTitle(base)` — auto-suffix ` (2)`, ` (3)`, ... kalau title sudah ada di DB

Multer config: `diskStorage`, filename `<timestamp>_<sanitized>`, 5 GB limit, ekstensi whitelist.

### `src/routes/streams.js`
- `GET /streams` → redirect ke `/streams/single`
- `GET /streams/single` → list single-video streams + presets RTMP URL (object `{label, url}` dengan label capitalized)
- `GET /streams/playlist` → list playlist streams + available playlists
- `POST /streams` → insert row (auto-detect single vs playlist dari body `playlist_id`)
- `POST /streams/:id/start` → codec validation (Copy mode) + `streamManager.startStream(...)`
- `POST /streams/:id/stop` → `streamManager.stopStream(...)` — mark `retryStopped` flag agar tidak di-auto-retry
- `POST /streams/:id/edit` → update config (guard: tidak boleh edit kalau running)
- `POST /streams/:id/delete` → stop kalau running, delete row
- `GET /streams/:id/log` → `text/plain` log tail (redacted, dipakai stream log modal auto-refresh)

`PRESETS` = map platform key → `{label, url}`:
- `youtube`: `rtmp://x.rtmp.youtube.com/live2` (note: letter `x`, bukan `a`)
- `facebook`: `rtmps://live-api-s.facebook.com:443/rtmp`
- `twitch`: `rtmp://live.twitch.tv/app`
- `custom`: empty URL (user isi manual)

Codec validation: kalau `stream.re_encode === 0` (Copy mode), panggil `transcoder.validateCodec(videoPath)`. Kalau `check.ok === false`, redirect dengan error message dari `check.issues`.

### `src/routes/playlists.js`
- `GET /playlists` → list playlists dengan 4 thumbnail pertama untuk collage + item count + available videos
- `POST /playlists` → insert playlist dengan multi-video picker (body `video_ids[]` → loop insert `playlist_items`)
- `GET /playlists/:id` → playlist detail (items ordered by position + available videos)
- `GET /playlists/:id/state.json` → JSON `{ playlist, itemIds, videos }` untuk manage modal
- `POST /playlists/:id/sync` → JSON body `{ video_ids }` → diff add/remove
- `POST /playlists/:id/settings` → update nama + loop + shuffle
- `POST /playlists/:id/add-video` → insert playlist_item di posisi terakhir + 1
- `POST /playlists/:id/remove-item/:itemId` → delete playlist_item
- `POST /playlists/:id/move-up/:itemId` → swap position dengan item di atasnya
- `POST /playlists/:id/move-down/:itemId` → swap position dengan item di bawahnya
- `POST /playlists/:id/delete` → delete semua items + delete playlist

### `src/routes/history.js`
Stream history management.
- `GET /history` → tabel semua row `stream_history` order by `stopped_at DESC`
- `POST /history/:id/delete` → hapus 1 entry
- `POST /history/clear` → clear semua history (`DELETE FROM stream_history`)

History di-insert otomatis oleh `streamManager.saveHistory()` saat stream stop/error dengan durasi >= 10 detik. Route ini read-only + delete, tidak ada INSERT endpoint.

### `src/routes/schedules.js`
- `GET /schedules` → list schedules (join streams + videos) + form opsi
- `POST /schedules` → parse datetime-local input dari zona `TZ` env ke UTC ISO, insert row `status='pending'`
- `POST /schedules/:id/cancel` → `UPDATE status='cancelled'` (hanya efektif saat `pending`)
- `POST /schedules/:id/delete` → DELETE row (bebas di status apapun)

Helper internal `parseLocalToUTC(str, tz)` handle DST & cross-day — diuji via `scripts/test-tz.js`.

## `views/`

EJS templates. Semua render melalui `include('partials/header', { title: ... })` + `include('partials/footer')`. Flash messages via `include('partials/flash', { error, notice })`.

- `partials/header.ejs` — sidebar nav (brand, nav items dengan sub-menus termasuk History link, user block) + topbar (page title, action slot, user pill) + open `<main>`. Mobile: hamburger toggle.
- `partials/footer.ejs` — toast root (`<div id="toast-root">`) + custom confirm modal script + stream-key show/hide toggle global handler + close tags
- `partials/flash.ejs` — toast notification renderer (auto-dismiss 4 detik, URL cleanup via `history.replaceState`)
- `login.ejs` — form login (special: `currentUser: null` di-override)
- `dashboard.ejs` — stat cards (videos, streams, running, disk usage, next schedule) + system monitor widget (CPU/RAM/Disk/Network/Uptime, SSE dengan fallback polling `/api/system`) + recent streams table (thumbnail 140×79 + platform capitalized + icon actions Start/Stop/external link) + stream duration timer
- `videos.ejs` — upload modal (XHR progress bar) + import URL modal + library table dengan pagination 20/page + folder bar chips + edit video modal + prepare modal (preset selector + x264 preset + source info note) + job detail modal (progress + log + ETA) + video preview player modal + inline `<script>` untuk polling progress
- `streams-single.ejs` — new stream modal (video selector, platform preset, RTMP config, stream key show/hide toggle) + single-video streams table dengan icon actions (Start/Stop/Edit/Log/Delete) + edit stream modal + stream log modal (auto-refresh 3s)
- `streams-playlist.ejs` — new stream modal (playlist selector) + playlist streams table dengan icon actions + edit modal + log modal
- `playlists.ejs` — new playlist modal dengan multi-video picker (search filter, checkbox, thumbnails, select all/clear) + playlists table dengan collage thumbnail 2×2 + manage modal (AJAX sync add/remove) + edit settings modal
- `playlist-detail.ejs` — add video form + items table dengan thumbnail (position, title, duration, move up/down, remove) + settings modal (loop/shuffle/rename)
- `history.ejs` — stream history tabel (name, video, platform, duration, status, stopped_at) + delete per row + clear all button
- `schedules.ejs` — new schedule modal (datetime-local di zona user, stream selector) + schedules table
- `error.ejs` — generic error page

## `public/`

- `public/css/app.css` — single CSS file, dark theme, CSS variables, sidebar layout, modal styles, toast animations, progress bar, btn-icon variants, folder bar chips, playlist collage grid, video picker, input-with-toggle (eye button), responsive (hamburger mobile)
- `public/uploads/` — runtime video files (gitignored)
- `public/uploads/thumbs/` — generated thumbnails `thumb_<id>.jpg` (gitignored)
- `public/uploads/chunks/` — temporary chunk storage untuk chunked upload (gitignored)

## `scripts/`

One-shot / utility scripts yang **bukan** bagian dari route app:

- `smoke.js` — load test, dijalankan setelah edit. Verifies semua modul load + `ensureSchema()` sukses.
- `test-codec.js` — standalone codec validation test. Jalankan dengan path ke video file untuk cek H.264 + AAC compliance.
- `render-check.js` — verify EJS templates render tanpa error (basic syntax check).
- `generate-thumbs.js` — bulk generate thumbnail untuk video existing. Flag `--force` untuk regenerate semua (default skip yang sudah ada).
- `ensure-tz-env.js` — tambah `TZ` / `TZ_LABEL` ke `.env` existing tanpa overwrite nilai lain.
- `fix-video-status.js` — legacy: reset baris `status='ready'` yang salah dari migrasi lama → `'uploaded'`.
- `test-tz.js` — sanity check `parseLocalToUTC` dengan 5 case (WIB, WITA, UTC, DST).

**Kalau bikin one-shot fix / migration, taruh di `scripts/`.**

## `db/` & `logs/`

Runtime directories, gitignored:
- `db/awanstream.db` — schema: users, videos, streams, schedules, playlists, playlist_items, folders, stream_history
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
| System monitor metrics | `app.js` (`GET /api/system` dan `GET /api/events` SSE) + `views/dashboard.ejs` (SSE consumer + polling fallback) |
| Stream history | `src/streamManager.js` (`saveHistory`) + `src/routes/history.js` + `views/history.ejs` |
| Stream auto-retry behavior | `src/streamManager.js` (`scheduleRetry`, `getRetryDelay`, `retryCount` Map) |
| Video thumbnail | `src/transcoder.js` (`generateThumbnail`) + `scripts/generate-thumbs.js` (bulk) |
| Folder CRUD / bulk actions | `src/routes/videos.js` (folder endpoints) + `views/videos.ejs` (folder bar) |
| Chunked upload (re-enable) | `src/chunkUpload.js` (backend) + `views/videos.ejs` (client script rewrite) |
| Morgan logger customization | `app.js` (morgan format tokens + skip function) |
