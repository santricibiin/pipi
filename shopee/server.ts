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
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, join, basename } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

import { establishShopeeSession } from './login'
import { scrapeOrders } from './scrape-orders'
import type { ShopeeLoginOptions } from './types'
import type { ScrapeOrdersOptions } from './order-types'

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
  concurrency?: number
  show?: boolean
  blockResources?: boolean
}

async function runScrape(body: ScrapeBody): Promise<void> {
  if (running) {
    broadcast('[web] ⚠️  sebuah proses scrape sedang berjalan — tunggu sampai selesai')
    return
  }
  running = true
  broadcastEvent('status', { running: true })

  const login: ShopeeLoginOptions = { headless: !body.show, log: broadcast }
  const scrape: ScrapeOrdersOptions = {
    orderType: body.type || 'completed',
    limit: Number(body.limit) || 0,
    concurrency: Number(body.concurrency) || 4,
    blockResources: body.blockResources !== false,
    log: broadcast,
  }

  broadcast(
    `[web] ▶️  mulai scrape — type=${scrape.orderType} limit=${scrape.limit || 'all'} concurrency=${scrape.concurrency} ${
      body.show ? '(window terlihat)' : '(headless)'
    }`
  )

  let session: Awaited<ReturnType<typeof establishShopeeSession>>['session'] | undefined
  try {
    const established = await establishShopeeSession(login)
    session = established.session
    if (!established.result.success) {
      broadcast('[web] ❌ gagal login — cookies/session ditolak. Export ulang cookies lalu coba lagi.')
      return
    }
    const result = await scrapeOrders(session.page, scrape)
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

  // --- list result files ---
  if (req.method === 'GET' && path === '/api/results') {
    sendJson(res, 200, { running, files: await listResults() })
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
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262b36; --text: #e6e9ef;
    --muted: #8b93a7; --accent: #ee4d2d; --accent-h: #ff6b4a; --ok: #3fb950; --warn: #d29922;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { padding: 18px 24px; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 18px; margin: 0; font-weight: 600; }
  header .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
  header .dot.on { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
  header .timer { margin-left: auto; font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 20px; font-weight: 600; letter-spacing: .04em; color: var(--muted);
    background: #0d0f14; border: 1px solid var(--border); border-radius: 8px; padding: 4px 12px; }
  header .timer.on { color: var(--accent-h); border-color: var(--accent); }
  header .timer::before { content: '⏱ '; font-size: 15px; }
  .wrap { display: grid; grid-template-columns: 320px 1fr; gap: 16px; padding: 16px 24px; }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--muted); margin: 0 0 12px; }
  label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
  input, select { width: 100%; padding: 8px 10px; background: #0d0f14; color: var(--text);
    border: 1px solid var(--border); border-radius: 7px; font: inherit; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .check input { width: auto; }
  button { margin-top: 16px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
    background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: var(--accent-h); }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .log { background: #0a0c10; border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    height: 320px; overflow: auto; font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12.5px; white-space: pre-wrap; }
  .log .ok { color: var(--ok); } .log .warn { color: var(--warn); } .log .err { color: var(--accent-h); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  tr.file { cursor: pointer; } tr.file:hover { background: #1d212b; }
  .muted { color: var(--muted); }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: none;
    align-items: center; justify-content: center; padding: 24px; }
  .modal.show { display: flex; }
  .modal .box { background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    width: min(820px, 100%); max-height: 84vh; display: flex; flex-direction: column; }
  .modal .box header { justify-content: space-between; }
  .modal pre { margin: 0; padding: 16px; overflow: auto; font-size: 12.5px;
    font-family: ui-monospace, Menlo, Consolas, monospace; }
  .x { background: transparent; width: auto; margin: 0; padding: 4px 10px; color: var(--muted); }
  .x:hover { background: var(--border); }
  @media (max-width: 820px) { .wrap { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <span class="dot" id="statusDot"></span>
  <h1>Shopee Order Scraper</h1>
  <span class="muted" id="statusText">idle</span>
  <span class="timer" id="timer">00:00</span>
</header>

<div class="wrap">
  <div class="panel">
    <h2>Pengaturan</h2>
    <label for="type">Tipe pesanan</label>
    <select id="type">
      <option value="completed" selected>completed (selesai)</option>
      <option value="all">all (semua)</option>
      <option value="unpaid">unpaid</option>
      <option value="toship">toship</option>
      <option value="shipping">shipping</option>
      <option value="cancelled">cancelled</option>
    </select>
    <div class="row">
      <div>
        <label for="limit">Limit (0 = semua)</label>
        <input id="limit" type="number" min="0" value="0" />
      </div>
      <div>
        <label for="concurrency">Tab paralel</label>
        <input id="concurrency" type="number" min="1" max="10" value="4" />
      </div>
    </div>
    <div class="check">
      <input id="show" type="checkbox" />
      <label for="show" style="margin:0">Tampilkan window browser</label>
    </div>
    <div class="check">
      <input id="block" type="checkbox" checked />
      <label for="block" style="margin:0">Blokir gambar (lebih cepat)</label>
    </div>
    <button id="start">Mulai Scrape</button>
  </div>

  <div>
    <div class="panel">
      <h2>Log Langsung</h2>
      <div class="log" id="log"></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h2>Hasil (klik untuk lihat)</h2>
      <table>
        <thead><tr><th>Nama File</th><th style="width:120px">Ukuran</th><th style="width:170px">Waktu</th></tr></thead>
        <tbody id="files"><tr><td colspan="3" class="muted">belum ada hasil</td></tr></tbody>
      </table>
    </div>
  </div>
</div>

<div class="modal" id="modal">
  <div class="box">
    <header><strong id="mTitle">file.json</strong><button class="x" id="mClose">tutup ✕</button></header>
    <pre id="mBody"></pre>
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
    $('statusText').textContent = isRunning ? 'berjalan…' : 'idle';
    $('start').disabled = isRunning;
    $('start').textContent = isRunning ? 'Sedang berjalan…' : 'Mulai Scrape';
    if (isRunning) startTimer(); else stopTimer();
  }

  // --- Penghitung waktu (mulai saat klik, berhenti saat selesai) ---
  let timerStart = 0;
  let timerInterval = null;
  const timerEl = $('timer');

  function fmt(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (hh > 0 ? pad(hh) + ':' : '') + pad(mm) + ':' + pad(ss);
  }

  function startTimer() {
    if (timerInterval) return; // sudah jalan — jangan reset
    timerStart = Date.now();
    timerEl.classList.add('on');
    timerEl.textContent = '00:00';
    timerInterval = setInterval(() => {
      timerEl.textContent = fmt(Date.now() - timerStart);
    }, 250);
  }

  function stopTimer() {
    if (!timerInterval) return;
    clearInterval(timerInterval);
    timerInterval = null;
    const elapsed = Date.now() - timerStart;
    timerEl.classList.remove('on');
    timerEl.textContent = fmt(elapsed);
    addLog('[web] ⏱️ total waktu: ' + fmt(elapsed));
  }

  // Live log via Server-Sent Events.
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => { try { addLog(JSON.parse(e.data)); } catch {} };
  es.addEventListener('status', (e) => { try { setStatus(JSON.parse(e.data).running); } catch {} });
  es.addEventListener('done', () => loadResults());

  async function loadResults() {
    const r = await fetch('/api/results').then((x) => x.json()).catch(() => null);
    const tbody = $('files');
    if (!r || !r.files.length) { tbody.innerHTML = '<tr><td colspan="3" class="muted">belum ada hasil</td></tr>'; return; }
    tbody.innerHTML = '';
    for (const f of r.files) {
      const tr = document.createElement('tr');
      tr.className = 'file';
      const kb = (f.size / 1024).toFixed(1) + ' KB';
      const when = new Date(f.mtime).toLocaleString('id-ID');
      tr.innerHTML = '<td>' + f.name + '</td><td class="muted">' + kb + '</td><td class="muted">' + when + '</td>';
      tr.onclick = () => viewFile(f.name);
      tbody.appendChild(tr);
    }
  }

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
      limit: Number($('limit').value) || 0,
      concurrency: Number($('concurrency').value) || 4,
      show: $('show').checked,
      blockResources: $('block').checked,
    };
    logEl.innerHTML = '';
    startTimer();
    addLog('[web] mengirim permintaan…');
    const r = await fetch('/api/scrape', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 409) addLog('[web] ⚠️ sudah ada proses berjalan');
  };

  loadResults();
</script>
</body>
</html>`
