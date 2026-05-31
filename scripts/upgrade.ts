import { mkdir, writeFile, readFile, readdir, stat, rename } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import { execSync } from 'node:child_process'
import { VccPool } from '../lib/vcc'
import { loadKiroSession } from '../lib/session-hydrate'
import { upgradeKiroAccount, type UpgradeResult } from '../lib/upgrade'
import { loadGSuiteAccounts } from '../lib/accounts'
import type { BrowserEngine } from '../lib/browser'
import type { KiroSession } from '../lib/google-login'

if (process.platform === 'win32') {
  try {
    const stdout = execSync('chcp', { encoding: 'utf8' })
    if (!stdout.includes('65001')) {
      execSync('chcp 65001 >nul 2>&1')
    }
  } catch {}
}

process.stdin.setEncoding?.('utf8')
process.stdout.setDefaultEncoding?.('utf8')
process.stderr.setDefaultEncoding?.('utf8')

type On3ds = 'auto_flip' | 'pause' | 'fail'
type AuthMode = 'hydrate' | 'google_login' | 'hydrate_or_login'

type CliOptions = {
  count: number
  concurrency: number
  delayMs: number
  proxyUrl?: string
  headless: boolean
  useFingerprint: boolean
  engine: BrowserEngine
  humanize: boolean
  geoip: boolean
  on3ds: On3ds
  authMode: AuthMode
  maxVccAttempts: number
  threeDsManualTimeoutMs: number
  resultsPath: string
  stateFilePath: string
  sessionsDir: string
  /** Optional: restrict to one session file. Overrides `sessionsDir` scan. */
  sessionFile?: string
  /** Optional: comma-separated emails to include (after dir scan). */
  onlyEmails?: string[]
  vccPath: string
  vccStatePath: string
  /** GSuite accounts file — supplies Google password for fresh login. */
  accountsPath: string
}

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  magenta: '\x1b[35m'
}

function print(text: string): void {
  process.stdout.write(text + '\n')
}

function log(color: keyof typeof COLORS, text: string): void {
  process.stdout.write(COLORS[color] + text + COLORS.reset + '\n')
}

function toInt(value: string | undefined, fallback: number) {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) ? n : fallback
}

function parseArgs(argv: string[]): Partial<CliOptions> {
  const get = (name: string) => {
    const idx = argv.indexOf(name)
    if (idx === -1) return undefined
    return argv[idx + 1]
  }
  const has = (name: string) => argv.includes(name)

  const result: Partial<CliOptions> = {}

  if (has('--count') || has('-n')) {
    result.count = toInt(get('--count') ?? get('-n'), 1)
  }
  if (has('--concurrency') || has('-c')) {
    result.concurrency = toInt(get('--concurrency') ?? get('-c'), 1)
  }
  if (has('--delayMs') || has('--delay') || has('-d')) {
    result.delayMs = toInt(get('--delayMs') ?? get('--delay') ?? get('-d'), 0)
  }
  if (has('--proxyUrl') || has('--proxy')) {
    result.proxyUrl = get('--proxyUrl') ?? get('--proxy')
  }
  if (has('--results')) result.resultsPath = get('--results')
  if (has('--state-file')) result.stateFilePath = get('--state-file')
  if (has('--sessionsDir')) result.sessionsDir = get('--sessionsDir')
  if (has('--session-file')) result.sessionFile = get('--session-file')
  if (has('--only')) {
    const raw = get('--only') ?? ''
    result.onlyEmails = raw.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  }
  if (has('--vcc')) result.vccPath = get('--vcc')
  if (has('--vcc-state')) result.vccStatePath = get('--vcc-state')
  if (has('--accounts')) result.accountsPath = get('--accounts')
  if (has('--auth-mode')) {
    const v = get('--auth-mode')
    if (v === 'hydrate' || v === 'google_login' || v === 'hydrate_or_login') {
      result.authMode = v
    }
  }
  if (has('--engine')) {
    const e = get('--engine')
    if (e === 'camoufox' || e === 'chromium-stealth' || e === 'chromium-vanilla') {
      result.engine = e
    }
  }
  if (has('--headed')) result.headless = false
  if (has('--headless')) result.headless = true
  if (has('--no-fingerprint')) result.useFingerprint = false
  if (has('--fingerprint')) result.useFingerprint = true
  if (has('--no-humanize')) result.humanize = false
  if (has('--humanize')) result.humanize = true
  if (has('--no-geoip')) result.geoip = false
  if (has('--geoip')) result.geoip = true
  if (has('--on3ds')) {
    const v = get('--on3ds')
    if (v === 'auto_flip' || v === 'pause' || v === 'fail') result.on3ds = v
  }
  if (has('--max-vcc-attempts')) {
    result.maxVccAttempts = toInt(get('--max-vcc-attempts'), 1)
  }
  if (has('--3ds-timeout-s')) {
    result.threeDsManualTimeoutMs = toInt(get('--3ds-timeout-s'), 300) * 1000
  }

  return result
}

async function fileExists(path: string) {
  try {
    await readFile(path, 'utf-8')
    return true
  } catch {
    return false
  }
}

async function runWithConcurrency<TItem>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, idx: number) => Promise<void>
) {
  let nextIdx = 0
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const idx = nextIdx++
      if (idx >= items.length) return
      await worker(items[idx], idx)
    }
  })
  await Promise.all(runners)
}

const DEFAULT_OPTIONS: CliOptions = {
  count: 1,
  concurrency: 1,
  delayMs: 0,
  proxyUrl: undefined,
  headless: true,
  useFingerprint: true,
  engine: 'camoufox',
  humanize: true,
  geoip: true,
  on3ds: 'auto_flip',
  authMode: 'hydrate_or_login',
  maxVccAttempts: 1,
  threeDsManualTimeoutMs: 5 * 60 * 1000,
  resultsPath: 'show/upgrade-results.json',
  stateFilePath: 'show/upgrade-state.json',
  sessionsDir: 'show/sessions',
  sessionFile: undefined,
  onlyEmails: undefined,
  vccPath: 'accounts/vcc.json',
  vccStatePath: 'accounts/vcc.state.json',
  accountsPath: 'accounts/gsuite.txt'
}

type SessionCandidate = {
  /** Path to the session JSON. May be undefined when running google_login-only mode. */
  path: string | null
  /** Captured Kiro session, or `undefined` when there's nothing to hydrate. */
  session: KiroSession | undefined
  /** Account email — derived from session when present, otherwise from gsuite.txt. */
  email: string
  /** Google password loaded from gsuite.txt. `undefined` if not in the accounts file. */
  password?: string
}

async function loadPasswordMap(
  accountsPath: string
): Promise<Record<string, string>> {
  const map: Record<string, string> = {}
  try {
    const accounts = await loadGSuiteAccounts(accountsPath)
    for (const a of accounts) {
      map[a.email.toLowerCase()] = a.password
    }
  } catch {
    // accounts file is optional — only required when authMode needs a password
  }
  return map
}

async function findSessionCandidates(opts: CliOptions): Promise<SessionCandidate[]> {
  const out: SessionCandidate[] = []
  const passwords = await loadPasswordMap(opts.accountsPath)

  if (opts.sessionFile) {
    const abs = resolve(opts.sessionFile)
    const s = await loadKiroSession(abs)
    out.push({
      path: abs,
      session: s,
      email: s.email,
      password: passwords[s.email.toLowerCase()]
    })
    return out
  }

  const dir = resolve(opts.sessionsDir)
  let entries: string[] = []
  try {
    entries = await readdir(dir)
  } catch {
    // No sessions dir — google_login mode can still run from gsuite.txt alone.
    if (opts.authMode === 'google_login') {
      const onlyEmailSet = opts.onlyEmails
        ? new Set(opts.onlyEmails.map((e) => e.toLowerCase()))
        : null
      for (const [emailLc, password] of Object.entries(passwords)) {
        if (onlyEmailSet && !onlyEmailSet.has(emailLc)) continue
        out.push({ path: null, session: undefined, email: emailLc, password })
      }
      out.sort((a, b) => a.email.localeCompare(b.email))
      return out
    }
    return []
  }

  // Pick the latest session per email — a failed run may have left a stale
  // JSON alongside the good one.
  const byEmail = new Map<string, { path: string; mtimeMs: number; session: KiroSession }>()
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const p = join(dir, name)
    try {
      const info = await stat(p)
      if (!info.isFile()) continue
      const session = await loadKiroSession(p)
      const existing = byEmail.get(session.email.toLowerCase())
      if (!existing || existing.mtimeMs < info.mtimeMs) {
        byEmail.set(session.email.toLowerCase(), {
          path: p,
          mtimeMs: info.mtimeMs,
          session
        })
      }
    } catch {
      // skip malformed JSONs silently
    }
  }

  const onlyEmailSet = opts.onlyEmails
    ? new Set(opts.onlyEmails.map((e) => e.toLowerCase()))
    : null

  for (const [emailLc, v] of byEmail.entries()) {
    if (onlyEmailSet && !onlyEmailSet.has(emailLc)) continue
    out.push({
      path: v.path,
      session: v.session,
      email: v.session.email,
      password: passwords[emailLc]
    })
  }

  // Pure google_login mode also pulls in accounts that don't have a session
  // file yet (so users can run upgrades against fresh accounts without going
  // through register first).
  if (opts.authMode === 'google_login') {
    for (const [emailLc, password] of Object.entries(passwords)) {
      if (onlyEmailSet && !onlyEmailSet.has(emailLc)) continue
      if (byEmail.has(emailLc)) continue
      out.push({ path: null, session: undefined, email: emailLc, password })
    }
  }
  out.sort((a, b) => a.email.localeCompare(b.email))
  return out
}

type UpgradeState = {
  done: Record<
    string,
    {
      status: 'success' | 'already_pro' | 'failed'
      reason?: string
      at: number
      sessionFile?: string
      vccLast4?: string
      finalSignal?: string
    }
  >
}

async function loadUpgradeState(path: string): Promise<UpgradeState> {
  if (!(await fileExists(path))) return { done: {} }
  try {
    const raw = await readFile(path, 'utf-8')
    const parsed = JSON.parse(raw) as UpgradeState
    return { done: parsed.done ?? {} }
  } catch {
    return { done: {} }
  }
}

async function saveUpgradeState(path: string, state: UpgradeState): Promise<void> {
  const abs = resolve(path)
  await mkdir(resolve(path, '..'), { recursive: true })
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
  // Windows rename across drives can fail; guard with write+unlink fallback.
  try {
    await rename(tmp, abs)
  } catch {
    await writeFile(abs, JSON.stringify(state, null, 2), 'utf-8')
  }
}

type RunRecord = {
  email: string
  sessionFile: string
  success: boolean
  error?: string
  reason?: string
  step?: string
  vccLast4?: string
  attempts?: number
  finalSignal?: string
  at: number
}

async function runUpgrade(opts: CliOptions): Promise<{ ok: number; fail: number; skipped: number }> {
  const resultsAbs = resolve(opts.resultsPath)
  await mkdir(resolve(opts.resultsPath, '..'), { recursive: true })

  // Sessions.
  const candidates = await findSessionCandidates(opts)
  if (candidates.length === 0) {
    log(
      'red',
      `No session JSONs found${opts.sessionFile ? ` at ${resolve(opts.sessionFile)}` : ` in ${resolve(opts.sessionsDir)}`}`
    )
    return { ok: 0, fail: 0, skipped: 0 }
  }

  // VCC pool.
  const vccPool = await VccPool.open(opts.vccPath, opts.vccStatePath, (m) =>
    process.stdout.write(`[vcc] ${m}\n`)
  )
  if (vccPool.availableCount() === 0) {
    log('red', `No unused VCCs in ${resolve(opts.vccPath)}`)
    log(
      'dim',
      `   total: ${vccPool.totalCount()} | success: ${vccPool.successCount()} | used: ${vccPool.failedCount()}`
    )
    return { ok: 0, fail: 0, skipped: 0 }
  }

  // Upgrade state — skip accounts already upgraded.
  const upgradeState = await loadUpgradeState(opts.stateFilePath)

  // Filter out already-done unless user bounded the set via --only / --session-file.
  const pickable = candidates.filter((c) => {
    const done = upgradeState.done[c.email.toLowerCase()]
    if (!done) return true
    if (opts.sessionFile) return true
    if (opts.onlyEmails?.length) return true
    if (done.status === 'success' || done.status === 'already_pro') {
      return false
    }
    return true // retry previously-failed
  })

  if (pickable.length === 0) {
    log(
      'yellow',
      `All ${candidates.length} session(s) already upgraded — delete ${resolve(
        opts.stateFilePath
      )} to replay`
    )
    return { ok: 0, fail: 0, skipped: candidates.length }
  }

  const effectiveCount = Math.min(opts.count, pickable.length)
  if (effectiveCount < opts.count) {
    log(
      'yellow',
      `Requested ${opts.count} but only ${pickable.length} eligible — running ${effectiveCount}`
    )
  }

  if (opts.proxyUrl) {
    process.env.HTTP_PROXY = opts.proxyUrl
    process.env.HTTPS_PROXY = opts.proxyUrl
    process.env.http_proxy = opts.proxyUrl
    process.env.https_proxy = opts.proxyUrl
  }

  const slice = pickable.slice(0, effectiveCount)
  const records: RunRecord[] = new Array(slice.length)
  const startedAt = Date.now()

  await runWithConcurrency(slice, opts.concurrency, async (candidate, idx) => {
    if (opts.delayMs > 0 && idx > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs))
    }
    const taskNum = idx + 1
    const taskLog = (m: string) => process.stdout.write(`[#${taskNum} ${candidate.email}] ${m}\n`)

    // Validate that we have something usable for this candidate before launching.
    const needPassword =
      opts.authMode === 'google_login' ||
      (opts.authMode === 'hydrate_or_login' && !candidate.session)
    if (needPassword && !candidate.password) {
      const msg = `no Google password in ${resolve(opts.accountsPath)} for ${candidate.email}`
      records[idx] = {
        email: candidate.email,
        sessionFile: candidate.path ?? '(none)',
        success: false,
        error: msg,
        reason: 'no_auth_available',
        step: 'auth',
        at: Date.now()
      }
      taskLog(`SKIP: ${msg}`)
      return
    }
    if (opts.authMode === 'hydrate' && !candidate.session) {
      const msg = `no session JSON for ${candidate.email} (authMode=hydrate)`
      records[idx] = {
        email: candidate.email,
        sessionFile: '(none)',
        success: false,
        error: msg,
        reason: 'no_auth_available',
        step: 'auth',
        at: Date.now()
      }
      taskLog(`SKIP: ${msg}`)
      return
    }

    let result: UpgradeResult
    try {
      result = await upgradeKiroAccount({
        session: candidate.session,
        email: candidate.email,
        password: candidate.password,
        authMode: opts.authMode,
        vccPool,
        log: taskLog,
        engine: opts.engine,
        headless: opts.headless,
        proxyUrl: opts.proxyUrl,
        useFingerprint: opts.useFingerprint,
        humanize: opts.humanize,
        geoip: opts.geoip,
        maxVccAttempts: opts.maxVccAttempts,
        on3ds: opts.on3ds,
        threeDsManualTimeoutMs: opts.threeDsManualTimeoutMs
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      records[idx] = {
        email: candidate.email,
        sessionFile: candidate.path ?? '(none)',
        success: false,
        error: msg,
        reason: 'fatal',
        step: 'launch',
        at: Date.now()
      }
      taskLog(`FATAL: ${msg}`)
      return
    }

    if (result.success) {
      const rec: RunRecord = {
        email: result.email,
        sessionFile: candidate.path ?? '(none)',
        success: true,
        vccLast4: result.usedVcc.last4,
        attempts: result.attempts.length,
        finalSignal: result.finalProStatus.signal,
        at: Date.now()
      }
      records[idx] = rec
      upgradeState.done[result.email.toLowerCase()] = {
        status: rec.vccLast4 === '----' ? 'already_pro' : 'success',
        sessionFile: candidate.path ?? '(none)',
        vccLast4: rec.vccLast4,
        finalSignal: rec.finalSignal,
        at: rec.at
      }
      await saveUpgradeState(opts.stateFilePath, upgradeState)
      taskLog(
        rec.vccLast4 === '----'
          ? `OK (already Pro)`
          : `OK upgraded via VCC ****${rec.vccLast4} (signal=${rec.finalSignal})`
      )
    } else {
      records[idx] = {
        email: result.email,
        sessionFile: candidate.path ?? '(none)',
        success: false,
        error: result.error,
        reason: result.reason,
        step: result.step,
        vccLast4: result.usedVcc?.last4,
        attempts: result.attempts.length,
        finalSignal: result.finalProStatus?.signal,
        at: Date.now()
      }
      upgradeState.done[result.email.toLowerCase()] = {
        status: 'failed',
        reason: result.reason,
        sessionFile: candidate.path ?? '(none)',
        vccLast4: result.usedVcc?.last4,
        finalSignal: result.finalProStatus?.signal,
        at: records[idx].at
      }
      await saveUpgradeState(opts.stateFilePath, upgradeState)
      taskLog(`FAILED at ${result.step}: ${result.reason} — ${result.error}`)
    }
  })

  const ok = records.filter((r) => r?.success).length
  const fail = records.filter((r) => r && !r.success).length
  const elapsed = Math.round((Date.now() - startedAt) / 1000)

  print('')
  if (ok > 0 && fail === 0) {
    log('green', `${ok}/${slice.length} accounts upgraded in ${elapsed}s`)
  } else if (ok > 0) {
    log('yellow', `${ok} OK, ${fail} failed in ${elapsed}s`)
  } else {
    log('red', `all ${slice.length} attempts failed in ${elapsed}s`)
  }

  // Merge with existing results file.
  let existing: RunRecord[] = []
  if (await fileExists(resultsAbs)) {
    try {
      const raw = await readFile(resultsAbs, 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) existing = parsed as RunRecord[]
    } catch {
      existing = []
    }
  }
  const merged = existing.concat(records.filter(Boolean))
  await writeFile(resultsAbs, JSON.stringify(merged, null, 2), 'utf-8')
  log('green', `results: ${resultsAbs}`)
  log('green', `state:   ${resolve(opts.stateFilePath)}`)

  return { ok, fail, skipped: candidates.length - slice.length }
}

async function interactiveMode(initialOptions: Partial<CliOptions>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let rlClosed = false
  rl.on('close', () => {
    rlClosed = true
  })

  // Wrap rl.question so a closed/dying readline surfaces as a typed Error we
  // can catch in the main loop instead of an unhandled ERR_USE_AFTER_CLOSE.
  const question = (prompt: string): Promise<string> =>
    new Promise((resolve, reject) => {
      if (rlClosed) {
        reject(new Error('readline_closed'))
        return
      }
      const onClose = () => {
        reject(new Error('readline_closed'))
      }
      rl.once('close', onClose)
      try {
        rl.question(prompt, (answer) => {
          rl.removeListener('close', onClose)
          resolve(answer)
        })
      } catch (e) {
        rl.removeListener('close', onClose)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  const qd = async (prompt: string, def: string): Promise<string> => {
    const a = await question(`${prompt} [${def}]: `)
    return a.trim() || def
  }

  let currentOptions: CliOptions = { ...DEFAULT_OPTIONS, ...initialOptions }
  let running = true

  const banner = () => {
    print('')
    log('bright', '╔════════════════════════════════════════════════╗')
    log('bright', '║  Kiro Auto — Upgrade to Pro via Stripe         ║')
    log('bright', '║  session → kiro.dev → Stripe checkout → Pro    ║')
    log('bright', '╚════════════════════════════════════════════════╝')
  }

  const menu = async () => {
    banner()

    // Session discovery.
    let sessionStats = '(not scanned)'
    try {
      const cands = await findSessionCandidates(currentOptions)
      const state = await loadUpgradeState(currentOptions.stateFilePath)
      const done = cands.filter((c) => {
        const s = state.done[c.email.toLowerCase()]
        return s && (s.status === 'success' || s.status === 'already_pro')
      }).length
      sessionStats = `${cands.length - done}/${cands.length} pending`
    } catch (e) {
      sessionStats = `(error: ${e instanceof Error ? e.message : String(e)})`
    }

    // VCC stats.
    let vccStats = '(not loaded)'
    try {
      const pool = await VccPool.open(currentOptions.vccPath, currentOptions.vccStatePath)
      vccStats = `${pool.availableCount()}/${pool.totalCount()} unused · ok:${pool.successCount()} used:${pool.failedCount()}`
    } catch (e) {
      vccStats = `(error: ${e instanceof Error ? e.message : String(e)})`
    }

    print('')
    log('dim', '┌─ Config ─────────────────────────────────────────')
    log('dim', `│ sessionsDir: ${resolve(currentOptions.sessionsDir)} (${sessionStats})`)
    log('dim', `│ vcc: ${resolve(currentOptions.vccPath)} (${vccStats})`)
    log(
      'dim',
      `│ count: ${currentOptions.count}  concurrency: ${currentOptions.concurrency}  delay: ${currentOptions.delayMs}ms`
    )
    log(
      'dim',
      `│ engine: ${currentOptions.engine}  headless: ${currentOptions.headless}  humanize: ${currentOptions.humanize}  geoip: ${currentOptions.geoip}`
    )
    log(
      'dim',
      `│ on3ds: ${currentOptions.on3ds}  maxVccAttempts: ${currentOptions.maxVccAttempts}  3dsTimeout: ${Math.round(
        currentOptions.threeDsManualTimeoutMs / 1000
      )}s`
    )
    log('dim', `│ authMode: ${currentOptions.authMode}  accounts: ${resolve(currentOptions.accountsPath)}`)
    log('dim', `│ proxy: ${currentOptions.proxyUrl ?? '(none)'}`)
    log('dim', '└──────────────────────────────────────────────────')
    print('')
    log('cyan', '[1] Start upgrades')
    log('cyan', '[2] Set count')
    log('cyan', '[3] Set concurrency')
    log('cyan', '[4] Set delay (ms)')
    log('cyan', '[5] Toggle headless')
    log('cyan', '[6] Switch engine (camoufox → chromium-stealth → chromium-vanilla)')
    log('cyan', '[7] Set proxy')
    log('cyan', '[8] Set sessions dir')
    log('cyan', '[9] Set VCC file')
    log('cyan', '[a] Toggle geoip (camoufox)')
    log('cyan', '[b] Cycle on3ds (auto_flip → pause → fail)')
    log('cyan', '[c] Set max VCC attempts')
    log('cyan', '[d] Set 3DS manual timeout (s)')
    log('cyan', '[f] Toggle chromium fingerprint injection')
    log('cyan', '[h] Toggle humanize (camoufox)')
    log('cyan', '[m] Cycle authMode (hydrate_or_login → google_login → hydrate)')
    log('cyan', '[g] Set GSuite accounts file')
    log('cyan', '[0] Quit')
    print('')
  }

  await menu()
  while (running) {
    if (rlClosed) {
      running = false
      break
    }
    let cmd: string
    try {
      cmd = (await question(COLORS.green + '> ' + COLORS.reset)).trim().toLowerCase()
    } catch (e) {
      // readline was closed (Ctrl+D / EOF on piped stdin / SIGINT) — treat as quit.
      if (e instanceof Error && e.message === 'readline_closed') {
        running = false
        print('')
        log('green', 'bye')
        break
      }
      throw e
    }
    try {
      switch (cmd) {
      case '1':
        print('')
        await runUpgrade(currentOptions)
        break
      case '2': {
        const v = toInt(await qd('count', String(currentOptions.count)), currentOptions.count)
        currentOptions.count = Math.max(1, v)
        break
      }
      case '3': {
        const v = toInt(
          await qd('concurrency', String(currentOptions.concurrency)),
          currentOptions.concurrency
        )
        currentOptions.concurrency = Math.max(1, v)
        break
      }
      case '4': {
        const v = toInt(await qd('delayMs', String(currentOptions.delayMs)), currentOptions.delayMs)
        currentOptions.delayMs = Math.max(0, v)
        break
      }
      case '5':
        currentOptions.headless = !currentOptions.headless
        break
      case '6':
        currentOptions.engine =
          currentOptions.engine === 'camoufox'
            ? 'chromium-stealth'
            : currentOptions.engine === 'chromium-stealth'
              ? 'chromium-vanilla'
              : 'camoufox'
        break
      case '7': {
        const a = await question(`proxy [${currentOptions.proxyUrl ?? ''}]: `)
        currentOptions.proxyUrl = a.trim() ? a.trim() : undefined
        break
      }
      case '8':
        currentOptions.sessionsDir = await qd('sessionsDir', currentOptions.sessionsDir)
        break
      case '9':
        currentOptions.vccPath = await qd('vcc file', currentOptions.vccPath)
        break
      case 'a':
        currentOptions.geoip = !currentOptions.geoip
        break
      case 'b':
        currentOptions.on3ds =
          currentOptions.on3ds === 'auto_flip'
            ? 'pause'
            : currentOptions.on3ds === 'pause'
              ? 'fail'
              : 'auto_flip'
        break
      case 'c': {
        const v = toInt(
          await qd('maxVccAttempts', String(currentOptions.maxVccAttempts)),
          currentOptions.maxVccAttempts
        )
        currentOptions.maxVccAttempts = Math.max(1, v)
        break
      }
      case 'd': {
        const v = toInt(
          await qd(
            '3DS manual timeout (s)',
            String(Math.round(currentOptions.threeDsManualTimeoutMs / 1000))
          ),
          Math.round(currentOptions.threeDsManualTimeoutMs / 1000)
        )
        currentOptions.threeDsManualTimeoutMs = Math.max(30, v) * 1000
        break
      }
      case 'f':
        currentOptions.useFingerprint = !currentOptions.useFingerprint
        break
      case 'h':
        currentOptions.humanize = !currentOptions.humanize
        break
      case 'm':
        currentOptions.authMode =
          currentOptions.authMode === 'hydrate_or_login'
            ? 'google_login'
            : currentOptions.authMode === 'google_login'
              ? 'hydrate'
              : 'hydrate_or_login'
        break
      case 'g':
        currentOptions.accountsPath = await qd('accounts file', currentOptions.accountsPath)
        break
      case '0':
      case 'q':
      case 'exit':
      case 'quit':
        running = false
        log('green', 'bye')
        break
      default:
        log('yellow', `unknown: ${cmd}`)
        break
    }
    } catch (e) {
      if (e instanceof Error && e.message === 'readline_closed') {
        running = false
        print('')
        log('green', 'bye')
        break
      }
      throw e
    }
    if (running) {
      print('')
      await menu()
    }
  }
  if (!rlClosed) rl.close()
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2))
  const hasCliArgs = Object.keys(cliArgs).length > 0
  const nonInteractive =
    process.argv.includes('--non-interactive') || process.argv.includes('-y')

  if (hasCliArgs && nonInteractive) {
    const opts: CliOptions = { ...DEFAULT_OPTIONS, ...cliArgs }
    const result = await runUpgrade(opts)
    process.exitCode = result.fail > 0 ? 1 : 0
  } else {
    await interactiveMode(cliArgs)
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exitCode = 1
})
