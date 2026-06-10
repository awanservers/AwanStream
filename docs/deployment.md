# Deployment

Panduan menjalankan AwanStream sebagai service di production. Tiga opsi: **systemd** (paling umum di VPS Linux), **pm2** (simpel, cross-platform), dan **Docker**.

## Prasyarat umum

- Node.js 18+ (rekomendasi: 20 LTS via nvm atau nodesource)
- FFmpeg 4+ di `$PATH`
- Port outbound tidak diblokir:
  - **1935** untuk RTMP (YouTube, Twitch)
  - **443** untuk RTMPS (Facebook)
- Domain + DNS (optional tapi recommended untuk HTTPS)

## WSL (Ubuntu 24.04) development notes

Kalau project dikembangkan di Windows host dengan WSL Ubuntu 24.04, ada beberapa quirk yang perlu diketahui:

### Node via nvm tidak ter-load di non-interactive shell

Kalau Node.js di-install lewat nvm, path-nya di-setup di `~/.bashrc` (interactive shell), **bukan** `~/.bash_profile` (login shell). Akibatnya:

```bash
wsl bash -lc "node --version"   # → bash: node: command not found
wsl bash -c  "node --version"   # → bash: node: command not found
wsl bash -ic "node --version"   # → v20.20.2 ✓ (interactive shell loads .bashrc)
```

**Solusi:** pakai `bash -ic` (interactive + command) saat run command dari Windows side, atau pakai path absolut ke binary:

```bash
/home/<user>/.nvm/versions/node/v20.20.2/bin/node app.js
```

Untuk script otomasi / CI, simpan path absolut atau install Node via nodesource (yang taruh binary di `/usr/bin/node`, accessible dari mana saja).

### File access dari Windows

Repo di WSL bisa diakses dari Windows lewat `\\wsl.localhost\Ubuntu-24.04\home\<user>\<project>\`. Aman untuk editor (VS Code, dll), tapi **hindari `npm install` dari Windows side** (dari PowerShell/CMD menuju ke file WSL) — performance 10x lebih lambat dan kadang permissions bermasalah. Lakukan semua `npm install` / `npm start` dari dalam WSL.

### systemd di WSL2

WSL2 Ubuntu 24.04 sudah support systemd. Aktifkan di `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

Lalu restart WSL dari PowerShell:
```powershell
wsl --shutdown
```

Setelah itu unit file `awanstream.service` di section systemd bawah ini bisa dipakai langsung.

### Running as service di WSL (dev only)

Untuk dev, biasanya cukup jalankan `npm start` di terminal WSL dan biarkan terbuka. Kalau mau jalan background tanpa buka terminal:

```bash
nohup npm start > app.log 2>&1 &
disown
```

Atau pakai `tmux` / `screen`. **Jangan pakai WSL untuk production** — pakai VPS / server Linux asli.

### Port forwarding WSL2 → Windows

WSL2 pakai virtual network. Secara default `localhost:7575` di Windows sudah forward ke WSL (localhost forwarding built-in). Kalau tidak:

```powershell
# Dari PowerShell admin, cari IP WSL:
wsl hostname -I
# Forward ke port Windows:
netsh interface portproxy add v4tov4 listenport=7575 connectport=7575 connectaddress=<WSL_IP>
```

## Pre-deployment checklist

1. Clone repo ke server
2. `npm install --omit=dev` (prod-only install, lebih kecil)
3. `node generate-secret.js`
4. Edit `.env`:
   ```env
   PORT=7575
   SESSION_SECRET=<dari generate-secret>
   NODE_ENV=production
   TZ=Asia/Jakarta
   TZ_LABEL=WIB
   ```
5. `node reset-password.js` → buat admin user
6. Test manual: `npm start` → akses `http://<server-ip>:7575`
7. Ctrl+C, lanjut ke service setup

---

## Opsi A: systemd (recommended untuk VPS Linux)

### 1. User & path

Anggap repo di `/home/awan/awanstream`, user `awan`. Sesuaikan.

### 2. Unit file

Simpan di `/etc/systemd/system/awanstream.service`:

```ini
[Unit]
Description=AwanStream RTMP streaming app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=awan
Group=awan
WorkingDirectory=/home/awan/awanstream
EnvironmentFile=/home/awan/awanstream/.env
ExecStart=/usr/bin/node /home/awan/awanstream/app.js
Restart=on-failure
RestartSec=5

# Hardening (optional tapi recommended)
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/awan/awanstream
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true

# Resource limits
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
```

**Cek path `node`** di server:
```bash
which node
# kalau pakai nvm: /home/awan/.nvm/versions/node/v20.x.x/bin/node
```

### 3. Aktifkan

```bash
sudo systemctl daemon-reload
sudo systemctl enable awanstream
sudo systemctl start awanstream
sudo systemctl status awanstream
```

### 4. Operasi

```bash
# Restart (setelah update code atau .env)
sudo systemctl restart awanstream

# Stop
sudo systemctl stop awanstream

# Logs (systemd journal)
sudo journalctl -u awanstream -f
sudo journalctl -u awanstream --since "1 hour ago"
```

### 5. Deploy update

```bash
cd /home/awan/awanstream
git pull
npm install --omit=dev
sudo systemctl restart awanstream
```

---

## Opsi B: pm2

### 1. Install

```bash
sudo npm install -g pm2
```

### 2. Ecosystem file

Simpan sebagai `ecosystem.config.js` di root project:

```js
module.exports = {
  apps: [{
    name: 'awanstream',
    script: 'app.js',
    cwd: __dirname,
    instances: 1,                 // SQLite tidak cocok multi-instance
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production' },
    error_file: './logs/pm2-err.log',
    out_file: './logs/pm2-out.log',
    time: true,
  }],
};
```

### 3. Jalankan & persist

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # ikuti instruksi yang muncul (biasanya ada perintah sudo yang perlu dijalankan)
```

### 4. Operasi

```bash
pm2 status
pm2 restart awanstream
pm2 stop awanstream
pm2 logs awanstream
pm2 monit
```

### 5. Deploy update

```bash
cd awanstream && git pull && npm install --omit=dev && pm2 restart awanstream
```

**Catatan:** `instances: 1` wajib. Multiple instance dengan SQLite akan bentrok di WAL dan session store, plus state `running Map` tidak share antar process.

---

## Opsi C: Docker

### 1. Dockerfile

Simpan di root project:

```dockerfile
FROM node:20-bookworm-slim

# Install ffmpeg + build tools untuk better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

# Runtime dirs (akan di-mount sebagai volume)
RUN mkdir -p db logs public/uploads

EXPOSE 7575

CMD ["node", "app.js"]
```

### 2. docker-compose.yml

```yaml
services:
  awanstream:
    build: .
    container_name: awanstream
    restart: unless-stopped
    ports:
      - "7575:7575"
    env_file: .env
    environment:
      NODE_ENV: production
    volumes:
      - ./db:/app/db
      - ./logs:/app/logs
      - ./public/uploads:/app/public/uploads
```

### 3. Jalankan

```bash
# Pre-setup (generate secret + admin user di host, bind mount volumes)
node generate-secret.js

# Build + start
docker compose up -d --build

# Create admin user inside container
docker compose exec awanstream node reset-password.js

# Logs
docker compose logs -f

# Stop
docker compose down
```

### 4. Update

```bash
git pull
docker compose up -d --build
```

### Catatan Docker

- `better-sqlite3` perlu build native, makanya base image Debian + build tools. Alpine bisa dipakai tapi butuh `apk add --no-cache build-base python3 sqlite-dev ffmpeg`.
- Cookie `secure` aktif di `NODE_ENV=production` — hanya HTTPS. Pasang reverse proxy atau set `NODE_ENV=development` untuk akses HTTP di lokal.
- Volume mount `db/`, `logs/`, `public/uploads/` wajib supaya data persist saat container di-rebuild.

---

## Reverse proxy (HTTPS)

AwanStream **bukan** HTTPS-capable sendiri. Wajib di balik reverse proxy untuk production.

### nginx

```nginx
server {
    listen 80;
    server_name stream.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name stream.example.com;

    ssl_certificate     /etc/letsencrypt/live/stream.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/stream.example.com/privkey.pem;

    # Upload video 5 GB
    client_max_body_size 5120M;

    location / {
        proxy_pass         http://127.0.0.1:7575;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;

        proxy_read_timeout    3600s;
        proxy_send_timeout    3600s;
        proxy_connect_timeout 60s;
    }
}
```

**Penting:** karena cookie `secure` aktif di production, Express harus tahu request datang via HTTPS. Tambah di `app.js`:

```js
app.set('trust proxy', 1);  // trust first proxy (nginx)
```

### Caddy (lebih simpel)

```caddy
stream.example.com {
    reverse_proxy 127.0.0.1:7575
    request_body {
        max_size 5GB
    }
}
```

Caddy auto-issue TLS dari Let's Encrypt.

### Let's Encrypt (certbot)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d stream.example.com
# Auto-renew via systemd timer (sudah di-setup otomatis)
```

---

## Firewall (ufw)

```bash
# PENTING: Buka SSH dulu supaya tidak ketendang
sudo ufw allow 22/tcp           # atau port SSH custom

# HTTPS (untuk reverse proxy)
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Port app kalau tidak pakai reverse proxy (NOT recommended untuk internet)
# sudo ufw allow 7575/tcp

sudo ufw enable
sudo ufw status verbose
```

---

## Log rotation

### Systemd journal (kalau pakai systemd)

Sudah otomatis di-rotate. Config di `/etc/systemd/journald.conf`:

```ini
SystemMaxUse=500M
MaxRetentionSec=1week
```

### FFmpeg logs di `logs/stream-*.log` dan `logs/transcode-*.log`

File tumbuh tanpa batas. Setup `logrotate`:

Simpan sebagai `/etc/logrotate.d/awanstream`:

```
/home/awan/awanstream/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` penting karena FFmpeg memegang file handle dan tidak reopen saat file di-rename.

---

## Monitoring

### Health check endpoint (belum ada, tapi mudah ditambah)

Kalau perlu, tambah di `app.js`:
```js
app.get('/healthz', (req, res) => res.json({ ok: true }));
```

Lalu monitor dengan uptime-kuma / healthchecks.io / prometheus.

### Disk monitoring

`public/uploads/` bisa cepat penuh. Set alert:

```bash
# Sample cron job
*/15 * * * * df -h /home/awan/awanstream/public/uploads | awk 'NR==2 {gsub("%",""); if ($5 > 85) print}' | mail -s "Disk alert" you@example.com
```

### Bandwidth monitoring (vnStat)

Dashboard card **BW Bulan Ini** membaca histori dari `vnstat --json`.

```bash
sudo apt install vnstat
sudo systemctl enable --now vnstat
vnstat
```

Kalau AwanStream berjalan di Docker, jalankan vnStat di host atau pastikan database vnStat di container ikut dipersist. Tanpa vnStat, dashboard tetap jalan dan menampilkan `N/A`.

### Process crash alert

systemd `Restart=on-failure` + `journalctl` sudah cukup. Untuk alert proaktif, pakai pm2-plus, Sentry, atau tool favorit.

---

## Backup

Data penting:

```
.env                    (credentials)
db/awanstream.db        (users, videos metadata, streams config)
public/uploads/         (video files — biasanya paling besar)
```

Simple nightly backup cron:

```bash
#!/bin/bash
# /home/awan/backup-awanstream.sh
cd /home/awan/awanstream
TIMESTAMP=$(date +%Y%m%d-%H%M)
tar -czf /backup/awanstream-$TIMESTAMP.tar.gz \
    .env db/ public/uploads/
# Retain 7 days
find /backup/ -name "awanstream-*.tar.gz" -mtime +7 -delete
```

Tambah ke crontab:
```cron
0 3 * * * /home/awan/backup-awanstream.sh
```

Kalau disk mahal dan video bisa di-recompute, skip `public/uploads/` dari backup.

---

## Upgrade / rollback

### Upgrade

```bash
cd awanstream
git fetch && git log --oneline HEAD..origin/main    # preview changes
git pull
npm install --omit=dev
node scripts/smoke.js                                # verify
sudo systemctl restart awanstream                    # or pm2 restart / docker compose up -d --build
```

### Rollback

```bash
cd awanstream
git log --oneline -10
git checkout <commit-hash>
npm install --omit=dev
sudo systemctl restart awanstream
```

**DB schema:** `ensureSchema()` hanya bisa ADD, tidak DROP. Rollback ke commit lama yang tidak kenal kolom baru → aman, kolomnya di-ignore. Tapi kalau rollback ke schema lama yang ada constraint NOT NULL pada kolom yang sudah dihapus di versi baru, bisa error. Testing dulu sebelum release.

---

## Troubleshooting production

**Stream tidak start, tidak ada error di UI**  
Cek `logs/stream-<id>.log` dan systemd journal:
```bash
sudo journalctl -u awanstream -n 100 --no-pager
```

**`better-sqlite3` error saat build di server**  
Butuh build tools: `sudo apt install build-essential python3`.

**Upload 5 GB timeout**  
Reverse proxy timeout terlalu pendek. Naikkan `proxy_read_timeout` / `client_max_body_size` di nginx, atau `request_body max_size` di Caddy.

**Cookie tidak persist padahal HTTPS ada**  
Lupa set `app.set('trust proxy', 1)` — Express anggap request HTTP, cookie `secure` gak di-set browser.

**FFmpeg crash terus-menerus saat streaming**  
Source file corrupt atau codec incompatible. Re-run Prepare dengan source yang benar.

**Port 7575 sudah dipakai**  
```bash
sudo lsof -i :7575
sudo kill -9 <PID>
# atau ganti PORT di .env
```

---

## GitLab CI/CD (test → build → deploy)

Repo ini sudah di-setup untuk auto-deploy via GitLab Runner. Pipeline 3 stage di `.gitlab-ci.yml`:

1. **test** — install deps + `node scripts/smoke.js` + `node scripts/render-check.js`. Jalan di semua branch.
2. **build** — `docker build` → push ke GitLab Container Registry (`$CI_REGISTRY_IMAGE`). Hanya di default branch (`main`).
3. **deploy** — SSH ke server production → update `.env` dari CI variables → `docker compose pull && up -d`. Hanya di default branch.

### Required CI/CD Variables

Set di **Settings → CI/CD → Variables** di GitLab project:

| Variable | Type | Protected | Masked | Value example |
|---|---|---|---|---|
| `DEPLOY_HOST` | Variable | ✓ | — | `stream.example.com` atau IP |
| `DEPLOY_USER` | Variable | ✓ | — | `awan` (SSH user di server) |
| `DEPLOY_PATH` | Variable | ✓ | — | `/home/awan/awanstream` |
| `DEPLOY_SSH_KEY` | **File** | ✓ | — | isi private key (`-----BEGIN ...`) |
| `SESSION_SECRET` | Variable | ✓ | ✓ | hex 48 bytes |
| `APP_PORT` | Variable | ✓ | — | `7575` |
| `APP_TZ` | Variable | ✓ | — | `Asia/Jakarta` |
| `APP_TZ_LABEL` | Variable | ✓ | — | `WIB` |

**`DEPLOY_SSH_KEY` type WAJIB "File"** — bukan "Variable". GitLab akan inject sebagai path ke temp file, jadi di script pakai `chmod 400 "$DEPLOY_SSH_KEY"` dan `ssh-add "$DEPLOY_SSH_KEY"` (pakai path, bukan `echo | ssh-add -`).

### Common deploy error: `chmod: : No such file or directory`

Error ini muncul saat `$DEPLOY_SSH_KEY` empty di runtime. 99% penyebabnya: **variable mark "Protected" tapi branch tidak protected**. GitLab hanya inject Protected variables ke Protected branches/tags.

**Fix (pilih salah satu):**
- **Protect branch:** Settings → Repository → Protected branches → protect `main` (default branch)
- **Unprotect variable:** Settings → CI/CD → Variables → edit `DEPLOY_SSH_KEY` → uncheck "Protect variable". Ulangi untuk semua `DEPLOY_*` variable dan `SESSION_SECRET`.

`.gitlab-ci.yml` punya sanity check di awal `deploy:before_script` yang exit dengan pesan jelas kalau `$DEPLOY_SSH_KEY` kosong.

### Server prerequisites

Server target perlu:
- Docker + `docker compose` plugin (`docker compose version`)
- SSH access untuk `DEPLOY_USER` dengan public key dari pair `DEPLOY_SSH_KEY`
- `DEPLOY_PATH` directory writable oleh user
- Outbound network ke RTMP endpoints (1935, 443)

Pertama kali setup server:
```bash
# Generate SSH key di local
ssh-keygen -t ed25519 -f ~/.ssh/awanstream_deploy -C "gitlab-ci@awanstream"
# Copy public key ke server
ssh-copy-id -i ~/.ssh/awanstream_deploy.pub awan@stream.example.com
# Paste private key content ke GitLab variable DEPLOY_SSH_KEY (type File)
cat ~/.ssh/awanstream_deploy
```

### Image size

Docker image ±114 MB (`node:20-alpine` + `ffmpeg` + `node_modules`). Ini normal — FFmpeg saja ±40 MB. Multi-stage build sudah optimal.

### Runtime files di server

Setelah deploy pertama, di `DEPLOY_PATH` akan ada:
- `.env` — generated dari CI variables
- `docker-compose.yml` — scp dari repo
- `db/`, `logs/`, `public/uploads/` — volume mount (persist antar deploy)

Admin user pertama **tidak otomatis** dibuat. Setelah deploy pertama, SSH ke server lalu:
```bash
cd /home/awan/awanstream
docker compose exec awanstream node reset-password.js
```

### Manual deploy (tanpa CI)

Kalau pipeline gagal dan perlu hotfix langsung:
```bash
# Di server
cd /home/awan/awanstream
docker login registry.gitlab.com
docker pull registry.gitlab.com/<namespace>/<project>:latest
docker compose down
docker compose up -d
docker compose logs -f
```

---

## Quick reference

| Task | systemd | pm2 | docker |
|---|---|---|---|
| Start | `systemctl start awanstream` | `pm2 start ecosystem.config.js` | `docker compose up -d` |
| Stop | `systemctl stop awanstream` | `pm2 stop awanstream` | `docker compose down` |
| Restart | `systemctl restart awanstream` | `pm2 restart awanstream` | `docker compose restart` |
| Logs | `journalctl -u awanstream -f` | `pm2 logs awanstream` | `docker compose logs -f` |
| Status | `systemctl status awanstream` | `pm2 status` | `docker compose ps` |
| Deploy update | `git pull && npm i && systemctl restart` | `git pull && npm i && pm2 restart` | `git pull && docker compose up -d --build` |
