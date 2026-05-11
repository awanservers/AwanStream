# AwanStream

Self-hosted web app untuk live streaming video pre-recorded ke platform RTMP (YouTube Live, Facebook Live, Twitch, custom). Versi basic, terinspirasi [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow).

## Fitur

- Login admin (single user)
- **Upload video** dari PC (XHR progress bar — persen, speed, bisa cancel)
- **Import video dari URL** — Google Drive, Mega.nz, MediaFire, direct link (server-side download via axios/megajs)
- Auto-suffix duplicate titles (`Video (2)`, `Video (3)`, ...)
- **Prepare**: transcode video sekali jadi stream-ready (H.264 + AAC + GOP 2 detik)
  - Presets: 720p30, 720p60, 1080p30, 1080p60 + pilihan x264 preset
  - Auto-detect source resolution (width, height, fps) via ffprobe
  - Live note tentang preset compatibility (misal: source 720p → preset 1080p = upscale warning)
  - **Job detail modal** — progress bar + FFmpeg log inline + ETA estimasi
- **Playlist management** — create playlist, add/remove/reorder videos
- **Stream — Single Video** — Copy mode enforced, codec validation (H.264 + AAC) sebelum start
- **Stream — Playlist** — sequential auto-advance ke video berikutnya, loop playlist option
- **Scheduled streaming**: auto-start / auto-stop stream pada waktu tertentu (input di zona lokal, disimpan UTC)
- **System monitor** real-time di dashboard (CPU%, RAM%, Uptime — polling setiap 3 detik)
- **Sidebar layout** dengan sub-menus:
  - Videos: Library + Playlists
  - Streams: Single Video + Playlist
- **Modal dialogs** (native `<dialog>`) untuk semua form (New Stream, Upload, Import URL, Prepare, dll)
- **Custom confirm modal** — menggantikan native `confirm()`, konsisten dark theme
- **Toast notifications** — auto-dismiss 4 detik, URL cleanup via `history.replaceState`
- **Codec validation** sebelum stream start di Copy mode (H.264 + AAC check via ffprobe)
- Dashboard: jumlah video / stream / running + disk usage + next schedule + system monitor
- Dark theme, responsive (hamburger sidebar di mobile)
- Timezone configurable (default WIB)

## Requirements

- Node.js 18+ (tested: 20.20.2)
- FFmpeg + **ffprobe** terinstall di `$PATH` (biasanya satu paket)
- SQLite (ditangani oleh `better-sqlite3`, no setup)
- ~2 GB disk untuk video + DB

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Generate SESSION_SECRET ke .env
node generate-secret.js

# 3. (Opsional) edit .env untuk ganti PORT / TZ
#    default: PORT=7575, TZ=Asia/Jakarta, TZ_LABEL=WIB

# 4. Buat user admin (interaktif)
node reset-password.js

# 5. Jalankan
npm start
# AwanStream running on http://localhost:7575
```

Login pakai user yang tadi dibuat.

## Alur pemakaian (recommended)

1. **Upload** video di `/videos` (dari PC via modal Upload, atau import dari URL via modal Import URL).
2. Klik **Prepare** pada video, pilih preset (720p30 / 1080p30 default / 1080p60). Transcode jalan di background — klik row untuk buka **job detail modal** (progress bar + log + ETA). Status akan jadi `ready` setelah selesai.
3. (Opsional) Buat **Playlist** di `/playlists` — tambahkan beberapa video, atur urutan.
4. Di `/streams/single`, create stream baru: pilih video ready, platform (auto-isi RTMP URL), masukkan stream key. Mode **Copy** enforced — codec divalidasi otomatis sebelum start.
5. Atau di `/streams/playlist`, create stream dari playlist — video akan diputar berurutan, auto-advance ke video berikutnya.
6. Klik **Start** manual, **atau** buka `/schedules` untuk jadwalkan auto-start (dan opsional auto-stop) pada waktu tertentu.
7. CPU ~0% saat streaming (mode Copy), YouTube Live Control Room akan "Excellent".
8. Klik **Stop** kalau selesai manual, atau biarkan schedule yang stop.

## Env vars

File `.env` (copy dari `.env.example`):

```env
PORT=7575
SESSION_SECRET=<generate via node generate-secret.js>
NODE_ENV=development         # set "production" kalau serve via HTTPS
TZ=Asia/Jakarta              # IANA timezone untuk render timestamp
TZ_LABEL=WIB                 # label singkat di UI (WIB / WITA / WIT / UTC / ...)
```

## Reset password

```bash
node reset-password.js
```

Interaktif, akan tanya username (default `admin`) dan password baru.

## Struktur folder

```
app.js                  Entry Express + /api/system endpoint
src/db.js               SQLite schema + migrasi inline
src/streamManager.js    FFmpeg manager untuk live streaming + playlist advance
src/transcoder.js       FFmpeg manager untuk Prepare + validateCodec + probeVideoInfo
src/downloader.js       URL import (Google Drive, Mega, MediaFire, direct)
src/scheduler.js        Scheduled streaming runner
src/auth.js             Session middleware
src/routes/             auth / videos / streams / playlists / schedules
views/                  EJS templates (sidebar layout)
  streams-single.ejs    Single video stream page
  streams-playlist.ejs  Playlist stream page
  playlists.ejs         Playlist management
  playlist-detail.ejs   Playlist items (add/remove/reorder)
public/css/app.css      Dark theme, sidebar, modals, toast
public/uploads/         Uploaded videos (gitignored)
db/                     SQLite data (gitignored)
logs/                   FFmpeg per-job logs (gitignored)
scripts/                One-shot utilities (smoke, test-codec, migrations)
docs/                   Dokumentasi detail
```

## Production notes

- Set `NODE_ENV=production` → cookie session `secure` aktif (wajib HTTPS).
- Gunakan reverse proxy (nginx / caddy) untuk TLS + auto-renew.
- Pakai process manager: pm2, systemd, atau Docker.
- Monitor disk usage di `public/uploads/` — video besar.
- Pastikan port RTMP outbound tidak diblokir firewall (biasanya 1935 / 443 untuk FB RTMPS).

## Troubleshooting

**Codec validation error saat Start stream**  
Copy mode membutuhkan video H.264 + AAC. Jalankan Prepare dulu, atau periksa codec source via `scripts/test-codec.js`.

**YouTube: "keyframe interval > 4 detik"**  
Pakai Prepare dulu. Copy mode butuh source file yang sudah punya GOP yang benar (Prepare set GOP 2 detik).

**YouTube: "bitrate terlalu tinggi"**  
Pakai Prepare (akan downscale ke bitrate preset). Kalau Re-encode, turunkan `video_bitrate` di form.

**FFmpeg error "cover type" warning**  
Sudah ditangani via `-map 0:v:0 -map 0:a:0?`. Kalau masih muncul, mungkin ada non-standard stream di source — transcode ulang via Prepare.

**Import URL gagal (Google Drive)**  
File mungkin private atau terlalu besar. Pastikan file di-share "Anyone with the link".

**App crash / stream status stuck "running"**  
Restart app (`Ctrl+C`, `npm start`). `reconcileOnBoot()` akan reset row stale otomatis.

**Lupa password**  
```bash
node reset-password.js
```

**Port 7575 sudah dipakai**  
Ganti `PORT=` di `.env`, restart.

## Dokumentasi lanjutan

- `AGENTS.md` — instruksi untuk AI coding agents yang melanjutkan project
- `docs/architecture.md` — request flow, data model, state machine
- `docs/codebase.md` — peta detail setiap file
- `docs/services.md` — API reference modul backend (streamManager, transcoder, downloader, auth, db)
- `docs/deployment.md` — systemd / pm2 / docker + reverse proxy HTTPS
- `CHANGELOG.md` — history perubahan

## Lisensi

MIT (kalau ingin pakai repo publik, tambahkan file `LICENSE`).
