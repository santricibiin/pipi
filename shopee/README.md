# Shopee Auto-Login

Auto-login ke Shopee Seller Center pakai cookie injection + engine **camoufox** (Firefox anti-fingerprint). Tidak mengetik password — login murni dari cookie yang sudah ada.

## Struktur

```
shopee/
  index.ts          # CLI entry (parse args, jalankan login)
  login.ts          # logika inti: parse cookie → launch camoufox → inject → navigate
  cookie-parser.ts  # parser cookies.txt format Netscape
  verify.ts         # deteksi nama toko/akun dari dashboard
  session.ts        # simpan & load session (storageState + metadata)
  types.ts          # tipe bersama
  sessions/         # hasil session tersimpan (per toko)
```

## Cara pakai

Pastikan cookie Shopee ada di `cookies.txt` (format Netscape, sudah terdeteksi `*.shopee.co.id`).

```bash
# default: pakai session tersimpan kalau ada, kalau tidak pakai cookies.txt.
# Browser DIBIARKAN TERBUKA setelah login (Ctrl+C untuk menutup).
npm run shopee

# headless (tanpa jendela)
npm run shopee -- --headless

# tutup browser otomatis setelah login (tidak dibiarkan terbuka)
npm run shopee -- --close

# pakai file cookie lain / proxy
npm run shopee -- --cookies ./cookies.txt --proxy http://user:pass@host:port

# --- session tersimpan ---
# load session tertentu (bukan auto-pick terbaru)
npm run shopee -- --use-session ./shopee/sessions/myshop.json

# paksa abaikan session tersimpan, selalu pakai cookies.txt
npm run shopee -- --no-use-session

# simpan session ke path tertentu
npm run shopee -- --session ./shopee/sessions/myshop.json

# jangan simpan session
npm run shopee -- --no-session

# biar lebih cepat
npm run shopee:orders -- --concurrency 6
```

## Cara kerja

1. **Coba session tersimpan dulu.** `login.ts` cari session terbaru di `sessions/` (atau path dari `--use-session`). Kalau ada, launch camoufox dengan `storageState`-nya — tanpa inject cookie.
2. **Fallback ke cookies.txt.** Kalau tidak ada session / session kedaluwarsa (dipantul ke login), otomatis baca `cookies.txt`, ambil domain `*.shopee.co.id`, lalu inject.
3. Navigasi ke `https://seller.shopee.co.id/`.
   - Berhasil → bertahan di dashboard → `success: true`.
   - Gagal → dipantul ke halaman login → `success: false`.
4. `verify.ts` membaca nama toko/akun dari dashboard (selector DOM → window state → judul halaman).
5. `session.ts` menyimpan ulang `storageState` (cookies + localStorage) + metadata ke `sessions/<nama-toko>.json` — jadi session selalu di-refresh tiap login sukses.
6. **Browser dibiarkan terbuka** (default) supaya bisa diinspeksi / dipakai fitur berikutnya. Tutup dengan Ctrl+C, atau pakai `--close` untuk menutup otomatis.

Urutan auth: session tersimpan → cookies.txt. Field `authSource` di hasil menandai mana yang dipakai (`session` atau `cookies`).

## Session tersimpan

File `sessions/<nama-toko>.json` berisi:

```json
{
  "shopName": "auroracihuy",
  "finalUrl": "https://seller.shopee.co.id/",
  "capturedAt": 1780234997112,
  "userAgent": "Mozilla/5.0 ...",
  "storageState": { "cookies": [ ... ], "origins": [ ... ] }
}
```

`storageState` pakai format native Playwright, jadi bisa langsung di-load ulang lewat `loadSession()` di `session.ts` untuk membuat context yang sudah login tanpa inject cookie manual lagi.

## Catatan

- Token Shopee `SPC_*` cepat kedaluwarsa. Kalau session tersimpan sudah mati, flow otomatis fallback ke `cookies.txt`. Kalau cookie juga mati, export ulang cookie segar.
- Deteksi nama toko bersifat best-effort — kalau Shopee ubah DOM, nama mungkin kosong tapi login tetap valid.
- Mode keep-open (default) memblokir proses sampai Ctrl+C, jadi tidak ada exit code. Pakai `--close` kalau butuh exit code (`0` sukses, `1` gagal) untuk automation.
