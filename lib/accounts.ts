import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type GSuiteAccount = {
  email: string
  password: string
  line: number
}

export type AccountState = {
  used: Record<string, { status: 'success' | 'failed'; reason?: string; at: number }>
}

type LogCallback = (message: string) => void

const DEFAULT_STATE: AccountState = { used: {} }

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf-8')
    return true
  } catch {
    return false
  }
}

function parseLine(raw: string, lineNo: number): GSuiteAccount | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return null
  const sepIdx = trimmed.indexOf(':')
  if (sepIdx === -1) return null
  const email = trimmed.slice(0, sepIdx).trim()
  const password = trimmed.slice(sepIdx + 1).trim()
  if (!email.includes('@') || !password) return null
  return { email, password, line: lineNo }
}

export async function loadGSuiteAccounts(
  accountsPath: string,
  log?: LogCallback
): Promise<GSuiteAccount[]> {
  const abs = resolve(accountsPath)
  if (!(await fileExists(abs))) {
    throw new Error(`Accounts file not found: ${abs}`)
  }
  const raw = await readFile(abs, 'utf-8')
  const lines = raw.split(/\r?\n/)
  const accounts: GSuiteAccount[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseLine(lines[i], i + 1)
    if (!parsed) continue
    const key = parsed.email.toLowerCase()
    if (seen.has(key)) {
      log?.(`⚠ Duplicate email at line ${parsed.line}: ${parsed.email} (skipped)`)
      continue
    }
    seen.add(key)
    accounts.push(parsed)
  }
  return accounts
}

export async function loadAccountState(statePath: string): Promise<AccountState> {
  const abs = resolve(statePath)
  if (!(await fileExists(abs))) return { ...DEFAULT_STATE, used: {} }
  try {
    const raw = await readFile(abs, 'utf-8')
    const parsed = JSON.parse(raw) as AccountState
    return { used: parsed.used ?? {} }
  } catch {
    return { ...DEFAULT_STATE, used: {} }
  }
}

async function writeStateAtomic(statePath: string, state: AccountState): Promise<void> {
  const abs = resolve(statePath)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
  await rename(tmp, abs)
}

type AccountClaim = {
  account: GSuiteAccount
  release: (result: { status: 'success' | 'failed'; reason?: string }) => Promise<void>
}

/**
 * In-process mutex so concurrent registration workers do not double-claim
 * an account. A file-level lock would be needed for multi-process safety —
 * out of scope here (single CLI invocation is the supported runtime).
 */
let claimMutex: Promise<void> = Promise.resolve()

async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const prev = claimMutex
  let release!: () => void
  claimMutex = new Promise<void>((r) => (release = r))
  try {
    await prev
    return await fn()
  } finally {
    release()
  }
}

export class AccountPool {
  private accounts: GSuiteAccount[]
  private state: AccountState
  private statePath: string
  private claimed: Set<string> = new Set()

  private constructor(accounts: GSuiteAccount[], state: AccountState, statePath: string) {
    this.accounts = accounts
    this.state = state
    this.statePath = statePath
  }

  static async open(accountsPath: string, statePath: string, log?: LogCallback): Promise<AccountPool> {
    const accounts = await loadGSuiteAccounts(accountsPath, log)
    const state = await loadAccountState(statePath)
    return new AccountPool(accounts, state, statePath)
  }

  availableCount(): number {
    return this.accounts.filter((a) => !this.isConsumed(a.email)).length
  }

  totalCount(): number {
    return this.accounts.length
  }

  successCount(): number {
    return Object.values(this.state.used).filter((v) => v.status === 'success').length
  }

  failedCount(): number {
    return Object.values(this.state.used).filter((v) => v.status === 'failed').length
  }

  private isConsumed(email: string): boolean {
    const key = email.toLowerCase()
    return key in this.state.used || this.claimed.has(key)
  }

  async claimNext(): Promise<AccountClaim | null> {
    return withMutex(async () => {
      const next = this.accounts.find((a) => !this.isConsumed(a.email))
      if (!next) return null
      const key = next.email.toLowerCase()
      this.claimed.add(key)

      const release = async (result: { status: 'success' | 'failed'; reason?: string }) => {
        await withMutex(async () => {
          this.claimed.delete(key)
          this.state.used[key] = {
            status: result.status,
            reason: result.reason,
            at: Date.now()
          }
          await writeStateAtomic(this.statePath, this.state)
        })
      }

      return { account: next, release }
    })
  }
}
