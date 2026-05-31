import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import type { KiroSession } from './google-login'

type LogCallback = (message: string) => void

const KIRO_ORIGIN = 'https://app.kiro.dev'
const KIRO_BOOT_URL = `${KIRO_ORIGIN}/account/usage`

/** Cookie names that carry Kiro auth. Matched case-insensitively on the
 *  cookie name AND restricted to app.kiro.dev domains — any cookie on the
 *  Cognito / Google / YouTube domains is noise from the register flow and
 *  actively harmful to re-inject (expired Google session IDs, consent
 *  cookies, etc. trigger redirect loops). */
const KIRO_AUTH_COOKIE_NAMES = new Set([
  'refreshtoken',
  'accesstoken',
  'idtoken',
  'kiro-visitor-id'
])

function isKiroDomain(domain: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase()
  return d === 'app.kiro.dev' || d === 'kiro.dev' || d.endsWith('.kiro.dev')
}

function filterAuthCookies(
  all: KiroSession['cookies']
): KiroSession['cookies'] {
  return all.filter((c) => {
    if (!isKiroDomain(c.domain)) return false
    return KIRO_AUTH_COOKIE_NAMES.has(c.name.toLowerCase())
  })
}

export async function loadKiroSession(path: string): Promise<KiroSession> {
  const abs = resolve(path)
  const raw = await readFile(abs, 'utf-8')
  const parsed = JSON.parse(raw) as KiroSession
  if (!parsed.cookies || !Array.isArray(parsed.cookies)) {
    throw new Error(`session file malformed (no cookies[]): ${abs}`)
  }
  return parsed
}

function cookiesForContext(session: KiroSession): Parameters<BrowserContext['addCookies']>[0] {
  const sameSiteMap: Record<string, 'Strict' | 'Lax' | 'None'> = {
    Strict: 'Strict',
    Lax: 'Lax',
    None: 'None'
  }
  return session.cookies.map((c) => {
    const entry: Parameters<BrowserContext['addCookies']>[0][number] = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      httpOnly: c.httpOnly ?? false,
      secure: c.secure ?? false,
      sameSite: c.sameSite ? sameSiteMap[c.sameSite] ?? 'Lax' : 'Lax'
    }
    if (typeof c.expires === 'number' && c.expires > 0) {
      entry.expires = c.expires
    }
    return entry
  })
}

/**
 * Rehydrate a captured KiroSession into an already-launched browser context:
 *   1. Inject cookies (context-level, so they apply to all domains).
 *   2. Navigate to app.kiro.dev so Web Storage APIs attach to the right origin.
 *   3. Restore localStorage and sessionStorage via page.evaluate.
 *   4. Fresh-navigate to /account/usage so the SPA boots with the injected
 *      auth state. `page.reload()` on camoufox has been observed to hang
 *      waiting for `domcontentloaded` on some builds; a full goto is both
 *      faster and lands us directly where Pro-check needs us.
 *
 * Returns the final URL after boot. Throws on navigation failure — callers
 * should treat that as a hydrate failure distinct from login failure.
 */
export async function hydrateKiroSession(
  page: Page,
  context: BrowserContext,
  session: KiroSession,
  log: LogCallback
): Promise<string> {
  const filtered = filterAuthCookies(session.cookies)
  if (filtered.length === 0) {
    throw new Error(
      `hydrate: no Kiro auth cookies (RefreshToken / kiro-visitor-id) in session for ${session.email}`
    )
  }
  const cookies = cookiesForContext({ ...session, cookies: filtered })
  log(
    `[hydrate] injecting ${cookies.length} Kiro auth cookies (filtered from ${session.cookies.length}) for ${session.email}`
  )
  await context.addCookies(cookies)

  // Seed the origin so window.localStorage / window.sessionStorage are writable.
  // Use `commit` so we don't block on the SPA's long-running fetches — cookies
  // plus the origin landing page is all we need to then write storage.
  try {
    await page.goto(`${KIRO_ORIGIN}/`, { waitUntil: 'commit', timeout: 45000 })
  } catch (e) {
    throw new Error(
      `hydrate: initial navigation to ${KIRO_ORIGIN} failed: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  const ls = session.localStorage ?? {}
  const ss = session.sessionStorage ?? {}
  if (Object.keys(ls).length > 0 || Object.keys(ss).length > 0) {
    try {
      await page.evaluate(
        ({ ls, ss }) => {
          try {
            for (const [k, v] of Object.entries(ls)) {
              try {
                window.localStorage.setItem(k, v as string)
              } catch {}
            }
          } catch {}
          try {
            for (const [k, v] of Object.entries(ss)) {
              try {
                window.sessionStorage.setItem(k, v as string)
              } catch {}
            }
          } catch {}
        },
        { ls, ss }
      )
      log(
        `[hydrate] seeded ${Object.keys(ls).length} localStorage + ${
          Object.keys(ss).length
        } sessionStorage keys`
      )
    } catch (e) {
      // A hard seed failure isn't fatal — cookies alone are often enough to
      // auth. Log and continue to the fresh nav.
      log(
        `[hydrate] WARN: storage seed failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
  }

  // Fresh goto to /account/usage so the SPA boots with the injected auth
  // state. This replaces an earlier `page.reload()` which hung on camoufox.
  try {
    await page.goto(KIRO_BOOT_URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
  } catch (e) {
    log(
      `[hydrate] /account/usage goto failed (${
        e instanceof Error ? e.message : String(e)
      }) — retrying with 'commit'`
    )
    await page.goto(KIRO_BOOT_URL, { waitUntil: 'commit', timeout: 30000 })
  }

  // Give the SPA a brief moment to render its first paint — Pro detection
  // uses its own deadline polling on top of this, so keep it short.
  await page.waitForTimeout(600)

  return page.url()
}
