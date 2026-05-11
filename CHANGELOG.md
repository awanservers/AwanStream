# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versi belum di-tag — pakai tanggal sebagai penanda release.

## [Unreleased]

### Added
- **Import video dari URL** — support Google Drive, Mega.nz, MediaFire, dan direct link. Server-side download via `axios` + `megajs`. Progress tracking per job. Module baru: `src/downloader.js`.
- **Playlist management** — halaman `/playlists` untuk create/delete playlist, `/playlists/:id` untuk add/remove/reorder video. Tabel baru: `playlists`, `playlist_items`.
- **Stream — Playlist mode** — halaman `/streams/playlist` terpisah dari single video. Stream dari playlist auto-advance ke video berikutnya secara sequential. Option `loop_playlist` untuk wrap around ke awal.
- **Stream — Single Video** split — halaman `/streams/single` khusus untuk stream single video. Sidebar sub-menu: Single Video + Playlist.
- **Codec validation** sebelum stream start di Copy mode. `transcoder.validateCodec(path)` cek H.264 video + AAC audio via ffprobe. Kalau gagal, redirect dengan error message yang jelas.
- **Auto-detect source resolution** — `transcoder.probeVideoInfo(path)` probe width, height, fps, duration, videoCodec, audioCodec dalam satu call. Data disimpan di kolom `videos.src_width`, `src_height`, `src_fps`.
- **Auto-suffix duplicate titles** — fungsi `uniqueTitle(base)` di route videos otomatis append ` (2)`, ` (3)`, dst kalau title sudah ada.
- **Job detail modal** — klik video yang sedang transcoding buka modal dengan progress bar + FFmpeg log inline + ETA estimasi. Endpoint baru: `GET /videos/:id/status` (gabungan progress + log tail).
- **System monitor real-time** — dashboard menampilkan CPU%, RAM%, Uptime. Endpoint `GET /api/system` di-poll setiap 3 detik oleh inline JS di `dashboard.ejs`.
- **Sidebar layout** dengan sub-menus — Videos: Library (`/videos`) + Playlists (`/playlists`). Streams: Single Video (`/streams/single`) + Playlist (`/streams/playlist`).
- **Custom confirm modal** menggantikan native `window.confirm()`. Form opt-in pakai `data-confirm="..."` + `data-confirm-title` + `data-confirm-action`. Konsisten dengan tema dark.
- **Toast notification** untuk flash messages (notice / error). Muncul di pojok kanan atas dengan slide-in animation, auto-dismiss 4 detik, tombol close manual. URL cleanup via `history.replaceState` (hapus query params setelah toast muncul). Mobile jadi bottom sheet.
- **Upload progress bar** di modal Upload video. Pakai XMLHttpRequest `upload.onprogress` — tampilkan persen, bytes uploaded, speed (MB/s). Bisa cancel di tengah upload.
- **Modal dialogs** (native `<dialog>`) untuk semua form New/Edit. Konsisten, no framework. Trigger via `data-open-modal`, close via `data-close-modal` / ESC / backdrop click.
- **Prepare button contextual** — tombol "Prepare" di row video berubah jadi "Re-Prepare" (muted link) kalau status `ready`, "Retry Prepare" (primary) kalau `error`.
- **Prepare preset compatibility note** — live note di form Prepare tentang apakah preset cocok dengan source resolution (misal: source 720p → preset 1080p = upscale warning).
- **Table column classes** (`col-title`, `col-date`, `col-size`, `mono`) dengan ellipsis + 2-line clamp untuk cegah overflow.
- Script baru: `scripts/test-codec.js` — standalone codec validation test.
- Script baru: `scripts/render-check.js` — verify EJS templates render tanpa error.
- Dependency baru: `axios` ^1.16.0 (HTTP download), `megajs` ^1.3.10 (Mega.nz download).
- Kolom baru: `streams.playlist_id` (FK ke playlists), `videos.src_width`, `videos.src_height`, `videos.src_fps`.
- Video status baru: `downloading` (saat import URL sedang berjalan).
- Dokumentasi: `AGENTS.md`, `docs/architecture.md`, `docs/codebase.md`, `docs/services.md`, `docs/deployment.md`, `CHANGELOG.md` untuk onboarding AI / kontributor baru.

### Changed
- Layout shell: sidebar + topbar + content area (bukan top nav + container).
- Streams split menjadi dua halaman: `/streams/single` dan `/streams/playlist`. Route `GET /streams` redirect ke `/streams/single`.
- Videos sidebar sub-menu: Library (`/videos`) + Playlists (`/playlists`).
- Stream list: header kolom "Started" → "Last run", menampilkan `stopped_at` kalau stream sudah berhenti.
- Form New Stream / Upload / New Schedule pindah dari inline card ke modal floating dengan tombol Save/Cancel.
- Dashboard diperkaya: disk usage total, next pending schedule, system monitor widget.
- `streamManager.startStream()` sekarang handle playlist auto-advance via internal `advancePlaylist()`.

### Progress bar transcode & scheduled streaming
- **Progress bar transcode** — polling endpoint `GET /videos/:id/progress` yang parse `-progress pipe:1` dari FFmpeg. UI menampilkan persentase, elapsed/total, speed (x), fps. Duration di-probe via ffprobe saat upload dan dicache di kolom `videos.duration_seconds`.
- **Scheduled streaming** — halaman `/schedules` untuk mengatur auto-start / auto-stop stream pada waktu tertentu. Input pakai datetime-local (zona lokal user, di-parse pakai `TZ` env) → simpan UTC ISO di DB. Scheduler polling tiap 15 detik.
- Module baru: `src/scheduler.js` (reconcile + tick loop), `src/routes/schedules.js` (CRUD).
- Tabel baru: `schedules` (stream_id, start_at UTC, stop_at UTC, status, last_error).
- Scheduler state machine: `pending → started → done | error | cancelled`.
- Link "Schedules" di nav utama.

## 2026-05-11

### Added
- **Prepare (one-shot transcode)** di halaman Videos. Preset: 720p30, 720p60, 1080p30, 1080p60 dengan pilihan x264 preset.
- Status state machine untuk video: `uploaded → transcoding → ready | error`.
- Module `src/transcoder.js` dengan `reconcileOnBoot()`.
- **Copy mode** di form stream (default) — streaming 0% CPU untuk video yang sudah di-Prepare.
- **Re-encode mode** di form stream (opsional) dengan opsi: bitrate, keyframe interval, x264 preset, untuk source yang belum di-Prepare.
- GOP enforcement saat re-encode via `-g`, `-keyint_min`, `-sc_threshold 0`, `-force_key_frames`.
- `bufsize` otomatis 2x bitrate.
- `-map 0:v:0 -map 0:a:0?` untuk skip attachment stream (menghilangkan warning "Unknown cover type").
- `-max_muxing_queue_size 1024` untuk stabilitas mux saat streaming panjang.
- Env vars `TZ` dan `TZ_LABEL`. Helper `formatTime(value)` di `app.locals` untuk render semua timestamp ke zona waktu lokal (default WIB).
- Script `scripts/ensure-tz-env.js` untuk menambahkan `TZ` / `TZ_LABEL` ke `.env` existing.
- Script `scripts/fix-video-status.js` untuk koreksi legacy row yang salah ditandai `ready` saat migrasi pertama.

### Changed
- Log streaming sekarang **me-redact stream key** di semua tulisan. `tailLog()` juga redact saat baca (defense in depth).
- Form stream kolom bitrate default naik dari `2500k` ke `4500k` + hint angka per resolusi.
- Default encoding mode pada form new stream: **Copy** (bukan Re-encode) karena workflow rekomendasi adalah Prepare dulu.

### Fixed
- Error YouTube "keyframe interval > 4 detik" — dengan Prepare (GOP 2 detik) atau Re-encode mode, keyframe sekarang konsisten 2 detik.
- Error YouTube "bitrate terlalu tinggi" — Prepare memotong bitrate ke target preset (default 4500k untuk 1080p30).
- Legacy row videos yang dimark `'ready'` otomatis via migrasi — sekarang default `'uploaded'` supaya tidak menyesatkan.

## 2026-05-11 — Initial

### Added
- Express + EJS web app dengan session auth (bcrypt + SQLite session store).
- Upload video via multer ke `public/uploads/` (max 5 GB, whitelist ekstensi).
- CRUD streams dengan preset RTMP URL: YouTube, Facebook, Twitch, custom.
- Start/stop live streaming via FFmpeg (`-c:v copy` default awal).
- Status state machine untuk stream: `idle → running → idle | error`.
- Live log per stream (file + endpoint `GET /streams/:id/log`).
- `streamManager.reconcileOnBoot()` untuk reset row running stale setelah restart.
- Dashboard dengan 3 stat + recent streams.
- Dark-theme single CSS file.
- Script `generate-secret.js`, `reset-password.js`, `scripts/smoke.js`.
