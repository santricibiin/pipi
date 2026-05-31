#!/usr/bin/env bash
#
# Shopee Scraper — one-command deploy untuk VPS Linux (Ubuntu/Debian).
#
# Pakai:
#   bash deploy.sh                 # setup + jalankan web UI
#   HOST=0.0.0.0 bash deploy.sh    # expose ke internet (butuh token, lihat bawah)
#   WEB_TOKEN=rahasia123 bash deploy.sh
#
# Script ini idempotent — aman dijalankan ulang.
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }

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
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    warn "Bukan sistem apt. Pasang Node.js 20+ manual lalu jalankan ulang."
    exit 1
  fi
else
  say "Node.js $(node -v) sudah ada."
fi

# ---------------------------------------------------------------------------
# 2. Dependency sistem untuk Camoufox (Firefox headless)
# ---------------------------------------------------------------------------
if command -v apt-get >/dev/null 2>&1; then
  say "Memasang library sistem untuk Camoufox…"
  sudo apt-get update -y
  sudo apt-get install -y \
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
  warn "Upload cookies.txt (format Netscape) ke folder ini sebelum scrape."
fi

# ---------------------------------------------------------------------------
# 5. Host, port, dan token akses
# ---------------------------------------------------------------------------
# Ini script VPS → default expose ke publik (0.0.0.0) supaya bisa diakses lewat
# ip:port. Untuk lokal saja, jalankan: HOST=127.0.0.1 bash deploy.sh
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-5173}"

if [ "$HOST" = "0.0.0.0" ]; then
  # Token WAJIB saat publik — data pesanan berisi info pembeli (nama/alamat/HP).
  if [ -z "${WEB_TOKEN:-}" ]; then
    if [ -f .web-token ]; then
      WEB_TOKEN="$(cat .web-token)"
    else
      WEB_TOKEN="$(head -c 18 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')"
      echo "$WEB_TOKEN" > .web-token
      chmod 600 .web-token 2>/dev/null || true
    fi
  fi
  export WEB_TOKEN

  # Buka port di firewall lokal (ufw / firewalld) kalau ada & aktif.
  if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -qi active; then
    say "Membuka port $PORT di ufw…"
    sudo ufw allow "$PORT"/tcp >/dev/null 2>&1 || warn "Gagal buka port di ufw."
  elif command -v firewall-cmd >/dev/null 2>&1; then
    say "Membuka port $PORT di firewalld…"
    sudo firewall-cmd --add-port="$PORT"/tcp --permanent >/dev/null 2>&1 || true
    sudo firewall-cmd --reload >/dev/null 2>&1 || true
  fi
fi

export HOST PORT

# ---------------------------------------------------------------------------
# 6. Deteksi IP publik & tampilkan URL akses
# ---------------------------------------------------------------------------
if [ "$HOST" = "0.0.0.0" ]; then
  IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo '<ip-vps>')"
  TOKEN_QS=""
  [ -n "${WEB_TOKEN:-}" ] && TOKEN_QS="/?token=$WEB_TOKEN"
  echo
  printf '\033[1;32m  ============================================================\033[0m\n'
  printf '\033[1;32m   Akses dari browser mana saja:\033[0m\n'
  printf '\033[1;32m   http://%s:%s%s\033[0m\n' "$IP" "$PORT" "$TOKEN_QS"
  printf '\033[1;32m  ============================================================\033[0m\n'
  warn "Kalau belum bisa dibuka: cek juga firewall di panel provider"
  warn "(AWS Security Group / GCP Firewall / Oracle / dll) — port $PORT/tcp."
fi

# ---------------------------------------------------------------------------
# 7. Jalankan web UI
# ---------------------------------------------------------------------------
say "Menjalankan Shopee Scraper UI…"
exec npm run shopee:web
