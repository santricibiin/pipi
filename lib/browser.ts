import type { Browser, BrowserContext, Page, LaunchOptions } from 'playwright'
import { chromium as vanillaChromium } from 'playwright'
import { chromium as extraChromium } from 'playwright-extra'
import StealthPlugin from 'puppeteer-extra-plugin-stealth'
import { FingerprintGenerator } from './fingerprint/generator'
import { FingerprintInjector } from './fingerprint/injector'
import type { FingerprintProfile } from './fingerprint/types'

export type BrowserEngine = 'camoufox' | 'chromium-stealth' | 'chromium-vanilla'

export type StealthLaunchOptions = {
  engine?: BrowserEngine
  headless?: boolean
  proxyUrl?: string
  useFingerprint?: boolean
  fingerprintProfile?: FingerprintProfile
  viewport?: { width: number; height: number }
  /** Hint for camoufox geoip resolution. `true` resolves via outbound IP. */
  geoip?: string | boolean
  /** Humanize mouse movement (camoufox only). */
  humanize?: boolean | number
  /** Seed the context with a saved Playwright storageState (path or object). */
  storageState?: string | { cookies: any[]; origins: any[] }
  log?: (msg: string) => void
}

export type StealthSession = {
  engine: BrowserEngine
  browser: Browser
  context: BrowserContext
  page: Page
  profile?: FingerprintProfile
  close: () => Promise<void>
}

let stealthRegistered = false

function ensureStealthRegistered(log?: (msg: string) => void): void {
  if (stealthRegistered) return
  try {
    extraChromium.use(StealthPlugin())
    stealthRegistered = true
  } catch (e) {
    log?.(`[browser] stealth plugin registration failed: ${e}`)
  }
}

function parseProxyUrl(proxyUrl: string):
  | { server: string; username?: string; password?: string }
  | undefined {
  try {
    const u = new URL(proxyUrl)
    const entry: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`
    }
    if (u.username) entry.username = decodeURIComponent(u.username)
    if (u.password) entry.password = decodeURIComponent(u.password)
    return entry
  } catch {
    return { server: proxyUrl }
  }
}

function buildChromiumArgs(): string[] {
  return [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--disable-session-crashed-bubble',
    '--no-default-browser-check',
    '--no-first-run',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-background-networking',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-pings',
    '--incognito',
    '--lang=en-US'
  ]
}

async function applyHardenedInitScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false,
        configurable: true
      })
    } catch {}
    try {
      const anyNav = navigator as any
      if (anyNav.permissions?.query) {
        const origQuery = anyNav.permissions.query.bind(anyNav.permissions)
        anyNav.permissions.query = (params: any) => {
          if (params && params.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission } as any)
          }
          return origQuery(params)
        }
      }
    } catch {}
    try {
      if (!(window as any).chrome) {
        ;(window as any).chrome = { runtime: {} }
      }
    } catch {}
  })
}

async function launchChromium(
  engine: Exclude<BrowserEngine, 'camoufox'>,
  options: StealthLaunchOptions
): Promise<StealthSession> {
  const log = options.log ?? (() => {})
  const headless = options.headless ?? true

  let profile: FingerprintProfile | undefined = options.fingerprintProfile
  if (options.useFingerprint && !profile) {
    profile = new FingerprintGenerator().generate()
    log(`[browser:${engine}] generated fingerprint UA=${profile.navigator.userAgent}`)
  }

  const launchOpts: LaunchOptions = {
    headless,
    args: buildChromiumArgs(),
    proxy: options.proxyUrl ? parseProxyUrl(options.proxyUrl) : undefined,
    chromiumSandbox: false
  }

  const browser =
    engine === 'chromium-stealth'
      ? ((ensureStealthRegistered(log), (await extraChromium.launch(launchOpts)) as unknown as Browser))
      : await vanillaChromium.launch(launchOpts)

  const viewport = options.viewport ?? { width: 1400, height: 900 }
  const userAgent =
    profile?.navigator.userAgent ??
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

  const context = await browser.newContext({
    viewport,
    userAgent,
    locale: profile?.navigator.language ?? 'en-US',
    timezoneId: profile?.timezone.name ?? 'America/Los_Angeles',
    deviceScaleFactor: profile?.screen.devicePixelRatio ?? 1,
    acceptDownloads: false,
    javaScriptEnabled: true,
    bypassCSP: false,
    storageState: options.storageState as any,
    extraHTTPHeaders: {
      'Accept-Language': profile?.navigator.languages.join(',') ?? 'en-US,en;q=0.9'
    }
  })

  if (profile) {
    const injector = new FingerprintInjector()
    await context.addInitScript(injector.generateInjectionCode(profile))
  }
  await applyHardenedInitScripts(context)

  const page = await context.newPage()
  await page.setExtraHTTPHeaders({
    'Accept-Language': profile?.navigator.languages.join(',') ?? 'en-US,en;q=0.9'
  })

  const close = async (): Promise<void> => {
    try {
      await context.close()
    } catch {}
    try {
      await browser.close()
    } catch {}
  }

  return { engine, browser, context, page, profile, close }
}

async function launchCamoufox(options: StealthLaunchOptions): Promise<StealthSession> {
  const log = options.log ?? (() => {})
  const headless = options.headless ?? true

  // camoufox-js ships its own Firefox fork with C-level anti-fingerprint
  // patches. It accepts the same-ish launch options shape but uses
  // snake_case. It also downloads the browser on first use.
  const { Camoufox } = (await import('camoufox-js')) as typeof import('camoufox-js')

  const proxyOpt = options.proxyUrl ? parseProxyUrl(options.proxyUrl) : undefined

  // A normal desktop window size. We deliberately drive the *window* size and
  // let the page viewport follow it (viewport: null below) so the page renders
  // exactly like a real browser — no fixed-viewport scaling / zoom artifacts.
  const win = options.viewport ?? { width: 1280, height: 800 }

  const browser = (await Camoufox({
    headless,
    proxy: proxyOpt,
    // Lock to Windows. Mixing in 'macos' sometimes yields a retina fingerprint
    // (devicePixelRatio: 2), which makes everything render at 2x — the "zoomed
    // in" look. A single host-matching OS keeps DPR at 1 and is also more
    // consistent (less detectable) on a Windows machine.
    os: 'windows',
    humanize: options.humanize ?? true,
    geoip: options.geoip ?? (!!options.proxyUrl && true),
    block_webrtc: true,
    // Single fully-qualified locale only. camoufox-js's locale handler treats
    // a bare language code like 'en' as a *region* and calls fromRegion('en'),
    // which hits an un-awaited async load (this.root undefined) and throws
    // "Cannot read properties of undefined (reading 'territoryInfo')".
    // 'en-US' (length > 3) takes the normalizeLocale fast-path and never
    // touches that code.
    locale: 'en-US',
    window: [win.width, win.height],
    i_know_what_im_doing: true
  } as any)) as unknown as Browser

  // Camoufox generates a fresh fingerprint per launch — we do NOT layer the
  // Chromium-targeted injector on top (it would clash with Firefox internals
  // and expose inconsistencies). Use an incognito context for session isolation.
  const context = await browser.newContext({
    // viewport: null → the page uses the real window's inner size and resizes
    // with it, just like a normal browser. A fixed viewport here is what made
    // the content look zoomed.
    viewport: null,
    acceptDownloads: false,
    javaScriptEnabled: true,
    storageState: options.storageState as any
  })

  const page = await context.newPage()

  const close = async (): Promise<void> => {
    try {
      await context.close()
    } catch {}
    try {
      await browser.close()
    } catch {}
  }

  log(`[browser:camoufox] launched (headless=${headless})`)
  return { engine: 'camoufox', browser, context, page, close }
}

export async function launchStealthBrowser(
  options: StealthLaunchOptions = {}
): Promise<StealthSession> {
  const engine: BrowserEngine = options.engine ?? 'camoufox'
  if (engine === 'camoufox') return launchCamoufox(options)
  return launchChromium(engine, options)
}
