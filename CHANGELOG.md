# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versi belum di-tag — pakai tanggal sebagai penanda release.

## [Unreleased]

### Fixed — vnStat in Docker support
- **Menambahkan paket `vnstat` ke dalam Dockerfile** dan memetakan database `vnstat` dari host VPS (`/var/lib/vnstat`) ke dalam container secara read-only agar statistik bandwidth bulanan dapat dibaca saat dijalankan via Docker.

### Changed — Loop tool UX
- **Form Loop dirapikan jadi builder dua kolom** — pilihan video, durasi, title, mode, audio overlay, dan preview sumber sekarang lebih mudah discan.
- **Loop form sekarang menampilkan thumbnail video sumber** dan estimasi loop secara ringkas.
- **Validasi Loop form pindah ke inline error** — tidak lagi memakai popup `alert()`.

### Changed — Dashboard bandwidth label
- **Kartu Bandwidth di Dashboard disederhanakan** — subteks sekarang hanya "Total bulan ini", tanpa detail In/Out.
- **Kartu Memory di Dashboard sekarang menampilkan used / total** — unit adaptif dari MB ke GB.

### Changed — Stream creation modal
- **Schedule dipindah ke modal New Stream** — create stream sekarang punya tab Stream / Schedule / Audio, dan bisa langsung membuat jadwal saat stream dibuat.
- **Tombol kalender per-row di halaman Streams dihapus** supaya alur utama tidak bercabang dan lebih mudah dipahami.
- **Modal New Single Stream sekarang menampilkan preview thumbnail video** — video picker dipindah ke bawah field Name, area kanan dipakai untuk visual video yang akan live.
- **Modal create/edit stream diperlebar** supaya form dan preview video terasa lebih lega.

### Fixed — Stream key secret handling
- **Edit stream modal tidak lagi render stream key lama ke HTML** — `data-stream-key` di tombol Edit dihapus dari Single Stream dan Playlist Stream.
- **Edit stream key sekarang opsional** — field key dikosongkan saat modal dibuka; kalau dibiarkan kosong, backend mempertahankan key lama. Isi field hanya kalau ingin mengganti key.

### Added — Schedule from stream rows
- **Tombol kalender di Single Stream dan Playlist Stream** — buat jadwal start/stop langsung dari row stream tanpa perlu klik Start manual.
- **Badge pending schedule di row stream** — menampilkan jadwal pending terdekat dengan `formatTimeShort()`.
- **Route baru `POST /streams/:id/schedule`** — memakai parser timezone yang sama dengan halaman `/schedules`.
- **Sidebar disederhanakan** — item Schedules dihapus karena scheduling sekarang dibuat langsung dari halaman Streaming.

### Fixed — Modal layout
- **Form modal tidak melebar mengikuti isi input/select panjang** — grid form sekarang memakai kolom yang bisa shrink, field dibatasi ke lebar parent, dan modal body memakai vertical scroll tanpa horizontal overflow.
- **Footer modal tidak memotong tombol action** — footer tidak ikut shrink dan tombol punya tinggi minimum stabil.
- **Form di dalam modal sekarang ikut layout flex** — memperbaiki kasus `modal-body` mendorong footer keluar pada modal New/Edit Stream.

### Added — Dashboard bandwidth via vnStat
- **Kartu Uptime diganti menjadi BW Bulan Ini** — menampilkan total bandwidth bulan berjalan dengan breakdown `In` dan `Out`.
- **Module baru `src/bandwidthManager.js`** — membaca `vnstat --json`, cache 60 detik, fallback aman ke `N/A` kalau vnStat belum terpasang/aktif.
- **Payload `/api/system` dan `/api/events`** sekarang menyertakan `bandwidth` supaya kartu dashboard ikut refresh.

### Added — YouTube Upload: Restart-aware retry
- **`reconcileOnBoot()` di `youtubeUploader.js`** — message lebih actionable: "Upload interrupted by server restart. Click Retry to upload again." (dari sebelumnya generic "upload interrupted").
- **Retry button (orange refresh icon) di video library** — muncul kalau ada upload yang ke-interrupt server restart. Klik buka modal upload lagi (start dari awal — true resume tidak di-support karena googleapis tidak expose resumable upload URL).
- **Disclaimer di upload modal** — warn user bahwa kalau server restart mid-upload, harus mulai ulang. Tujuan: set expectation untuk file besar (10+ GB) yang butuh waktu lama.
- Annotation `youtube_interrupted` flag di video library row (dari `last_error` regex match).

### Added — Audio Loudness Normalization
- **EBU R128 / ITU BS.1770 normalization** ke -14 LUFS (YouTube standard) — bikin volume audio konsisten antar video, viewer tidak perlu adjust volume saat ganti video di playlist.
- **Phase 1 — Audio Library** — semua audio yang di-upload otomatis di-normalize via 2-pass `loudnorm` filter (analyze → apply). File overwrite di disk. Loudness measurements (integrated LUFS, true peak, LRA) disimpan di kolom baru `audio_tracks.{integrated_lufs, true_peak_db, loudness_range, normalized}`. UI di `/audio` tampilkan kolom **Loudness** dengan badge ✓ -14 LUFS dan source loudness di tooltip.
- **Phase 2 — Loop output** — `loudnorm=I=-14:TP=-1.5:LRA=11` di-chain ke audio filter di phase 2 (smooth) atau single pass (fast), apply setelah `amix`. Output video Loop guaranteed -14 LUFS regardless of source levels (video crackling + audio overlay). Solve real problem: kalau audio overlay di-attenuate ke 0.3 dan video source quiet, output sebelumnya bisa jadi -22 LUFS (terlalu pelan). Sekarang konsisten.
- **Module API baru** di `audioManager.js`: `normalize(path)`, `analyzeLoudness(path)`, `applyLoudnessNormalization(path, measured)`, `LOUDNESS_TARGET`.
- **Soft fail** — kalau normalize gagal saat upload, file tetap bisa dipakai (`normalized=0`), error logged ke `last_error`.
- **Codec preservation** saat normalize: MP3 → libmp3lame, M4A/AAC → aac, OGG/Opus → libopus, WAV/FLAC → flac, lainnya → aac fallback.

### Added — YouTube Integration (Phase 2: Upload)
- **Tombol "Upload to YouTube"** di video library — muncul untuk video status `ready`. Dropdown privacy: Unlisted (default, rekomendasi), Private, atau Public. Default category: Music (10).
- **Resumable upload** via `googleapis` library — handle chunked upload + auto-retry transparently. Progress real-time via polling (2 detik). Bytes sent + percent + status di UI.
- **Cancel upload** mid-progress — abort signal ke googleapis. Cleanup DB row + log "cancelled".
- **Status indicators** di video library:
  - **Belum upload** → tombol YouTube putih (klik buka modal)
  - **Uploading** → icon YouTube biru dengan badge percent (e.g. "47%"), auto-refresh 3s
  - **Done** → icon YouTube hijau (klik buka YouTube Studio untuk edit metadata + publish)
  - **Belum connect** → icon abu-abu, klik redirect ke `/youtube`
- **Tabel baru `youtube_uploads`** — track semua upload jobs. Fields: video_id, youtube_video_id, title, privacy, category_id, status, bytes_sent, total_bytes, percent, last_error, started_at, finished_at. Status state machine: `pending → uploading → done | error | cancelled`.
- **Module `src/youtubeUploader.js`** — pattern mirip `transcoder.js`/`looper.js`: in-memory `jobs` Map + DB persistence + `reconcileOnBoot()` reset stale uploads.
- **Routes baru:** `POST /youtube/upload/:videoId` (start), `GET /youtube/upload/:jobId/progress` (polling), `POST /youtube/upload/:jobId/cancel`, `GET /youtube/uploads/active` (list active jobs).
- **Log per upload:** `logs/youtube-upload-<uploadId>.log` — capture full lifecycle + error response details dari Google API.
- **Default behavior:** privacy=unlisted, notifySubscribers=false, selfDeclaredMadeForKids=false, no description/tags (user edit manual di Studio setelah upload).
- **Auto-detect duplicate jobs** — kalau video sama lagi uploading, throw error supaya tidak upload 2x.

### Added — YouTube Integration (Phase 1: Auth)
- **OAuth2 connection ke YouTube** — halaman baru `/youtube` untuk hubungkan akun YouTube ke AwanStream. Single-account model. Token refresh otomatis (googleapis library handle transparently). Disconnect tombol revoke token di Google + clear DB.
- **Tabel baru `youtube_accounts`** — store access_token, refresh_token, channel_id, channel_title, expiry_date.
- **Module `src/youtubeManager.js`** — API: `isConfigured()`, `getAuthUrl()`, `exchangeCodeAndStore()`, `getAuthedClient()`, `getStatus()`, `disconnect()`. Auto-persist refreshed tokens via `oauth2.on('tokens')`.
- **Routes** — `GET /youtube` (status page), `GET /youtube/connect` (redirect to consent), `GET /youtube/callback` (OAuth callback handler), `POST /youtube/disconnect`.
- **Setup guide** di `docs/youtube-setup.md` — step-by-step Google Cloud Console + OAuth consent screen + redirect URI configuration.
- **Sidebar nav** — "YouTube" item baru dengan icon YouTube logo.
- **Env vars baru (opsional):** `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`.
- **Phase 2 (planned):** tombol "Upload to YouTube" di video library, resumable upload dengan progress, default privacy=private (user publish manual via YouTube Studio).
- **Dependency baru:** `googleapis ^171.4.0`.

### Added — Download buttons & Security hardening
- **Tombol Download di Library** — video library dan audio library sekarang punya tombol download per row. File dikirim dengan filename yang friendly (dari title, sanitized ASCII-only untuk RFC 6266 compliance). Express `res.download()` handle HTTP Range requests otomatis, jadi file besar (10+ GB) bisa resume kalau pakai download manager seperti IDM/FDM.
- **Thumbnail tools untuk YouTube** — di video preview modal ada 2 tombol baru:
  - **📸 Set thumbnail from current frame** — scrub ke frame yang bagus, klik tombol, AJAX capture frame itu sebagai thumbnail video (update in-place tanpa reload). Berguna untuk pilih frame paling dramatis buat thumbnail YouTube (misal: api lagi besar di video fireplace).
  - **⬇ Download thumbnail** — download JPEG 1280×720 dengan filename dari title. Cocok sebagai base image untuk di-edit di Canva/Photoshop (tambah text, logo, dll).
  - Backend: `generateThumbnail(path, id, { atSecond })` extended, `POST /videos/:id/regen-thumb` terima body `at_second`, route baru `GET /videos/:id/thumb/download`.
- **Security fix: protected media serving** — sebelumnya `app.use(express.static('public'))` meng-expose folder `public/uploads/` tanpa auth, siapapun dengan URL bisa akses video/audio/thumbnail. Sekarang static middleware hanya serve `/css/` (assets browser yang memang public). Media files diakses via route protected:
  - `GET /videos/:id/file` — stream video (untuk HTML5 `<video>` preview, support HTTP Range)
  - `GET /videos/:id/download` — download dengan filename friendly
  - `GET /videos/:id/thumb` — thumbnail image (cacheable)
  - `GET /audio/:id/download` — download audio dengan filename friendly
- Semua view yang sebelumnya pakai `/uploads/thumbs/<file>` atau `/uploads/<file>` diubah ke URL-based route. Query playlists juga ikut include `video_id` di collage thumbnails.

### Added — Loop + Audio Overlay
- **Audio overlay di Loop tool** — saat bikin video loop panjang, user bisa attach audio track dari Audio Library sebagai musik background. Audio otomatis di-loop mengikuti target durasi. Dua mode: **Mix** (gabung dengan suara asli video, default volume 0.3) atau **Replace** (ganti total suara video dengan audio overlay). Cocok untuk use case fireplace pendek + jazz background → video panjang siap upload ke YouTube. FFmpeg `amix` filter di phase 2 (smooth) atau single-pass (fast). Video tetap `-c:v copy` (no re-encode video), hanya audio yang di-encode ke AAC 192k.

### Added — Audio Library (separate from videos)
- **Tabel baru `audio_tracks`** — storage terpisah untuk file audio (MP3, M4A, AAC, WAV, OGG, OPUS, FLAC, WMA). Kolom: `id, title, filename, size_bytes, duration_seconds, codec, bitrate, sample_rate, channels, status, last_error, created_at`. File audio disimpan di `public/uploads/audio/`, terpisah dari video di `public/uploads/`.
- **Halaman `/audio`** — Audio Library di sidebar (Videos → Audio). Upload via XHR dengan progress bar (max 500 MB per file), rename, delete. Menampilkan codec, duration, bitrate, channels (mono/stereo), size, status.
- **Module `src/audioManager.js`** — API: `register()`, `getFilePath()`, `remove()`, `list()`, `listReady()`, `probe()`. Probe ffprobe saat upload, cache metadata. Delete guard: tidak bisa hapus track yang sedang dipakai running stream.
- **Audio Overlay (revised)** — dropdown audio overlay di form stream sekarang ambil dari tabel `audio_tracks`, bukan dari video library. Lebih bersih dan tidak campur aduk dengan video.
- **Performance fix** — kolom baru `videos.has_audio` (cached dari ffprobe saat upload) supaya `streamManager.startStream()` tidak perlu probe sync setiap stream start / playlist advance.

### Added — Audio Overlay
- **Audio Overlay untuk streaming** — pilih audio track (musik background) yang di-mix dengan video saat live streaming. Audio di-loop otomatis (independen dari video loop). Volume bisa diatur (0.0 - 1.0, default 0.3). Tersedia di Single Video dan Playlist stream. Kalau video tidak punya audio track, overlay jadi satu-satunya audio. Kalau video punya audio, keduanya di-mix via FFmpeg `amix` filter. Kolom baru: `streams.audio_id` (FK ke `audio_tracks`), `streams.audio_volume`.

### Added — Loop tool logging
- **Loop job logging** — log FFmpeg untuk fitur Loop sekarang bisa dilihat dari UI (tombol 📄 di active jobs + section "Recent errors" di halaman Loop). Job ID pakai timestamp (tidak reset setelah restart). Kolom baru `videos.loop_job_id` untuk tracking log file setelah job selesai. Endpoint baru: `GET /looper/:jobId/log`, `GET /looper/video/:videoId/log`.

### Added — Loop tool
- **Video Loop** — perpanjang clip pendek jadi video panjang (30 menit - 24 jam) untuk 24/7 livestream. Accessible via sidebar "Loop" di bawah Streams. Pilih video sumber, target durasi (preset: 30m/1h/2h/3h/6h/12h/24h + custom menit), optional custom title. Dua mode:
  - **Smooth mode (default)** — 2-phase pipeline: phase 1 re-encode clip pendek jadi "seamless unit" dengan FFmpeg `xfade` + `acrossfade` di loop boundary (crossfade 1 detik antara tail + head). Phase 2 `-stream_loop -1 -c copy` seamless unit ke durasi target. Hasilnya: transisi loop tidak kelihatan sama sekali — mata tidak bisa catch frame jump karena join-nya ada di tengah crossfade. Butuh clip minimal ~2 detik (kalau lebih pendek, crossfade di-auto-shrink ke floor(L/3) detik).
  - **Fast mode** — single FFmpeg pass, `-stream_loop -1 -c copy`. Tidak re-encode sama sekali, super cepat (detik). Ada visible jump di loop boundary — cocok kalau source naturally start≈end atau kamu prioritas speed.
- Progress bar weighted antara phase (0-60% phase 1, 60-100% phase 2 untuk smooth mode). Speed factor + ETA + phase label update tiap 2 detik via polling `/looper/progress`. Cancel mid-run tersedia. Output jadi video baru di Library (tidak menimpa source) dengan status `transcoding` → `ready`, auto-thumbnail, inherit folder & resolution dari source. Module `src/looper.js`, route `/looper`, view `views/looper.ejs`. Catatan: untuk fireplace/ambient visuals dari Veo, smooth mode direkomendasikan karena AI clips jarang seamless secara natural.

### Added — Video library & organization
- **Video Folders** — organisasi library video dengan folder (mirip File Explorer). Create/rename/delete folder, move video antar folder, filter library per folder. Upload langsung ke folder aktif. Bulk actions per folder: Prepare all, Create playlist dari folder, Delete semua videos. Tabel baru `folders`, kolom baru `videos.folder_id`.
- **Video Thumbnails** — auto-generate thumbnail 1280×720 JPEG dari frame video saat upload dan setelah Prepare. Extract frame di ~10% durasi (min 1s, max 30s), fallback ke frame 0 kalau seek gagal. Async via `setImmediate()` supaya tidak blocking upload response. Display 160×90 di library table, 60×34 di playlist picker, 80×45 di playlist items. Manual regen + bulk script `scripts/generate-thumbs.js`. Disimpan di `public/uploads/thumbs/`, kolom baru `videos.thumbnail`.
- **Video Preview Player** — klik thumbnail di library buka modal dengan native HTML5 `<video>` + controls. Preload metadata untuk efficient load, browser handle range requests via Express static. Hover thumbnail menampilkan ▶ overlay.
- **Pagination library** — 20 video per halaman di `/videos` dengan smart ellipsis (`← Prev 1 … 4 5 [6] 7 8 … 20 Next →`). URL `?page=N`, compatible dengan `?folder=X`.

### Added — Playlist redesign
- **Create playlist dengan multi-video picker** — modal all-in-one. Bikin playlist baru sekaligus pilih beberapa video (checkbox + thumbnail + size + duration + search filter). Helper Select all / Clear + counter "N selected".
- **Manage playlist modal** — edit isi playlist lewat modal AJAX. Fetch state via `GET /playlists/:id/state.json`, save via `POST /playlists/:id/sync` (diff add/remove). Tidak perlu buka halaman detail.
- **Shuffle mode** — opsi shuffle di playlist. Kalau aktif, `advancePlaylist()` pick random video (exclude current). Bisa di-toggle dari modal create/edit. Kolom baru `playlists.shuffle`.
- **Collage thumbnail** — playlist list thumbnail adalah collage 2×2 dari 4 video pertama. Layout adaptif: 1 video = full, 2 = split, 3 = 1 besar + 2 stacked, 4+ = grid 2×2. Pure CSS grid, tidak generate composite image.

### Added — Streaming
- **Auto-Retry + Health Check** — FFmpeg crash (exit code non-zero) trigger auto-retry hingga 5x dengan exponential backoff (3s → 60s max + jitter). User stop = no retry (flag `retryStopped`). Retry attempt di `last_error`. Reset otomatis setelah stream berhasil jalan. Health check polling 30 detik detect stale stream (no FFmpeg output 5 menit) → SIGKILL → retry logic.
- **Stream Duration Timer** — live counter 🔴 2h 15m 30s via client-side JS. Update setiap 1 detik. Format adaptif (detik → menit → jam → hari). Tampil di `/streams/single`, `/streams/playlist`, Dashboard recent streams.
- **Stream Log modal** — view log FFmpeg via modal (bukan buka tab baru). Auto-refresh 3 detik untuk stream running, fetch once untuk idle. Toggle auto-scroll. Stream key selalu redacted.
- **Stream Edit modal** — edit config stream tanpa harus delete + recreate. Guard: tidak bisa edit kalau sedang running.
- **Icon-only stream actions** — replace Start/Stop/Log/Edit/Delete text buttons dengan `.btn-icon` variants + tooltip. Stream key input dengan show/hide toggle (eye icon, global handler).

### Added — History & monitoring
- **Stream History** — riwayat semua sesi streaming yang sudah selesai. Otomatis tercatat saat stream stop (manual atau natural finish) atau error via `saveHistory()` di `streamManager`. Halaman `/history` menampilkan stream name, video, platform, durasi, status, waktu. Bisa hapus per-entry atau clear all. **Minimum 10 detik durasi** untuk tercatat. Tabel baru `stream_history`.
- **SSE real-time dashboard** — `GET /api/events` endpoint push system snapshot setiap 3 detik (CPU, RAM, Disk, Network, Uptime). Client try SSE first, fallback ke polling `/api/system` on error. Auth via session cookie check (bukan `requireAuth`) untuk avoid session store locking.
- **Network throughput monitor** — baca `/proc/net/dev`, hitung delta bytes/sec antar tick. Per-connection `lastNet` untuk SSE, global `lastNetSample` untuk polling. Idle label kalau 0 B/s.
- **Disk usage monitor** — parse output `df` command, tampil di dashboard (used/total + percent).
- **Recent streams dashboard** — redesigned dengan thumbnail 140×79 + platform capitalized (YouTube/Facebook/Twitch) + icon actions (Start/Stop + external link).

### Added — Logging & deploy
- **HTTP request logger (morgan)** — NestJS-style custom format `[AwanStream] - date LOG METHOD URL status - Nms - IP: x` dengan colored status codes (2xx/3xx cyan, 4xx yellow, 5xx red), integer latency, skip static assets. IP detection via `x-forwarded-for` + `req.ip`.
- **GitLab CI/CD pipeline** — `.gitlab-ci.yml` dengan 3 stage: test (smoke + render-check), build (Docker image push ke Container Registry), deploy (SSH + docker compose up). Required variables: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PATH`, `DEPLOY_SSH_KEY` (File type), `SESSION_SECRET`, `APP_PORT`, `APP_TZ`, `APP_TZ_LABEL`. Sanity check di `before_script` exit dengan pesan jelas kalau `DEPLOY_SSH_KEY` empty (Protected variable issue).
- **Dockerfile** multi-stage dengan `node:20-alpine` + `ffmpeg`. Image size ≈114 MB. Non-root user `awanstreamuser`. Healthcheck via HTTP GET `/login`.
- **docker-compose.yml** — volume mount `db/`, `logs/`, `public/uploads/` untuk persistence.

### Changed
- Dashboard redesign: stat cards dengan colored icons + system monitor SSE + recent streams dengan thumbnail + icon actions.
- Platform presets di `src/routes/streams.js` sekarang object `{ label, url }` dengan label capitalized. YouTube URL confirmed `rtmp://x.rtmp.youtube.com/live2` (letter `x`).
- Stream actions di tabel jadi icon-only dengan tooltip (sebelumnya text buttons).
- Playlist list dengan collage thumbnail 2×2 (sebelumnya plain text).
- Upload modal: video title field optional (auto-detect dari filename) + folder selector.

### Fixed
- SSE endpoint "login-login sendiri" bug — caused by `requireAuth` middleware redirect + session store locking saat multiple concurrent SSE. Fix: manual cookie check di endpoint SSE, tidak pakai middleware.
- FFmpeg "Unknown cover type" warning saat stream — via `-map 0:v:0 -map 0:a:0?` skip attachment stream.
- Timezone inconsistency — semua timestamp render via `formatTime()` helper dari `app.locals`, format `DD/MM/YYYY HH.mm.ss WIB` (Indonesian locale, 24-hour, dots separator).

### Removed / Reverted
- Chart.js dashboard — user decided "gak worth it ada chart dan import CDN", revert ke plain stat cards + system monitor.
- Chunked upload client-side — reverted ke simple XHR upload karena issue stuck. Backend endpoints dan `src/chunkUpload.js` **tetap ada** untuk future re-enable.

### Earlier features in this release cycle

- **Import video dari URL** — Google Drive, Mega.nz, MediaFire, direct link. Module: `src/downloader.js`. State `jobs: Map<jobId, ...>`. Video row di-insert dengan status `downloading` langsung, update ke `uploaded` setelah selesai.
- **Playlist management basic** — CRUD playlist + playlist_items (add/remove/reorder). Tabel baru: `playlists`, `playlist_items`.
- **Stream — Playlist mode** — halaman `/streams/playlist` terpisah dari single video. Auto-advance sequential dengan option `loop_playlist`.
- **Stream — Single Video split** — halaman `/streams/single` terpisah. Sidebar sub-menu: Single Video + Playlist.
- **Codec validation** sebelum stream start di Copy mode. `transcoder.validateCodec(path)` cek H.264 + AAC via ffprobe.
- **Auto-detect source resolution** — `transcoder.probeVideoInfo(path)` full media probe dalam satu call. Disimpan di `videos.src_width`, `src_height`, `src_fps`.
- **Auto-suffix duplicate titles** — `uniqueTitle(base)` append ` (2)`, ` (3)`, dst.
- **Job detail modal** — klik video yang transcoding buka modal dengan progress bar + log tail + ETA. Endpoint `GET /videos/:id/status`.
- **Sidebar layout** dengan sub-menus (Videos, Streams).
- **Custom confirm modal** replace `window.confirm()` — opt-in via `data-confirm="..."` attribute.
- **Toast notification** untuk flash messages, auto-dismiss 4 detik, URL cleanup via `history.replaceState`.
- **Upload progress bar** via XMLHttpRequest `upload.onprogress`.
- **Modal dialogs** native `<dialog>` untuk semua form.
- **Prepare button contextual** — "Prepare" / "Re-Prepare" / "Retry Prepare" berdasarkan status.
- **Prepare preset compatibility note** — live warning kalau preset > source (upscale).
- Dependency baru: `morgan` ^1.10 (HTTP logger), `axios` ^1.16 (HTTP download), `megajs` ^1.3 (Mega.nz download).
- Kolom baru: `streams.playlist_id`, `videos.src_width`, `src_height`, `src_fps`, `thumbnail`, `folder_id`, `playlists.shuffle`.
- Video status baru: `downloading`.
- Dokumentasi baru: `docs/features.md` (per-feature reference), update `AGENTS.md`, `docs/architecture.md`, `docs/codebase.md`, `docs/services.md`, `docs/deployment.md` (GitLab CI section).

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
