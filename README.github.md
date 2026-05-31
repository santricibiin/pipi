# kiro-auto

Bulk register + upgrade [Kiro IDE](https://kiro.dev) accounts. GSuite → Google OAuth register → Stripe checkout → Pro.

Stealth browser via Camoufox (Firefox) atau Chromium + playwright-extra stealth.

## Fitur

- **Register** akun Kiro bulk via Google OAuth di `app.kiro.dev/signin`
- **Upgrade to Pro** otomatis: hydrate session → klik Upgrade → fill Stripe checkout → verify Pro
- VCC pool dengan Luhn validation, per-card use-state, multi-attempt on decline
- Auth mode `hydrate_or_login` — pakai cookies dulu, fallback ke fresh Google login kalau expired
- 3DS handling: auto-flip headless → headed, pause for manual, atau fail
- Anti-bot: camoufox fingerprint patches, humanize mouse, geoip resolve, stealth plugin

## Requirements

- Node.js 20+
- Akun GSuite (`email:password` per line)
- Camoufox auto-download di first run (~170MB)

## Quick start

```powershell
git clone <repo> kiro-auto
cd kiro-auto
npm install
npm run install-browser

# 1. Isi accounts
cp accounts/gsuite.example.txt accounts/gsuite.txt
# edit → email:password per line

cp accounts/vcc.example.json accounts/vcc.json
# edit → isi VCC asli

# 2. Register
npm run register -- --count 5 -y

# 3. Upgrade ke Pro
npm run upgrade -- --count 5 -y
```

## Commands

| Command | Fungsi |
|---------|--------|
| `npm run register` | Bulk register akun Kiro via Google OAuth |
| `npm run upgrade` | Upgrade akun ke Pro via Stripe checkout |
| `npm run switch` | Legacy aor* token switcher |
| `npm run typecheck` | TypeScript check |

Tanpa flag → interactive menu. Dengan flag + `-y` → non-interactive.

### Register flags

```
--count 5 --concurrency 2 --proxy http://user:pass@host:port
--engine camoufox|chromium-stealth|chromium-vanilla
--headed --no-humanize --no-geoip
```

### Upgrade flags

```
--count 5 --auth-mode hydrate_or_login|google_login|hydrate
--on3ds auto_flip|pause|fail --3ds-timeout-s 300
--max-vcc-attempts 3 --headed
--only alice@x.com,bob@x.com
--session-file show/sessions/alice.123.json
```

## File layout

```
accounts/
├── gsuite.txt              # email:password per line (gitignored)
├── gsuite.state.json       # per-account register state
├── vcc.json                # VCC pool (gitignored)
└── vcc.state.json          # per-VCC use-state

show/
├── sessions/               # captured Kiro sessions per account
├── results.json            # register records
├── upgrade-results.json    # upgrade records
├── upgrade-state.json      # per-account upgrade state
└── diagnostics/            # failure dumps (screenshot + HTML + buttons)
```

## VCC format

`accounts/vcc.json` — array of cards:

```json
[
  {
    "number": "4242 4242 4242 4242",
    "expMonth": 12,
    "expYear": 2029,
    "cvc": "123",
    "billing": {
      "name": "Jane Doe",
      "country": "US",
      "line1": "1600 Amphitheatre Parkway",
      "city": "Mountain View",
      "state": "CA",
      "postalCode": "94043"
    }
  }
]
```

Accept: `expiry: "MM/YY"` instead of expMonth+expYear. `country` wajib ISO alpha-2 (`US`, `ID`, `GB`). Luhn-invalid cards ditolak saat load.

## Auth modes

| Mode | Behavior |
|------|----------|
| `hydrate` | Pakai session JSON only. Fastest, fragile. |
| `google_login` | Fresh OAuth every run. Robust, slower. |
| `hydrate_or_login` (default) | Hydrate first, fallback ke Google login kalau expired. |

## 3DS handling

Issuer Indonesia hampir selalu trigger 3DS. Default `--on3ds auto_flip` → close headless browser, relaunch headed, retry flow. `pause` → tunggu user selesaikan 3DS manual. `fail` → skip akun.

## Failure modes

Per-akun di `show/results.json` / `show/upgrade-results.json`:

- `google_button_not_found` — DOM berubah, update selector
- `challenge_required` — Google 2FA / device verify
- `captcha_required` — butuh residential IP
- `bot_detection` — fingerprint/IP flagged
- `upgrade_button_not_found` — check `show/diagnostics/` dump
- `stripe_declined` / `stripe_validation` — VCC issue
- `threeds_required_headless` — pakai `--on3ds auto_flip` atau `--headed`

## Troubleshooting

Upgrade fail silent? Check `show/diagnostics/<email>.<reason>.<ts>.{png,html,buttons.json}` — screenshot + full HTML + visible button inventory saat fail.

Akun sudah Pro tapi state bilang failed? Run `npm run upgrade` lagi — Pro badge detection via `aria-label="Current plan: KIRO PRO"` auto-detect and skip.

Reset state: delete `accounts/*.state.json` atau `show/upgrade-state.json`.

## Disclaimer

For personal automation of accounts you own. Patuhi Google Workspace TOS, Kiro TOS, dan hukum lokal.

## License

MIT
