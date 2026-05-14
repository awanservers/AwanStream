# YouTube Upload — Setup Guide

Panduan setup OAuth credentials di Google Cloud Console untuk fitur YouTube upload di AwanStream.

> **Phase 1 status:** Authentication only. Upload feature menyusul di Phase 2.

---

## Prasyarat

- Akun Google (yang sama dengan channel YouTube tujuan)
- Channel YouTube (kalau belum ada, buat dulu di [studio.youtube.com](https://studio.youtube.com))

---

## Langkah-langkah

### 1. Buat Google Cloud Project

1. Buka [Google Cloud Console](https://console.cloud.google.com/)
2. Klik dropdown project di header → **New Project**
3. Nama: `AwanStream` (atau bebas), klik **Create**
4. Tunggu beberapa detik, lalu pilih project tersebut

### 2. Aktifkan YouTube Data API v3

1. Sidebar → **APIs & Services** → **Library**
2. Cari **YouTube Data API v3**
3. Klik → **Enable**

### 3. Setup OAuth Consent Screen

Wajib sebelum bikin OAuth client.

1. **APIs & Services** → **OAuth consent screen**
2. User type: pilih **External**, klik **Create**
3. Isi form:
   - App name: `AwanStream`
   - User support email: email kamu
   - Developer contact: email kamu
4. **Save and Continue**
5. **Scopes** → klik **Add or Remove Scopes** → cari & centang:
   - `youtube.upload`
   - `youtube.readonly`
6. **Save and Continue**
7. **Test users** → klik **Add Users** → tambahkan email Google kamu (yang punya channel)
8. **Save and Continue** → **Back to Dashboard**

> Selama app status "Testing", hanya test users yang bisa connect. Cukup untuk personal use.

### 4. Buat OAuth Client ID

1. **APIs & Services** → **Credentials**
2. Klik **Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `AwanStream Web Client`
5. **Authorized redirect URIs** → klik **Add URI**:
   - Untuk dev lokal: `http://localhost:7575/youtube/callback`
   - Untuk VPS: `http://your-server-ip:7575/youtube/callback` atau `https://your-domain.com/youtube/callback`
6. Klik **Create**
7. Copy **Client ID** dan **Client Secret** dari modal yang muncul

### 5. Tambahkan ke `.env`

Edit file `.env` di root project:

```env
YOUTUBE_CLIENT_ID=your-id.apps.googleusercontent.com
YOUTUBE_CLIENT_SECRET=GOCSPX-your-secret
YOUTUBE_REDIRECT_URI=http://localhost:7575/youtube/callback
```

> **Penting:** `YOUTUBE_REDIRECT_URI` harus **persis sama** dengan yang didaftarkan di step 4 (case-sensitive, slash sensitive).

### 6. Restart AwanStream

```bash
npm start
```

### 7. Connect Account

1. Buka `http://localhost:7575/youtube`
2. Klik **Connect YouTube**
3. Browser akan redirect ke halaman consent Google
4. Login dengan akun yang punya channel target
5. Kalau muncul warning "Google hasn't verified this app" — klik **Advanced** → **Go to AwanStream (unsafe)**. Ini wajar untuk app dalam status Testing, aman karena ini app kamu sendiri.
6. Setujui akses (upload + read channel info)
7. Browser redirect kembali ke `/youtube/callback` → AwanStream dapat token → status berubah jadi **Connected**

---

## Verifikasi

Setelah connect, halaman `/youtube` akan menampilkan:
- ✅ Channel name
- ✅ Channel ID
- ✅ Connected timestamp
- ✅ Disconnect button

---

## Troubleshooting

### "Error 400: redirect_uri_mismatch"
Redirect URI di `.env` tidak match dengan yang di Google Cloud Console. Cek:
- Protokol (http vs https)
- Port (7575 vs port lain)
- Trailing slash (jangan ada)
- Path (`/youtube/callback` exact)

### "Error 403: access_denied"
Email kamu belum di-add sebagai test user (lihat step 3 nomor 7).

### "OAuth consent screen 'app not verified'"
Wajar untuk Testing mode. Klik **Advanced** → **Go to AwanStream**. Aman karena app ini punya kamu sendiri.

### Token expired / refresh failed
- Coba **Disconnect** lalu **Connect** lagi
- Refresh token bisa di-revoke oleh Google kalau:
  - 6 bulan tidak dipakai
  - User revoke manual di [Google Account permissions](https://myaccount.google.com/permissions)
  - Password Google diubah

### Quota limit
- Default quota: **10,000 units/hari** per project
- Upload video = ~1,600 units
- Maksimal ~6 video/hari di default quota
- Reset jam **00:00 Pacific Time** (= 15:00 WIB)
- Request quota increase di [Google Cloud Console quota page](https://console.cloud.google.com/iam-admin/quotas) kalau perlu

---

## Production deployment notes

Kalau pakai VPS dengan domain & HTTPS:

1. Update `YOUTUBE_REDIRECT_URI=https://your-domain.com/youtube/callback`
2. Update redirect URI di Google Cloud Console juga
3. Restart app

Untuk production yang serious (publish app, bukan testing):
- Submit OAuth consent screen for verification (proses Google review, bisa beberapa minggu)
- Tanpa verification, max 100 test users

---

## Security

- `YOUTUBE_CLIENT_SECRET` itu **secret** — jangan commit ke git, sudah di-`.gitignore` lewat `.env`
- Refresh token disimpan di SQLite (`db/awanstream.db`), juga sudah di-`.gitignore`
- Untuk extra security di production: enkripsi refresh token sebelum simpan ke DB (Phase 2 enhancement)
