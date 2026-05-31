/**
 * Shopee auto-login via cookie injection (camoufox engine).
 *
 * Flow:
 *   1. Parse cookies.txt (Netscape format) and keep only *.shopee.co.id.
 *   2. Launch camoufox (anti-fingerprint Firefox fork) through the shared
 *      stealth browser helper.
 *   3. Inject the cookies at the context level so they apply to every
 *      shopee.co.id origin.
 *   4. Navigate to the seller dashboard. If the cookies are valid we land on
 *      the dashboard; otherwise Shopee bounces us back to the login page.
 */

import { resolve } from 'node:path'
import type { BrowserContext } from 'playwright'
import { launchStealthBrowser, type StealthSession } from '../lib/browser'
import { parseCookiesFile, filterByDomain } from './cookie-parser'
import { detectShopName } from './verify'
import { saveSession, slugify, loadSession, findLatestSession } from './session'
import type { NetscapeCookie, ShopeeLoginOptions, ShopeeLoginResult } from './types'

const SHOPEE_ROOT = 'shopee.co.id'
const SELLER_HOME = 'https://seller.shopee.co.id/'
const LOGIN_URL =
  'https://accounts.shopee.co.id/seller/login?next=https%3A%2F%2Fseller.shopee.co.id%2F'

type PwCookie = Parameters<BrowserContext['addCookies']>[0][number]

/** Convert Netscape cookies to the shape Playwright's addCookies expects. */
function toPlaywrightCookies(cookies: NetscapeCookie[]): PwCookie[] {
  return cookies.map((c) => {
    const entry: PwCookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: c.httpOnly,
      // Secure must be true when sameSite is None, and most Shopee auth
      // cookies are served over https anyway.
      secure: c.secure,
      sameSite: c.secure ? 'None' : 'Lax'
    }
    // expires of 0 means "session cookie" — omit it so Playwright treats it
    // as a session cookie instead of an already-expired one.
    if (c.expires > 0) entry.expires = c.expires
    return entry
  })
}

type Attempt = { session: StealthSession; finalUrl: string; success: boolean }

/**
 * Launch a camoufox session and navigate to the seller home, then report
 * whether we landed on the dashboard (logged in) or got bounced to login.
 * Pass `storageState` to reuse a saved session, or `cookies` to inject a
 * fresh cookie set.
 */
async function launchAndCheck(
  options: ShopeeLoginOptions,
  storageState: unknown | undefined,
  cookies: PwCookie[] | undefined,
  settleMs: number,
  log: (m: string) => void
): Promise<Attempt> {
  const session = await launchStealthBrowser({
    engine: 'camoufox',
    headless: options.headless ?? false,
    proxyUrl: options.proxyUrl,
    storageState: storageState as any,
    log
  })

  if (cookies && cookies.length > 0) {
    await session.context.addCookies(cookies)
    log(`[shopee] injected ${cookies.length} cookies into browser context`)
  }

  log(`[shopee] navigating to seller dashboard...`)
  await session.page.goto(SELLER_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await session.page.waitForTimeout(settleMs)

  const finalUrl = session.page.url()
  const onLoginPage = /accounts\.shopee\.co\.id\/.*login/i.test(finalUrl)
  return { session, finalUrl, success: !onLoginPage }
}

/** Resolve which saved-session file to try, if any. */
async function resolveSessionPath(
  useSession: ShopeeLoginOptions['useSession'],
  sessionDir: string | undefined,
  log: (m: string) => void
): Promise<string | undefined> {
  if (useSession === false) return undefined
  if (typeof useSession === 'string') return resolve(useSession)
  // true / undefined → auto-find newest (in the per-token dir if given)
  const latest = sessionDir ? await findLatestSession(resolve(sessionDir)) : await findLatestSession()
  if (latest) log(`[shopee] found saved session: ${latest}`)
  return latest
}

export async function shopeeLogin(
  options: ShopeeLoginOptions = {}
): Promise<ShopeeLoginResult> {
  const log = options.log ?? ((m: string) => console.log(m))
  const keepOpen = options.keepOpen ?? true

  const established = await establishShopeeSession(options)
  const { session, result } = established

  // Keep the browser open for inspection, or close it.
  await holdOrClose(session, keepOpen, log)
  return result
}

export type EstablishedSession = {
  /** The live browser session. Caller owns its lifetime (must close it). */
  session: StealthSession
  result: ShopeeLoginResult
}

/**
 * Authenticate to Shopee Seller Centre and return the LIVE browser session
 * (still open) plus a result summary. Tries a saved session first, then falls
 * back to cookies.txt. The caller is responsible for closing the session.
 *
 * This is the building block reused by both `shopeeLogin` (which then holds or
 * closes the browser) and the order scraper (which keeps navigating).
 */
export async function establishShopeeSession(
  options: ShopeeLoginOptions = {}
): Promise<EstablishedSession> {
  const log = options.log ?? ((m: string) => console.log(m))
  const cookiesPath = resolve(options.cookiesPath ?? 'cookies.txt')
  const settleMs = options.settleMs ?? 3000

  let attempt: Attempt | undefined
  let authSource: 'session' | 'cookies' | undefined

  // 1. Try a saved session first (if one exists / was requested).
  const sessionFilePath = await resolveSessionPath(options.useSession, options.sessionDir, log)
  if (sessionFilePath) {
    try {
      const saved = await loadSession(sessionFilePath)
      log(`[shopee] trying saved session (${saved.shopName ?? 'unknown shop'})...`)
      attempt = await launchAndCheck(options, saved.storageState, undefined, settleMs, log)
      if (attempt.success) {
        authSource = 'session'
        log(`[shopee] ♻️  reused saved session — no cookie inject needed`)
      } else {
        log(`[shopee] saved session expired — falling back to cookies.txt`)
        await attempt.session.close()
        attempt = undefined
      }
    } catch (e) {
      log(
        `[shopee] could not use saved session (${
          e instanceof Error ? e.message : String(e)
        }) — falling back to cookies.txt`
      )
      if (attempt) {
        await (attempt as Attempt).session.close()
        attempt = undefined
      }
    }
  } else if (options.useSession !== false) {
    log(`[shopee] no saved session found — using cookies.txt`)
  }

  // 2. Fall back to cookies.txt.
  if (!attempt) {
    log(`[shopee] reading cookies from ${cookiesPath}`)
    const all = await parseCookiesFile(cookiesPath)
    const shopeeCookies = filterByDomain(all, SHOPEE_ROOT)
    if (shopeeCookies.length === 0) {
      throw new Error(`[shopee] no *.${SHOPEE_ROOT} cookies found in ${cookiesPath}`)
    }
    log(`[shopee] found ${shopeeCookies.length} Shopee cookies (of ${all.length} total)`)
    attempt = await launchAndCheck(
      options,
      undefined,
      toPlaywrightCookies(shopeeCookies),
      settleMs,
      log
    )
    authSource = 'cookies'
  }

  const { session, finalUrl, success } = attempt

  // 3. Failure — cookies/session rejected.
  if (!success) {
    log(`[shopee] ❌ not logged in — redirected to login (${finalUrl})`)
    log(`[shopee]    hint: re-export fresh cookies; Shopee SPC_* tokens expire fast`)
    log(`[shopee]    login page: ${LOGIN_URL}`)
    return { session, result: { success, finalUrl, authSource } }
  }

  log(`[shopee] ✅ logged in via ${authSource} — landed on ${finalUrl}`)

  // 4. Verify by reading the shop / account name from the dashboard.
  const shopName = await detectShopName(session.page)
  if (shopName) {
    log(`[shopee] 🏪 shop name: ${shopName}`)
  } else {
    log(`[shopee] ⚠️  could not detect shop name (DOM may have changed) — login still valid`)
  }

  // 5. Persist the (possibly refreshed) session for next time.
  let sessionPath: string | undefined
  if (options.saveSession !== false) {
    const outPath =
      typeof options.saveSession === 'string'
        ? options.saveSession
        : resolve(options.sessionDir ?? resolve('shopee', 'sessions'), `${slugify(shopName)}.json`)
    try {
      sessionPath = await saveSession(session.context, session.page, outPath, shopName)
      log(`[shopee] 💾 session saved → ${sessionPath}`)
    } catch (e) {
      log(`[shopee] WARN: failed to save session: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { session, result: { success, finalUrl, shopName, sessionPath, authSource } }
}

/**
 * When keepOpen is true, leave the browser running and block forever so you
 * can inspect the page / build the next feature (press Ctrl+C to exit).
 * Otherwise close the session and return.
 */
async function holdOrClose(
  session: StealthSession,
  keepOpen: boolean,
  log: (m: string) => void
): Promise<void> {
  if (keepOpen) {
    log(`[shopee] 🔓 browser kept open — press Ctrl+C here to close it when done`)
    await new Promise<void>(() => {}) // never resolves
    return
  }
  await session.close()
}
