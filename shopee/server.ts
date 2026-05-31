/**
 * Simple local web UI for the Shopee order scraper.
 *
 * No extra dependencies — uses Node's built-in `http` module. Start it with:
 *
 *   npm run shopee:web
 *
 * Then open http://localhost:5173 in your browser. Click "Mulai Scrape",
 * watch the live log, and browse the resulting JSON files — no terminal needed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdir, readFile, stat, writeFile, unlink } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

import { establishShopeeSession } from './login'
import { scrapeOrders } from './scrape-orders'
import { scrapeOrdersApi, scrapeOrdersApiDirect } from './scrape-orders-api'
import { parseCookiesText, filterByDomain, serializeNetscape } from './cookie-parser'
import type { ShopeeLoginOptions } from './types'
import type { ScrapeOrdersOptions } from './order-types'

/** Shopee root domain — used to validate uploaded cookies. */
const SHOPEE_ROOT = 'shopee.co.id'
/** Where uploaded cookies are saved (the fallback the login flow reads). */
const COOKIES_PATH = resolve('cookies.txt')

const PORT = Number(process.env.PORT ?? 5173)
// Bind address. Default to localhost-only (safe). Set HOST=0.0.0.0 to expose on
// a VPS — but ONLY do that together with a WEB_TOKEN, since order data is PII.
const HOST = process.env.HOST ?? '127.0.0.1'
// Optional access token. When set, every request must carry it (?token=… on
// first load → stored in an HttpOnly cookie). When empty, the UI is open
// (fine for localhost, NOT for a public VPS).
const WEB_TOKEN = process.env.WEB_TOKEN ?? ''
const RESULT_DIR = resolve('result')

/** Constant-time string compare (avoids token timing leaks). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Read a cookie value from the request header. */
function getCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie
  if (!raw) return undefined
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim())
  }
  return undefined
}

/** Is this request authorized? (Always true when no WEB_TOKEN is configured.) */
function isAuthed(req: IncomingMessage, url: URL): boolean {
  if (!WEB_TOKEN) return true
  const q = url.searchParams.get('token')
  if (q && safeEqual(q, WEB_TOKEN)) return true
  const c = getCookie(req, 'sid')
  return !!c && safeEqual(c, WEB_TOKEN)
}

/** Only one scrape may run at a time. */
let running = false

/** Connected SSE clients (browsers watching the live log). */
const sseClients = new Set<ServerResponse>()

/** Push a log line to every connected browser AND the terminal. */
function broadcast(line: string): void {
  console.log(line)
  const payload = `data: ${JSON.stringify(line)}\n\n`
  for (const res of sseClients) res.write(payload)
}

/** Push a typed event (e.g. status changes) to every browser. */
function broadcastEvent(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) res.write(payload)
}

// ---------------------------------------------------------------------------
// Scrape orchestration
// ---------------------------------------------------------------------------

type ScrapeBody = {
  type?: string
  limit?: number
  maxPages?: number
  concurrency?: number
  show?: boolean
  blockResources?: boolean
  /** 'api' (fast, default) talks to Shopee's JSON API; 'browser' renders pages. */
  mode?: 'api' | 'browser'
}

async function runScrape(body: ScrapeBody): Promise<void> {
  if (running) {
    broadcast('[web] ⚠️  sebuah proses scrape sedang berjalan — tunggu sampai selesai')
    return
  }
  running = true
  broadcastEvent('status', { running: true })

  const mode: 'api' | 'browser' = body.mode === 'browser' ? 'browser' : 'api'
  const login: ShopeeLoginOptions = { headless: !body.show, log: broadcast }
  const scrape: ScrapeOrdersOptions = {
    orderType: body.type || 'completed',
    limit: Number(body.limit) || 0,
    maxPages: Number(body.maxPages) || 0,
    concurrency: Number(body.concurrency) || (mode === 'api' ? 8 : 4),
    blockResources: body.blockResources !== false,
    log: broadcast,
  }

  broadcast(
    `[web] ▶️  mulai scrape (${mode === 'api' ? 'API cepat' : 'browser'}) — type=${scrape.orderType} halaman=${scrape.maxPages || 'all'} limit=${scrape.limit || 'all'} concurrency=${scrape.concurrency} ${
      body.show ? '(window terlihat)' : '(headless)'
    }`
  )

  let session: Awaited<ReturnType<typeof establishShopeeSession>>['session'] | undefined
  try {
    // Fast path: API mode reuses saved cookies with NO browser launch (skips
    // the ~30-40s Camoufox startup). Fall back to a browser login only if the
    // saved session is expired or missing.
    if (mode === 'api' && !body.show) {
      try {
        const result = await scrapeOrdersApiDirect(scrape)
        broadcast(`[web] ✅ selesai — ${result.details.length} pesanan tersimpan`)
        broadcastEvent('done', { scraped: result.details.length })
        return
      } catch (e) {
        const authFailed = (e as { authFailed?: boolean }).authFailed
        const noSession = e instanceof Error && /no saved session/.test(e.message)
        if (!authFailed && !noSession) throw e
        broadcast('[web] ⚠️  sesi tersimpan kedaluwarsa — login ulang via browser...')
      }
    }

    const established = await establishShopeeSession(login)
    session = established.session
    if (!established.result.success) {
      broadcast('[web] ❌ gagal login — cookies/session ditolak. Export ulang cookies lalu coba lagi.')
      return
    }
    const result =
      mode === 'api'
        ? await scrapeOrdersApi(session.page, scrape)
        : await scrapeOrders(session.page, scrape)
    broadcast(`[web] ✅ selesai — ${result.details.length} pesanan tersimpan`)
    broadcastEvent('done', { scraped: result.details.length })
  } catch (e) {
    broadcast(`[web] 💥 error: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    if (session) await session.close().catch(() => {})
    running = false
    broadcastEvent('status', { running: false })
  }
}

// ---------------------------------------------------------------------------
// Result-file helpers
// ---------------------------------------------------------------------------

async function listResults(): Promise<Array<{ name: string; size: number; mtime: number }>> {
  let names: string[] = []
  try {
    names = await readdir(RESULT_DIR)
  } catch {
    return []
  }
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('_index'))
  const out = await Promise.all(
    files.map(async (name) => {
      const s = await stat(join(RESULT_DIR, name)).catch(() => null)
      return { name, size: s?.size ?? 0, mtime: s?.mtimeMs ?? 0 }
    })
  )
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Read one result file safely (no path traversal). */
async function readResult(name: string): Promise<string | null> {
  const safe = basename(name)
  if (!safe.endsWith('.json')) return null
  try {
    return await readFile(join(RESULT_DIR, safe), 'utf8')
  } catch {
    return null
  }
}

/**
 * Delete result files. With no `name`, clears EVERY .json in the result dir
 * (including `_index*` files). With a `name`, deletes just that one file.
 * Returns the number of files removed.
 */
async function clearResults(name?: string): Promise<number> {
  if (name) {
    const safe = basename(name)
    if (!safe.endsWith('.json')) return 0
    try {
      await unlink(join(RESULT_DIR, safe))
      return 1
    } catch {
      return 0
    }
  }
  let names: string[] = []
  try {
    names = await readdir(RESULT_DIR)
  } catch {
    return 0
  }
  const files = names.filter((n) => n.endsWith('.json'))
  let removed = 0
  await Promise.all(
    files.map(async (n) => {
      try {
        await unlink(join(RESULT_DIR, n))
        removed += 1
      } catch {
        // ignore
      }
    })
  )
  return removed
}

// ---------------------------------------------------------------------------
// Summary / accounting
// ---------------------------------------------------------------------------

/** Fixed order-processing fee (Biaya Proses Pesanan) — Rp1.250 per order. */
const PROCESSING_FEE_PER_ORDER = 1250

type Summary = {
  orderCount: number
  productCount: number
  /** Penghasilan kotor — Σ subtotal semua produk. */
  grossIncome: number
  /** Biaya administrasi — Σ |Biaya Administrasi|. */
  adminFee: number
  /** Biaya asuransi — Σ |Premi|. */
  insurance: number
  /** Biaya layanan — Σ |Biaya Layanan|. */
  serviceFee: number
  /** Biaya proses pesanan — Rp1.250 × jumlah pesanan. */
  processingFee: number
  /** Biaya Komisi AMS (afiliasi) — Σ |Komisi AMS|, kalau ada. */
  amsCommission: number
  /** Jumlah pesanan yang punya komponen Komisi AMS. */
  amsOrderCount: number
  /** Penghasilan bersih — Σ Total Penghasilan (dari file). */
  netIncome: number
  /** Agregasi produk (nama+variasi+SKU) dengan total qty di semua pesanan. */
  products: ProductAgg[]
}

/** Satu baris produk teragregasi untuk perhitungan modal/HPP. */
type ProductAgg = {
  /** Kunci unik: name|||variation|||code (dipakai juga untuk simpan HPP). */
  key: string
  /** Nama produk (dari `name`). */
  name: string
  /** Ukuran (bagian setelah koma di `variation`, mis. "XL (12-15 Tahun)"). */
  size: string
  /** Variasi/warna (bagian sebelum koma di `variation`, mis. "burgundy"). */
  color: string
  /** SKU (dari `code`). */
  sku: string
  /** Total qty di semua pesanan. */
  qty: number
}

type ResultShape = {
  products?: Array<{
    name?: string
    variation?: string
    code?: string
    subtotal?: string
    qty?: string
  }>
  paymentBreakdown?: Array<{ label?: string; amount?: string }>
  total?: { amount?: string }
}

/**
 * Parse an Indonesian rupiah string into an integer of rupiah.
 * Examples: "Rp256.000" → 256000, "-Rp33.920" → -33920, "256.000" → 256000.
 * (Dots are thousand separators; the minus sign is preserved.)
 */
function parseAmount(raw: string | undefined): number {
  if (!raw) return 0
  const negative = raw.includes('-')
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return 0
  const n = Number.parseInt(digits, 10)
  return negative ? -n : n
}

/**
 * Pecah string `variation` Shopee jadi { color, size }.
 * Contoh: "Variasi: burgundy,XL (12-15 Tahun)Kode Variasi: WAFAANAK-"
 *   → { color: "burgundy", size: "XL (12-15 Tahun)" }
 * Format: "Variasi: <warna>,<ukuran>Kode Variasi: <kode>".
 * Bila tidak ada koma, seluruh nilai dianggap sebagai warna.
 */
function parseVariation(raw: string | undefined): { color: string; size: string } {
  if (!raw) return { color: '', size: '' }
  // Buang label "Kode Variasi: ..." di belakang (kode SKU diambil dari `code`).
  let v = raw.replace(/Kode\s*Variasi\s*:.*$/i, '')
  // Buang prefix "Variasi:".
  v = v.replace(/^\s*Variasi\s*:\s*/i, '').trim()
  if (!v) return { color: '', size: '' }
  const comma = v.indexOf(',')
  if (comma === -1) return { color: v.trim(), size: '' }
  return {
    color: v.slice(0, comma).trim(),
    size: v.slice(comma + 1).trim(),
  }
}

/** Find a breakdown row by exact label and return its amount (absolute). */
function breakdownAbs(rows: ResultShape['paymentBreakdown'], label: string): number {
  if (!rows) return 0
  const row = rows.find((r) => (r.label ?? '').trim() === label)
  return row ? Math.abs(parseAmount(row.amount)) : 0
}

/**
 * Sum every breakdown row whose label matches a regex (absolute value).
 * Used for fees Shopee labels inconsistently — e.g. "Komisi AMS", "Biaya
 * Komisi AMS", "Komisi Program AMS". Returns the total and how many rows hit.
 */
function breakdownMatch(
  rows: ResultShape['paymentBreakdown'],
  pattern: RegExp
): { total: number; count: number } {
  if (!rows) return { total: 0, count: 0 }
  let total = 0
  let count = 0
  for (const r of rows) {
    if (pattern.test((r.label ?? '').trim())) {
      total += Math.abs(parseAmount(r.amount))
      count += 1
    }
  }
  return { total, count }
}

/** Matches Shopee's affiliate/AMS commission line however it's labelled. */
const AMS_LABEL = /komisi.*ams|ams.*komisi|biaya komisi ams|komisi affiliate|komisi afiliasi/i

/** Read every result file and roll up the accounting totals. */
async function computeSummary(): Promise<Summary> {
  const summary: Summary = {
    orderCount: 0,
    productCount: 0,
    grossIncome: 0,
    adminFee: 0,
    insurance: 0,
    serviceFee: 0,
    processingFee: 0,
    amsCommission: 0,
    amsOrderCount: 0,
    netIncome: 0,
    products: [],
  }

  let names: string[] = []
  try {
    names = await readdir(RESULT_DIR)
  } catch {
    return summary
  }
  const files = names.filter((n) => n.endsWith('.json') && !n.startsWith('_index'))

  // Agregasi produk unik (name|||variation|||code) → total qty.
  const agg = new Map<string, ProductAgg>()

  for (const name of files) {
    let data: ResultShape
    try {
      data = JSON.parse(await readFile(join(RESULT_DIR, name), 'utf8')) as ResultShape
    } catch {
      continue
    }
    summary.orderCount += 1
    for (const p of data.products ?? []) {
      summary.productCount += 1
      summary.grossIncome += parseAmount(p.subtotal)

      // Kelompokkan produk identik (nama + variasi + SKU sama).
      const pname = (p.name ?? '').trim()
      const variation = (p.variation ?? '').trim()
      const sku = (p.code ?? '').trim()
      const key = pname + '|||' + variation + '|||' + sku
      const qty = Number.parseInt((p.qty ?? '').replace(/[^0-9]/g, ''), 10) || 0
      const existing = agg.get(key)
      if (existing) {
        existing.qty += qty
      } else {
        const { color, size } = parseVariation(variation)
        agg.set(key, { key, name: pname, size, color, sku, qty })
      }
    }
    summary.adminFee += breakdownAbs(data.paymentBreakdown, 'Biaya Administrasi')
    summary.insurance += breakdownAbs(data.paymentBreakdown, 'Premi')
    summary.serviceFee += breakdownAbs(data.paymentBreakdown, 'Biaya Layanan')
    const ams = breakdownMatch(data.paymentBreakdown, AMS_LABEL)
    summary.amsCommission += ams.total
    if (ams.count > 0) summary.amsOrderCount += 1
    summary.netIncome += parseAmount(data.total?.amount)
  }
  summary.processingFee = summary.orderCount * PROCESSING_FEE_PER_ORDER
  // Urutkan produk dari qty terbanyak agar yang paling laku di atas.
  summary.products = [...agg.values()].sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name))
  return summary
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolveBody(data))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const path = url.pathname

  // --- access gate (only active when WEB_TOKEN is set) ---
  if (!isAuthed(req, url)) {
    if (req.method === 'GET' && path === '/') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<body style="font:16px system-ui;background:#0f1115;color:#e6e9ef;padding:40px">' +
          '<h2>🔒 Token diperlukan</h2><p>Buka dengan: <code>http://&lt;ip&gt;:' +
          PORT +
          '/?token=TOKEN_KAMU</code></p></body>'
      )
      return
    }
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return
  }

  // --- UI ---
  if (req.method === 'GET' && path === '/') {
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }
    // Valid token in the URL → remember it in an HttpOnly cookie so the
    // browser keeps access without the token in every link.
    if (WEB_TOKEN && url.searchParams.get('token')) {
      headers['set-cookie'] = `sid=${encodeURIComponent(WEB_TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`
    }
    res.writeHead(200, headers)
    res.end(PAGE_HTML)
    return
  }

  // --- live log stream (SSE) ---
  if (req.method === 'GET' && path === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    res.write(`event: status\ndata: ${JSON.stringify({ running })}\n\n`)
    res.write(`retry: 3000\n\n`)
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }

  // --- start a scrape ---
  if (req.method === 'POST' && path === '/api/scrape') {
    const raw = await readBody(req)
    let body: ScrapeBody = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      // ignore — use defaults
    }
    if (running) {
      sendJson(res, 409, { ok: false, error: 'sedang berjalan' })
      return
    }
    sendJson(res, 202, { ok: true })
    // Fire and forget — progress streams over SSE.
    void runScrape(body)
    return
  }

  // --- upload cookies (Netscape text OR browser JSON export) ---
  if (req.method === 'POST' && path === '/api/cookies') {
    const raw = await readBody(req)
    let content = ''
    // Accept either { cookies: "<text>" } JSON or a raw text/plain body.
    const ct = (req.headers['content-type'] ?? '').toLowerCase()
    if (ct.includes('application/json')) {
      try {
        const parsed = JSON.parse(raw) as { cookies?: string }
        content = typeof parsed.cookies === 'string' ? parsed.cookies : ''
      } catch {
        content = ''
      }
    } else {
      content = raw
    }
    content = content.trim()
    if (!content) {
      sendJson(res, 400, { ok: false, error: 'isi cookies kosong' })
      return
    }

    const all = parseCookiesText(content)
    const shopeeCookies = filterByDomain(all, SHOPEE_ROOT)
    if (shopeeCookies.length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: `tidak ada cookie *.${SHOPEE_ROOT} ditemukan (dari ${all.length} cookie). Pastikan export saat login di seller.shopee.co.id.`,
      })
      return
    }

    // Save ALL cookies (login flow filters by domain itself) so nothing is lost.
    try {
      await writeFile(COOKIES_PATH, serializeNetscape(all), 'utf8')
    } catch (e) {
      sendJson(res, 500, {
        ok: false,
        error: `gagal menyimpan cookies.txt: ${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }
    broadcast(
      `[web] 🍪 cookies tersimpan — ${shopeeCookies.length} cookie Shopee (dari ${all.length} total) → cookies.txt`
    )
    sendJson(res, 200, { ok: true, shopee: shopeeCookies.length, total: all.length })
    return
  }

  // --- list result files ---
  if (req.method === 'GET' && path === '/api/results') {
    sendJson(res, 200, { running, files: await listResults() })
    return
  }

  // --- accounting summary across all result files ---
  if (req.method === 'GET' && path === '/api/summary') {
    sendJson(res, 200, { ok: true, summary: await computeSummary() })
    return
  }

  // --- read one result file ---
  if (req.method === 'GET' && path === '/api/result') {
    const name = url.searchParams.get('name') ?? ''
    const content = await readResult(name)
    if (content == null) {
      sendJson(res, 404, { ok: false, error: 'tidak ditemukan' })
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(content)
    return
  }

  // --- clear result files (all, or one via ?name=) ---
  if (req.method === 'POST' && path === '/api/clear') {
    if (running) {
      sendJson(res, 409, { ok: false, error: 'tidak bisa hapus saat scrape berjalan' })
      return
    }
    const name = url.searchParams.get('name') ?? undefined
    const removed = await clearResults(name)
    broadcast(
      name
        ? `[web] 🗑️  hapus 1 file hasil: ${basename(name)}`
        : `[web] 🗑️  bersihkan semua hasil — ${removed} file dihapus`
    )
    sendJson(res, 200, { ok: true, removed })
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('Not found')
})

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '<ip-vps>' : HOST
  const tokenQs = WEB_TOKEN ? `/?token=${WEB_TOKEN}` : '/'
  console.log(`\n  Shopee Scraper UI  →  http://${shown}:${PORT}${tokenQs}\n`)
  if (HOST === '0.0.0.0' && !WEB_TOKEN) {
    console.log('  ⚠️  PERINGATAN: server terbuka ke publik TANPA token.')
    console.log('     Data pesanan berisi info pembeli (nama/alamat/HP).')
    console.log('     Set WEB_TOKEN dulu sebelum expose ke internet.\n')
  }
  console.log('  Tekan Ctrl+C di sini untuk berhenti.\n')
})

// ---------------------------------------------------------------------------
// Embedded UI (single-file, no build step)
// ---------------------------------------------------------------------------

const PAGE_HTML = /* html */ `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Shopee Order Scraper</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #f3f5fa; --surface: #ffffff; --surface-2: #f8fafd;
    --navy: #0b2545; --navy-2: #13315c; --blue: #2563eb; --blue-h: #1d4ed8;
    --blue-soft: #eef3ff; --ink: #14202f; --muted: #69748a; --border: #e6eaf3;
    --ok: #0f9d58; --warn: #b7791f; --err: #dc2626; --err-soft: #fdeceb;
    --shadow-sm: 0 1px 2px rgba(16,32,64,.05);
    --shadow: 0 2px 10px rgba(16,32,64,.05), 0 14px 30px rgba(16,32,64,.05);
    --radius: 16px; --radius-sm: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body { background: var(--bg); color: var(--ink);
    font-family: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.6; -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

  /* ---- Top bar ---- */
  .topbar { background: var(--navy); color: #fff; padding: 0 28px;
    height: 66px; display: flex; align-items: center; gap: 16px;
    box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, var(--shadow-sm);
    position: sticky; top: 0; z-index: 20; }
  .brand { display: flex; align-items: center; gap: 13px; }
  .brand .logo { width: 40px; height: 40px; border-radius: 12px; flex: none;
    background: linear-gradient(150deg, #2f6bff 0%, #1748c9 100%); display: grid; place-items: center;
    box-shadow: 0 6px 16px rgba(37,99,235,.4); }
  .brand .logo svg { width: 22px; height: 22px; color: #fff; }
  .brand h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: -.01em; }
  .brand p { margin: 1px 0 0; font-size: 12px; color: #9db0cc; font-weight: 500; }
  .topbar .status { display: flex; align-items: center; gap: 10px; margin-left: auto;
    font-size: 13px; font-weight: 600; color: #d7e2f3;
    background: rgba(255,255,255,.07); padding: 7px 14px; border-radius: 999px;
    border: 1px solid rgba(255,255,255,.09); }
  .topbar .dot { width: 8px; height: 8px; border-radius: 50%; background: #7c8aa3; transition: all .2s; }
  .topbar .dot.on { background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.22); }
  .topbar .timer { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 14px;
    color: #fff; padding-left: 10px; border-left: 1px solid rgba(255,255,255,.16); letter-spacing: .02em; }
  .topbar .timer.on { color: #fbd66b; }

  /* ---- Layout ---- */
  .wrap { max-width: 1300px; margin: 0 auto; padding: 26px 28px;
    display: grid; grid-template-columns: 348px 1fr; gap: 22px; align-items: start; }
  .col { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
  .card { background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
  .card > .head { display: flex; align-items: center; gap: 10px; padding: 16px 20px;
    border-bottom: 1px solid var(--border); }
  .card > .head .hicon { width: 18px; height: 18px; color: var(--blue); flex: none; }
  .card > .head h2 { font-size: 14px; letter-spacing: -.01em; color: var(--ink); margin: 0; font-weight: 700; }
  .card > .head .tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .card > .head .badge { font-size: 12px; color: var(--muted); font-weight: 600;
    background: var(--surface-2); border: 1px solid var(--border); padding: 3px 11px; border-radius: 999px; }
  .card > .body { padding: 20px; }

  label { display: block; font-size: 12.5px; color: var(--muted); margin: 16px 0 6px; font-weight: 600; }
  label:first-child { margin-top: 0; }
  input, select, textarea { width: 100%; padding: 10px 12px; background: #fff; color: var(--ink);
    border: 1px solid var(--border); border-radius: var(--radius-sm); font: inherit; font-size: 14px;
    transition: border-color .15s, box-shadow .15s; }
  input:hover, select:hover, textarea:hover { border-color: #cdd6e8; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--blue);
    box-shadow: 0 0 0 3px rgba(37,99,235,.13); }
  textarea { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; resize: vertical; }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; min-width: 0; }
  .check { display: flex; align-items: center; gap: 10px; margin-top: 15px; }
  .check input { width: auto; accent-color: var(--blue); }
  .check label { margin: 0; font-weight: 500; color: var(--ink); font-size: 14px; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    width: 100%; padding: 12px 14px; border: 1px solid transparent; border-radius: var(--radius-sm);
    font: inherit; font-size: 14px; font-weight: 700; cursor: pointer; letter-spacing: -.01em;
    transition: background .15s, border-color .15s, transform .04s, box-shadow .15s; }
  .btn svg { width: 17px; height: 17px; }
  .btn:active { transform: translateY(1px); }
  .btn-primary { background: var(--blue); color: #fff; margin-top: 20px;
    box-shadow: 0 6px 16px rgba(37,99,235,.28); }
  .btn-primary:hover { background: var(--blue-h); }
  .btn-ghost { background: var(--surface-2); color: var(--navy); border-color: var(--border); margin-top: 14px; }
  .btn-ghost:hover { background: var(--blue-soft); border-color: #cbd9f5; }
  .btn-danger { background: #fff; color: var(--err); border-color: #f1c7c5; }
  .btn-danger:hover { background: var(--err-soft); }
  .btn-sm { width: auto; padding: 7px 12px; font-size: 13px; font-weight: 600; }
  .btn:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
  .hint { font-size: 12.5px; color: var(--muted); margin: 0 0 12px; line-height: 1.55; }
  code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px;
    padding: 1px 6px; font-size: 12px; font-family: ui-monospace, Menlo, Consolas, monospace; }

  /* ---- Summary ---- */
  .hero { display: grid; grid-template-columns: 1.3fr 1fr; gap: 16px; }
  .hero .figure { border-radius: 14px; padding: 18px 20px; border: 1px solid var(--border); }
  .hero .figure .lbl { font-size: 12.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .hero .figure .amt { font-size: 30px; font-weight: 800; margin-top: 8px; letter-spacing: -.02em;
    font-variant-numeric: tabular-nums; line-height: 1.1; }
  .hero .figure .sub { font-size: 12px; margin-top: 7px; }
  .hero .net { background: linear-gradient(155deg, var(--navy) 0%, var(--navy-2) 100%); border-color: transparent; }
  .hero .net .lbl { color: #9fb4d4; } .hero .net .amt { color: #fff; } .hero .net .sub { color: #8aa0c2; }
  .hero .gross { background: var(--blue-soft); border-color: #d7e3fb; }
  .hero .gross .lbl { color: #4063b8; } .hero .gross .amt { color: var(--navy); }
  .hero .ic { width: 16px; height: 16px; }

  .breakdown { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-top: 16px; }
  .bd { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 15px; }
  .bd .lbl { font-size: 12px; color: var(--muted); font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .bd .lbl svg { width: 15px; height: 15px; color: var(--blue); }
  .bd .amt { font-size: 18px; font-weight: 700; margin-top: 7px; color: var(--ink);
    font-variant-numeric: tabular-nums; letter-spacing: -.01em; }

  /* ---- Modal produk & laba ---- */
  .modal-sec { margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--border); }
  .modal-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 14px; }
  .modal-head .mh-title { display: flex; align-items: center; gap: 8px; }
  .modal-head svg { width: 17px; height: 17px; color: var(--blue); }
  .modal-head h3 { font-size: 15px; font-weight: 700; color: var(--navy); margin: 0; }
  .profit { display: grid; grid-template-columns: 1fr 1.4fr; gap: 14px; margin-bottom: 16px; }
  .pf { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
  .pf .lbl { font-size: 12px; color: var(--muted); font-weight: 600; }
  .pf .amt { font-size: 22px; font-weight: 800; margin-top: 6px; color: var(--ink);
    font-variant-numeric: tabular-nums; letter-spacing: -.02em; }
  .pf .sub { font-size: 11.5px; color: var(--muted); margin-top: 4px; }
  .pf.net { background: linear-gradient(135deg, #0f2c52, #143a6b); border-color: #0f2c52; }
  .pf.net .lbl { color: #9db8e6; } .pf.net .amt { color: #fff; } .pf.net .sub { color: #7e9bce; }
  .pf.net.loss .amt { color: #ff9b92; }
  .ptable td, .ptable th { white-space: normal; }
  .ptable td:first-child { font-weight: 600; color: var(--navy); font-size: 13px; min-width: 200px; }
  .ptable .sku { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--muted); }
  .ptable .qty { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
  .ptable .tcost { text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink); }
  .hpp-wrap { position: relative; }
  .hpp-wrap .pfx { position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--muted); font-size: 13px; pointer-events: none; }
  .ptable input.hpp { width: 100%; padding: 8px 10px 8px 28px; font-size: 13px;
    font-variant-numeric: tabular-nums; }

  /* ---- Log ---- */
  .log { background: #0a1830; color: #cfe0f7; border-radius: var(--radius-sm); padding: 14px 16px;
    height: 300px; overflow: auto; font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12.5px; white-space: pre-wrap; line-height: 1.6; }
  .log .ok { color: #65e093; } .log .warn { color: #ffce6b; } .log .err { color: #ff8077; }
  .log:empty::before { content: 'Log akan muncul di sini saat scrape berjalan.'; color: #56708f; }

  /* ---- Results table ---- */
  .tablewrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  th { color: var(--muted); font-weight: 600; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em;
    background: var(--surface-2); }
  tr.file { cursor: pointer; transition: background .12s; }
  tr.file:hover { background: var(--blue-soft); }
  tr.file td:first-child { font-weight: 600; color: var(--navy); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 13px; }
  .muted { color: var(--muted); }
  .rowdel { background: transparent; border: 0; color: var(--muted); cursor: pointer; padding: 5px;
    border-radius: 7px; display: inline-flex; transition: background .12s, color .12s; }
  .rowdel:hover { background: var(--err-soft); color: var(--err); }
  .rowdel svg { width: 16px; height: 16px; }

  /* ---- Modal ---- */
  .modal { position: fixed; inset: 0; background: rgba(11,37,69,.45); backdrop-filter: blur(3px);
    display: none; align-items: center; justify-content: center; padding: 24px; z-index: 50; }
  .modal.show { display: flex; }
  .modal .box { background: var(--surface); border-radius: var(--radius);
    width: min(840px, 100%); max-height: 84vh; display: flex; flex-direction: column;
    box-shadow: 0 24px 70px rgba(11,37,69,.35); }
  .modal .box header { display: flex; align-items: center; justify-content: space-between;
    padding: 16px 20px; border-bottom: 1px solid var(--border); }
  .modal .box header strong { color: var(--navy); font-size: 15px; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .modal pre { margin: 0; padding: 20px; overflow: auto; font-size: 12.5px;
    font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--ink); line-height: 1.6; }
  .x { background: var(--surface-2); border: 1px solid var(--border); width: auto; margin: 0;
    padding: 7px 13px; color: var(--muted); border-radius: 8px; cursor: pointer; font: inherit;
    font-size: 13px; font-weight: 600; }
  .x:hover { background: var(--blue-soft); }

  /* ---- Confirm dialog ---- */
  .confirm { position: fixed; inset: 0; background: rgba(11,37,69,.45); backdrop-filter: blur(3px);
    display: none; align-items: center; justify-content: center; padding: 24px; z-index: 60; }
  .confirm.show { display: flex; }
  .confirm .box { background: #fff; border-radius: var(--radius); width: min(420px, 100%);
    padding: 24px; box-shadow: 0 24px 70px rgba(11,37,69,.35); text-align: center; }
  .confirm .ic { width: 46px; height: 46px; border-radius: 50%; background: var(--err-soft);
    color: var(--err); display: grid; place-items: center; margin: 0 auto 14px; }
  .confirm .ic svg { width: 24px; height: 24px; }
  .confirm h3 { margin: 0 0 6px; font-size: 17px; color: var(--ink); font-weight: 700; }
  .confirm p { margin: 0 0 20px; font-size: 13.5px; color: var(--muted); line-height: 1.55; }
  .confirm .acts { display: flex; gap: 10px; }

  /* ---- Responsive ---- */
  @media (max-width: 1000px) {
    .wrap { grid-template-columns: 1fr; padding: 18px; gap: 18px; }
  }
  @media (max-width: 640px) {
    .topbar { padding: 0 16px; }
    .brand p { display: none; }
    .topbar .status { padding: 6px 11px; gap: 8px; }
    .hero { grid-template-columns: 1fr; }
    .hero .figure .amt { font-size: 26px; }
    .breakdown { grid-template-columns: repeat(2, 1fr); }
    .profit { grid-template-columns: 1fr; }
  }
  @media (max-width: 380px) {
    .breakdown { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="brand">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
    </div>
    <div>
      <h1>Shopee Order Scraper</h1>
      <p>Dashboard penarikan &amp; rekap penghasilan pesanan</p>
    </div>
  </div>
  <div class="status">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Idle</span>
    <span class="timer" id="timer">00:00</span>
  </div>
</div>

<div class="wrap">
  <!-- Sidebar -->
  <div class="col">
    <div class="card">
      <div class="head">
        <svg class="hicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H2a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 3.6 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H8a1.65 1.65 0 0 0 1-1.51V2a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V8a1.65 1.65 0 0 0 1.51 1H22a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
        <h2>Pengaturan Scrape</h2>
      </div>
      <div class="body">
        <label for="type">Tipe pesanan</label>
        <select id="type">
          <option value="completed" selected>Selesai (completed)</option>
          <option value="all">Semua (all)</option>
          <option value="unpaid">Belum bayar (unpaid)</option>
          <option value="toship">Perlu dikirim (toship)</option>
          <option value="shipping">Dikirim (shipping)</option>
          <option value="cancelled">Dibatalkan (cancelled)</option>
        </select>
        <label for="mode">Mode pengambilan</label>
        <select id="mode">
          <option value="api" selected>API cepat (direkomendasikan)</option>
          <option value="browser">Browser (render halaman, lambat)</option>
        </select>
        <div class="row">
          <div>
            <label for="pages">Jumlah halaman (0 = semua)</label>
            <input id="pages" type="number" min="0" value="0" />
          </div>
          <div>
            <label for="limit">Jumlah pesanan (0 = semua)</label>
            <input id="limit" type="number" min="0" value="0" />
          </div>
        </div>
        <div class="row">
          <div>
            <label for="concurrency">Tab paralel</label>
            <input id="concurrency" type="number" min="1" max="20" value="8" />
          </div>
        </div>
        <div class="check">
          <input id="show" type="checkbox" />
          <label for="show">Tampilkan window browser</label>
        </div>
        <div class="check">
          <input id="block" type="checkbox" checked />
          <label for="block">Blokir gambar (lebih cepat)</label>
        </div>
        <button class="btn btn-primary" id="start">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
          Mulai Scrape
        </button>
      </div>
    </div>

    <div class="card">
      <div class="head">
        <svg class="hicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        <h2>Cookies Login</h2>
      </div>
      <div class="body">
        <p class="hint">
          Belum punya sesi? Upload cookies dari browser tempat kamu login di
          <code>seller.shopee.co.id</code>. Tempel teks (Netscape / JSON export) atau pilih file.
        </p>
        <textarea id="cookieText" rows="5" placeholder="Tempel isi cookies.txt atau JSON export di sini."></textarea>
        <label for="cookieFile">atau pilih file</label>
        <input id="cookieFile" type="file" accept=".txt,.json" />
        <button class="btn btn-ghost" id="uploadCookies">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Upload Cookies
        </button>
        <div id="cookieStatus" class="hint" style="margin:12px 0 0"></div>
      </div>
    </div>
  </div>

  <!-- Main -->
  <div class="col">
    <div class="card">
      <div class="head">
        <svg class="hicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        <h2>Rekap Penghasilan</h2>
        <div class="tools"><span class="badge" id="sumMeta">0 pesanan</span></div>
      </div>
      <div class="body">
        <div class="hero">
          <div class="figure net">
            <div class="lbl">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              Penghasilan Bersih
            </div>
            <div class="amt" id="sNet">Rp0</div>
            <div class="sub" id="sNetSub">setelah dipotong semua biaya</div>
          </div>
          <div class="figure gross">
            <div class="lbl">
              <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
              Penghasilan Kotor
            </div>
            <div class="amt" id="sGross">Rp0</div>
            <div class="sub muted">total subtotal produk</div>
          </div>
        </div>
        <div class="breakdown">
          <div class="bd">
            <div class="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Biaya Administrasi</div>
            <div class="amt" id="sAdmin">Rp0</div>
          </div>
          <div class="bd">
            <div class="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Biaya Asuransi</div>
            <div class="amt" id="sIns">Rp0</div>
          </div>
          <div class="bd">
            <div class="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8 7 17M17 7l2.8-2.8"/></svg> Biaya Layanan</div>
            <div class="amt" id="sService">Rp0</div>
          </div>
          <div class="bd">
            <div class="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg> Biaya Proses Pesanan</div>
            <div class="amt" id="sProcess">Rp0</div>
          </div>
          <div class="bd" id="amsCard">
            <div class="lbl"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg> Biaya Komisi AMS</div>
            <div class="amt" id="sAms">Rp0</div>
          </div>
        </div>

        <div class="modal-sec">
          <div class="modal-head">
            <div class="mh-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
              <h3>Modal Produk &amp; Laba Bersih</h3>
            </div>
            <span class="hint" id="modalHint">Isi HPP (modal per pcs) tiap produk. Otomatis dikurangi dari Penghasilan Bersih.</span>
          </div>
          <div class="profit">
            <div class="pf">
              <div class="lbl">Total Modal (HPP)</div>
              <div class="amt" id="sCost">Rp0</div>
            </div>
            <div class="pf net">
              <div class="lbl">Laba Bersih</div>
              <div class="amt" id="sProfit">Rp0</div>
              <div class="sub" id="sProfitSub">Penghasilan Bersih − Total Modal</div>
            </div>
          </div>
          <div class="tablewrap">
            <table class="ptable">
              <thead><tr>
                <th>Nama Produk</th>
                <th style="width:120px">Ukuran</th>
                <th style="width:110px">Variasi</th>
                <th style="width:120px">SKU</th>
                <th style="width:64px;text-align:right">Qty</th>
                <th style="width:150px">HPP / pcs</th>
                <th style="width:130px;text-align:right">Total Modal</th>
              </tr></thead>
              <tbody id="prodRows"><tr><td colspan="7" class="muted">Belum ada produk. Mulai scrape untuk mengisi daftar.</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="head">
        <svg class="hicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <h2>Log Langsung</h2>
      </div>
      <div class="body"><div class="log" id="log"></div></div>
    </div>

    <div class="card">
      <div class="head">
        <svg class="hicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <h2>Riwayat Hasil Pesanan</h2>
        <div class="tools">
          <button class="btn btn-danger btn-sm" id="clearAll">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Bersihkan Semua
          </button>
        </div>
      </div>
      <div class="body">
        <div class="tablewrap">
          <table>
            <thead><tr><th>Nama File</th><th style="width:100px">Ukuran</th><th style="width:160px">Waktu</th><th style="width:54px"></th></tr></thead>
            <tbody id="files"><tr><td colspan="4" class="muted">Belum ada hasil. Mulai scrape untuk mengisi riwayat.</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="modal" id="modal">
  <div class="box">
    <header><strong id="mTitle">file.json</strong><button class="x" id="mClose">Tutup</button></header>
    <pre id="mBody" class="mono"></pre>
  </div>
</div>

<div class="confirm" id="confirm">
  <div class="box">
    <div class="ic">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
    </div>
    <h3 id="cfTitle">Hapus hasil?</h3>
    <p id="cfMsg">Tindakan ini tidak bisa dibatalkan.</p>
    <div class="acts">
      <button class="btn btn-ghost" id="cfCancel" style="margin:0">Batal</button>
      <button class="btn btn-danger" id="cfOk" style="margin:0">Hapus</button>
    </div>
  </div>
</div>

<script>
  const $ = (id) => document.getElementById(id);
  const logEl = $('log');

  function addLog(line) {
    const div = document.createElement('div');
    if (/✅|done|selesai|logged in|✓/i.test(line)) div.className = 'ok';
    else if (/⚠|WARN|warn/i.test(line)) div.className = 'warn';
    else if (/❌|💥|error|gagal|fatal/i.test(line)) div.className = 'err';
    div.textContent = line;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStatus(isRunning) {
    $('statusDot').classList.toggle('on', isRunning);
    $('statusText').textContent = isRunning ? 'Berjalan' : 'Idle';
    $('start').disabled = isRunning;
    if (isRunning) startTimer(); else stopTimer();
  }

  // --- Penghitung waktu ---
  let timerStart = 0, timerInterval = null;
  const timerEl = $('timer');
  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (hh > 0 ? pad(hh) + ':' : '') + pad(mm) + ':' + pad(ss);
  }
  function startTimer() {
    if (timerInterval) return;
    timerStart = Date.now();
    timerEl.classList.add('on');
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => { timerEl.textContent = fmt(Date.now() - timerStart); }, 250);
  }
  function stopTimer() {
    if (!timerInterval) return;
    clearInterval(timerInterval); timerInterval = null;
    const elapsed = Date.now() - timerStart;
    timerEl.classList.remove('on');
    timerEl.textContent = fmt(elapsed);
    addLog('[web] total waktu: ' + fmt(elapsed));
  }

  // --- Format rupiah ---
  function rp(n) {
    const sign = n < 0 ? '-' : '';
    return sign + 'Rp' + Math.abs(Math.round(n)).toLocaleString('id-ID');
  }

  // --- Confirm dialog (Promise-based) ---
  let confirmResolve = null;
  function askConfirm(title, msg) {
    $('cfTitle').textContent = title;
    $('cfMsg').textContent = msg;
    $('confirm').classList.add('show');
    return new Promise((res) => { confirmResolve = res; });
  }
  function closeConfirm(val) {
    $('confirm').classList.remove('show');
    if (confirmResolve) { confirmResolve(val); confirmResolve = null; }
  }
  $('cfCancel').onclick = () => closeConfirm(false);
  $('cfOk').onclick = () => closeConfirm(true);
  $('confirm').onclick = (e) => { if (e.target.id === 'confirm') closeConfirm(false); };

  // Live log via SSE.
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => { try { addLog(JSON.parse(e.data)); } catch {} };
  es.addEventListener('status', (e) => { try { setStatus(JSON.parse(e.data).running); } catch {} });
  es.addEventListener('done', () => { loadResults(); loadSummary(); });

  async function loadSummary() {
    const r = await fetch('/api/summary').then((x) => x.json()).catch(() => null);
    if (!r || !r.ok) return;
    const s = r.summary;
    $('sGross').textContent = rp(s.grossIncome);
    $('sAdmin').textContent = rp(s.adminFee);
    $('sIns').textContent = rp(s.insurance);
    $('sService').textContent = rp(s.serviceFee);
    $('sProcess').textContent = rp(s.processingFee);
    $('sNet').textContent = rp(s.netIncome);
    // Biaya Komisi AMS selalu tampil (Rp0 kalau pesanan tidak mengandung komisi AMS).
    $('sAms').textContent = rp(s.amsCommission);
    const amsCard = $('amsCard');
    amsCard.title = s.amsOrderCount > 0
      ? s.amsOrderCount + ' pesanan mengandung komisi AMS'
      : 'Belum ada pesanan dengan komisi AMS';
    $('sumMeta').textContent = s.orderCount + ' pesanan · ' + s.productCount + ' produk';
    netIncomeCurrent = s.netIncome || 0;
    renderProducts(s.products || []);
  }

  // --- Modal produk & laba bersih ---
  let netIncomeCurrent = 0;
  const HPP_STORE = 'shopee-hpp-v1';
  function loadHpp() { try { return JSON.parse(localStorage.getItem(HPP_STORE) || '{}'); } catch { return {}; } }
  function saveHpp(map) { try { localStorage.setItem(HPP_STORE, JSON.stringify(map)); } catch {} }
  function parseRpInput(v) { const d = String(v).replace(/[^0-9]/g, ''); return d ? parseInt(d, 10) : 0; }

  function renderProducts(products) {
    const tbody = $('prodRows');
    if (!products.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">Belum ada produk. Mulai scrape untuk mengisi daftar.</td></tr>';
      recalcProfit();
      return;
    }
    const hpp = loadHpp();
    tbody.innerHTML = '';
    for (const p of products) {
      const tr = document.createElement('tr');
      const stored = hpp[p.key] || 0;
      tr.innerHTML =
        '<td>' + esc(p.name || '-') + '</td>' +
        '<td>' + esc(p.size || '-') + '</td>' +
        '<td>' + esc(p.color || '-') + '</td>' +
        '<td class="sku">' + esc(p.sku || '-') + '</td>' +
        '<td class="qty">' + p.qty + '</td>' +
        '<td><div class="hpp-wrap"><span class="pfx">Rp</span>' +
          '<input class="hpp" type="text" inputmode="numeric" value="' + (stored ? stored.toLocaleString('id-ID') : '') + '" placeholder="0" /></div></td>' +
        '<td class="tcost">' + rp(stored * p.qty) + '</td>';
      const input = tr.querySelector('input.hpp');
      const costCell = tr.querySelector('.tcost');
      input.dataset.key = p.key;
      input.dataset.qty = p.qty;
      input.oninput = () => {
        const val = parseRpInput(input.value);
        input.value = val ? val.toLocaleString('id-ID') : '';
        costCell.textContent = rp(val * p.qty);
        const m = loadHpp();
        if (val) m[p.key] = val; else delete m[p.key];
        saveHpp(m);
        recalcProfit();
      };
      tbody.appendChild(tr);
    }
    recalcProfit();
  }

  function recalcProfit() {
    const hpp = loadHpp();
    let totalCost = 0;
    document.querySelectorAll('#prodRows input.hpp').forEach((inp) => {
      const val = parseRpInput(inp.value);
      const qty = Number(inp.dataset.qty) || 0;
      totalCost += val * qty;
    });
    $('sCost').textContent = rp(totalCost);
    const profit = netIncomeCurrent - totalCost;
    $('sProfit').textContent = rp(profit);
    $('sProfit').closest('.pf').classList.toggle('loss', profit < 0);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function svgTrash() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  }

  async function loadResults() {
    const r = await fetch('/api/results').then((x) => x.json()).catch(() => null);
    const tbody = $('files');
    if (!r || !r.files.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="muted">Belum ada hasil. Mulai scrape untuk mengisi riwayat.</td></tr>';
      $('clearAll').disabled = true;
      return;
    }
    $('clearAll').disabled = false;
    tbody.innerHTML = '';
    for (const f of r.files) {
      const tr = document.createElement('tr');
      tr.className = 'file';
      const kb = (f.size / 1024).toFixed(1) + ' KB';
      const when = new Date(f.mtime).toLocaleString('id-ID');
      const nameTd = document.createElement('td'); nameTd.textContent = f.name;
      const sizeTd = document.createElement('td'); sizeTd.className = 'muted'; sizeTd.textContent = kb;
      const timeTd = document.createElement('td'); timeTd.className = 'muted'; timeTd.textContent = when;
      const actTd = document.createElement('td');
      const del = document.createElement('button');
      del.className = 'rowdel'; del.title = 'Hapus file ini'; del.innerHTML = svgTrash();
      del.onclick = (e) => { e.stopPropagation(); deleteFile(f.name); };
      actTd.appendChild(del);
      tr.appendChild(nameTd); tr.appendChild(sizeTd); tr.appendChild(timeTd); tr.appendChild(actTd);
      tr.onclick = () => viewFile(f.name);
      tbody.appendChild(tr);
    }
  }

  async function deleteFile(name) {
    const ok = await askConfirm('Hapus file ini?', name + ' akan dihapus permanen.');
    if (!ok) return;
    await fetch('/api/clear?name=' + encodeURIComponent(name), { method: 'POST' }).catch(() => {});
    loadResults(); loadSummary();
  }

  $('clearAll').onclick = async () => {
    const ok = await askConfirm('Bersihkan semua hasil?', 'Semua file hasil pesanan & rekap akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.');
    if (!ok) return;
    const r = await fetch('/api/clear', { method: 'POST' }).then((x) => x.json()).catch(() => null);
    if (r && r.ok) addLog('[web] riwayat dibersihkan — ' + r.removed + ' file dihapus');
    else if (r && r.error) addLog('[web] ⚠️ ' + r.error);
    loadResults(); loadSummary();
  };

  async function viewFile(name) {
    const txt = await fetch('/api/result?name=' + encodeURIComponent(name)).then((x) => x.text());
    $('mTitle').textContent = name;
    try { $('mBody').textContent = JSON.stringify(JSON.parse(txt), null, 2); }
    catch { $('mBody').textContent = txt; }
    $('modal').classList.add('show');
  }
  $('mClose').onclick = () => $('modal').classList.remove('show');
  $('modal').onclick = (e) => { if (e.target.id === 'modal') $('modal').classList.remove('show'); };

  $('start').onclick = async () => {
    const body = {
      type: $('type').value,
      mode: $('mode').value,
      maxPages: Number($('pages').value) || 0,
      limit: Number($('limit').value) || 0,
      concurrency: Number($('concurrency').value) || 0,
      show: $('show').checked,
      blockResources: $('block').checked,
    };
    logEl.innerHTML = '';
    startTimer();
    addLog('[web] mengirim permintaan.');
    const r = await fetch('/api/scrape', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 409) addLog('[web] ⚠️ sudah ada proses berjalan');
  };

  // --- Upload cookies ---
  $('cookieFile').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $('cookieText').value = await file.text();
    $('cookieStatus').textContent = 'File "' + file.name + '" dimuat — klik Upload Cookies.';
  };

  $('uploadCookies').onclick = async () => {
    const cookies = $('cookieText').value.trim();
    const statusEl = $('cookieStatus');
    if (!cookies) { statusEl.textContent = '⚠️ tempel/pilih cookies dulu.'; return; }
    $('uploadCookies').disabled = true;
    statusEl.textContent = 'menyimpan.';
    try {
      const r = await fetch('/api/cookies', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cookies }),
      });
      const j = await r.json();
      statusEl.textContent = j.ok
        ? '✅ tersimpan — ' + j.shopee + ' cookie Shopee (dari ' + j.total + ' total). Sekarang klik Mulai Scrape.'
        : '❌ ' + (j.error || 'gagal menyimpan');
    } catch (err) {
      statusEl.textContent = '❌ ' + (err && err.message ? err.message : 'gagal mengirim');
    } finally {
      $('uploadCookies').disabled = false;
    }
  };

  loadResults();
  loadSummary();
</script>
</body>
</html>`
