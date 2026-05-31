import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export type VccBillingAddress = {
  /** Full cardholder name as printed on the card. */
  name: string
  /** ISO-3166 alpha-2 country code, e.g. "US", "ID", "GB". Must match a Stripe country <option value>. */
  country: string
  line1: string
  line2?: string
  city: string
  /** Administrative area / state / province. For ID this is the Indonesian
   *  province name exactly as Stripe's <option value> (e.g. "DKI Jakarta"). */
  state?: string
  postalCode: string
}

export type VccEntry = {
  /** Stable id. Derived if missing from last4+expiry+name hash. */
  id: string
  /** Raw PAN, digits only after normalization. */
  number: string
  /** 1..12. */
  expMonth: number
  /** 4-digit year. 2-digit inputs are expanded to 2000+nn. */
  expYear: number
  cvc: string
  billing: VccBillingAddress
  /** Optional label for UI / logs. */
  label?: string
  /** Optional preferred brand — informational only, Stripe detects its own. */
  brand?: 'visa' | 'mastercard' | 'amex' | 'jcb' | 'discover' | 'diners' | 'other'
}

export type VccState = {
  used: Record<
    string,
    {
      status: 'success' | 'declined' | 'invalid' | 'challenge' | 'failed'
      reason?: string
      at: number
      /** Email of the Kiro account we applied this VCC to. */
      usedBy?: string
    }
  >
}

type LogCallback = (message: string) => void

const DEFAULT_STATE: VccState = { used: {} }

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf-8')
    return true
  } catch {
    return false
  }
}

function stripDigits(v: string): string {
  return v.replace(/\D+/g, '')
}

export function luhnValid(pan: string): boolean {
  const s = stripDigits(pan)
  if (s.length < 12 || s.length > 19) return false
  let sum = 0
  let alt = false
  for (let i = s.length - 1; i >= 0; i--) {
    let n = s.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

export function detectBrand(pan: string): VccEntry['brand'] {
  const s = stripDigits(pan)
  if (/^4/.test(s)) return 'visa'
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(s)) return 'mastercard'
  if (/^3[47]/.test(s)) return 'amex'
  if (/^35(2[89]|[3-8]\d)/.test(s)) return 'jcb'
  if (/^(6011|65|64[4-9])/.test(s)) return 'discover'
  if (/^(36|30[0-5]|3095|38|39)/.test(s)) return 'diners'
  return 'other'
}

function normalizeExpiry(
  month: unknown,
  year: unknown,
  combined?: unknown
): { expMonth: number; expYear: number } {
  // Accept several shapes:
  //   { expMonth: 3, expYear: 2029 }
  //   { expMonth: "03", expYear: "29" }
  //   { expiry: "03/29" }  or  { expiry: "3/2029" }  or  { expiry: "0329" }
  let m: number | null = null
  let y: number | null = null

  if (combined != null && typeof combined === 'string' && combined.trim()) {
    const raw = combined.trim()
    const parts = raw.split(/[\/\-\s]+/)
    if (parts.length === 2) {
      m = Number.parseInt(parts[0], 10)
      y = Number.parseInt(parts[1], 10)
    } else {
      const digits = stripDigits(raw)
      if (digits.length === 4) {
        m = Number.parseInt(digits.slice(0, 2), 10)
        y = Number.parseInt(digits.slice(2), 10)
      } else if (digits.length === 6) {
        m = Number.parseInt(digits.slice(0, 2), 10)
        y = Number.parseInt(digits.slice(2), 10)
      }
    }
  }
  if (m == null && month != null) m = Number.parseInt(String(month), 10)
  if (y == null && year != null) y = Number.parseInt(String(year), 10)

  if (m == null || !Number.isFinite(m) || m < 1 || m > 12) {
    throw new Error(`invalid expMonth: ${month ?? combined}`)
  }
  if (y == null || !Number.isFinite(y)) {
    throw new Error(`invalid expYear: ${year ?? combined}`)
  }
  if (y < 100) y = 2000 + y
  if (y < 2000 || y > 2100) {
    throw new Error(`expYear out of range: ${y}`)
  }
  return { expMonth: m, expYear: y }
}

function deriveId(entry: {
  number: string
  expMonth: number
  expYear: number
  billing: { name: string }
}): string {
  const last4 = entry.number.slice(-4)
  const exp = `${String(entry.expMonth).padStart(2, '0')}${String(entry.expYear).slice(-2)}`
  const h = createHash('sha1')
    .update(`${entry.number}:${exp}:${entry.billing.name}`)
    .digest('hex')
    .slice(0, 10)
  return `${last4}-${exp}-${h}`
}

function asString(v: unknown, field: string): string {
  if (v == null) throw new Error(`missing ${field}`)
  const s = String(v).trim()
  if (!s) throw new Error(`missing ${field}`)
  return s
}

function optString(v: unknown): string | undefined {
  if (v == null) return undefined
  const s = String(v).trim()
  return s ? s : undefined
}

function normalizeEntry(raw: any, index: number): VccEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`entry #${index}: not an object`)
  }

  // Card number: accept `number`, `pan`, `card`, `cardNumber`.
  const panRaw = asString(
    raw.number ?? raw.pan ?? raw.card ?? raw.cardNumber,
    `entry #${index}: number`
  )
  const number = stripDigits(panRaw)
  if (!luhnValid(number)) {
    throw new Error(`entry #${index}: card number fails Luhn (last4=${number.slice(-4)})`)
  }

  // Expiry.
  const { expMonth, expYear } = normalizeExpiry(
    raw.expMonth ?? raw.exp_month ?? raw.month,
    raw.expYear ?? raw.exp_year ?? raw.year,
    raw.expiry ?? raw.exp
  )

  // CVC — keep leading zeros, digits only.
  const cvc = stripDigits(asString(raw.cvc ?? raw.cvv ?? raw.cvn, `entry #${index}: cvc`))
  if (cvc.length < 3 || cvc.length > 4) {
    throw new Error(`entry #${index}: cvc must be 3 or 4 digits`)
  }

  // Billing.
  const billingRaw = raw.billing ?? raw.billingAddress ?? raw.address ?? raw
  if (!billingRaw || typeof billingRaw !== 'object') {
    throw new Error(`entry #${index}: missing billing object`)
  }
  const name = asString(
    billingRaw.name ??
      billingRaw.cardholder ??
      billingRaw.cardholderName ??
      billingRaw.fullName ??
      raw.name ??
      raw.cardholder,
    `entry #${index}: billing.name`
  )
  const country = asString(
    billingRaw.country ?? billingRaw.countryCode ?? raw.country,
    `entry #${index}: billing.country`
  ).toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new Error(
      `entry #${index}: billing.country must be ISO-3166 alpha-2 (e.g. "US"), got "${country}"`
    )
  }
  const line1 = asString(
    billingRaw.line1 ?? billingRaw.address1 ?? billingRaw.addressLine1 ?? billingRaw.street,
    `entry #${index}: billing.line1`
  )
  const line2 = optString(billingRaw.line2 ?? billingRaw.address2 ?? billingRaw.addressLine2)
  const city = asString(
    billingRaw.city ?? billingRaw.locality ?? billingRaw.town,
    `entry #${index}: billing.city`
  )
  const state = optString(
    billingRaw.state ??
      billingRaw.province ??
      billingRaw.administrativeArea ??
      billingRaw.region
  )
  const postalCode = asString(
    billingRaw.postalCode ?? billingRaw.postal ?? billingRaw.zip ?? billingRaw.zipCode,
    `entry #${index}: billing.postalCode`
  )

  const billing: VccBillingAddress = {
    name,
    country,
    line1,
    city,
    postalCode
  }
  if (line2) billing.line2 = line2
  if (state) billing.state = state

  const base: Omit<VccEntry, 'id'> = {
    number,
    expMonth,
    expYear,
    cvc,
    billing
  }

  const label = optString(raw.label ?? raw.name)
  const brand = (raw.brand as VccEntry['brand']) ?? detectBrand(number)
  const id = optString(raw.id) ?? deriveId(base as any)

  const entry: VccEntry = { id, ...base, brand }
  if (label) entry.label = label
  return entry
}

export async function loadVccFile(
  path: string,
  log?: LogCallback
): Promise<VccEntry[]> {
  const abs = resolve(path)
  if (!(await fileExists(abs))) {
    throw new Error(`VCC file not found: ${abs}`)
  }
  const raw = await readFile(abs, 'utf-8')
  const parsed = parseTolerantJson(raw, abs, log)

  let list: any[]
  if (Array.isArray(parsed)) {
    list = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).cards)) {
    list = (parsed as any).cards
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as any).vccs)) {
    list = (parsed as any).vccs
  } else {
    throw new Error(
      `VCC file must be a JSON array or { cards: [...] } / { vccs: [...] } object: ${abs}`
    )
  }

  const entries: VccEntry[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < list.length; i++) {
    try {
      const entry = normalizeEntry(list[i], i + 1)
      if (seenIds.has(entry.id)) {
        log?.(`⚠ Duplicate VCC id at entry ${i + 1}: ${entry.id} (skipped)`)
        continue
      }
      seenIds.add(entry.id)
      entries.push(entry)
    } catch (e) {
      log?.(`⚠ ${e instanceof Error ? e.message : String(e)} — skipped`)
    }
  }
  return entries
}

/**
 * Parse a JSON file forgiving of three common hand-edit mistakes that strict
 * `JSON.parse` rejects:
 *
 *   1. Leading zeros on numbers — `"expMonth": 01` (very common because users
 *      write months / days zero-padded).
 *   2. Trailing commas at the end of objects / arrays.
 *   3. `//` line comments and `/* … *​/` block comments.
 *
 * Strict parse is attempted first so well-formed files keep their original
 * semantics. Only when strict parse fails does the sanitizer run, and even
 * then it's a single-pass character-aware rewrite that respects string
 * boundaries — values inside strings are never touched.
 */
function parseTolerantJson(raw: string, abs: string, log?: LogCallback): unknown {
  try {
    return JSON.parse(raw)
  } catch (strictErr) {
    const sanitized = sanitizeJsonish(raw)
    try {
      const parsed = JSON.parse(sanitized)
      log?.(
        `⚠ ${abs} had non-strict JSON (leading zeros / trailing commas / comments) — auto-fixed in memory; consider cleaning the file`
      )
      return parsed
    } catch (sanitizedErr) {
      const msg =
        sanitizedErr instanceof Error ? sanitizedErr.message : String(sanitizedErr)
      const orig = strictErr instanceof Error ? strictErr.message : String(strictErr)
      throw new Error(`VCC file is not valid JSON: ${abs} — ${orig} (after sanitize: ${msg})`)
    }
  }
}

/**
 * Character-aware JSON sanitizer. Walks the input once, tracking whether the
 * cursor is inside a string literal so transformations only apply to source
 * code outside of strings.
 *
 * Transformations:
 *   - strip `// …\n` line comments and `/* … *​/` block comments
 *   - drop leading zeros on numeric tokens   (`01` → `1`, `-007` → `-7`)
 *   - drop trailing commas before `]` and `}`
 *
 * Strings (both `"…"` and `'…'`) are passed through verbatim so user-supplied
 * card numbers like `"5154 6200 2253 7557"` are never modified. Backslash
 * escapes inside strings are honoured so a `\"` does not end the string early.
 */
function sanitizeJsonish(text: string): string {
  let out = ''
  let i = 0
  const n = text.length
  let inString = false
  let stringQuote = ''
  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]

    if (inString) {
      if (ch === '\\' && i + 1 < n) {
        out += ch + text[i + 1]
        i += 2
        continue
      }
      if (ch === stringQuote) {
        inString = false
      }
      out += ch
      i++
      continue
    }

    if (ch === '"' || ch === "'") {
      inString = true
      stringQuote = ch
      out += ch
      i++
      continue
    }

    // Line comment.
    if (ch === '/' && next === '/') {
      i += 2
      while (i < n && text[i] !== '\n') i++
      continue
    }

    // Block comment.
    if (ch === '/' && next === '*') {
      i += 2
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }

    // Trailing comma before `]` or `}`.
    if (ch === ',') {
      let k = i + 1
      while (k < n && /\s/.test(text[k])) k++
      if (k < n && (text[k] === ']' || text[k] === '}')) {
        // Skip the comma; whitespace stays so output formatting is preserved.
        i++
        continue
      }
      out += ch
      i++
      continue
    }

    // Numeric token: optional `-`, then digits, optional `.digits`, optional exponent.
    // Only treated as a number when at the start of a value position — we
    // detect that by requiring the previous non-whitespace char to be one of
    // `[ , :` (or BOF). This avoids accidentally rewriting numerics that are
    // somehow embedded mid-token (shouldn't happen in valid-ish JSON, but
    // belt-and-braces).
    if ((ch === '-' && /[0-9]/.test(next ?? '')) || /[0-9]/.test(ch)) {
      // Look back for value-position context.
      let p = out.length - 1
      while (p >= 0 && /\s/.test(out[p])) p--
      const prev = p >= 0 ? out[p] : ''
      if (prev === '' || prev === '[' || prev === ',' || prev === ':') {
        let j = i
        if (text[j] === '-') j++
        // Integer part.
        const intStart = j
        while (j < n && /[0-9]/.test(text[j])) j++
        let intPart = text.slice(intStart, j)
        // Strip leading zeros but keep a single zero if that's all there is.
        if (intPart.length > 1) intPart = intPart.replace(/^0+(?=\d)/, '')
        let token = (text[i] === '-' ? '-' : '') + intPart
        // Fractional part.
        if (text[j] === '.') {
          token += '.'
          j++
          const fracStart = j
          while (j < n && /[0-9]/.test(text[j])) j++
          token += text.slice(fracStart, j)
        }
        // Exponent.
        if (text[j] === 'e' || text[j] === 'E') {
          token += text[j]
          j++
          if (text[j] === '+' || text[j] === '-') {
            token += text[j]
            j++
          }
          const expStart = j
          while (j < n && /[0-9]/.test(text[j])) j++
          token += text.slice(expStart, j)
        }
        out += token
        i = j
        continue
      }
    }

    out += ch
    i++
  }
  return out
}

export async function loadVccState(statePath: string): Promise<VccState> {
  const abs = resolve(statePath)
  if (!(await fileExists(abs))) return { ...DEFAULT_STATE, used: {} }
  try {
    const raw = await readFile(abs, 'utf-8')
    const parsed = JSON.parse(raw) as VccState
    return { used: parsed.used ?? {} }
  } catch {
    return { ...DEFAULT_STATE, used: {} }
  }
}

async function writeStateAtomic(statePath: string, state: VccState): Promise<void> {
  const abs = resolve(statePath)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
  await rename(tmp, abs)
}

type VccClaim = {
  vcc: VccEntry
  release: (result: {
    status: VccState['used'][string]['status']
    reason?: string
    usedBy?: string
  }) => Promise<void>
  /** Revert the in-memory claim without persisting — use for retry-on-same-account. */
  abandon: () => Promise<void>
}

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

export class VccPool {
  private vccs: VccEntry[]
  private state: VccState
  private statePath: string
  private claimed: Set<string> = new Set()

  private constructor(vccs: VccEntry[], state: VccState, statePath: string) {
    this.vccs = vccs
    this.state = state
    this.statePath = statePath
  }

  static async open(
    vccPath: string,
    statePath: string,
    log?: LogCallback
  ): Promise<VccPool> {
    const vccs = await loadVccFile(vccPath, log)
    const state = await loadVccState(statePath)
    return new VccPool(vccs, state, statePath)
  }

  availableCount(): number {
    return this.vccs.filter((v) => !this.isConsumed(v.id)).length
  }

  totalCount(): number {
    return this.vccs.length
  }

  successCount(): number {
    return Object.values(this.state.used).filter((v) => v.status === 'success').length
  }

  failedCount(): number {
    return Object.values(this.state.used).filter(
      (v) => v.status !== 'success'
    ).length
  }

  private isConsumed(id: string): boolean {
    // `failed` status (e.g. challenge/3DS timeout) is terminal too — retry
    // requires the user to delete state. `declined` and `invalid` also block
    // reuse (same card won't succeed twice).
    return id in this.state.used || this.claimed.has(id)
  }

  async claimNext(): Promise<VccClaim | null> {
    return withMutex(async () => {
      const next = this.vccs.find((v) => !this.isConsumed(v.id))
      if (!next) return null
      this.claimed.add(next.id)

      const persist = async (result: {
        status: VccState['used'][string]['status']
        reason?: string
        usedBy?: string
      }) => {
        await withMutex(async () => {
          this.claimed.delete(next.id)
          this.state.used[next.id] = {
            status: result.status,
            reason: result.reason,
            usedBy: result.usedBy,
            at: Date.now()
          }
          await writeStateAtomic(this.statePath, this.state)
        })
      }

      const abandon = async () => {
        await withMutex(async () => {
          this.claimed.delete(next.id)
        })
      }

      return { vcc: next, release: persist, abandon }
    })
  }
}
