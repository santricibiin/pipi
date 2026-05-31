import { launchStealthBrowser, type BrowserEngine } from './browser'
import {
  registerViaKiroGoogle,
  captureKiroSession,
  type GoogleLoginResult,
  type KiroSession
} from './google-login'
import type { FingerprintProfile } from './fingerprint/types'

type LogCallback = (message: string) => void

export type RegisterKiroGoogleOptions = {
  email: string
  password: string
  log: LogCallback
  proxyUrl?: string
  engine?: BrowserEngine
  headless?: boolean
  useFingerprint?: boolean
  fingerprintProfile?: FingerprintProfile
  humanize?: boolean | number
  geoip?: string | boolean
}

export type RegisterKiroGoogleResult =
  | {
      success: true
      email: string
      password: string
      session: KiroSession
    }
  | {
      success: false
      email: string
      error: string
      reason?: GoogleLoginResult extends { success: false; reason: infer R } ? R : string
    }

export async function registerKiroWithGoogle(
  options: RegisterKiroGoogleOptions
): Promise<RegisterKiroGoogleResult> {
  const {
    email,
    password,
    log,
    proxyUrl,
    engine,
    headless = true,
    useFingerprint = true,
    fingerprintProfile,
    humanize = true,
    geoip = !!proxyUrl
  } = options

  log(`========== Kiro Google signin ==========`)
  log(`account: ${email}`)
  log(`engine: ${engine ?? 'camoufox'} | headless: ${headless} | proxy: ${proxyUrl ?? '(none)'}`)

  const session = await launchStealthBrowser({
    engine: engine ?? 'camoufox',
    headless,
    proxyUrl,
    useFingerprint,
    fingerprintProfile,
    humanize,
    geoip,
    log
  })

  try {
    const result = await registerViaKiroGoogle(session.page, session.context, email, password, log)
    if (!result.success) {
      return {
        success: false,
        email,
        error: `Google login failed: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`,
        reason: result.reason
      }
    }

    log(`[register] login OK (landed on ${new URL(result.finalUrl).host}), capturing session`)
    const captured = await captureKiroSession(session.page, session.context, email)
    log(
      `[register] captured ${captured.cookies.length} cookies, ` +
        `${Object.keys(captured.localStorage).length} localStorage keys`
    )

    return { success: true, email, password, session: captured }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`[register] fatal: ${msg}`)
    return { success: false, email, error: msg }
  } finally {
    await session.close()
  }
}
