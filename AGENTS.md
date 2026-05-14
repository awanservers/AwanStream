# AGENTS.md — AwanStream

Instruksi ringkas untuk AI coding agents yang melanjutkan project ini. Ini adalah entry point — baca dulu, lalu lompat ke `docs/` kalau butuh detail.

## Apa ini

AwanStream adalah web app untuk **live streaming pre-recorded video ke platform RTMP** (YouTube Live, Facebook Live, Twitch, custom) **plus tooling pendukung untuk channel YouTube ambient/24-7** (loop tool, audio overlay, YouTube upload). Terinspirasi [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow), tapi versi simple. Self-hosted, single-admin.

Fitur utama:

### Library
- **Video Library** dengan pagination (20/page), folder organizer, thumbnail 1280×720 auto-generate, edit title + folder via modal
- **Audio Library** terpisah (MP3/M4A/AAC/WAV/OGG/OPUS/FLAC/WMA) — upload XHR dengan progress bar, max 500 MB
- Upload video dari PC (XHR progress bar) atau **import dari URL** (Google Drive, Mega, MediaFire, direct link)
- Auto-suffix duplicate titles (`Video (2)`, `Video (3)`, ...)
- **Tombol Download** di video library + audio library (filename dari title, RFC 6266 compliant)
- **Thumbnail tools** untuk YouTube — capture frame at custom time via preview modal, download thumbnail JPEG

### Production tools
- **Prepare** — transcode sekali ke stream-ready (H.264 + AAC + GOP 2 detik) dengan **progress bar live + ETA**
  - Presets: 720p30, 720p60, 1080p30, 1080p60 + pilihan x264 preset
  - Auto-detect source resolution, live note tentang preset compatibility
  - Bulk prepare per folder
- **Loop tool** — perpanjang clip pendek jadi video panjang (30 menit - 24 jam) untuk 24/7 livestream / YouTube upload
  - Smooth mode (crossfade seamless) + Fast mode (`-c copy`)
  - **Audio overlay opsional** (mix atau replace) — pas untuk fireplace + jazz workflow
- **Job detail modal** — progress + FFmpeg log inline, ETA

### Streaming
- **Playlist management** — create dengan multi-select video picker, Manage modal (AJAX add/remove), Shuffle mode, Collage thumbnail 2×2
- **Stream — Single Video** (Copy mode enforced, codec validation sebelum start)
- **Stream — Playlist** (sequential / shuffle auto-advance, loop playlist)
- **Audio overlay saat streaming** — mix audio track terpisah dengan video real-time
- **Stream actions** sepenuhnya icon-based: Start, Stop, Edit (modal), Log (modal dengan auto-refresh), Delete
- **Stream key show/hide toggle** (icon mata) untuk keamanan UX
- **Auto-Retry + Health Check** — FFmpeg crash retry 5x dengan exponential backoff, stale stream auto-kill
- **Scheduled streaming** — auto-start / auto-stop berdasarkan tabel `schedules`, timezone-aware
- **Stream History** — riwayat sesi streaming yang sudah selesai, minimum 10 detik
- **Stream Duration Timer** — live counter 🔴 2h 15m 30s, update per detik
- **Codec validation** sebelum stream start (H.264 + AAC check)

### YouTube Upload
- **OAuth2 connection** — connect ke YouTube channel via standard Google OAuth flow
- **Tombol Upload to YouTube** di video library — modal dengan title, privacy (Unlisted default), category
- **Resumable upload** via `googleapis` library — handle chunked transfer + auto-retry
- **Progress real-time** dengan polling 2 detik, **resume mode** kalau modal di-close
- **Cancel mid-upload** via AbortController
- **Live progress badge** di video row (icon biru dengan percent)
- **Setelah upload:** "Open in YouTube Studio" + "View on YouTube" untuk edit metadata + publish manual

### UI / UX
- **Sidebar layout** dengan 2 parent groups: **Library** (Videos + Audio + Playlists) + **Streams** (Single Stream + Playlist Stream + Schedules + History)
- **Modal dialogs** (native `<dialog>`) untuk semua form
- **Custom confirm modal** (menggantikan native `confirm()`)
- **Toast notifications** (auto-dismiss, URL cleanup via `history.replaceState`)
- **System monitor** real-time (CPU/RAM/Uptime polling setiap 3 detik) di Dashboard
- **HTTP Request Logger** (morgan) — format NestJS-style dengan warna
- Dark theme, responsive (hamburger mobile)
- **Protected media serving** — `public/uploads/` tidak di-expose static; semua media via auth-protected routes

## Tech stack

- Node.js 18+ (dev: v20.20.2)
- Express 4 + EJS views + plain CSS
- SQLite via `better-sqlite3` (sync API)
- `express-session` + `connect-sqlite3` untuk session
- `multer` untuk upload (video + audio dengan limit & filter terpisah)
- `morgan` untuk HTTP request logging (NestJS-style custom format)
- `bcryptjs` untuk password hash
- `axios` untuk HTTP download (Google Drive, MediaFire, direct URL)
- `megajs` untuk Mega.nz download
- **`googleapis`** untuk YouTube OAuth + upload (resumable)
- **FFmpeg + ffprobe** (dari system `$PATH`) untuk transcode, RTMP push, codec validation, media probe, loop, audio mix
- Child process spawn per stream / per transcode job — **bukan** queue terpusat
- `setInterval` 15 detik di main process untuk scheduler (no external cron)
- `setInterval` 30 detik untuk health check stream (detect stale)

## Struktur file penting

```
app.js                 Entry Express; mounts routes, configures session,
                       morgan HTTP logger, formatTime helper, scheduler start,
                       /api/system + /api/events SSE endpoints. Static
                       middleware HANYA serve /css (uploads via protected route).
src/db.js              SQLite schema + lightweight ALTER TABLE migrations.
                       Tabel: users, videos, streams, schedules, playlists,
                       playlist_items, stream_history, folders, audio_tracks,
                       youtube_accounts, youtube_uploads.
src/auth.js            requireAuth middleware + injectUser locals.
src/streamManager.js   FFmpeg manager untuk live streaming (Map streamId → proc).
                       Redacts stream key di semua tulisan log. Audio overlay
                       support (amix filter, optional 2nd input). Playlist
                       auto-advance, auto-retry exp backoff, health check.
src/transcoder.js      FFmpeg manager untuk "Prepare" + codec validation +
                       media probe + thumbnail generation (atSecond opsional).
src/downloader.js      URL import (Google Drive, Mega, MediaFire, direct).
src/scheduler.js       setInterval(tick, 15s) auto-start / auto-stop streams.
src/looper.js          Video loop tool (smooth crossfade + fast mode) dengan
                       audio overlay opsional (mix/replace). Pattern mirrors
                       transcoder.js — Map jobs, progress, reconcileOnBoot.
src/audioManager.js    Audio tracks manager (probe, register, remove, list).
                       File disimpan di public/uploads/audio/ (terpisah dari video).
src/youtubeManager.js  YouTube OAuth — buildOAuthClient, getAuthUrl,
                       exchangeCodeAndStore, getAuthedClient (auto-refresh
                       via 'tokens' event), disconnect.
src/youtubeUploader.js YouTube upload — start, cancel, getProgress, listJobs.
                       Resumable upload via googleapis. AbortController untuk
                       cancel. Tabel youtube_uploads track progress + status.
src/chunkUpload.js     Chunked upload backend (currently disabled di client-side).
src/routes/auth.js     /login /logout
src/routes/videos.js   /videos dengan pagination + folder filter
                       + /videos/:id/{prepare,progress,status,edit,
                         regen-thumb (terima at_second), move-folder,
                         cancel-prepare, delete, file, download, thumb,
                         thumb/download}
                       + folders CRUD + chunked upload endpoints
                       + import-url + download progress
                       + youtube-upload state annotation per video row
src/routes/streams.js  /streams/single + /streams/playlist
                       + /streams/:id/{start,stop,log,edit,delete}
                       + audio_id + audio_volume support
src/routes/playlists.js /playlists CRUD + state.json + sync (diff add/remove)
src/routes/history.js  /history (list + delete + clear all)
src/routes/schedules.js /schedules CRUD — datetime-local → UTC ISO
src/routes/looper.js   /looper (form + active jobs + recent errors)
                       + /start, /:jobId/{cancel,log}, /video/:videoId/log,
                       + /progress (JSON)
src/routes/audio.js    /audio (list) + /upload (XHR) + /:id/{delete,rename,download}
src/routes/youtube.js  /youtube (status), /connect, /callback (OAuth flow),
                       /disconnect + /upload/:videoId, /upload/:jobId/{progress,
                       cancel}, /uploads/active
views/                 EJS templates, partials di views/partials/
  videos.ejs           Library + upload/import modal + folder bar + edit
                       modal + prepare modal + job detail modal +
                       video preview player (capture thumbnail + download)
                       + youtube upload modal (resume mode)
  streams-single.ejs   Single video stream + audio overlay dropdown
  streams-playlist.ejs Playlist stream + audio overlay dropdown
  playlists.ejs        Playlist list + collage + new modal + manage modal
  playlist-detail.ejs  Playlist items + reorder + settings modal
  history.ejs          Stream history tabel
  dashboard.ejs        Stats + system monitor + recent streams
  schedules.ejs        Schedule management
  looper.ejs           Loop tool form + active jobs + recent errors
                       + audio overlay section (track + mode + volume)
                       + log modal
  audio.ejs            Audio library + upload modal + rename modal
  youtube.ejs          OAuth status (3 states: not-configured, not-connected,
                       connected) + setup guide inline + disconnect
  partials/header.ejs  Sidebar nav (Library + Streams parents) + topbar
  partials/footer.ejs  Toast root + confirm modal + stream-key toggle
  partials/flash.ejs   Toast notification renderer
scripts/
  smoke.js             Load-test semua module + render-check semua view
  test-codec.js        Standalone codec validation test
  generate-thumbs.js   Bulk generate thumbnail untuk video existing
  ensure-tz-env.js     One-shot: tambahkan TZ & TZ_LABEL ke .env existing
  fix-video-status.js  One-shot legacy fix
  render-check.js      Verify EJS templates render tanpa error
  test-tz.js           Sanity check parseLocalToUTC
public/css/app.css     Single CSS file, dark theme, sidebar, modals, toast,
                       progress bar, folder bar chips, playlist collage,
                       video picker, btn-icon variants, input-with-toggle.
public/uploads/        Tempat semua video (gitignored, served via /videos/:id/file)
public/uploads/thumbs/ Generated thumbnails (served via /videos/:id/thumb)
public/uploads/audio/  Audio tracks (served via /audio/:id/download)
public/uploads/chunks/ Temporary chunk storage (gitignored)
db/                    SQLite files (gitignored)
logs/                  stream-<id>.log + transcode-<id>.log + loop-<id>.log
                       + youtube-upload-<id>.log (gitignored)
docs/
  features.md          Per-feature reference (user-facing + technical)
  architecture.md      Diagram request flow & state machines
  codebase.md          Detail tiap file
  services.md          API reference modul backend
  deployment.md        systemd / pm2 / docker + reverse proxy
  youtube-setup.md     Step-by-step OAuth credentials di Google Cloud Console
```

## Cara menjalankan

```bash
npm install
node generate-secret.js     # populate .env dengan SESSION_SECRET
node reset-password.js      # buat / reset admin user (interaktif)
npm start                   # http://localhost:7575
```

Untuk fitur YouTube upload, set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI` di `.env` — lihat `docs/youtube-setup.md`.

## Environment notes (WSL + nvm)

Kalau kamu AI yang jalan di Windows host dan ngetik command ke WSL via `wsl bash -c "..."`, Node.js yang di-install via nvm **tidak akan ketemu** — nvm hanya di-load di interactive shell. Pakai `bash -ic` biar `.bashrc` (tempat nvm di-setup) ter-load:

```bash
wsl bash -ic "cd /home/<user>/<project> && node scripts/smoke.js"
```

Bukan `bash -lc` (login shell, tidak load `.bashrc`) atau `bash -c` (non-interactive).

PowerShell kadang print exit code -1 palsu untuk `wsl bash -ic ...` — cek output stdout, bukan exit code. Kalau stdout menunjukkan hasil yang diharapkan, command sebenarnya sukses.

Lihat `docs/deployment.md` section "WSL (Ubuntu 24.04) development notes" untuk detail lengkap.

## Wajib dilakukan sebelum menyerahkan perubahan

1. **Jalankan smoke test:**
   ```bash
   node scripts/smoke.js
   ```
   Harus print `schema OK` + `modules OK` + semua view PASS. Ini verifies semua modul load, tidak ada circular require, `ensureSchema()` sukses (termasuk migrasi ALTER TABLE baru), dan semua EJS template render tanpa error.

2. **Cek diagnostics** file yang diedit kalau ada tool-nya, atau manual load test:
   ```bash
   node -e "require('./src/FILENAME')"
   ```

3. **Jangan commit `.env`, `db/`, `logs/`, `public/uploads/`, atau `node_modules/`.** Sudah di-gitignore.

## Konvensi & rules

- **Stream key adalah secret.** Jangan pernah log, jangan pernah kirim ke client, jangan pernah tulis ke file. Di `streamManager.js` ada `makeRedactingStream` yang wajib dipakai untuk semua tulisan log ffmpeg.
- **YouTube tokens (access + refresh) adalah secret.** Disimpan di tabel `youtube_accounts`. Jangan log, jangan kirim ke client. DB di-`.gitignore`.
- **Route pattern:** form POST → mutate DB → `res.redirect('/page?notice=...'|'?error=...')`. Hindari JSON endpoint kecuali benar-benar perlu (contoh: `/videos/:id/status` JSON untuk modal polling, `/api/system` untuk system monitor, semua endpoint upload progress).
- **Modals:** semua form New/Edit pakai native `<dialog>`. Trigger via `data-open-modal="modalId"`, close via `data-close-modal` / ESC / backdrop click.
- **Confirmations:** jangan pakai `onsubmit="return confirm(...)"`. Pakai attribute declarative:
  ```html
  <form data-confirm="message" data-confirm-title="Judul" data-confirm-action="Hapus">
  ```
  Global listener di `views/partials/footer.ejs` otomatis render modal dark yang konsisten.
- **Flash messages:** `partials/flash.ejs` render sebagai toast (pojok kanan atas, auto-dismiss 4 detik). URL cleanup via `history.replaceState`.
- **Timestamps:** semua view wajib render timestamp via `formatTime(value)` (helper di `app.locals`). Jangan tampilkan mentah `v.created_at`.
- **Schema changes:** tambah kolom lewat `PRAGMA table_info` guard di `ensureSchema()`, bukan migration framework. Lihat pola `add()` dan `addv()` di `src/db.js`.
- **Status state machines:**
  - Video: `uploaded` | `downloading` → `transcoding` → `ready` | `error`
  - Stream: `idle` → `running` → `idle` | `error`
  - Schedule: `pending` → `started` → `done` | `error` | `cancelled`
  - YouTube upload: `pending` → `uploading` → `done` | `error` | `cancelled`
  - Loop job: in-memory only (transcoding via videos.status)
  - Audio track: `uploaded` | `error`
  - Kalau bikin status baru, update badge di `views/*.ejs` dan CSS di `public/css/app.css`.
- **Background processes:** setiap manager (streamManager, transcoder, downloader, scheduler, looper, audioManager, youtubeManager, youtubeUploader) **wajib** punya `reconcileOnBoot()` yang reset row stale setelah restart, dan di-call di `app.js`.
- **Time storage:** SQLite `CURRENT_TIMESTAMP` untuk row timestamps biasa; UTC ISO string (`Z` suffix) untuk schedule triggers (`schedules.start_at`, `schedules.stop_at`). Render ke zona lokal via `formatTime()`. Parse datetime-local input via `parseLocalToUTC(str, tz)` pattern (lihat `src/routes/schedules.js`).
- **Media serving:** `public/uploads/` BUKAN di-serve via `express.static`. Semua akses lewat protected route (`/videos/:id/file`, `/videos/:id/thumb`, `/videos/:id/download`, `/audio/:id/download`). Jangan reference `<img src="/uploads/...">` atau `<video src="/uploads/...">` di view.
- **FFmpeg paths:** pakai `path.join(__dirname, '..', 'public', 'uploads')`, jangan hard-code path absolut.
- **Sidebar groups:**
  - **Library** parent → Videos (`/videos`) + Audio (`/audio`) + Playlists (`/playlists`)
  - **Streams** parent → Single Stream (`/streams/single`) + Playlist Stream (`/streams/playlist`) + Schedules (`/schedules`) + History (`/history`)
  - Top-level: Loop (`/looper`) + YouTube (`/youtube`)
- **Bahasa UI:** Indonesia ringan campur Inggris teknis (sesuai style project). Commit message: bebas.
- **Security defaults:** cookie `httpOnly: true`, `sameSite: 'lax'`, `secure: NODE_ENV === 'production'`. Jangan turunkan.

## Do / Don't

**Do:**
- Baca `docs/codebase.md` kalau ragu file mana yang harus disentuh.
- Tambah entry di `CHANGELOG.md` untuk perubahan user-visible.
- Jalankan `node scripts/smoke.js` setelah edit.
- Pakai `transcoder.validateCodec(path)` sebelum start stream di Copy mode.
- Pakai `uniqueTitle(base)` pattern di route videos untuk auto-suffix duplicate titles.
- Pakai `audioManager.getFilePath(id)` untuk resolve audio file path (jangan query langsung tabel videos).
- Pakai `youtubeManager.getAuthedClient()` untuk dapat OAuth2 client yang auto-refresh.

**Don't:**
- Jangan introduce framework baru (Next.js, React, TypeScript, ORM) tanpa diskusi. Project ini sengaja simple.
- Jangan tulis stream key, password, SESSION_SECRET, YouTube tokens, OAuth client_secret ke log atau response.
- Jangan pakai `exec()` dengan user input untuk FFmpeg — selalu `spawn()` dengan args array.
- Jangan overwrite file user tanpa safeguard. Transcoder hanya menimpa file original **setelah** file output sudah sukses dibuat.
- Jangan delete file `public/uploads/*` kalau ada row `videos` yang refer — hapus row dulu.
- Jangan reference `/uploads/...` di view — pakai protected route (`/videos/:id/file`, `/videos/:id/thumb`).
- Jangan store OAuth credentials (client_secret) di DB — itu app-level secret, simpan di `.env`. Tabel `youtube_accounts` hanya untuk user-level tokens (access + refresh).

## Next steps yang mungkin diminta user

Urut dari yang paling feasible:
1. **Multi-platform broadcast** — satu source → beberapa RTMP target via FFmpeg `tee` muxer.
2. **Real-time status via WebSocket/SSE** untuk semua progress (sekarang sebagian polling, sebagian SSE).
3. **Recurring schedules** — daily/weekly repeat via cron-like pattern.
4. **Global active uploads panel** di topbar — visible di semua halaman (sekarang cuma di /videos).
5. **App settings page** — ubah timezone, label, dll dari UI (bukan edit .env + restart).
6. **Bulk upload** — multi-file picker, upload banyak video sekaligus.
7. **Drag & drop reorder** — untuk playlist items, replace tombol ↑↓.
8. **Disk usage warning** — alert di dashboard kalau disk > 85%.
9. **Re-enable chunked upload** — backend sudah ada (`src/chunkUpload.js`), tinggal wire ke client dengan logic resume yang robust.
10. **YouTube Phase 3** — set thumbnail via API, set tags/description templates, schedule publish via API.
11. **Encrypt YouTube tokens at rest** — pakai SESSION_SECRET sebagai master key untuk encrypt access_token + refresh_token di DB.

## Lihat juga

- `README.md` — user-facing quick start & troubleshooting
- `docs/features.md` — **referensi per-fitur** (user-facing + technical)
- `docs/architecture.md` — diagram request flow & data model
- `docs/codebase.md` — detail tiap file
- `docs/services.md` — API reference modul backend
- `docs/deployment.md` — systemd / pm2 / docker + reverse proxy
- `docs/youtube-setup.md` — Google Cloud Console + OAuth setup
- `CHANGELOG.md` — history perubahan
