# AGENTS.md — AwanStream

Instruksi ringkas untuk AI coding agents yang melanjutkan project ini. Ini adalah entry point — baca dulu, lalu lompat ke `docs/` kalau butuh detail.

## Apa ini

AwanStream adalah web app untuk **live streaming pre-recorded video ke platform RTMP** (YouTube Live, Facebook Live, Twitch, custom). Terinspirasi [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow), tapi versi simple. Self-hosted, single-admin.

Fitur utama:
- **Video Library** dengan pagination (20/page), folder organizer, thumbnail 1280×720 auto-generate, edit title + folder via modal
- Upload video dari PC (XHR progress bar) atau **import dari URL** (Google Drive, Mega, MediaFire, direct link)
- Auto-suffix duplicate titles (`Video (2)`, `Video (3)`, ...)
- **Prepare** — transcode sekali ke stream-ready (H.264 + AAC + GOP 2 detik) dengan **progress bar live + ETA**
  - Presets: 720p30, 720p60, 1080p30, 1080p60 + pilihan x264 preset
  - Auto-detect source resolution, live note tentang preset compatibility
  - Bulk prepare per folder
- **Job detail modal** — progress + FFmpeg log inline, ETA
- **Playlist management** — create dengan multi-select video picker, Manage modal (AJAX add/remove), Shuffle mode, Collage thumbnail 2×2
- **Stream — Single Video** (Copy mode enforced, codec validation sebelum start)
- **Stream — Playlist** (sequential / shuffle auto-advance, loop playlist)
- **Stream actions** sepenuhnya icon-based: Start, Stop, Edit (modal), Log (modal dengan auto-refresh), Delete
- **Stream key show/hide toggle** (icon mata) untuk keamanan UX
- **Auto-Retry + Health Check** — FFmpeg crash retry 5x dengan exponential backoff, stale stream (no output 5 menit) auto-kill
- **Scheduled streaming** — auto-start / auto-stop berdasarkan tabel `schedules`, timezone-aware
- **Stream History** — riwayat sesi streaming yang sudah selesai, minimum 10 detik
- **Stream Duration Timer** — live counter 🔴 2h 15m 30s, update per detik
- **System monitor** real-time (CPU/RAM/Uptime polling setiap 3 detik)
- **HTTP Request Logger** (morgan) — format NestJS-style dengan warna
- **Sidebar layout** dengan sub-menus (Videos: Library + Playlists, Streams: Single Video + Playlist)
- **Modal dialogs** (native `<dialog>`) untuk semua form
- **Custom confirm modal** (menggantikan native `confirm()`)
- **Toast notifications** (auto-dismiss, URL cleanup via `history.replaceState`)
- **Codec validation** sebelum stream start (H.264 + AAC check)
- Dark theme, responsive (hamburger mobile)

## Tech stack

- Node.js 18+ (dev: v20.20.2)
- Express 4 + EJS views + plain CSS
- SQLite via `better-sqlite3` (sync API)
- `express-session` + `connect-sqlite3` untuk session
- `multer` untuk upload
- `morgan` untuk HTTP request logging (NestJS-style custom format)
- `bcryptjs` untuk password hash
- `axios` untuk HTTP download (Google Drive, MediaFire, direct URL)
- `megajs` untuk Mega.nz download
- **FFmpeg + ffprobe** (dari system `$PATH`) untuk transcode, RTMP push, codec validation, dan media probe
- Child process spawn per stream / per transcode job — **bukan** queue terpusat
- `setInterval` 15 detik di main process untuk scheduler (no external cron)
- `setInterval` 30 detik untuk health check stream (detect stale)

## Struktur file penting

```
app.js                 Entry Express; mounts routes, configures session,
                       morgan HTTP logger (NestJS-style custom format),
                       menyediakan helper formatTime via app.locals,
                       start scheduler polling loop, /api/system endpoint.
src/db.js              SQLite schema + lightweight ALTER TABLE migrations.
                       Tabel: users, videos, streams, schedules, playlists,
                       playlist_items, stream_history, folders.
src/auth.js            requireAuth middleware + injectUser locals.
src/streamManager.js   FFmpeg manager untuk live streaming (Map streamId → proc).
                       Redacts stream key di semua tulisan log.
                       Playlist auto-advance (advancePlaylist) — sequential atau
                       shuffle. Auto-retry dengan exponential backoff (max 5x).
                       Health check 30 detik (stale stream detection).
                       saveHistory() ke tabel stream_history saat stop/error.
src/transcoder.js      FFmpeg manager untuk "Prepare" (one-shot transcode).
                       Overwrites source file after success. Exposes progress
                       via getProgress() + probeDuration() + probeVideoInfo() +
                       validateCodec() (ffprobe sync, dengan timeout 30s).
                       generateThumbnail(): extract frame 10% → 1280×720 JPEG.
src/downloader.js      URL import module (Google Drive, Mega, MediaFire, direct).
                       Pattern mirrors transcoder.js (Map jobs, progress).
                       reconcileOnBoot() resets stale 'downloading' rows.
src/scheduler.js       setInterval(tick, 15s) auto-start / auto-stop streams
                       berdasarkan row schedules. No in-memory state.
src/chunkUpload.js     (Currently disabled at client-side, backend endpoints still
                       exist.) Chunked upload manager untuk file > 50MB — session
                       state, chunk storage di public/uploads/chunks/, merge saat
                       finalize, auto-cleanup stale 24 jam.
src/routes/auth.js     /login /logout
src/routes/videos.js   /videos dengan pagination (page, folder filter)
                       + /videos/:id/{prepare,progress,status,edit,
                         regen-thumb,move-folder,cancel-prepare,delete}
                       + /videos/upload (XHR) + /videos/import-url
                       + /videos/download/:jobId/progress
                       + /videos/folders/{create,:id/rename,:id/delete,
                         :id/prepare-all,:id/create-playlist,:id/delete-videos}
                       + /videos/chunked/{init, :id/status, :id/:chunkIndex (PUT),
                         :id/finalize, :id (DELETE)}
src/routes/streams.js  /streams/single + /streams/playlist (split views)
                       + /streams/:id/{start,stop,log,edit,delete}
                       Codec validation sebelum start (Copy mode).
                       PRESETS: { key: { label, url } } — YouTube, Facebook,
                       Twitch, Custom dengan display label capitalized.
src/routes/playlists.js /playlists (CRUD dengan video_ids[] multi-select pada create)
                       + /:id/{add-video,remove-item,move-up,move-down,settings,delete}
                       + /:id/state.json (GET) + /:id/sync (POST — add/remove diff)
src/routes/history.js  /history (list + delete + clear all)
src/routes/schedules.js /schedules (CRUD) — datetime-local input → UTC ISO DB
views/                 EJS templates, partials di views/partials/
  videos.ejs           Library + upload/import modal + inline polling script
                       + folder filter bar + edit-video modal + pagination
                       + thumbnail 160×90, bulk actions dalam folder
  streams-single.ejs   Single video stream management (icon-only actions)
                       + edit-stream modal + stream-log modal (auto-refresh 3s)
  streams-playlist.ejs Playlist stream management (icon-only actions)
                       + edit-stream-pl modal + stream-log modal
  playlists.ejs        Playlist list dengan collage thumbnail 2×2
                       + new-playlist modal (multi-video picker)
                       + manage-playlist modal (AJAX sync add/remove)
                       + edit-playlist modal (settings)
  playlist-detail.ejs  Playlist items dengan thumbnail + reorder (↑↓)
                       + settings modal (loop/shuffle/rename)
  history.ejs          Stream history tabel + delete/clear
  dashboard.ejs        Stats + system monitor + recent streams + timer
  schedules.ejs        Schedule management
  partials/header.ejs  Sidebar nav + topbar + sub-menus + History link
  partials/footer.ejs  Toast root + confirm modal + stream-key show/hide
                       toggle global handler + close tags
  partials/flash.ejs   Toast notification renderer
scripts/
  smoke.js             Load-test semua module + jalankan ensureSchema
  test-codec.js        Standalone codec validation test
  generate-thumbs.js   Bulk generate thumbnail untuk video existing
                       (--force untuk regenerate semua)
  ensure-tz-env.js     One-shot: tambahkan TZ & TZ_LABEL ke .env existing
  fix-video-status.js  One-shot: reset status 'ready' → 'uploaded' (legacy fix)
  render-check.js      Verify EJS templates render tanpa error
  test-tz.js           Sanity check parseLocalToUTC (5 case)
public/css/app.css     Single CSS file, dark theme, sidebar, modals, toast,
                       progress bar, folder bar chips, playlist collage,
                       video picker, btn-icon variants, input-with-toggle.
public/uploads/        Tempat semua video (original & prepared — timpa original)
public/uploads/thumbs/ Generated thumbnails (thumb_<id>.jpg)
public/uploads/chunks/ Temporary chunk storage (gitignored)
db/                    SQLite files (gitignored)
logs/                  stream-<id>.log + transcode-<id>.log (gitignored)
docs/
  features.md          Per-feature reference (user-facing + technical)
  architecture.md      Diagram request flow & state machines
  codebase.md          Detail tiap file
  services.md          API reference modul backend
  deployment.md        systemd / pm2 / docker + reverse proxy
```

## Cara menjalankan

```bash
npm install
node generate-secret.js     # populate .env dengan SESSION_SECRET
node reset-password.js      # buat / reset admin user (interaktif)
npm start                   # http://localhost:7575
```

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
   Harus print `schema OK` + `modules OK`. Ini verifies semua modul load, tidak ada circular require, dan `ensureSchema()` sukses (termasuk migrasi ALTER TABLE baru).

2. **Cek diagnostics** file yang diedit kalau ada tool-nya, atau manual load test:
   ```bash
   node -e "require('./src/FILENAME')"
   ```

3. **Jangan commit `.env`, `db/`, `logs/`, `public/uploads/`, atau `node_modules/`.** Sudah di-gitignore.

## Konvensi & rules

- **Stream key adalah secret.** Jangan pernah log, jangan pernah kirim ke client, jangan pernah tulis ke file. Di `streamManager.js` ada `makeRedactingStream` yang wajib dipakai untuk semua tulisan log ffmpeg.
- **Route pattern:** form POST → mutate DB → `res.redirect('/page?notice=...'|'?error=...')`. Hindari JSON endpoint kecuali benar-benar perlu (contoh: `/videos/:id/status` JSON untuk modal polling, `/api/system` untuk system monitor).
- **Modals:** semua form New/Edit pakai native `<dialog>`. Trigger via `data-open-modal="modalId"`, close via `data-close-modal` / ESC / backdrop click.
- **Confirmations:** jangan pakai `onsubmit="return confirm(...)"`. Pakai attribute declarative:
  ```html
  <form data-confirm="message" data-confirm-title="Judul" data-confirm-action="Hapus">
  ```
  Global listener di `views/partials/footer.ejs` otomatis render modal dark yang konsisten.
- **Flash messages:** `partials/flash.ejs` sekarang render sebagai toast (pojok kanan atas, auto-dismiss 4 detik) via element `<div id="toast-root">` di footer. URL cleanup via `history.replaceState` (hapus query params setelah toast muncul).
- **Timestamps:** semua view wajib render timestamp via `formatTime(value)` (helper di `app.locals`). Jangan tampilkan mentah `v.created_at`.
- **Schema changes:** tambah kolom lewat `PRAGMA table_info` guard di `ensureSchema()`, bukan migration framework. Lihat pola `add()` dan `addv()` di `src/db.js`.
- **Status state machines:**
  - Video: `uploaded` | `downloading` → `transcoding` → `ready` | `error`
  - Stream: `idle` → `running` → `idle` | `error`
  - Schedule: `pending` → `started` → `done` | `error` | `cancelled`
  - Kalau bikin status baru, update badge di `views/*.ejs` dan CSS di `public/css/app.css`.
- **Background processes:** setiap manager (streamManager, transcoder, downloader, scheduler) **wajib** punya `reconcileOnBoot()` yang reset row stale setelah restart, dan di-call di `app.js`.
- **Time storage:** SQLite `CURRENT_TIMESTAMP` untuk row timestamps biasa; UTC ISO string (`Z` suffix) untuk schedule triggers (`schedules.start_at`, `schedules.stop_at`). Render ke zona lokal via `formatTime()`. Parse datetime-local input via `parseLocalToUTC(str, tz)` pattern (lihat `src/routes/schedules.js`).
- **FFmpeg paths:** pakai `path.join(__dirname, '..', 'public', 'uploads')`, jangan hard-code path absolut.
- **Sidebar sub-menus:** Videos → Library (`/videos`) + Playlists (`/playlists`). Streams → Single Video (`/streams/single`) + Playlist (`/streams/playlist`).
- **Bahasa UI:** Indonesia ringan campur Inggris teknis (sesuai style project). Commit message: bebas.
- **Security defaults:** cookie `httpOnly: true`, `sameSite: 'lax'`, `secure: NODE_ENV === 'production'`. Jangan turunkan.

## Do / Don't

**Do:**
- Baca `docs/codebase.md` kalau ragu file mana yang harus disentuh.
- Tambah entry di `CHANGELOG.md` untuk perubahan user-visible.
- Jalankan `node scripts/smoke.js` setelah edit.
- Pakai `transcoder.validateCodec(path)` sebelum start stream di Copy mode.
- Pakai `uniqueTitle(base)` pattern di route videos untuk auto-suffix duplicate titles.

**Don't:**
- Jangan introduce framework baru (Next.js, React, TypeScript, ORM) tanpa diskusi. Project ini sengaja simple.
- Jangan tulis stream key, password, atau SESSION_SECRET ke log atau response.
- Jangan pakai `exec()` dengan user input untuk FFmpeg — selalu `spawn()` dengan args array.
- Jangan overwrite file user tanpa safeguard. Transcoder hanya menimpa file original **setelah** file output sudah sukses dibuat.
- Jangan delete file `public/uploads/*` kalau ada row `videos` yang refer — hapus row dulu.

## Next steps yang mungkin diminta user

Urut dari yang paling feasible:
1. **Multi-platform broadcast** — satu source → beberapa RTMP target via FFmpeg `tee` muxer.
2. **Real-time status via WebSocket/SSE** — push update bukan polling.
3. **Recurring schedules** — daily/weekly repeat via cron-like pattern.
4. **Audio overlay** — background music terpisah di playlist mode (lofi-style 24/7 streams).
5. **App settings page** — ubah timezone, label, dll dari UI (bukan edit .env + restart).
6. **Bulk upload** — multi-file picker, upload banyak video sekaligus.
7. **Drag & drop reorder** — untuk playlist items, replace tombol ↑↓.
8. **Video preview player** — klik thumbnail → mini HTML5 video player.
9. **Disk usage warning** — alert di dashboard kalau disk > 85%.
10. **Re-enable chunked upload** — backend sudah ada (`src/chunkUpload.js`), tinggal wire ke client dengan logic resume yang robust.

## Lihat juga

- `README.md` — user-facing quick start & troubleshooting
- `docs/features.md` — **referensi per-fitur** (user-facing + technical)
- `docs/architecture.md` — diagram request flow & data model
- `docs/codebase.md` — detail tiap file
- `docs/services.md` — API reference modul backend (streamManager, transcoder, downloader, auth, db)
- `docs/deployment.md` — systemd / pm2 / docker + reverse proxy
- `CHANGELOG.md` — history perubahan
