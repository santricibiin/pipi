import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import { execSync } from 'node:child_process'
import { registerKiroWithGoogle } from '../lib/register'
import { AccountPool } from '../lib/accounts'
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
  resultsPath: string
  sessionsDir: string
  accountsPath: string
  accountsStatePath: string
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
  if (has('--sessionsDir')) result.sessionsDir = get('--sessionsDir')
  if (has('--accounts')) result.accountsPath = get('--accounts')
  if (has('--accounts-state')) result.accountsStatePath = get('--accounts-state')
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
  resultsPath: 'show/results.json',
  sessionsDir: 'show/sessions',
  accountsPath: 'accounts/gsuite.txt',
  accountsStatePath: 'accounts/gsuite.state.json'
}

type RunRecord = {
  email: string
  success: boolean
  error?: string
  reason?: string
  sessionFile?: string
  cookieCount?: number
  capturedAt?: number
  // Extracted auth tokens (Cognito-issued). Populated on success.
  accessToken?: string
  idToken?: string
  refreshToken?: string
  cognitoUsername?: string
  cognitoClientId?: string
}

function safeEmailSlug(email: string): string {
  return email.replace(/[^a-zA-Z0-9._-]+/g, '_')
}

async function saveSession(sessionsDir: string, session: KiroSession): Promise<string> {
  const absDir = resolve(sessionsDir)
  await mkdir(absDir, { recursive: true })
  const fname = `${safeEmailSlug(session.email)}.${session.capturedAt}.json`
  const abs = join(absDir, fname)
  await writeFile(abs, JSON.stringify(session, null, 2), 'utf-8')
  return abs
}

async function runRegistration(opts: CliOptions): Promise<{ ok: number; fail: number }> {
  const resultsAbs = resolve(opts.resultsPath)
  await mkdir(resolve(opts.resultsPath, '..'), { recursive: true })
  await mkdir(resolve(opts.sessionsDir), { recursive: true })

  const pool = await AccountPool.open(opts.accountsPath, opts.accountsStatePath, (m) =>
    process.stdout.write(`[accounts] ${m}\n`)
  )

  const available = pool.availableCount()
  if (available === 0) {
    log('red', `No unused GSuite accounts in ${resolve(opts.accountsPath)}`)
    log(
      'dim',
      `   total: ${pool.totalCount()} | success: ${pool.successCount()} | failed: ${pool.failedCount()}`
    )
    return { ok: 0, fail: 0 }
  }

  const effectiveCount = Math.min(opts.count, available)
  if (effectiveCount < opts.count) {
    log(
      'yellow',
      `Requested ${opts.count} but only ${available} accounts unused — running ${effectiveCount}`
    )
  }

  const startedAt = Date.now()
  const records: RunRecord[] = new Array(effectiveCount)

  const tasks = Array.from({ length: effectiveCount }, (_, i) => i)

  if (opts.proxyUrl) {
    process.env.HTTP_PROXY = opts.proxyUrl
    process.env.HTTPS_PROXY = opts.proxyUrl
    process.env.http_proxy = opts.proxyUrl
    process.env.https_proxy = opts.proxyUrl
  }

  await runWithConcurrency(tasks, opts.concurrency, async (_, idx) => {
    if (opts.delayMs > 0 && idx > 0) {
      await new Promise((r) => setTimeout(r, opts.delayMs))
    }
    const taskNum = idx + 1
    const taskLog = (m: string) => process.stdout.write(`[#${taskNum}] ${m}\n`)

    const claim = await pool.claimNext()
    if (!claim) {
      records[idx] = { email: '(none)', success: false, error: 'No available account on claim' }
      return
    }
    const { account, release } = claim

    try {
      const result = await registerKiroWithGoogle({
        email: account.email,
        password: account.password,
        log: taskLog,
        proxyUrl: opts.proxyUrl,
        engine: opts.engine,
        headless: opts.headless,
        useFingerprint: opts.useFingerprint,
        humanize: opts.humanize,
        geoip: opts.geoip
      })

      if (!result.success) {
        records[idx] = {
          email: account.email,
          success: false,
          error: result.error,
          reason: result.reason as string | undefined
        }
        await release({ status: 'failed', reason: result.error })
        taskLog(`FAILED: ${result.error}`)
        return
      }

      const sessionFile = await saveSession(opts.sessionsDir, result.session)
      records[idx] = {
        email: result.email,
        success: true,
        sessionFile,
        cookieCount: result.session.cookies.length,
        capturedAt: result.session.capturedAt,
        accessToken: result.session.tokens.accessToken,
        idToken: result.session.tokens.idToken,
        refreshToken: result.session.tokens.refreshToken,
        cognitoUsername: result.session.tokens.cognitoUsername,
        cognitoClientId: result.session.tokens.cognitoClientId
      }
      await release({ status: 'success' })
      const tokenSummary = result.session.tokens.refreshToken
        ? `refreshToken=${result.session.tokens.refreshToken.substring(0, 24)}…`
        : 'no refreshToken found'
      taskLog(`OK: ${tokenSummary} | session → ${sessionFile}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      records[idx] = { email: account.email, success: false, error: msg }
      await release({ status: 'failed', reason: msg })
      taskLog(`ERROR: ${msg}`)
    }
  })

  const ok = records.filter((r) => r?.success).length
  const fail = records.filter((r) => r && !r.success).length
  const elapsed = Math.round((Date.now() - startedAt) / 1000)

  print('')
  if (ok > 0 && fail === 0) {
    log('green', `${ok}/${effectiveCount} accounts registered in ${elapsed}s`)
  } else if (ok > 0) {
    log('yellow', `${ok} OK, ${fail} failed in ${elapsed}s`)
  } else {
    log('red', `all ${effectiveCount} attempts failed in ${elapsed}s`)
  }

  // Merge with existing results file to preserve prior runs.
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
  log('green', `sessions: ${resolve(opts.sessionsDir)}`)

  return { ok, fail }
}

async function interactiveMode(initialOptions: Partial<CliOptions>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const question = (prompt: string): Promise<string> =>
    new Promise((r) => rl.question(prompt, r))
  const qd = async (prompt: string, def: string): Promise<string> => {
    const a = await question(`${prompt} [${def}]: `)
    return a.trim() || def
  }

  let currentOptions: CliOptions = { ...DEFAULT_OPTIONS, ...initialOptions }
  let running = true

  const banner = () => {
    print('')
    log('bright', '╔════════════════════════════════════════════════╗')
    log('bright', '║  Kiro Auto — Google OAuth registrar (v2)       ║')
    log('bright', '║  app.kiro.dev/signin · camoufox stealth        ║')
    log('bright', '╚════════════════════════════════════════════════╝')
  }

  const menu = async () => {
    banner()
    let available = 0
    let total = 0
    let failed = 0
    let succeeded = 0
    try {
      const pool = await AccountPool.open(currentOptions.accountsPath, currentOptions.accountsStatePath)
      available = pool.availableCount()
      total = pool.totalCount()
      failed = pool.failedCount()
      succeeded = pool.successCount()
    } catch {
      total = -1
    }

    print('')
    log('dim', '┌─ Config ─────────────────────────────────────────')
    log(
      'dim',
      `│ accounts: ${resolve(currentOptions.accountsPath)} ${
        total >= 0 ? `(${available}/${total} unused · ok:${succeeded} fail:${failed})` : '(not found)'
      }`
    )
    log('dim', `│ count: ${currentOptions.count}  concurrency: ${currentOptions.concurrency}  delay: ${currentOptions.delayMs}ms`)
    log(
      'dim',
      `│ engine: ${currentOptions.engine}  headless: ${currentOptions.headless}  humanize: ${currentOptions.humanize}  geoip: ${currentOptions.geoip}`
    )
    log('dim', `│ fingerprint (chromium): ${currentOptions.useFingerprint}`)
    log('dim', `│ proxy: ${currentOptions.proxyUrl ?? '(none)'}`)
    log('dim', `│ sessions: ${resolve(currentOptions.sessionsDir)}`)
    log('dim', '└──────────────────────────────────────────────────')
    print('')
    log('cyan', '[1] Start registration')
    log('cyan', '[2] Set count')
    log('cyan', '[3] Set concurrency')
    log('cyan', '[4] Set delay (ms)')
    log('cyan', '[5] Toggle headless')
    log('cyan', '[6] Switch engine (camoufox → chromium-stealth → chromium-vanilla)')
    log('cyan', '[7] Set proxy')
    log('cyan', '[8] Set accounts file')
    log('cyan', '[9] Toggle humanize (camoufox)')
    log('cyan', '[a] Toggle geoip (camoufox)')
    log('cyan', '[f] Toggle chromium fingerprint injection')
    log('cyan', '[0] Quit')
    print('')
  }

  await menu()
  while (running) {
    const cmd = (await question(COLORS.green + '> ' + COLORS.reset)).trim().toLowerCase()
    switch (cmd) {
      case '1':
        print('')
        await runRegistration(currentOptions)
        break
      case '2': {
        const v = toInt(await qd('count', String(currentOptions.count)), currentOptions.count)
        currentOptions.count = Math.max(1, v)
        break
      }
      case '3': {
        const v = toInt(await qd('concurrency', String(currentOptions.concurrency)), currentOptions.concurrency)
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
        currentOptions.accountsPath = await qd('accounts file', currentOptions.accountsPath)
        break
      case '9':
        currentOptions.humanize = !currentOptions.humanize
        break
      case 'a':
        currentOptions.geoip = !currentOptions.geoip
        break
      case 'f':
        currentOptions.useFingerprint = !currentOptions.useFingerprint
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
    if (running) {
      print('')
      await menu()
    }
  }
  rl.close()
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2))
  const hasCliArgs = Object.keys(cliArgs).length > 0
  const nonInteractive =
    process.argv.includes('--non-interactive') || process.argv.includes('-y')

  if (hasCliArgs && nonInteractive) {
    const opts: CliOptions = { ...DEFAULT_OPTIONS, ...cliArgs }
    const result = await runRegistration(opts)
    process.exitCode = result.fail > 0 ? 1 : 0
  } else {
    await interactiveMode(cliArgs)
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
  process.exitCode = 1
})
