# AwanStream

Self-hosted web app untuk live streaming video pre-recorded ke platform RTMP (YouTube Live, Facebook Live, Twitch, custom) **plus tooling pendukung untuk channel YouTube ambient/24-7** (loop tool, audio overlay, YouTube upload). Terinspirasi [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow).

## Fitur

### Library
- Login admin (single user)
- **Video Library** dengan pagination, folder organizer, thumbnail auto-generate
- **Audio Library** terpisah (MP3/M4A/AAC/WAV/OGG/OPUS/FLAC/WMA)
- Upload dari PC (XHR progress bar) atau **import dari URL** (Google Drive, Mega.nz, MediaFire, direct link)
- Auto-suffix duplicate titles (`Video (2)`, `Video (3)`, ...)
- **Tombol Download** (filename dari title, support resumable HTTP Range)
- **Capture thumbnail dari frame custom** via preview modal — pilih frame paling bagus untuk YouTube thumbnail

### Production tools
- **Prepare**: transcode video sekali jadi stream-ready (H.264 + AAC + GOP 2 detik)
  - Presets: 720p30, 720p60, 1080p30, 1080p60 + pilihan x264 preset
  - Auto-detect source resolution + live note tentang preset compatibility
- **Loop tool** — perpanjang clip pendek jadi video panjang (30 menit - 24 jam) untuk 24/7 stream / YouTube upload
  - **Smooth mode** (crossfade seamless di loop boundary) atau **Fast mode** (`-c copy`)
  - **Audio overlay opsional** — mix musik background dengan audio video. Pas untuk fireplace + jazz workflow
  - 2-phase pipeline: phase 1 re-encode seamless unit, phase 2 loop dengan `-c copy`

### Streaming
- **Playlist management** — create dengan multi-video picker, manage modal (AJAX)
- **Stream — Single Video** — Copy mode enforced, codec validation (H.264 + AAC) sebelum start
- **Stream — Playlist** — sequential auto-advance, loop playlist, shuffle mode
- **Audio overlay saat streaming** — mix audio track terpisah dengan video real-time via FFmpeg `amix` filter
- **Auto-Retry + Health Check** — FFmpeg crash retry 5x exponential backoff, stale stream auto-kill
- **Scheduled streaming** — auto-start / auto-stop pada waktu tertentu (input zona lokal, disimpan UTC)
- **Stream History** — riwayat sesi streaming yang sudah selesai (≥10 detik)

### YouTube Upload
- **OAuth2 connection** ke YouTube channel
- **Upload langsung dari AwanStream** — pas untuk VPS dengan bandwidth besar (file 30 GB selesai dalam menit, bukan jam)
- Resumable upload, progress real-time, cancel mid-upload
- Default privacy: **Unlisted** (kamu finalize metadata + publish manual via YouTube Studio)

### UI / UX
- **Sidebar layout** dengan 2 group: Library + Streams (plus Loop, YouTube top-level)
- **System monitor** real-time (CPU/RAM/Disk/Network/Uptime)
- **Modal dialogs** native `<dialog>` untuk semua form
- **Toast notifications** dengan auto-dismiss
- **Custom confirm modal** menggantikan native `confirm()`
- Dark theme, responsive (hamburger sidebar di mobile)
- Timezone configurable (default WIB)

## Requirements

- Node.js 18+ (tested: 20.20.2)
- FFmpeg + **ffprobe** terinstall di `$PATH` (biasanya satu paket)
- SQLite (ditangani oleh `better-sqlite3`, no setup)
- ~2 GB disk untuk video + DB (lebih kalau pakai Loop ke 10+ jam)

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

### Optional: setup YouTube upload

Untuk fitur upload ke YouTube, ikuti `docs/youtube-setup.md` — butuh Google Cloud project + OAuth credentials. Set di `.env`:

```env
YOUTUBE_CLIENT_ID=your-id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-your-secret
YOUTUBE_REDIRECT_URI=http://localhost:7575/youtube/callback
```

Lalu buka `/youtube` → klik **Connect YouTube**.

## Workflow umum

### Untuk live streaming

1. **Upload** video di `/videos` (dari PC via modal Upload, atau import dari URL).
2. Klik **Prepare** pada video, pilih preset (720p30 / 1080p30 / 1080p60). Status akan jadi `ready` setelah selesai.
3. (Opsional) Buat **Playlist** di `/playlists` — tambahkan beberapa video, atur urutan.
4. (Opsional) Upload **Audio track** di `/audio` untuk pakai sebagai background music.
5. Di `/streams/single` (atau `/streams/playlist`), create stream baru. Pilih video/playlist, platform (auto-isi RTMP URL), masukkan stream key. Optional: pilih audio overlay.
6. Klik **Start** manual, atau buka `/schedules` untuk jadwalkan auto-start.

### Untuk YouTube upload (workflow ambient/24-7)

1. **Generate** video pendek (misal fireplace 8 detik dari Veo) + audio panjang (misal jazz 3 menit dari SUNO).
2. Upload keduanya ke AwanStream (`/videos` + `/audio`).
3. Di `/looper`, pilih video sumber + target durasi (misal 10 jam) + audio overlay (mix mode, volume 0.3).
4. Start → tunggu (~10-20 menit, video di-loop tanpa re-encode setelah seamless unit jadi).
5. Hasil video panjang muncul di `/videos`. Klik thumbnail → preview, **Set thumbnail** dari frame yang dramatis, **Download thumbnail** untuk edit di Canva.
6. Klik tombol **YouTube** di video row → modal upload. Confirm title + privacy (default Unlisted).
7. Tunggu upload selesai (depend on bandwidth). Modal bisa di-close — upload tetap jalan, klik icon biru di row untuk re-open progress.
8. Klik **Open in YouTube Studio** → set thumbnail (yang sudah edit di Canva), title SEO, description, tags, schedule publish.

## Env vars

File `.env` (copy dari `.env.example`):

```env
PORT=7575
SESSION_SECRET=<generate via node generate-secret.js>
NODE_ENV=development         # set "production" kalau serve via HTTPS
TZ=Asia/Jakarta              # IANA timezone untuk render timestamp
TZ_LABEL=WIB                 # label singkat di UI (WIB / WITA / WIT / UTC / ...)

# Optional — untuk YouTube upload
# YOUTUBE_CLIENT_ID=
# YOUTUBE_CLIENT_SECRET=
# YOUTUBE_REDIRECT_URI=
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
src/streamManager.js    FFmpeg manager untuk live streaming + audio overlay
src/transcoder.js       FFmpeg manager untuk Prepare + thumbnail
src/downloader.js       URL import (Google Drive, Mega, MediaFire, direct)
src/scheduler.js        Scheduled streaming runner
src/looper.js           Loop tool (smooth/fast + audio overlay)
src/audioManager.js     Audio tracks library
src/youtubeManager.js   YouTube OAuth manager
src/youtubeUploader.js  YouTube upload (resumable)
src/auth.js             Session middleware
src/routes/             auth / videos / streams / playlists / schedules /
                        history / looper / audio / youtube
views/                  EJS templates (sidebar layout)
public/css/app.css      Dark theme
public/uploads/         Uploaded videos (gitignored, served via protected route)
public/uploads/audio/   Audio tracks (gitignored, served via protected route)
public/uploads/thumbs/  Thumbnails (gitignored, served via protected route)
db/                     SQLite data (gitignored)
logs/                   FFmpeg per-job logs (gitignored)
scripts/                One-shot utilities (smoke, test-codec, migrations)
docs/                   Dokumentasi detail
```

## Production notes

- Set `NODE_ENV=production` → cookie session `secure` aktif (wajib HTTPS).
- Gunakan reverse proxy (nginx / caddy) untuk TLS + auto-renew.
- Pakai process manager: pm2, systemd, atau Docker.
- Monitor disk usage di `public/uploads/` — video Loop ke 10+ jam bisa 15-30 GB per file.
- Pastikan port RTMP outbound tidak diblokir firewall (1935 untuk YouTube/Twitch, 443 untuk Facebook RTMPS).
- Untuk YouTube upload dari VPS, set `YOUTUBE_REDIRECT_URI` ke domain VPS (bukan localhost), dan update di Google Cloud Console juga.

## Troubleshooting

**Codec validation error saat Start stream**
Copy mode membutuhkan video H.264 + AAC. Jalankan Prepare dulu, atau periksa codec source via `scripts/test-codec.js`.

**YouTube: "keyframe interval > 4 detik"**
Pakai Prepare dulu. Copy mode butuh source file yang sudah punya GOP yang benar (Prepare set GOP 2 detik).

**YouTube: "bitrate terlalu tinggi"**
Pakai Prepare (akan downscale ke bitrate preset). Kalau Re-encode, turunkan `video_bitrate` di form.

**YouTube upload: "processing abandoned: video is too long"**
YouTube batas durasi 12 jam. Kalau video sedikit lebih, trim ke 11:55 atau 10:00. Loop tool sekarang batas 24 jam tapi YouTube reject kalau >12 jam.

**FFmpeg error "cover type" warning**
Sudah ditangani via `-map 0:v:0 -map 0:a:0?`. Kalau masih muncul, ada non-standard stream — re-Prepare.

**Import URL gagal (Google Drive)**
File mungkin private atau terlalu besar. Pastikan file di-share "Anyone with the link".

**App crash / stream status stuck "running"**
Restart app (`Ctrl+C`, `npm start`). `reconcileOnBoot()` akan reset row stale otomatis.

**YouTube OAuth: "Access blocked: app not verified"**
Wajar untuk app dalam Testing mode. Add email kamu sebagai test user di Google Cloud Console → OAuth consent screen → Test users.

**YouTube OAuth: "redirect_uri_mismatch"**
URL di `.env` (`YOUTUBE_REDIRECT_URI`) tidak match dengan yang didaftarkan di Google Cloud Console. Cek persis (protokol, port, path).

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
- `docs/services.md` — API reference modul backend
- `docs/deployment.md` — systemd / pm2 / docker + reverse proxy HTTPS
- `docs/youtube-setup.md` — Google Cloud Console + OAuth setup step-by-step
- `docs/features.md` — referensi per-fitur (user-facing + technical)
- `CHANGELOG.md` — history perubahan

## Lisensi

MIT (kalau ingin pakai repo publik, tambahkan file `LICENSE`).
