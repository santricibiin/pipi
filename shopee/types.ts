/**
 * Shopee auto-login — shared types.
 */

/** A single cookie parsed from a Netscape-format cookies.txt file. */
export type NetscapeCookie = {
  domain: string
  /** TRUE = cookie valid for subdomains (leading-dot domain). */
  includeSubdomains: boolean
  path: string
  secure: boolean
  /** Unix epoch seconds. 0 = session cookie (no expiry). */
  expires: number
  name: string
  value: string
  httpOnly: boolean
}

export type ShopeeLoginOptions = {
  /** Path to the Netscape cookies file. Defaults to `cookies.txt` at repo root. */
  cookiesPath?: string
  /** Run camoufox headless. Defaults to false so you can watch the login. */
  headless?: boolean
  /** Optional proxy URL, e.g. http://user:pass@host:port. */
  proxyUrl?: string
  /** How long (ms) to wait for the dashboard to settle after navigation. */
  settleMs?: number
  /**
   * Saved session to try first.
   *   - string  → load that exact session file.
   *   - true / undefined → auto-find the newest session in `shopee/sessions/`.
   *   - false   → skip saved sessions, always use cookies.txt.
   * If the saved session is expired, the flow falls back to cookies.txt.
   */
  useSession?: string | boolean
  /**
   * Where to save the authenticated session (Playwright storageState +
   * metadata) on success. Defaults to `shopee/sessions/<shop>.json`.
   * Pass `false` to skip saving.
   */
  saveSession?: string | false
  /**
   * Keep the browser open after login instead of closing it, so you can
   * inspect the page or build the next feature. Defaults to true. The call
   * resolves once login finishes but the browser stays alive until you press
   * Ctrl+C (or it is closed elsewhere).
   */
  keepOpen?: boolean
  log?: (msg: string) => void
}

export type ShopeeLoginResult = {
  success: boolean
  /** The URL the page ended on after cookie injection + navigation. */
  finalUrl: string
  /** Detected seller shop / account name, if found. */
  shopName?: string
  /** Absolute path to the saved session file, if one was written. */
  sessionPath?: string
  /** How auth was established: 'session' (reused) or 'cookies' (fresh inject). */
  authSource?: 'session' | 'cookies'
}

/** Persisted Shopee seller session — Playwright storageState plus metadata. */
export type ShopeeSession = {
  shopName?: string
  finalUrl: string
  capturedAt: number
  userAgent: string
  /** Playwright storageState (cookies + origin localStorage). */
  storageState: unknown
}
