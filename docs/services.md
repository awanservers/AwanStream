# Services / Modules reference

API reference untuk modul-modul internal di `src/`. Ini kontrak yang harus dijaga saat refactor, dan cheat-sheet untuk memakai modul-modul ini dari route baru.

## `src/db.js`

**Purpose:** single source of truth SQLite handle + schema lifecycle.

### Exports

```js
const { db, ensureSchema } = require('./db');
```

#### `db` — `Database` instance (better-sqlite3)

Singleton. Sudah di-configure `journal_mode = WAL`. Pakai prepared statements:

```js
db.prepare('SELECT * FROM videos WHERE id=?').get(id);
db.prepare('INSERT INTO streams (...) VALUES (...)').run(...);
db.prepare('UPDATE videos SET status=? WHERE id=?').run('ready', id);
```

**Jangan** buat instance `Database` kedua — SQLite WAL + multiple handles = pain.

#### `ensureSchema()` → `void`

Idempotent. Buat tabel kalau belum ada, tambah kolom baru via `PRAGMA table_info` guard. Aman dipanggil berkali-kali. Dipanggil sekali di `app.js` saat startup.

Untuk tambah kolom baru, edit helper inline di `ensureSchema()`:

```js
const cols = db.prepare('PRAGMA table_info(streams)').all().map(c => c.name);
const add = (name, type, def) => {
  if (!cols.includes(name)) db.exec(`ALTER TABLE streams ADD COLUMN ${name} ${type} DEFAULT ${def}`);
};
add('new_col', 'TEXT', "'default_value'");
```

---

## `src/auth.js`

**Purpose:** session-based auth middleware.

### Exports

```js
const { requireAuth, injectUser } = require('./auth');
```

#### `requireAuth(req, res, next)` — Express middleware

Cek `req.session.userId`. Kalau tidak ada:
- Request mau HTML → `res.redirect('/login')`
- Request mau JSON → `res.status(401).json({ error: 'unauthorized' })`

**Pakai di route yang protected:**
```js
app.use('/videos', requireAuth, videoRoutes);
```

Kalau request sudah login, `req.session.userId` dan `req.session.username` tersedia.

#### `injectUser(req, res, next)` — Express middleware

Set `res.locals.currentUser = { id, username }` atau `null`. Wajib di-register sebelum mount route yang render view yang memakai `currentUser` (dashboard, nav, dll).

---

## `src/streamManager.js`

**Purpose:** lifecycle manager untuk FFmpeg child process yang push video → RTMP endpoint. Handle auto-retry, health check, playlist advance, dan stream history.

### State

- `running: Map<streamId, { process, logStream, startedAt, lastActivity }>` — in-memory, tidak dipersist. Hilang saat restart, di-reconcile via `reconcileOnBoot()`.
- `retryCount: Map<streamId, number>` — attempt counter per stream, reset ke 0 setelah berhasil jalan.
- `retryStopped: Set<streamId>` — flag user stop (skip auto-retry).
- `retryTimers: Map<streamId, NodeJS.Timeout>` — pending retry setTimeout handles.

### Exports

```js
const streamManager = require('./streamManager');
// Methods: startStream, stopStream, isRunning, reconcileOnBoot, tailLog,
//          startHealthCheck, stopHealthCheck
```

#### `startStream(stream, videoPath)` → `void`

- `stream` = row dari tabel `streams`
- `videoPath` = path absolut ke file video
- **Throws:**
  - `Error('Stream already running')` — kalau `isRunning(id)` sudah true
  - `Error('Video file not found: ...')` — kalau `videoPath` tidak exist
- **Side effects:**
  - Spawn `ffmpeg` child, simpan `startedAt`, setup activity tracking via `stdout/stderr.on('data')` update `lastActivity`
  - Tulis log ke `logs/stream-<id>.log` (stream key di-redact via `makeRedactingStream`)
  - UPDATE `streams` SET `status='running'`, `started_at=CURRENT_TIMESTAMP`
  - On exit normal (code 0): cek `advancePlaylist(stream)` — kalau playlist punya next, start video berikutnya
  - On exit error (code non-zero) + bukan user stop: trigger `scheduleRetry(streamId, videoPath)`
  - On exit final (no retry / max retries): `saveHistory(stream, status, errorMsg)` dan UPDATE status

#### `stopStream(streamId)` → `boolean`

- Mark `retryStopped.add(streamId)` agar exit handler tidak trigger retry
- Cancel pending retry timer kalau ada
- Set `status='idle'` di DB dulu (supaya exit handler tidak overwrite ke `error`)
- SIGTERM ke child process kalau masih ada
- `saveHistory()` dengan status `completed`
- Return `true` kalau ada process yang di-kill, `false` kalau memang tidak running

#### `isRunning(streamId)` → `boolean`

Cek in-memory Map. Tidak query DB.

#### `reconcileOnBoot()` → `void`

UPDATE semua row `status='running'` menjadi `idle` dengan `stopped_at=now`. Panggil **sekali** di `app.js` saat startup, sebelum `app.listen(...)`.

#### `tailLog(streamId, lines=80)` → `string`

Baca tail file log. Redact stream key sebelum return (defense in depth kalau ada log lama sebelum redaction aktif).

#### `startHealthCheck()` / `stopHealthCheck()` → `void`

Idempotent. Mulai `setInterval` 30 detik yang iterasi `running` Map, check `lastActivity` > 5 menit lalu → SIGKILL child (exit handler lalu trigger retry). Panggil sekali di `app.js` startup.

### Internal helpers

- `buildRtmpTarget(url, key)` — gabung URL + key dengan normalisasi trailing slash
- `redact(text, secret)` — regex replace occurrence `secret` → `***REDACTED***`
- `makeRedactingStream(logStream, secret)` — writer wrapper. **Semua tulisan log ffmpeg wajib lewat ini.**
- `advancePlaylist(stream)` → `boolean` — cek `playlists.shuffle`:
  - Shuffle on → pick random item (exclude current kalau > 1 item)
  - Shuffle off → next position sequential
  - Kalau `loop_playlist=1` dan sudah di akhir → wrap ke posisi 0
  - Return `false` kalau tidak ada next (playlist non-loop selesai)
- `saveHistory(stream, status, errorMsg)` — insert row `stream_history` kalau durasi >= 10 detik. Fields: `stream_id`, `stream_name`, `video_title`, `platform`, `started_at`, `stopped_at`, `duration_seconds`, `status` (`completed` | `error`), `last_error`.
- `getRetryDelay(attempt)` → number (ms) — exponential backoff: `min(3000 * 2^attempt, 60000) + jitter(0..1000)`.
- `scheduleRetry(streamId, videoPath)` → schedule setTimeout berdasarkan `retryCount`. Max 5 attempts. Setelah max atau user stop → tidak retry lagi.

### FFmpeg args ringkasan

```
-hide_banner -loglevel warning -re
[-stream_loop -1]                         ← kalau loop_video
-i <videoPath>
-map 0:v:0 -map 0:a:0?                    ← skip cover art / attachments

# Copy mode:
-c:v copy -c:a aac -b:a 128k -ar 44100

# Re-encode mode:
-c:v libx264 -preset <preset> -tune zerolatency -profile:v high -pix_fmt yuv420p
-b:v <br> -maxrate <br> -bufsize <2*br>
-g <kf*60> -keyint_min <kf*60> -sc_threshold 0
-force_key_frames expr:gte(t,n_forced*<kf>)
-c:a aac -b:a 128k -ar 44100 -ac 2

-max_muxing_queue_size 1024
-f flv <target>
```

---

## `src/transcoder.js`

**Purpose:** one-shot Prepare — transcode video jadi stream-ready, lalu menimpa file asli.

### State

- `jobs: Map<videoId, process>` — in-memory

### Presets

```js
{
  '720p30':  { w:1280, h:720,  fps:30, br:'2500k', kf:2 },
  '720p60':  { w:1280, h:720,  fps:60, br:'4000k', kf:2 },
  '1080p30': { w:1920, h:1080, fps:30, br:'4500k', kf:2 },
  '1080p60': { w:1920, h:1080, fps:60, br:'6000k', kf:2 },
}
```

### Exports

```js
const transcoder = require('./transcoder');
// Methods: presets, start, cancel, isRunning, reconcileOnBoot, tailLog,
//          getProgress, probeDuration, probeVideoInfo, validateCodec,
//          generateThumbnail
```

#### `presets()` → `object`

Return map preset. Dipakai view `/videos` untuk render dropdown.

#### `start(videoId, presetName, x264Preset='medium')` → `void`

- **Throws:**
  - `Error('Transcode already running for this video')`
  - `Error('Video not found')`
  - `Error('Unknown preset: ...')`
  - `Error('Source file missing')`
- **Side effects:**
  - Kalau `videos.duration_seconds` null, probe via ffprobe dan UPDATE ke DB
  - UPDATE `videos` SET `status='transcoding'`, `last_error=NULL`
  - Spawn ffmpeg dengan `-progress pipe:1 -nostats` → parse stdout key=value untuk update in-memory progress
  - Write ke `<basename>__<preset>_ready.mp4`
  - On success: `unlink(source)` + `rename(ready, source)`, re-probe duration baru, UPDATE status `ready`, `size_bytes`, `duration_seconds`
  - On failure: hapus file partial, UPDATE status `error`, `last_error=<pesan>`

#### `cancel(videoId)` → `boolean`

SIGTERM child. Route handler yang pakai ini biasanya juga UPDATE status balik ke `uploaded`.

#### `isRunning(videoId)` → `boolean`

#### `reconcileOnBoot()` → `void`

UPDATE `status='transcoding'` → `status='error'` dengan message "transcoding interrupted by server restart". Panggil di `app.js` startup.

#### `tailLog(videoId, lines=60)` → `string`

Baca `logs/transcode-<id>.log`. Tidak ada secret di log ini.

#### `getProgress(videoId)` → `object | null`

Return current in-memory progress atau `null` kalau job tidak running. Shape:

```js
{
  percent: 42,       // 0-100 atau null kalau duration tidak diketahui
  time: 123.45,      // detik output yang sudah selesai di-encode
  duration: 300,     // detik total source (atau null)
  speed: 1.8,        // encode speed (x)
  fps: 58.3,         // output framerate saat ini
}
```

#### `probeDuration(filePath)` → `number | null`

Synchronous `ffprobe` call. Return detik (float) atau null kalau file tidak bisa diprobe. Dipakai di route `POST /videos/upload` dan di dalam `start(...)`.

#### `probeVideoInfo(filePath)` → `object | null`

Full media probe dalam satu call. Return:
```js
{
  width: 1920,
  height: 1080,
  fps: 30,
  duration: 300.5,
  videoCodec: 'h264',
  audioCodec: 'aac',
}
```
Dipakai di route upload, URL import, dan form Prepare untuk auto-detect source info.

#### `validateCodec(filePath)` → `object`

Cek H.264 video + AAC audio via ffprobe (sync, timeout 30s). Return:
```js
{
  ok: true | false,
  issues: ['Video codec is hevc (expected h264)', ...],  // empty kalau ok
  info: { videoCodec, audioCodec, width, height },
}
```
Dipakai di `streams.js` `POST /:id/start` saat Copy mode aktif. Redirect dengan error kalau `ok === false`.

#### `generateThumbnail(videoPath, videoId)` → `Promise<string | null>`

Extract 1 frame dari video ke JPEG 1280×720 di `public/uploads/thumbs/thumb_<id>.jpg`. Update kolom `videos.thumbnail`. Return filename atau `null` kalau gagal.

- Seek ke `min(duration * 0.10, 30)` detik (skip intro kalau video panjang, min 1s)
- Fallback ke frame 0 kalau seek gagal (video sangat pendek)
- Filter: `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black`
- Quality: `-q:v 3` (≈ high quality JPEG)
- Timeout: 20 detik (kalau lewat → kill + resolve null)
- Dipanggil async via `setImmediate()` setelah upload response terkirim (non-blocking)
- Dipanggil juga otomatis setelah Prepare sukses (karena source file ditimpa)

### FFmpeg args ringkasan

```
-hide_banner -y
-nostats                    ← matikan stats text biar stderr bersih
-progress pipe:1            ← machine-readable progress ke stdout
-i <src>
-map 0:v:0 -map 0:a:0?
-vf scale=<W>:<H>:force_original_aspect_ratio=decrease,
    pad=<W>:<H>:(ow-iw)/2:(oh-ih)/2,
    fps=<fps>
-c:v libx264 -preset <x264Preset> -profile:v high -pix_fmt yuv420p
-b:v <br> -maxrate <br> -bufsize <2*br>
-g <kf*fps> -keyint_min <kf*fps> -sc_threshold 0
-c:a aac -b:a 128k -ar 44100 -ac 2
-movflags +faststart
<output>
```

Beda signifikan dari live streaming:
- Tidak pakai `-re` (baca secepat mungkin, bukan real-time)
- Tidak pakai `-tune zerolatency` (boleh delay demi kualitas)
- Pakai `-movflags +faststart` (moov atom di depan → bisa seek cepat)
- Pakai `-progress pipe:1` + `-nostats` untuk progress reporting (stdout hanya berisi key=value pairs)

---

## `src/scheduler.js`

**Purpose:** polling loop yang auto-start / auto-stop streams berdasarkan tabel `schedules`.

### State

Tidak ada state in-memory. Semua dibaca dari DB tiap tick, supaya operator bisa insert/cancel/delete langsung di DB dan tick berikutnya pick up perubahan.

### Exports

```js
const scheduler = require('./scheduler');
// Methods: start, stop, tick, reconcileOnBoot
```

#### `start()` → `void`

Idempotent. Mulai `setInterval(tick, 15000)` dan immediate first tick. Panggil sekali di `app.js` setelah `ensureSchema()` dan `reconcileOnBoot()`.

#### `stop()` → `void`

`clearInterval`. Aman dipanggil kalau belum start. Dipakai di graceful shutdown / test.

#### `tick()` → `void`

Satu iterasi logic (sinkron, cepat). Bisa dipanggil manual untuk testing. Urutan:
1. SELECT `pending` yang `start_at <= now UTC ISO` → `streamManager.startStream(...)` → status `started` / `error`
2. SELECT `started` yang punya `stop_at <= now` → `streamManager.stopStream(...)` → status `done` / `error`
3. UPDATE `started` tanpa `stop_at` kalau stream-nya tidak lagi `running` (video non-loop selesai sendiri) → status `done`

#### `reconcileOnBoot()` → `void`

UPDATE `status='started'` → `status='error'` dengan `last_error='server restart during scheduled run'`. Dilakukan karena scheduler tidak tahu apakah stream tadi sempat selesai normal atau crash — lebih aman expose sebagai error supaya operator review.

### Contract penting

- **Timestamps di DB wajib UTC ISO** (dengan `Z` suffix). Scheduler compare pakai string comparison vs `new Date().toISOString()`. Ini valid karena ISO 8601 lexicographical order == chronological order.
- **Start at past time** → pada tick berikutnya (<= 15 detik) langsung di-start. Bukan di-skip.
- **Stop at di masa lalu tanpa start** belum kejadian → tidak relevan, karena status masih `pending`. Start tetap jalan, stop akan langsung ikut pada tick yang sama (stop_at <= now).
- **Multiple schedule sama stream** → masing-masing independen. Kalau sudah ada stream running saat `pending` matang, scheduler akan deteksi via `streamManager.isRunning()` dan langsung mark `started` tanpa double-spawn.

---

## `src/downloader.js`

**Purpose:** import video dari URL (Google Drive, Mega, MediaFire, direct link).

### State

- `jobs: Map<jobId, { videoId, source, progress, cancel, error, finishedAt }>` — job stays in Map 30 detik setelah selesai supaya client bisa poll final status.

### Exports

```js
const downloader = require('./downloader');
// Methods: start, getProgress, isRunning, detectSource, reconcileOnBoot
```

#### `start(url, title)` → `{ jobId, videoId, source }`

- Detect source via `detectSource(url)`, throw kalau tidak recognized
- INSERT row `videos` dengan `status='downloading'` dan `filename=null` sementara
- Mulai download async (fire-and-forget)
- Return `{ jobId, videoId, source }` immediately supaya client bisa redirect dengan progress ID

**Throws:** `Error('Unsupported URL')`, `Error('Title required')`.

#### `getProgress(jobId)` → `object | null`

```js
{
  percent: 42,         // 0-100 atau null kalau total tidak diketahui
  downloaded: 12345,   // bytes
  total: 29876,        // bytes (null kalau server tidak send Content-Length)
  status: 'downloading' | 'done' | 'error',
  error: '...',        // optional
}
```

#### `isRunning(jobId)` → `boolean`

#### `detectSource(url)` → `'gdrive' | 'mega' | 'mediafire' | 'direct' | null`

Match regex: `drive.google.com` / `mega.nz` / `mediafire.com` / `^https?://`. Return source key atau `null`.

#### `reconcileOnBoot()` → `void`

UPDATE `status='downloading'` → `status='error'` dengan `last_error='download interrupted by server restart'`.

### Behavior per source

- **Google Drive** — extract file ID dari `/file/d/<ID>/` atau `?id=<ID>`. Fetch og:title untuk filename default. Multi-URL fallback: `drive.usercontent.google.com/download` → `drive.google.com/uc?export=download`. Handle cookie warning page untuk file besar (virus scan bypass).
- **Mega.nz** — `megajs.File.fromURL(url)` → `loadAttributes()` → `download({ stream: true })` → pipe ke disk.
- **MediaFire** — fetch halaman, extract download button `href` via regex, follow ke URL final.
- **Direct URL** — axios GET stream, pipe langsung ke disk.

Setelah sukses: update `size_bytes`, `probeVideoInfo()` cache width/height/fps/duration, set `status='uploaded'`, generate thumbnail async.

---

## `src/chunkUpload.js`

**Purpose:** chunked upload untuk file > 50 MB (currently disabled di client-side, backend endpoints masih aktif untuk future re-enable).

### State

- `sessions: Map<sessionId, { title, fileName, totalSize, chunkSize, totalChunks, receivedChunks: Set<number>, folderId, createdAt }>`
- Folder chunks di `public/uploads/chunks/<sessionId>/chunk_000000`, `chunk_000001`, ...

### Exports

```js
const chunkUpload = require('./chunkUpload');
// Methods: initSession, saveChunk, getStatus, finalize, cancel, reconcileOnBoot
```

#### `initSession({ title, fileName, totalSize, chunkSize, folderId })` → `{ sessionId, totalChunks }`

Bikin session, siapkan folder chunks. `sessionId` = md5 hex dari timestamp + fileName. Default `chunkSize = 10 * 1024 * 1024` (10 MB).

#### `saveChunk(sessionId, chunkIndex, buffer)` → `{ received, total }`

Write `buffer` ke `chunks/<sessionId>/chunk_<index.padStart(6,'0')>`, add ke `receivedChunks`.

**Throws:** `Error('Session not found')`, `Error('Chunk out of range')`.

#### `getStatus(sessionId)` → `{ received, total, receivedChunks: number[] }`

Dipakai client untuk resume — skip chunk yang sudah terkirim. Return array indexed supaya client bisa tahu mana yang missing.

#### `finalize(sessionId)` → `{ videoId, filename }`

- Verify semua chunk received (throw kalau incomplete)
- Merge semua chunk sequentially → file final di `public/uploads/<timestamp>_<sanitized>`
- Delete folder chunks
- INSERT row `videos` dengan `status='uploaded'`, probe video info async, generate thumbnail async
- Return `{ videoId, filename }`

**Throws:** `Error('Incomplete upload, received N / M chunks')`.

#### `cancel(sessionId)` → `void`

Delete session + folder chunks. Aman dipanggil kapanpun.

#### `reconcileOnBoot()` → `void`

Scan `public/uploads/chunks/` untuk folder > 24 jam → delete. Dipanggil di `app.js` startup.

---

## System monitor & SSE

Implemented langsung di `app.js`, bukan module terpisah.

### `GET /api/system` (polling endpoint)

Return JSON snapshot:
```js
{
  cpu: 42.5,            // percent, dari os.loadavg()[0] / cpuCount * 100
  memory: 65.2,         // percent, dari (totalmem - freemem) / totalmem * 100
  memoryUsedGB: 5.2,
  memoryTotalGB: 8.0,
  uptime: 3600,         // seconds, dari os.uptime()
  disk: { total, used, free, percent },   // dari 'df' command
  network: { rxPerSec, txPerSec, label },  // 'Idle' kalau 0, else "X MB/s ↓ Y MB/s ↑"
}
```

Network throughput dihitung dari delta `/proc/net/dev` antara call sebelumnya dan sekarang (global `lastNetSample`).

### `GET /api/events` (SSE endpoint)

Server-Sent Events stream yang push system snapshot setiap 3 detik.

**Auth:** manual check `req.session.userId` — **bukan** `requireAuth` middleware. Alasan: `requireAuth` redirect ke `/login` untuk HTML requests, tapi SSE pakai Accept `text/event-stream` dan butuh respons berbeda. Selain itu ada isu session store locking kalau multiple concurrent SSE dengan auth middleware.

Per-connection state `lastNet` untuk hitung delta throughput isolated per client (supaya multiple tab tidak konflik).

Client pattern di `views/dashboard.ejs`:
```js
const es = new EventSource('/api/events');
es.onmessage = e => { /* update DOM */ };
es.onerror = () => { es.close(); startPolling(); };  // fallback
```

---

## Route layer — `src/routes/`

Route bukan "service" murni, tapi pola kontraknya tetap perlu didokumentasikan.

### Pola common untuk route mutasi

```js
router.post('/:id/action', (req, res) => {
  try {
    // validate
    // call service method (streamManager.xxx / transcoder.xxx / db.prepare)
    res.redirect('/page?notice=Action+completed');
  } catch (e) {
    res.redirect('/page?error=' + encodeURIComponent(e.message));
  }
});
```

Kenapa redirect bukan JSON:
- UI-only app, POST dari HTML form
- Browser handle POST/Redirect/GET pattern otomatis (no refresh → resubmit)
- Flash message via query string, dirender `partials/flash.ejs`

### `src/routes/auth.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/login` | Render form |
| POST | `/login` | bcrypt compare → set session |
| POST | `/logout` | destroy session |

### `src/routes/videos.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/videos` | List dengan pagination 20/page + folder filter |
| POST | `/videos/upload` | multer upload → probe → generate thumbnail async → INSERT |
| POST | `/videos/import-url` | `downloader.start(url, title)` |
| GET | `/videos/download/:jobId/progress` | JSON download progress |
| POST | `/videos/:id/prepare` | `transcoder.start(...)` |
| POST | `/videos/:id/cancel-prepare` | `transcoder.cancel(...)` |
| GET | `/videos/:id/prepare-log` | `text/plain` tail |
| GET | `/videos/:id/progress` | JSON progress snapshot |
| GET | `/videos/:id/status` | JSON progress + log tail + ETA (job detail modal) |
| POST | `/videos/:id/edit` | Rename + move folder |
| POST | `/videos/:id/regen-thumb` | Manual trigger `generateThumbnail()` |
| POST | `/videos/:id/move-folder` | Single-video folder change |
| POST | `/videos/:id/delete` | unlink file + thumbnail + DELETE row |
| POST | `/videos/folders/create` | Create folder |
| POST | `/videos/folders/:id/rename` | Rename folder |
| POST | `/videos/folders/:id/delete` | Delete folder (video dipindah ke unfiled) |
| POST | `/videos/folders/:id/prepare-all` | Bulk prepare semua `uploaded` di folder |
| POST | `/videos/folders/:id/create-playlist` | Create playlist dengan nama folder |
| POST | `/videos/folders/:id/delete-videos` | Hapus semua video di folder |
| POST | `/videos/chunked/init` | Init chunked upload session |
| GET | `/videos/chunked/:id/status` | Status untuk resume |
| PUT | `/videos/chunked/:id/:chunkIndex` | Save chunk |
| POST | `/videos/chunked/:id/finalize` | Merge + insert row |
| DELETE | `/videos/chunked/:id` | Cancel + cleanup |

### `src/routes/streams.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/streams` | Redirect ke `/streams/single` |
| GET | `/streams/single` | List single-video streams |
| GET | `/streams/playlist` | List playlist streams |
| POST | `/streams` | INSERT row (auto-detect single vs playlist dari body) |
| POST | `/streams/:id/start` | Codec validation + `streamManager.startStream(...)` |
| POST | `/streams/:id/stop` | `streamManager.stopStream(...)` |
| POST | `/streams/:id/edit` | Update config (guard: tidak bisa edit kalau running) |
| POST | `/streams/:id/delete` | Stop + DELETE row |
| GET | `/streams/:id/log` | `text/plain` tail (redacted, dipakai modal auto-refresh 3s) |

### `src/routes/playlists.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/playlists` | List dengan collage thumbnail |
| POST | `/playlists` | Create dengan multi-video picker (`video_ids[]`) |
| GET | `/playlists/:id` | Detail dengan items ordered |
| GET | `/playlists/:id/state.json` | JSON `{ playlist, itemIds, videos }` untuk manage modal |
| POST | `/playlists/:id/sync` | JSON body `{ video_ids }` → diff add/remove |
| POST | `/playlists/:id/settings` | Update name + loop + shuffle |
| POST | `/playlists/:id/add-video` | Append item |
| POST | `/playlists/:id/remove-item/:itemId` | Delete item |
| POST | `/playlists/:id/move-up/:itemId` | Swap position up |
| POST | `/playlists/:id/move-down/:itemId` | Swap position down |
| POST | `/playlists/:id/delete` | Delete items + playlist |

### `src/routes/history.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/history` | List stream history (order `stopped_at DESC`) |
| POST | `/history/:id/delete` | Delete 1 entry |
| POST | `/history/clear` | `DELETE FROM stream_history` |

### `src/routes/schedules.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/schedules` | List (join streams + videos) + new schedule form |
| POST | `/schedules` | Parse datetime-local → UTC ISO → INSERT row `pending` |
| POST | `/schedules/:id/cancel` | `UPDATE status='cancelled' WHERE status='pending'` |
| POST | `/schedules/:id/delete` | DELETE row |

Helper internal `parseLocalToUTC(str, tz)` — convert `YYYY-MM-DDTHH:MM` (browser datetime-local) ke UTC ISO based on IANA timezone dari env `TZ`. Handle DST dan cross-day dengan benar (tested via `scripts/test-tz.js`).

---

## View layer — `app.locals` helpers

### `formatTime(value)` → `string`

```ejs
<%= formatTime(s.started_at) %>  <!-- e.g. "11/05/2026 10.05.57 WIB" -->
```

- Input: SQLite `CURRENT_TIMESTAMP` string (`YYYY-MM-DD HH:MM:SS`, UTC, no tz suffix) atau ISO string
- Output: formatted string di TZ yang di-config di env (`TZ` + `TZ_LABEL`), fallback ke `Asia/Jakarta` + `WIB`
- `null` / `undefined` / empty → `'-'`
- Invalid → return value asli

**Semua view wajib pakai ini** untuk render timestamp. Jangan `<%= x.created_at %>` mentah.

### `currentUser` (dari `injectUser`)

```ejs
<% if (currentUser) { %>
  <span>@<%= currentUser.username %></span>
<% } %>
```

Null di halaman login, object `{id, username}` di halaman lain yang protected.

---

## Contract summary

Kalau mau tambah fitur baru yang spawn child process (misal: server-side download dari Google Drive, schedule runner), ikuti pola yang sama:

1. **Module di `src/<name>.js`** dengan:
   - `start(...)` / `cancel(...)` / `isRunning(...)` / `tailLog(...)`
   - `reconcileOnBoot()` yang reset row stale
2. **Import & call `reconcileOnBoot()`** di `app.js` startup
3. **Status state machine** di DB — pakai kolom `status TEXT` + `last_error TEXT`
4. **Log file per job** di `logs/<kind>-<id>.log`
5. **Redact secret** kalau ada (pakai helper yang sama pattern dengan `makeRedactingStream`)
6. **Progress endpoint** (opsional) — expose `GET /<kind>/:id/progress` JSON + in-memory state, polling 2 detik dari UI dengan auto-reload saat status berubah

Kalau mau tambah fitur time-triggered (recurring schedule, expiring session, dll), pola-nya:

1. **Module di `src/<name>.js`** dengan `start()` / `stop()` / `tick()` / `reconcileOnBoot()`
2. **Simpan timestamp sebagai UTC ISO string** di DB — lexicographic compare valid
3. **Input dari form datetime-local** → pakai helper `parseLocalToUTC(str, tz)` (lihat `src/routes/schedules.js`)
4. **Polling `setInterval`** 10-30 detik di main process — simpel, no external scheduler needed
5. **`reconcileOnBoot()`** tandai row "in-flight" dari run sebelumnya sebagai `error` bukan resume blind — operator perlu aware
