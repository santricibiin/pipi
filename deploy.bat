@echo off
REM ===========================================================================
REM  Shopee Scraper - jalankan sekali klik di Windows.
REM  Double-click file ini, atau jalankan: deploy.bat
REM ===========================================================================
setlocal

cd /d "%~dp0"

echo.
echo  == Shopee Scraper - setup ^& run ==
echo.

REM --- cek Node.js ---
where node >nul 2>nul
if errorlevel 1 (
  echo  [X] Node.js belum terpasang.
  echo      Download dulu di https://nodejs.org ^(versi 20 atau lebih baru^), lalu jalankan ulang.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo  [v] Node.js %%v

REM --- install dependency npm (sekali saja) ---
if not exist node_modules (
  echo.
  echo  Memasang dependency npm...
  call npm install
  if errorlevel 1 ( echo  [X] npm install gagal. & pause & exit /b 1 )
)

REM --- unduh Camoufox kalau belum ada ---
echo.
echo  Mengecek browser Camoufox...
call npm run install-camoufox
if errorlevel 1 ( echo  [!] Unduh Camoufox bermasalah - lanjut, mungkin sudah ada. )

REM --- ingatkan soal cookies ---
if not exist cookies.txt if not exist shopee\sessions\*.json (
  echo.
  echo  [!] Belum ada cookies.txt atau session tersimpan.
  echo      Taruh cookies.txt ^(format Netscape^) di folder ini sebelum scrape.
)

REM --- buka browser ke UI lalu jalankan server ---
echo.
echo  Membuka http://localhost:5173 ...
start "" "http://localhost:5173"

echo.
echo  Menjalankan server. Tutup jendela ini atau tekan Ctrl+C untuk berhenti.
echo.
call npm run shopee:web

endlocal
