#!/usr/bin/env bash
#
# Shopee Scraper — one-command deploy untuk VPS Linux (Ubuntu/Debian).
#
# Mode DOMAIN (direkomendasikan) — langsung jadi https://domain-kamu:
#   DOMAIN=jagopay.biz.id bash deploy.sh
#   DOMAIN=jagopay.biz.id EMAIL=kamu@gmail.com bash deploy.sh
#
# Mode IP (tanpa domain) — akses lewat http://ip-vps:5173:
#   HOST=0.0.0.0 bash deploy.sh
#
# Mode lokal saja:
#   HOST=127.0.0.1 bash deploy.sh
#
# Script ini idempotent — aman dijalankan ulang.
set -euo pipefail

cd "$(dirname "$0")"
APP_DIR="$(pwd)"
RUN_USER="$(id -un)"

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }

# Pakai sudo hanya kalau bukan root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else
    warn "Bukan root & tidak ada sudo — sebagian langkah sistem mungkin gagal."
  fi
fi

# ---------------------------------------------------------------------------
# Konfigurasi
# ---------------------------------------------------------------------------
DOMAIN="${DOMAIN:-}"
PORT="${PORT:-5173}"
# Saat ada domain → app cukup dengar di localhost; Nginx yang hadap publik.
if [ -n "$DOMAIN" ]; then
  HOST="${HOST:-127.0.0.1}"
else
  HOST="${HOST:-0.0.0.0}"
fi
EMAIL="${EMAIL:-admin@${DOMAIN:-example.com}}"

# ---------------------------------------------------------------------------
# 1. Node.js 20+
# ---------------------------------------------------------------------------
need_node() {
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  local major
  major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  [ "$major" -lt 20 ]
}

if need_node; then
  say "Memasang Node.js 20 LTS…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  else
    die "Bukan sistem apt. Pasang Node.js 20+ manual lalu jalankan ulang."
  fi
else
  ok "Node.js $(node -v) sudah ada."
fi

# ---------------------------------------------------------------------------
# 2. Dependency sistem untuk Camoufox (Firefox headless)
# ---------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  say "Memasang library sistem untuk Camoufox…"
  $SUDO apt-get update -y
  $SUDO apt-get install -y \
    libgtk-3-0 libx11-xcb1 libasound2 libdbus-glib-1-2 \
    libxtst6 libxrandr2 libgbm1 libpci3 libegl1 \
    fonts-liberation ca-certificates xvfb 2>/dev/null || \
    warn "Sebagian paket gagal dipasang — Camoufox mungkin tetap jalan."
fi

# ---------------------------------------------------------------------------
# 3. Dependency npm + unduh Camoufox
# ---------------------------------------------------------------------------
say "Memasang dependency npm…"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

say "Mengunduh browser Camoufox (sekali saja, ~530MB)…"
npm run install-camoufox

# ---------------------------------------------------------------------------
# 4. Cek cookies / session
# ---------------------------------------------------------------------------
if [ ! -f cookies.txt ] && [ -z "$(ls -A shopee/sessions 2>/dev/null || true)" ]; then
  warn "Belum ada cookies.txt atau session tersimpan."
  warn "Nanti bisa upload cookies langsung dari web UI (panel '🍪 Cookies Login')."
fi

# ---------------------------------------------------------------------------
# 5. Token akses (WAJIB saat publik — data pesanan berisi PII pembeli)
# ---------------------------------------------------------------------------
if [ "$HOST" != "127.0.0.1" ] || [ -n "$DOMAIN" ]; then
  if [ -z "${WEB_TOKEN:-}" ]; then
    if [ -f .web-token ]; then
      WEB_TOKEN="$(cat .web-token)"
    else
      WEB_TOKEN="$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
      echo "$WEB_TOKEN" > .web-token
      chmod 600 .web-token 2>/dev/null || true
    fi
  fi
fi
export HOST PORT
[ -n "${WEB_TOKEN:-}" ] && export WEB_TOKEN

# ---------------------------------------------------------------------------
# 6. systemd service — biar app tetap jalan walau SSH ditutup / VPS reboot
# ---------------------------------------------------------------------------
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
SERVICE_NAME="shopee-scraper"
USE_SYSTEMD=0

if command -v systemctl >/dev/null 2>&1 && { [ -n "$SUDO" ] || [ "$(id -u)" -eq 0 ]; }; then
  say "Membuat systemd service ($SERVICE_NAME)…"
  $SUDO tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null <<EOF
[Unit]
Description=Shopee Order Scraper Web UI
After=network.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
Environment=HOST=${HOST}
Environment=PORT=${PORT}
Environment=WEB_TOKEN=${WEB_TOKEN:-}
Environment=PATH=${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${NPM_BIN} run shopee:web
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  $SUDO systemctl restart "$SERVICE_NAME"
  ok "Service aktif. Lihat log: ${SUDO:+sudo }journalctl -u $SERVICE_NAME -f"
  USE_SYSTEMD=1
else
  warn "systemd tidak tersedia — app dijalankan di foreground (mati saat SSH ditutup)."
fi

# ---------------------------------------------------------------------------
# 7a. MODE DOMAIN — Nginx reverse proxy + SSL (certbot)
# ---------------------------------------------------------------------------
if [ -n "$DOMAIN" ]; then
  command -v apt-get >/dev/null 2>&1 || die "Mode domain butuh sistem apt (Ubuntu/Debian)."

  say "Memasang Nginx + Certbot…"
  $SUDO apt-get install -y nginx certbot python3-certbot-nginx

  # --- Cek DNS: domain harus mengarah ke IP VPS ini ---
  PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')"
  DOMAIN_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -n1 || echo '')"
  if [ -n "$PUBLIC_IP" ] && [ -n "$DOMAIN_IP" ] && [ "$PUBLIC_IP" != "$DOMAIN_IP" ]; then
    warn "DNS '$DOMAIN' → $DOMAIN_IP, tapi IP VPS ini = $PUBLIC_IP."
    warn "Arahkan A record '$DOMAIN' ke $PUBLIC_IP dulu, lalu jalankan ulang."
    warn "Lanjut tetap dicoba — certbot akan gagal kalau DNS belum benar."
  elif [ -z "$DOMAIN_IP" ]; then
    warn "Domain '$DOMAIN' belum bisa di-resolve. Pastikan A record sudah dibuat."
  else
    ok "DNS '$DOMAIN' mengarah ke $DOMAIN_IP."
  fi

  # --- Nginx site (HTTP dulu; certbot menambah blok SSL otomatis) ---
  say "Menulis konfigurasi Nginx untuk $DOMAIN…"
  $SUDO tee "/etc/nginx/sites-available/${SERVICE_NAME}.conf" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    # Body upload cookies bisa agak besar.
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Server-Sent Events (log langsung) — jangan di-buffer.
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        chunked_transfer_encoding off;
    }
}
EOF
  $SUDO ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}.conf" \
               "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  # Matikan default site biar tidak bentrok server_name _.
  $SUDO rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
  $SUDO nginx -t && $SUDO systemctl reload nginx

  # --- Firewall: izinkan HTTP/HTTPS ---
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -qi active; then
    $SUDO ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  fi

  # --- SSL cert (Let's Encrypt) ---
  say "Meminta sertifikat SSL untuk $DOMAIN…"
  if $SUDO certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos \
        -m "$EMAIL" --redirect; then
    ok "SSL aktif — auto-renew sudah dipasang certbot."
    SCHEME="https"
  else
    warn "Certbot gagal (cek DNS / port 80 terbuka). Sementara jalan via HTTP."
    SCHEME="http"
  fi

  TOKEN_QS=""
  [ -n "${WEB_TOKEN:-}" ] && TOKEN_QS="/?token=${WEB_TOKEN}"
  echo
  printf '\033[1;32m  ============================================================\033[0m\n'
  printf '\033[1;32m   🚀 Shopee Scraper siap diakses:\033[0m\n'
  printf '\033[1;32m   %s://%s%s\033[0m\n' "$SCHEME" "$DOMAIN" "$TOKEN_QS"
  printf '\033[1;32m  ============================================================\033[0m\n'
  [ -n "${WEB_TOKEN:-}" ] && warn "Simpan token ini: ${WEB_TOKEN}"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7b. MODE IP — tanpa domain
# ---------------------------------------------------------------------------
if [ "$HOST" = "0.0.0.0" ]; then
  # Buka port di firewall lokal kalau ada & aktif.
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -qi active; then
    say "Membuka port $PORT di ufw…"
    $SUDO ufw allow "$PORT"/tcp >/dev/null 2>&1 || warn "Gagal buka port di ufw."
  elif command -v firewall-cmd >/dev/null 2>&1; then
    say "Membuka port $PORT di firewalld…"
    $SUDO firewall-cmd --add-port="$PORT"/tcp --permanent >/dev/null 2>&1 || true
    $SUDO firewall-cmd --reload >/dev/null 2>&1 || true
  fi

  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo '<ip-vps>')"
  TOKEN_QS=""
  [ -n "${WEB_TOKEN:-}" ] && TOKEN_QS="/?token=$WEB_TOKEN"
  echo
  printf '\033[1;32m  ============================================================\033[0m\n'
  printf '\033[1;32m   Akses dari browser mana saja:\033[0m\n'
  printf '\033[1;32m   http://%s:%s%s\033[0m\n' "$IP" "$PORT" "$TOKEN_QS"
  printf '\033[1;32m  ============================================================\033[0m\n'
  warn "Kalau belum bisa dibuka: cek juga firewall panel provider (port $PORT/tcp)."
  [ -n "${WEB_TOKEN:-}" ] && warn "Token akses: ${WEB_TOKEN}"
fi

# ---------------------------------------------------------------------------
# 8. Jalankan (kalau tidak pakai systemd)
# ---------------------------------------------------------------------------
if [ "${USE_SYSTEMD:-0}" = "1" ]; then
  ok "App berjalan via systemd ($SERVICE_NAME). Selesai."
else
  say "Menjalankan Shopee Scraper UI di foreground…"
  exec npm run shopee:web
fi
