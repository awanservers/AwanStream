# Features reference

Dokumentasi per-fitur AwanStream. Untuk setiap fitur: apa fungsinya, cara pakainya dari UI, dan implementasi teknisnya (file, endpoint, tabel).

## Daftar isi

- [Video management](#video-management)
  - [Upload (XHR)](#upload-xhr)
  - [Import dari URL](#import-dari-url)
  - [Prepare (transcode)](#prepare-transcode)
  - [Video Thumbnails](#video-thumbnails)
  - [Custom thumbnail capture](#custom-thumbnail-capture)
  - [Video download](#video-download)
  - [Video Folders](#video-folders)
- [Audio Library](#audio-library)
- [Loop tool](#loop-tool)
  - [Smooth vs Fast mode](#smooth-vs-fast-mode)
  - [Audio overlay di Loop](#audio-overlay-di-loop)
- [Playlist management](#playlist-management)
  - [Create playlist dengan video picker](#create-playlist-dengan-video-picker)
  - [Manage playlist (modal)](#manage-playlist-modal)
  - [Shuffle mode](#shuffle-mode)
  - [Collage thumbnail](#collage-thumbnail)
- [Streaming](#streaming)
  - [Stream Single Video](#stream-single-video)
  - [Stream Playlist](#stream-playlist)
  - [Audio overlay saat streaming](#audio-overlay-saat-streaming)
  - [Auto-Retry + Health Check](#auto-retry--health-check)
  - [Stream Duration Timer](#stream-duration-timer)
  - [Stream Log modal](#stream-log-modal)
  - [Stream Edit modal](#stream-edit-modal)
- [Scheduling](#scheduling)
- [Stream History](#stream-history)
- [YouTube Upload](#youtube-upload)
  - [Connect (OAuth)](#connect-oauth)
  - [Upload video](#upload-video)
  - [Resume modal](#resume-modal)
- [Dashboard & System Monitor](#dashboard--system-monitor)
- [HTTP Request Logger (Morgan)](#http-request-logger-morgan)
- [Security: protected media serving](#security-protected-media-serving)
- [UI conventions](#ui-conventions)

---

## Video management

### Upload (XHR)

**Apa:** Upload video dari local PC dengan progress bar real-time.

**Cara pakai:**
1. Klik **+ Upload video** di halaman `/videos`
2. Pilih file (mp4, mkv, mov, flv, ts, webm — max 5 GB)
3. Optional: isi title (default pakai nama file), pilih folder
4. Klik **Upload** — progress bar menampilkan %, bytes, speed
5. Setelah selesai, modal close otomatis dan halaman reload

**Teknis:**
- Endpoint: `POST /videos/upload` (multer disk storage)
- Filename di-sanitize: `${Date.now()}_${safe_name}`
- File disimpan di `public/uploads/`
- Row di-insert ke `videos` dengan status `uploaded`
- `probeVideoInfo` + `generateThumbnail` jalan **async via `setImmediate()`** setelah response terkirim — tidak blocking redirect
- Client-side XHR dengan `xhr.upload.onprogress` untuk progress tracking

**File:** `src/routes/videos.js` (`POST /upload`), `views/videos.ejs` (modal + inline script)

---

### Import dari URL

**Apa:** Import video dari cloud storage atau direct link tanpa upload dari PC.

**Sources yang di-support:**
- **Google Drive** — multi-URL fallback dengan cookie handling untuk file besar
- **Mega.nz** — via `megajs` library
- **MediaFire** — scrape download link dari halaman
- **Direct URL** — file .mp4/.mkv/dll yang bisa di-GET langsung

**Cara pakai:**
1. Klik **+ Upload video** → tab **From URL**
2. Paste URL (auto-detect source type)
3. Optional: isi title (auto-detect dari source jika kosong)
4. Klik **Download** — server mulai download di background, progress bisa dipantau di library

**Teknis:**
- Module: `src/downloader.js`
- Endpoint: `POST /videos/import-url`, progress: `GET /videos/download/:jobId/progress`
- State: `jobs: Map<jobId, { progress, cancel }>`
- `detectSource(url)` return `'gdrive' | 'mega' | 'mediafire' | 'direct'`
- Video row dibuat dengan status `downloading` langsung (visible di library)
- Setelah sukses: update size, probe video info, status `uploaded`
- Failure: file partial dihapus, status `error`
- `reconcileOnBoot()` reset stale `downloading` → `error`

---

### Prepare (transcode)

**Apa:** One-shot transcode video ke stream-ready format (H.264 + AAC + GOP 2 detik) supaya live streaming bisa pakai `-c:v copy` (0% CPU).

**Cara pakai:**
1. Di library, klik tombol **Prepare** pada video dengan status `uploaded`
2. Modal terbuka dengan:
   - Info source (width × height @ fps) — auto-detected
   - Dropdown resolution/fps preset (720p30, 720p60, 1080p30, 1080p60)
   - Dropdown x264 preset (ultrafast → medium)
   - Live note tentang preset compatibility (e.g., "⚠ Upscale dari source")
3. Klik **Mulai Prepare** — proses background, progress bar + ETA real-time
4. Klik status badge `transcoding X%` untuk buka **Job Detail modal**:
   - Progress bar besar
   - Stats: time, speed, fps, ETA
   - FFmpeg log tail (auto-scroll)
   - Tombol Cancel kalau masih berjalan
5. Setelah sukses, source file **ditimpa** dengan hasil transcode, status → `ready`
6. Kalau gagal, status → `error`, klik badge `error` untuk lihat log

**Teknis:**
- Module: `src/transcoder.js`
- FFmpeg args penting: `-progress pipe:1 -nostats` untuk machine-readable progress
- Progress format: stdout emits `out_time`, `speed`, `fps` key=value pairs yang di-parse
- Output: `<basename>__<preset>_ready.mp4` → unlink source → rename ready → source
- `-movflags +faststart` supaya file seekable
- Thumbnail auto-regenerate setelah transcode selesai

**Endpoints:**
- `POST /videos/:id/prepare` — start job
- `POST /videos/:id/cancel-prepare` — cancel (SIGTERM)
- `GET /videos/:id/progress` — JSON snapshot
- `GET /videos/:id/status` — progress + log tail + ETA
- `GET /videos/:id/prepare-log` — full log text

---

### Video Thumbnails

**Apa:** Auto-generate thumbnail 1280×720 (YouTube-style) dari frame video untuk visual reference di library.

**Kapan di-generate:**
- Saat upload (async, non-blocking)
- Setelah Prepare sukses (karena file source ditimpa)
- Manual: klik placeholder video kosong di library (trigger `regen-thumb` endpoint)
- Bulk: `node scripts/generate-thumbs.js [--force]`

**Teknis:**
- `transcoder.generateThumbnail(videoPath, videoId)` di `src/transcoder.js`
- FFmpeg extract 1 frame pada **~10% durasi** video (min 1s, max 30s)
- Fallback ke frame 0 kalau seek gagal (video sangat pendek)
- Filter: `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black`
- Quality: JPEG `-q:v 3`
- Timeout: 20 detik
- Disimpan di `public/uploads/thumbs/thumb_<id>.jpg`
- Kolom DB: `videos.thumbnail` (string, nullable)

**Display:**
- Library table: 160×90px dengan hover scale + shadow
- Playlist picker: 60×34px
- Playlist items: 80×45px

---

### Video Folders

**Apa:** Organizer untuk library video — folder mirip File Explorer, bukan playlist.

**Perbedaan dengan Playlist:**
- **Folder** = storage organization (1 video = 1 folder max)
- **Playlist** = streaming queue (1 video bisa di banyak playlist)

**Cara pakai:**
1. Klik **+ Folder** di folder bar untuk bikin folder baru
2. Chip filter: klik **All** untuk lihat semua, klik folder untuk filter
3. Saat upload, video otomatis masuk ke folder aktif (kalau sedang di dalam folder)
4. Pindah video: klik icon **✏️ Edit** di row video, ganti folder di dropdown
5. Di dalam folder, ada bulk actions:
   - **▶ Create playlist** — bikin playlist baru dengan nama folder, isi dengan semua video `ready`
   - **⚙ Prepare all (N)** — transcode semua video `uploaded` di folder sekaligus
   - **Rename folder**
   - **Delete folder** (video di dalamnya tidak ikut terhapus, dipindah ke unfiled)

**Teknis:**
- Tabel: `folders (id, name, created_at)`
- Kolom baru: `videos.folder_id` (nullable FK)
- Route: `src/routes/videos.js` — folder CRUD + bulk actions
- Filter query: `?folder=<id>` untuk isi folder tertentu, `?folder=0` untuk unfiled

**Endpoints:**
- `POST /videos/folders/create` — buat folder
- `POST /videos/folders/:id/rename` — rename
- `POST /videos/folders/:id/delete` — hapus (video dipindah unfiled)
- `POST /videos/folders/:id/prepare-all` — bulk prepare
- `POST /videos/folders/:id/create-playlist` — convert ke playlist
- `POST /videos/folders/:id/delete-videos` — hapus semua video di folder (skip yang running)

---

### Custom thumbnail capture

**Apa:** Pilih frame spesifik dari video sebagai thumbnail. Berguna untuk YouTube — pilih frame paling dramatis (api besar, warna pop) supaya CTR thumbnail tinggi.

**Cara pakai:**
1. Klik thumbnail video di Library → modal preview HTML5 player terbuka
2. Scrub ke frame yang kamu mau
3. Pause → klik **📸 Set thumbnail from current frame**
4. AJAX request ke server, FFmpeg capture frame di detik itu, simpan jadi thumbnail
5. Image di-update in-place tanpa reload halaman (cache busting via `?v=<timestamp>`)

**Tombol kedua:** **⬇ Download thumbnail** — download JPEG 1280×720 dengan filename dari title video. Cocok sebagai base image untuk edit di Canva.

**Teknis:**
- `transcoder.generateThumbnail(path, id, { atSecond })` — clamp `atSecond` ke `[0, duration-0.1]`
- Endpoint `POST /videos/:id/regen-thumb` terima body `at_second` (form atau JSON)
- AJAX request set `Accept: application/json` → server return JSON `{ok, thumbnail, atSecond}`
- Endpoint `GET /videos/:id/thumb/download` — `Content-Disposition: attachment` dengan filename `.jpg`
- Cache-Control turun jadi `max-age=60` supaya thumbnail terupdate cepat

---

### Video download

**Apa:** Download file video dari library ke local disk dengan filename friendly.

**Teknis:**
- `GET /videos/:id/download` (auth-protected)
- `res.download(path, downloadName)` — set `Content-Disposition: attachment`
- Filename ASCII-only (RFC 6266 compliant)
- Support **HTTP Range** otomatis — file 10+ GB bisa resume kalau pakai download manager (IDM, FDM, aria2)

---

## Audio Library

**Apa:** Storage terpisah untuk file audio (musik background, sound effects). Tidak campur dengan video library.

**Format yang di-support:** MP3, M4A, AAC, WAV, OGG, OPUS, FLAC, WMA

**Cara pakai:**
1. Buka `/audio` (sidebar: Library → Audio)
2. Klik **+ Upload audio**, pilih file (max 500 MB), optional title
3. XHR upload dengan progress bar
4. Server auto-probe metadata via ffprobe: codec, duration, bitrate, sample rate, channels
5. Hasil tampil di tabel: Title, Format, Duration, Bitrate, Size, Status, Uploaded

**Actions per row:** Rename, Download, Delete (guard: tidak bisa hapus kalau dipakai stream running).

**Use case:**
- Background music untuk Loop tool (mix dengan video)
- Audio overlay saat live streaming (musik background untuk video silent)

**Teknis:**
- Tabel: `audio_tracks` (id, title, filename, size_bytes, duration_seconds, codec, bitrate, sample_rate, channels, status, last_error, created_at)
- Module: `src/audioManager.js`
- Storage: `public/uploads/audio/` (terpisah dari `public/uploads/`)
- Probe async via `setImmediate()` setelah upload (non-blocking response)
- Status: `uploaded` (default) atau `error` (kalau probe tidak detect audio stream)

**Endpoints:**
- `GET /audio` — library page
- `POST /audio/upload` — multer single file
- `POST /audio/:id/rename` — update title
- `POST /audio/:id/delete` — guard + cleanup file
- `GET /audio/:id/download` — download dengan filename friendly

---

## Loop tool

**Apa:** Perpanjang clip pendek jadi video panjang (30 menit - 24 jam) untuk 24/7 livestream atau YouTube upload.

**Use case utama:** generate fireplace 8 detik via Veo, mau jadi video 10 jam untuk channel YouTube ambient — pakai Loop tool, hasilnya file video panjang siap upload.

**Cara pakai:**
1. Buka `/looper` (sidebar: Loop)
2. Pilih video sumber (harus berstatus `ready`) + target durasi (preset Custom, 30 menit, 1 jam, 3 jam, atau 10 jam)
3. Pilih mode: **Smooth** (default, recommended) atau **Fast**
4. (Optional) Audio overlay — pilih audio track + mode (Mix/Replace) + volume
5. Klik **Start loop**
6. Progress bar + ETA + phase label di tabel "Active jobs"
7. Setelah selesai, video baru muncul di daftar video hasil loop di halaman `/looper` (terpisah dari Library Utama)

### Smooth vs Fast mode

| Aspek | Smooth | Fast |
|---|---|---|
| Loop boundary | Crossfade 1 detik (seamless) | Hard cut |
| Speed | Phase 1: re-encode (1-5 menit), Phase 2: copy (cepat) | Single pass copy (cepat) |
| Quality | Sedikit re-encode di seamless unit | 100% lossless |
| Best for | AI-generated clips yang loopnya tidak natural | Source yang sudah designed untuk loop |

**Teknis Smooth mode:**
1. Phase 1 — bikin "seamless unit" length L-D dimana boundary di start adalah crossfade `tail → head`. FFmpeg `xfade` filter (video) + `acrossfade` (audio kalau ada).
2. Phase 2 — `-stream_loop -1 -i seamless.mp4 -c copy -t target` — loop seamless unit sampai durasi target. Mata tidak catch transition karena join ada di tengah crossfade.

### Audio overlay di Loop

**Apa:** Tambahkan audio track saat loop — output adalah video panjang dengan audio sudah di-mix.

**Mode:**
- **Mix** — gabung dengan suara asli video (default volume overlay 0.3, video 1.0)
- **Replace** — ganti total suara video

**Teknis:**
- Phase 2 sekarang punya 2 input: `-i seamless.mp4 -stream_loop -1 -i audio.mp3`
- Filter: `[0:a]volume=1.0[va];[1:a]volume=<vol>[oa];[va][oa]amix=inputs=2:duration=first[aout]`
- Audio di-loop independen
- Video tetap `-c:v copy` (no re-encode!), audio di-encode ke AAC 192k

**Workflow ideal untuk fireplace + jazz:**
```
Video fireplace 8s (Veo) + Audio jazz 3 menit (SUNO)
       ↓
Loop tool: target 10 jam, Smooth, Mix, volume 0.3
       ↓
Phase 1: 1-3 menit
Phase 2: 2-5 menit
       ↓
Output: video 10 jam, ~20-25 GB, siap upload ke YouTube
```

**Endpoints:**
- `GET /looper` — list video hasil loop + form modal + active jobs + recent errors
- `POST /looper/start` — start job
- `GET /looper/progress` — JSON polling
- `POST /looper/:jobId/cancel` — abort
- `GET /looper/:jobId/log` / `GET /looper/video/:videoId/log` — text log

---

## Playlist management

### Create playlist dengan video picker

**Apa:** Modal all-in-one untuk bikin playlist baru — sekaligus pilih multiple video yang mau dimasukkan.

**Cara pakai:**
1. Klik **+ New playlist** di `/playlists`
2. Isi nama playlist
3. Toggle Loop (default on) / Shuffle (default off)
4. Video picker muncul: list video `ready` dengan checkbox, thumbnail, size, duration
5. Helper: **Select all** / **Clear**, counter "N selected / total"
6. Klik **Create playlist** — server bikin playlist + insert semua video ter-check dengan urutan pilihan

**Teknis:**
- Form field `video_ids[]` (array checkbox) — di-parse oleh server
- Di backend: bikin playlist, lalu loop `INSERT INTO playlist_items` dengan `position = idx + 1`
- Redirect ke `/playlists?notice=Playlist+created+with+N+videos`

**Sebelumnya:** Create playlist → buka detail page → add video satu per satu (3 step). Sekarang 1 step.

---

### Manage playlist (modal)

**Apa:** Edit isi playlist (add/remove video) lewat modal dengan AJAX — tidak perlu buka halaman detail.

**Cara pakai:**
1. Klik icon list (📋) di row playlist
2. Modal terbuka, fetch state via AJAX
3. Tampilkan semua video `ready` dengan checkbox:
   - Video yang sudah ada di playlist → auto-check
   - Video lain → unchecked
4. Toggle checkbox untuk tambah/hapus
5. Klik **Save changes** → AJAX `POST /playlists/:id/sync` dengan list `video_ids`
6. Server diff: tambah yang baru di-check, hapus yang di-uncheck
7. Page reload untuk refresh count & thumbnail

**Teknis:**
- Endpoint: `GET /playlists/:id/state.json` return `{ playlist, itemIds, videos }`
- Endpoint: `POST /playlists/:id/sync` JSON body `{ video_ids: [1, 2, 3] }` — sync diff
- Halaman detail `/playlists/:id` tetap ada untuk reorder (↑↓), tapi untuk add/remove modal cukup

---

### Shuffle mode

**Apa:** Playlist putar video secara acak, bukan sequential.

**Cara pakai:**
- Centang **Shuffle** saat create/edit playlist
- Kalau aktif: advancePlaylist pick random video, skip current
- Kalau 1 video doang, shuffle tidak berpengaruh
- Bisa dikombinasikan dengan Loop

**Teknis:**
- Kolom: `playlists.shuffle` (INTEGER 0/1)
- `streamManager.advancePlaylist()`: kalau shuffle aktif, `Math.floor(Math.random() * items.length)` dengan exclude current index

---

### Collage thumbnail

**Apa:** Thumbnail playlist di halaman list adalah **collage** dari 4 video pertama, bukan 1 thumbnail saja.

**Layout adaptif:**
| Jumlah video | Layout |
|---|---|
| 0 | Icon placeholder (kotak) |
| 1 | Thumbnail penuh |
| 2 | Split 50/50 horizontal |
| 3 | 1 besar kiri + 2 stacked kanan |
| 4+ | Grid 2×2 dari 4 video pertama |

**Teknis:**
- Query: ambil 4 thumbnail pertama (`LIMIT 4` dengan `thumbnail IS NOT NULL`)
- Render: CSS Grid dengan `.collage-1/2/3/4` — tidak generate composite image (ringan, instant)
- Badge count: `▶ N` di pojok kanan bawah

---

## Streaming

### Stream Single Video

**Apa:** Stream 1 video ke RTMP endpoint (loop atau sekali putar).

**Cara pakai:**
1. `/streams/single` → **+ New stream**
2. Isi Name, pilih Video, pilih Platform (YouTube/Facebook/Twitch/Custom)
3. RTMP URL auto-fill dari platform preset, bisa di-override
4. Paste Stream key (input type password dengan toggle mata)
5. Toggle Loop video
6. Klik **Simpan** — stream dibuat dengan status `idle`
7. Klik icon ▶ Start untuk mulai streaming
8. Saat running: Start berubah jadi ■ Stop, kolom "Last run" menampilkan live timer

**Modes:**
- **Copy mode** (default, `re_encode=0`) — 0% CPU, butuh source sudah H.264+AAC
- **Re-encode mode** (`re_encode=1`) — transcode on-the-fly, CPU signifikan, tapi toleran terhadap source format apapun

**Teknis:**
- Module: `src/streamManager.js`
- FFmpeg args dibangun di `startStream()` — beda untuk copy vs re-encode
- Stream key selalu di-redact di log (`makeRedactingStream`)
- Default args: `-hide_banner -loglevel warning -re -stream_loop -1 -i <video> -map 0:v:0 -map 0:a:0?`

---

### Stream Playlist

**Apa:** Stream playlist video — auto-advance ke video berikutnya saat satu selesai.

**Cara pakai:**
1. `/streams/playlist` → **+ New stream**
2. Pilih Playlist (harus sudah punya items)
3. Sisanya sama dengan Single Video
4. Saat start, stream play video pertama, lalu auto-advance:
   - **Sequential** (default): urut posisi
   - **Shuffle**: random
   - **Loop**: setelah video terakhir, wrap ke awal

**Teknis:**
- Kolom `streams.playlist_id` (nullable) — kalau set, mode playlist
- `streamManager.advancePlaylist(stream)`:
  - Cek items di playlist
  - Pilih next (sequential / random)
  - Update `streams.video_id` ke video berikutnya
  - Re-spawn FFmpeg dengan 1 detik delay (avoid rapid restart loops)

---

### Audio overlay saat streaming

**Apa:** Mix audio track terpisah dengan video saat live streaming — musik background untuk video silent (misal fireplace tanpa suara) atau tambahan ambience.

**Cara pakai:**
1. Upload audio di `/audio` dulu
2. Saat create/edit stream (Single atau Playlist), pilih audio dari dropdown **Audio overlay**
3. Set **Volume overlay** (0.0 - 1.0, default 0.3 = 30%)
4. Start stream

**Mode otomatis:**
- Video punya audio track → mix kedua audio (video full volume + overlay configurable)
- Video silent → overlay jadi satu-satunya audio

**Teknis:**
- Kolom: `streams.audio_id` (FK ke `audio_tracks`), `streams.audio_volume` (default '0.3')
- FFmpeg args: tambah `-stream_loop -1 -i <audio>` sebagai input ke-2
- Filter `amix=inputs=2:duration=first` kalau video has_audio, atau langsung `[1:a]volume=<vol>` kalau silent
- `videos.has_audio` di-cache saat upload/probe — tidak perlu probe sync setiap stream start
- Audio di-loop independen dari video

**Differences dengan Loop tool:**
- **Streaming overlay** = real-time, tidak bikin file output baru
- **Loop tool** = bikin file video panjang yang sudah di-mix (siap upload/distribute)

---

### Auto-Retry + Health Check

**Apa:** Recovery otomatis untuk stream yang crash atau stale.

**Auto-Retry:**
- FFmpeg exit dengan code non-zero (dan bukan SIGTERM dari user) → retry otomatis
- Max 5 attempts dengan exponential backoff (3s → 60s max + jitter)
- User stop = no retry (flag `retryStopped`)
- Setelah max retries atau stream `idle` → status `error`
- Retry attempt terlihat di `last_error`: `ffmpeg crashed (code N), retry 2/5 in 12s`

**Health Check:**
- Polling setiap 30 detik
- Detect stream stale: tidak ada output FFmpeg selama 5 menit
- Stream stale di-SIGKILL → exit handler trigger retry logic

**Teknis:**
- State: `retryCount: Map<id, number>`, `retryStopped: Set<id>`
- `getRetryDelay(attempt)`: `Math.min(BASE * 2^n, MAX) + jitter`
- Activity tracking: `proc.stdout/stderr.on('data')` update `lastActivity` timestamp
- `startHealthCheck()` dipanggil di `reconcileOnBoot()`

---

### Stream Duration Timer

**Apa:** Live counter yang menampilkan berapa lama stream sudah jalan.

**Format:** `🔴 2h 15m 30s` — adaptif: detik → menit → jam → hari
- Update setiap 1 detik via JavaScript
- Tampil di `/streams/single`, `/streams/playlist`, dan Dashboard (recent streams)

**Teknis:**
- `data-started-at="<ISO string>"` di span `.stream-timer`
- Client JS: hitung `Date.now() - startMs`, format ke string
- Pure client-side, tidak polling server

---

### Stream Log modal

**Apa:** Lihat log FFmpeg via modal (bukan buka tab baru), dengan auto-refresh untuk stream yang running.

**Cara pakai:**
1. Klik icon dokumen (📄) di row stream
2. Modal terbuka dengan log tail (80 lines)
3. Kalau stream running: auto-refresh setiap 3 detik (status: 🔴 Live · auto-refresh 3s)
4. Kalau stream idle/stopped: fetch sekali (status: "Last log (stream idle)")
5. Toggle **Auto-scroll** — default on, scroll ke bawah otomatis
6. Tombol **Refresh** untuk manual reload

**Teknis:**
- Endpoint: `GET /streams/:id/log` (plain text)
- Modal di-`modal:before-open` event → set `currentStreamId`, fetch once
- Kalau `status === 'running'`: `setInterval(fetchLog, 3000)`
- Modal close event: `clearInterval`
- Auto-scroll cerdas: preserve scroll position kalau user scroll ke atas

---

### Stream Edit modal

**Apa:** Edit konfigurasi stream tanpa harus delete + recreate.

**Cara pakai:**
1. Klik icon ✏️ Edit di row stream
2. Modal terbuka dengan data existing
3. Ganti apapun: name, video/playlist, platform, RTMP URL, stream key, loop
4. Klik **Save**

**Constraint:**
- Stream yang sedang **running tidak bisa di-edit** — harus Stop dulu
- Title tidak boleh duplicate

**Teknis:**
- Endpoint: `POST /streams/:id/edit`
- Guard: `if (streamManager.isRunning(id)) return redirect with error`

---

## Scheduling

**Apa:** Auto-start / auto-stop stream berdasarkan jadwal UTC.

**Cara pakai:**
1. `/schedules` → **+ New schedule**
2. Pilih Stream (harus sudah dibuat)
3. Isi Start at (datetime-local input, timezone user)
4. Optional: Stop at (kalau kosong, stream jalan sampai video selesai atau dihentikan manual)
5. Klik **Simpan**

**Status flow:**
```
pending → started → done | error
         ↓
       cancelled (user action, hanya saat pending)
```

**Teknis:**
- Polling 15 detik di main process (tidak pakai cron external)
- `src/scheduler.js` — stateless, semua dibaca dari tabel `schedules` tiap tick
- Waktu disimpan sebagai UTC ISO string (`2026-05-11T15:30:00Z`) — lexicographic compare valid
- `parseLocalToUTC(str, tz)` di route convert datetime-local → UTC ISO
- `reconcileOnBoot()` set stale `started` → `error` (operator review manual)

---

## Stream History

**Apa:** Riwayat sesi streaming yang sudah selesai.

**Kapan dicatat:**
- Stream stop manual (tombol Stop)
- Stream exit normal (video finished, non-loop)
- Stream error (FFmpeg crash, max retries reached)
- **Minimum 10 detik durasi** — stream yang baru jalan 3 detik tidak dicatat

**Cara lihat:**
- `/history` — tabel dengan stream name, video, platform, duration, status, stopped_at
- Dashboard: "Recent streams" + link "View full history (N entries)"
- Delete per entry atau "Clear All"

**Teknis:**
- Tabel: `stream_history` (stream_id, stream_name, video_title, platform, started_at, stopped_at, duration_seconds, status, last_error)
- `saveHistory()` di `src/streamManager.js` dipanggil saat `stopStream()` dan di exit handler
- Insert dilakukan sebelum DELETE stream — history survive meskipun stream row dihapus

---

## YouTube Upload

**Apa:** Upload video langsung ke YouTube dari AwanStream tanpa harus download dulu ke PC. Sangat berguna kalau AwanStream di-deploy di VPS dengan bandwidth besar — file 30 GB selesai dalam menit, bukan jam.

### Connect (OAuth)

**Cara pakai:**
1. Setup Google Cloud project + OAuth credentials (lihat `docs/youtube-setup.md`)
2. Tambahkan ke `.env`:
   ```env
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   YOUTUBE_REDIRECT_URI=http://localhost:7575/youtube/callback
   ```
3. Restart AwanStream
4. Buka `/youtube` (sidebar: YouTube)
5. Klik **Connect YouTube** → redirect ke Google consent screen
6. Login + setujui akses (upload + read channel info)
7. Status berubah jadi **Connected** dengan channel name

**Teknis:**
- Tabel: `youtube_accounts` (channel_id, channel_title, access_token, refresh_token, expiry_date, scope)
- Single-account model — connect satu kali, semua upload pakai akun itu
- Refresh token auto-update via googleapis `oauth2.on('tokens')` event
- Disconnect tombol revoke token di Google + clear DB row

### Upload video

**Cara pakai:**
1. Di video library, klik tombol YouTube (icon biru) di row video status `ready`
2. Modal terbuka dengan form:
   - **Title** — default dari `videos.title`, max 100 karakter
   - **Privacy** — Unlisted (default, recommended) / Private / Public
   - **Category** — Music (default), People & Blogs, Entertainment, Gaming, Education, Science & Tech
3. Klik **Start upload**
4. Progress bar real-time + bytes sent/total + percent + status
5. Setelah selesai → 2 tombol:
   - **Open in YouTube Studio** — edit metadata + publish manual
   - **View on YouTube** — buka video page

**Default behavior:**
- Privacy: **Unlisted** — supaya kamu bisa cek hasil dulu sebelum public
- Description: empty (edit di Studio)
- Tags: empty (edit di Studio)
- Notify subscribers: **false**
- Made for kids: **false**

**Teknis:**
- Tabel: `youtube_uploads` (video_id, youtube_video_id, title, privacy, category_id, status, bytes_sent, total_bytes, percent, last_error, started_at, finished_at)
- Status state machine: `pending → uploading → done | error | cancelled`
- Module: `src/youtubeUploader.js`
- Resumable upload via googleapis `youtube.videos.insert` — handle chunked transfer + auto-retry transparently
- Cancel via `AbortController` signal
- Log per upload: `logs/youtube-upload-<id>.log`
- Reconcile on boot: stale `pending`/`uploading` rows → `error` ("upload interrupted by server restart")

### Resume modal

**Apa:** Kalau modal di-close mid-upload, klik icon biru YouTube di video row akan re-open modal dan resume polling progress. Server upload tetap jalan independen dari modal.

**Cara pakai:**
1. Mulai upload, modal close
2. Di video row, icon YouTube biru dengan badge percent muncul (auto-refresh tiap 3 detik)
3. **Klik icon biru itu** → modal terbuka kembali
4. Polling progress resume otomatis dari job aktif

**Teknis:**
- Button uploading punya `data-yt-watch-job` (untuk badge auto-update) + `data-yt-resume-job` (untuk click handler)
- Click handler set `resumeMode = true`, skip form, langsung tampilkan progress view
- `resumeMode` di-check di submit handler — kalau true, return early supaya tidak start upload baru

**Limitasi sekarang:**
- Job hilang dari memory 30 detik setelah selesai → klik icon setelah itu reload page
- Server restart mid-upload → status `error`, harus mulai dari awal (no resume across restarts)
- Cuma visible di halaman `/videos` — kalau navigate ke halaman lain tidak ada indicator

**Endpoints:**
- `GET /youtube` — status page (3 states: not-configured / not-connected / connected)
- `GET /youtube/connect` — redirect ke Google consent
- `GET /youtube/callback` — OAuth callback handler
- `POST /youtube/disconnect` — revoke + clear DB
- `POST /youtube/upload/:videoId` — start upload (return JSON kalau Accept: application/json)
- `GET /youtube/upload/:jobId/progress` — JSON polling
- `POST /youtube/upload/:jobId/cancel` — abort
- `GET /youtube/uploads/active` — list active jobs

**Quota:**
- Default: 10,000 units/hari per Google Cloud project
- Upload video = ~1,600 units → max **6 video/hari**
- Reset jam 00:00 Pacific Time (= 15:00 WIB)
- Request quota increase di Google Cloud Console kalau perlu

---

## Dashboard & System Monitor

**Apa:** Overview app + real-time CPU/RAM/Disk/Network speed di dashboard, plus bandwidth bulanan dari vnStat.

**Stat cards:** Videos, Streams, Schedules, Storage — dengan ikon warna-warni + link ke halaman masing-masing.

**System monitor:**
- CPU% (hitung dari `os.loadavg()[0] / cpuCount * 100`)
- Memory% (dari `os.totalmem()/freemem()`)
- Disk usage (dari `fs.statfsSync()` pada `public/uploads`)
- Network speed live (delta `/proc/net/dev` via SSE / polling)
- BW Bulan Ini (dari `vnstat --json`; fallback `N/A` kalau vnStat belum tersedia)
- SSE `GET /api/events`, fallback polling ke `GET /api/system`

**Recent streams:** 5 stream terakhir (status + waktu)

**Next schedule:** pending schedule dengan `start_at` terdekat

---

## HTTP Request Logger (Morgan)

**Apa:** Log setiap HTTP request ke console dengan format NestJS-style.

**Output:**
```
[AwanStream] - 05/11/2026, 08:30:22 PM   LOG  GET /videos 200 - 13ms - IP: 127.0.0.1
[AwanStream] - 05/11/2026, 08:32:46 PM   LOG  POST /videos/upload 302 - 145ms - IP: 127.0.0.1
[AwanStream] - 05/11/2026, 08:35:22 PM   LOG  POST /videos/chunked/abc/finalize 400 - 3ms - IP: 127.0.0.1
```

**Color coding:**
- `[AwanStream]` — kuning
- `LOG` — hijau
- Status 2xx/3xx — cyan, 4xx — kuning, 5xx — merah
- IP — merah

**Konfigurasi:**
- Skip static assets (.css, .js, .png, dll) untuk keep output clean
- Latency integer (tanpa desimal) dengan `Math.round()`
- IP diambil dari `x-forwarded-for` kalau ada, fallback ke `req.ip`

**File:** `app.js` (setelah `express.urlencoded`, sebelum `express.static`)

---

## Security: protected media serving

**Apa:** File di `public/uploads/` (video, audio, thumbnail) **tidak di-expose** via static middleware. Semua akses lewat protected route yang require session auth.

**Sebelum (legacy, ada di pre-release):**
```
GET /uploads/1778503421404_Fireplace.mp4 → file served, NO AUTH
GET /uploads/thumbs/thumb_42.jpg → image served, NO AUTH
```

Siapa pun dengan URL bisa download video/thumbnail tanpa login. Risk leak.

**Sekarang:**
```
app.use('/css', express.static('public/css'))  // hanya CSS yang public
// public/uploads/ tidak di-serve sebagai static
```

Akses video/audio/thumbnail lewat protected route:
- `GET /videos/:id/file` — stream video untuk HTML5 player (support HTTP Range)
- `GET /videos/:id/download` — download dengan filename friendly
- `GET /videos/:id/thumb` — thumbnail image (cache 60s)
- `GET /videos/:id/thumb/download` — download thumbnail JPEG
- `GET /audio/:id/download` — download audio dengan filename friendly

**Semua route ini di-mount via `requireAuth` middleware**, jadi unauthenticated request dapat 401 (JSON) atau redirect ke /login (HTML).

**Catatan untuk view:**
- ❌ JANGAN: `<img src="/uploads/thumbs/thumb_42.jpg">`
- ✅ DO: `<img src="/videos/42/thumb">`

---

## UI conventions

### Icon buttons (btn-icon)
Action buttons di tabel diganti jadi icon seragam dengan tooltip (`title="…"`):
- **Start** — play icon (biru)
- **Stop** — stop square (kuning)
- **Edit** — pencil
- **Log** — document
- **Delete** — trash (hover merah)
- **Manage playlist** — 3 horizontal lines
- **Move folder** / **Thumbnail empty** — clickable placeholder

Semua pakai class `.btn-icon` + variant `.btn-icon-primary` / `.btn-icon-warn` / `.btn-icon-danger`.

### Stream key show/hide toggle
Input type `password` dengan tombol icon mata di ujung. Global handler di `views/partials/footer.ejs`:
```html
<div class="input-with-toggle">
  <input type="password" id="my-key">
  <button class="input-toggle" data-toggle-input="my-key">
    <svg class="eye-show">…</svg>
    <svg class="eye-hide" style="display:none">…</svg>
  </button>
</div>
```

### Modal pattern
Semua form New/Edit pakai native `<dialog>` dengan:
- `data-open-modal="<id>"` — trigger buka
- `data-close-modal` — tombol tutup
- `modal:before-open` event — populate form sebelum show

### Confirm modal
Replace `window.confirm()` dengan custom modal:
```html
<form data-confirm="Message" data-confirm-title="Title" data-confirm-action="Delete">
```
Global listener di `views/partials/footer.ejs` otomatis render modal dark yang konsisten.

### Toast notifications
Flash messages (`?notice=...` / `?error=...`) di-render sebagai toast (kanan atas, auto-dismiss 4 detik). URL cleanup via `history.replaceState` — refresh page tidak re-show toast.

### Platform presets
PRESETS di `src/routes/streams.js` sekarang object `{ label, url }`:
```js
{
  youtube:  { label: 'YouTube',  url: 'rtmp://x.rtmp.youtube.com/live2' },
  facebook: { label: 'Facebook', url: 'rtmps://live-api-s.facebook.com:443/rtmp' },
  twitch:   { label: 'Twitch',   url: 'rtmp://live.twitch.tv/app' },
  custom:   { label: 'Custom',   url: '' },
}
```
- Value (lowercase) = DB key
- Label (capitalized) = display text
- Dropdown default: placeholder "Select platform…" (disabled, required)

### Pagination
Library video menggunakan pagination 20 per halaman:
- URL: `/videos?page=2` atau `/videos?folder=X&page=2`
- Smart ellipsis untuk halaman banyak: `← Prev 1 … 4 5 [6] 7 8 … 20 Next →`
- Hanya muncul kalau total > 20

---

## Lihat juga

- [Architecture](architecture.md) — diagram request flow & state machines
- [Codebase map](codebase.md) — detail tiap file
- [Services reference](services.md) — API reference modul backend
- [Deployment](deployment.md) — systemd / pm2 / docker setup
- [CHANGELOG](../CHANGELOG.md) — history perubahan
