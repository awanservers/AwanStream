# AwanStream

Self-hosted web app untuk live streaming video pre-recorded ke platform RTMP (YouTube Live, Facebook Live, Twitch, custom) plus tooling pendukung untuk channel YouTube ambient/24-7 (loop tool, audio overlay, YouTube upload). Terinspirasi [bangtutorial/streamflow](https://github.com/bangtutorial/streamflow).

## Fitur

- **Library** — Video & audio library, folder organizer, thumbnail auto-generate, capture frame custom, chunked upload dengan resume (cocok untuk koneksi lambat), import dari Google Drive / Mega / MediaFire
- **Prepare** — transcode video sekali jadi stream-ready (H.264 + AAC + GOP 2s), 6 preset (720p30 → 1080p60 + low-bandwidth variants), bitrate sesuai rekomendasi YouTube, progress + ETA real-time. Video yang sudah H.264 + AAC + GOP ≤ 2s otomatis `ready` tanpa Prepare
- **Loop tool** — perpanjang clip pendek (8 detik) jadi panjang (sampai 24 jam) untuk 24/7 stream / YouTube upload, smooth crossfade atau fast copy mode, audio overlay opsional
- **Streaming** — single video atau playlist (sequential / shuffle), audio overlay live mix, auto-retry exponential backoff, health check stale stream, scheduled streaming, stream history
- **YouTube Upload** — OAuth2, resumable upload, progress real-time, cancel mid-upload (cocok untuk VPS bandwidth besar — file 30 GB selesai dalam menit)
- **Multi-admin** — beberapa user admin, profile page dengan stats, last login tracking, brute-force protection
- **System monitor** — CPU/RAM/Disk/Network/Uptime real-time via SSE, disk space pre-check di semua operasi upload/transcode/loop

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/awanservers/AwanStream.git
cd AwanStream
cp .env.example .env
node generate-secret.js     # populate SESSION_SECRET di .env

docker compose up -d --build
```

Buka `http://localhost:7575` — first run akan tampilkan halaman setup untuk buat admin pertama.

### Manual (Node.js + FFmpeg)

```bash
npm install
node generate-secret.js     # populate SESSION_SECRET di .env
npm start                   # http://localhost:7575
```

Requirements: Node.js 18+, FFmpeg + ffprobe di `$PATH`.

## Env vars

```env
PORT=7575                   # HTTP port
SESSION_SECRET=<generated>  # via node generate-secret.js
NODE_ENV=development        # set "production" saat di belakang HTTPS
TZ=Asia/Jakarta             # IANA timezone untuk render timestamp
TZ_LABEL=WIB                # label singkat di UI

# Optional — untuk fitur YouTube upload (lihat docs/youtube-setup.md)
YOUTUBE_CLIENT_ID=
YOUTUBE_CLIENT_SECRET=
YOUTUBE_REDIRECT_URI=http://localhost:7575/youtube/callback
```

## User management

- **First run** — akses `/setup`, buat user admin pertama
- **Tambah / hapus / reset password user lain** — di `/users` (klik avatar → Users)
- **Ubah password sendiri** — di `/users`, klik tombol di row "you"
- **Lupa password (locked out)** — `node reset-password.js` di terminal/container

Semua user punya akses admin penuh (no RBAC). Multi-admin model.

## Production notes

- Set `NODE_ENV=production` agar cookie session `secure`
- Reverse proxy (nginx / caddy) untuk TLS — lihat `docs/deployment.md`
- Monitor disk: video Loop 10+ jam bisa 15-30 GB per file (sudah ada disk pre-check yang block operasi kalau disk hampir penuh)
- Login rate-limited: 5 failure / 15 menit / IP → lockout 15 menit
- Backup `db/` directory secara berkala (semua state ada di sana, kecuali video file)

## Dokumentasi lanjutan

- `AGENTS.md` — instruksi untuk AI coding agents
- `docs/features.md` — referensi per-fitur lengkap (user-facing + technical)
- `docs/architecture.md` — request flow, data model, state machine
- `docs/codebase.md` — peta detail per file
- `docs/services.md` — API reference modul backend
- `docs/deployment.md` — systemd / pm2 / docker + reverse proxy HTTPS
- `docs/youtube-setup.md` — Google Cloud Console + OAuth setup step-by-step
- `CHANGELOG.md` — history perubahan

## Troubleshooting cepat

| Gejala | Solusi |
|--------|--------|
| Codec validation error saat Start | Jalankan **Prepare** dulu (Copy mode butuh H.264 + AAC + GOP ≤ 2s) |
| YouTube reject keyframe interval > 4s | Prepare mengatur GOP 2s — video dari CapCut/Filmora biasa GOP 5s, perlu Prepare |
| YouTube warning "bitrate terlalu rendah" | Re-Prepare dengan preset standard (bukan `-low`). Preset default sudah sesuai rekomendasi YouTube |
| Upload "network error" di koneksi lambat | Sudah dihandle via chunked + resume otomatis |
| Stream stuck "running" setelah crash | Restart app — `reconcileOnBoot()` reset state stale |
| YouTube OAuth "redirect_uri_mismatch" | `.env` `YOUTUBE_REDIRECT_URI` harus match Google Cloud Console |
| Lupa password | `node reset-password.js` (akan tanya username + password baru) |
| Port 7575 dipakai | Ganti `PORT=` di `.env`, restart |

Untuk troubleshooting lebih dalam → `docs/deployment.md` section *Common issues*.

## Lisensi

MIT — lihat `LICENSE`.
