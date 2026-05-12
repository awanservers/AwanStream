# Features reference

Dokumentasi per-fitur AwanStream. Untuk setiap fitur: apa fungsinya, cara pakainya dari UI, dan implementasi teknisnya (file, endpoint, tabel).

## Daftar isi

- [Video management](#video-management)
  - [Upload (XHR)](#upload-xhr)
  - [Import dari URL](#import-dari-url)
  - [Prepare (transcode)](#prepare-transcode)
  - [Video Thumbnails](#video-thumbnails)
  - [Video Folders](#video-folders)
- [Playlist management](#playlist-management)
  - [Create playlist dengan video picker](#create-playlist-dengan-video-picker)
  - [Manage playlist (modal)](#manage-playlist-modal)
  - [Shuffle mode](#shuffle-mode)
  - [Collage thumbnail](#collage-thumbnail)
- [Streaming](#streaming)
  - [Stream Single Video](#stream-single-video)
  - [Stream Playlist](#stream-playlist)
  - [Auto-Retry + Health Check](#auto-retry--health-check)
  - [Stream Duration Timer](#stream-duration-timer)
  - [Stream Log modal](#stream-log-modal)
  - [Stream Edit modal](#stream-edit-modal)
- [Scheduling](#scheduling)
- [Stream History](#stream-history)
- [Dashboard & System Monitor](#dashboard--system-monitor)
- [HTTP Request Logger (Morgan)](#http-request-logger-morgan)
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

## Dashboard & System Monitor

**Apa:** Overview app + real-time CPU/RAM/Uptime di dashboard.

**Stat cards:** Videos, Streams, Schedules, Storage — dengan ikon warna-warni + link ke halaman masing-masing.

**System monitor:**
- CPU% (hitung dari `os.loadavg()[0] / cpuCount * 100`)
- Memory% (dari `os.totalmem()/freemem()`)
- Uptime (dari `os.uptime()`)
- Polling setiap 3 detik ke `GET /api/system`

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
