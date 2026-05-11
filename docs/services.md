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

**Purpose:** lifecycle manager untuk FFmpeg child process yang push video → RTMP endpoint.

### State

- `running: Map<streamId, { process, logStream }>` — in-memory, tidak dipersist. Hilang saat restart, di-reconcile via `reconcileOnBoot()`.

### Exports

```js
const streamManager = require('./streamManager');
// Methods: startStream, stopStream, isRunning, reconcileOnBoot, tailLog
```

#### `startStream(stream, videoPath)` → `void`

- `stream` = row dari tabel `streams` (harus punya `id`, `rtmp_url`, `stream_key`, `re_encode`, `video_bitrate`, `keyframe_interval`, `preset`, `loop_video`)
- `videoPath` = path absolut ke file video
- **Throws:**
  - `Error('Stream already running')` — kalau `isRunning(id)` sudah true
  - `Error('Video file not found: ...')` — kalau `videoPath` tidak exist
- **Side effects:**
  - Spawn `ffmpeg` child
  - Tulis log ke `logs/stream-<id>.log` (stream key di-redact)
  - UPDATE `streams` SET `status='running'`, `started_at=CURRENT_TIMESTAMP`
  - On exit: UPDATE status `idle` / `error` sesuai exit code

#### `stopStream(streamId)` → `boolean`

- Set `status='idle'` di DB dulu (supaya exit handler tidak overwrite ke `error`)
- SIGTERM ke child process kalau masih ada
- Return `true` kalau ada process yang di-kill, `false` kalau memang tidak running

#### `isRunning(streamId)` → `boolean`

Cek in-memory Map. Tidak query DB.

#### `reconcileOnBoot()` → `void`

UPDATE semua row `status='running'` menjadi `idle` dengan `stopped_at=now`. Panggil **sekali** di `app.js` saat startup, sebelum `app.listen(...)`.

#### `tailLog(streamId, lines=80)` → `string`

Baca tail file log. Redact stream key sebelum return (defense in depth kalau ada log lama sebelum redaction aktif).

### Internal helpers (tidak di-export, tapi penting dipahami)

- `buildRtmpTarget(url, key)` — gabung URL + key dengan normalisasi trailing slash
- `redact(text, secret)` — regex replace occurrence `secret` → `***REDACTED***`
- `makeRedactingStream(logStream, secret)` — writer wrapper. **Semua tulisan log ffmpeg wajib lewat ini.**

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
//          getProgress, probeDuration
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
| GET | `/videos` | List + upload form |
| POST | `/videos/upload` | multer upload → probe duration → INSERT |
| POST | `/videos/:id/prepare` | `transcoder.start(...)` |
| POST | `/videos/:id/cancel-prepare` | `transcoder.cancel(...)` |
| GET | `/videos/:id/prepare-log` | `text/plain` tail |
| GET | `/videos/:id/progress` | JSON `{status, running, percent, time, duration, speed, fps, last_error}` |
| POST | `/videos/:id/delete` | unlink file + DELETE row |

### `src/routes/streams.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/streams` | List + new stream form |
| POST | `/streams` | INSERT row |
| POST | `/streams/:id/start` | `streamManager.startStream(...)` |
| POST | `/streams/:id/stop` | `streamManager.stopStream(...)` |
| POST | `/streams/:id/delete` | stop + DELETE row |
| GET | `/streams/:id/log` | `text/plain` tail (redacted) |

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
