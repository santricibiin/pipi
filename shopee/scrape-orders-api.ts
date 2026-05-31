/**
 * Shopee order scraper — DIRECT API mode (fast path).
 *
 * Instead of rendering each order page with Camoufox (slow), this talks to the
 * same internal JSON APIs the Seller Centre SPA uses, via `fetch()` executed
 * INSIDE the authenticated page (so cookies + SPC_CDS + same-origin all just
 * work). No page rendering per order = 10-50x faster, and we can run many
 * lightweight HTTP calls in parallel.
 *
 * Endpoints (discovered via shopee/discover-api.ts):
 *   POST /api/v3/order/search_order_list_index           -> order ids (paginated)
 *   POST /api/v3/order/get_order_list_card_list           -> summaries (batched)
 *   POST /api/v4/accounting/.../get_order_income_components -> products + payment
 *
 * Output shape is identical to the browser scraper (one JSON per order under
 * result/), so the web UI / index file keep working unchanged.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Page } from 'playwright'
import type {
  OrderDetail,
  OrderProduct,
  OrderSummary,
  PaymentLine,
  ScrapeOrdersOptions,
  ScrapeOrdersResult,
} from './order-types'
import { loadSession, findLatestSession } from './session'
import type { ShopeeSession } from './types'

const SELLER_ORIGIN = 'https://seller.shopee.co.id'
const SELLER_HOST = 'seller.shopee.co.id'

/** Map an order tab name to Shopee's numeric `order_list_tab`. */
const TAB_CODES: Record<string, number> = {
  all: 0,
  completed: 500,
}

type IndexEntry = { order_id: number; shop_id: number; region_id: string }

/** A function that POSTs JSON to a Shopee API path and returns the parsed body. */
type Poster = <T = any>(path: string, body: unknown) => Promise<T>

/** Build a Poster that runs fetch() INSIDE the authenticated page (cookies free). */
function makePagePoster(page: Page): Poster {
  return (<T = any>(path: string, body: unknown) =>
    page.evaluate(
      async ({ path, body }) => {
        const cds = (document.cookie.match(/(?:^|;\s*)SPC_CDS=([^;]+)/) || [])[1] || ''
        const sep = path.includes('?') ? '&' : '?'
        const url = `${path}${sep}SPC_CDS=${cds}&SPC_CDS_VER=2`
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json;charset=utf-8', 'x-api-src-list': 'pc' },
          body: JSON.stringify(body),
          credentials: 'include',
        })
        return res.json()
      },
      { path, body }
    )) as Poster
}

/**
 * Build a Cookie header for a given host from saved storageState cookies.
 * Includes cookies whose domain matches the host (or a parent .domain),
 * de-duplicating by name and preferring the most specific domain.
 */
function buildCookieHeader(cookies: Array<{ name: string; value: string; domain: string }>, host: string): string {
  const matching = cookies.filter((c) => {
    const d = c.domain.replace(/^\./, '')
    return host === d || host.endsWith('.' + d)
  })
  const byName = new Map<string, { name: string; value: string; domain: string }>()
  for (const c of matching) {
    const prev = byName.get(c.name)
    const dlen = c.domain.replace(/^\./, '').length
    if (!prev || dlen > prev.domain.replace(/^\./, '').length) byName.set(c.name, c)
  }
  return [...byName.values()].map((c) => `${c.name}=${c.value}`).join('; ')
}

/** Build a Poster that uses Node's native fetch + saved cookies (NO browser). */
function makeFetchPoster(session: ShopeeSession): Poster {
  const cookies = (session.storageState?.cookies ?? []) as Array<{
    name: string
    value: string
    domain: string
  }>
  const cookieHeader = buildCookieHeader(cookies, SELLER_HOST)
  const spcCds = cookies.find((c) => c.name === 'SPC_CDS')?.value ?? ''
  const ua =
    session.userAgent ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0'
  return (async <T = any>(path: string, body: unknown): Promise<T> => {
    const sep = path.includes('?') ? '&' : '?'
    const url = `${SELLER_ORIGIN}${path}${sep}SPC_CDS=${spcCds}&SPC_CDS_VER=2`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'x-api-src-list': 'pc',
        accept: 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.5',
        origin: SELLER_ORIGIN,
        referer: `${SELLER_ORIGIN}/portal/sale/order`,
        'user-agent': ua,
        cookie: cookieHeader,
      },
      body: JSON.stringify(body),
    })
    return res.json() as Promise<T>
  }) as Poster
}

/** Format micro-units (value * 100000) as Indonesian rupiah, e.g. "Rp190.000". */
function fmtRp(micro: number): string {
  const v = Math.round(micro / 100000)
  const neg = v < 0
  const abs = Math.abs(v).toLocaleString('id-ID')
  return `${neg ? '-Rp' : 'Rp'}${abs}`
}

/** Format micro-units as a plain number, e.g. "190.000" (used for product prices). */
function fmtNum(micro: number): string {
  return Math.round(micro / 100000).toLocaleString('id-ID')
}

/** Pause helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Make a filesystem-safe filename. */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
}

/** Flatten the seller-income breakdown into label/amount lines + total. */
function buildPayment(incomeData: any): { breakdown: PaymentLine[]; total?: PaymentLine } {
  const lines: PaymentLine[] = []
  let total: PaymentLine | undefined
  const breakdown = incomeData?.seller_income_breakdown?.breakdown ?? []
  for (const item of breakdown) {
    const line: PaymentLine = { label: item.display_name, amount: fmtRp(item.amount) }
    lines.push(line)
    // ESCROW_AMOUNT == "Total Penghasilan".
    if (item.field_name === 'ESCROW_AMOUNT') total = line
    for (const sub of item.sub_breakdown ?? []) {
      lines.push({ label: sub.display_name, amount: fmtRp(sub.amount) })
    }
  }
  return { breakdown: lines, total }
}

/** Build product lines from the income endpoint's order_item_list (has prices). */
function buildProducts(incomeData: any): OrderProduct[] {
  const items = incomeData?.order_item_list?.order_items ?? []
  return items.map((it: any, i: number): OrderProduct => {
    const variationParts: string[] = []
    if (it.model_name) variationParts.push(`Variasi: ${it.model_name}`)
    if (it.model_sku || it.product_sku) variationParts.push(`Kode Variasi: ${it.model_sku || it.product_sku}`)
    return {
      index: String(i + 1),
      name: it.product_name ?? '',
      variation: variationParts.join('') || undefined,
      code: it.model_sku || it.product_sku || undefined,
      price: fmtNum(it.price ?? 0),
      qty: String(it.amount ?? ''),
      subtotal: fmtNum(it.subtotal ?? it.price ?? 0),
    }
  })
}

/**
 * Scrape completed orders via the internal API (fast), using a logged-in page.
 * Runs fetch() inside the page so cookies travel automatically.
 *
 * @param page  a logged-in Shopee Seller Centre page.
 */
export async function scrapeOrdersApi(
  page: Page,
  options: ScrapeOrdersOptions = {}
): Promise<ScrapeOrdersResult> {
  const orderType = options.orderType ?? 'completed'
  // Ensure we're on the seller origin so same-origin fetch + SPC_CDS work.
  if (!page.url().startsWith(SELLER_ORIGIN)) {
    await page.goto(`${SELLER_ORIGIN}/portal/sale/order?type=${encodeURIComponent(orderType)}`, {
      waitUntil: 'domcontentloaded',
    })
  }
  return scrapeViaPoster(makePagePoster(page), options)
}

/**
 * Scrape completed orders via the internal API WITHOUT launching a browser.
 * Reuses a saved session's cookies with Node's native fetch — this skips the
 * ~30-40s Camoufox/Firefox startup entirely, so a full run takes a few seconds.
 *
 * @param sessionPath  optional path to a session JSON; defaults to the newest
 *                     file in `shopee/sessions/`.
 */
export async function scrapeOrdersApiDirect(
  options: ScrapeOrdersOptions = {},
  sessionPath?: string
): Promise<ScrapeOrdersResult> {
  const log = options.log ?? ((m: string) => console.log(m))
  const path = sessionPath ?? (await findLatestSession(options.sessionDir ? resolve(options.sessionDir) : undefined))
  if (!path) {
    throw new Error(
      'no saved session found in shopee/sessions/ — run a normal login once first (e.g. npm run shopee:orders -- --browser --limit 1)'
    )
  }
  const session = await loadSession(path)
  log(`[api] using saved session: ${session.shopName ?? path} (browserless)`)
  return scrapeViaPoster(makeFetchPoster(session), options)
}

/** Core scraping logic, parameterised over how API calls are made. */
async function scrapeViaPoster(
  post: Poster,
  options: ScrapeOrdersOptions = {}
): Promise<ScrapeOrdersResult> {
  const log = options.log ?? ((m: string) => console.log(m))
  const orderType = options.orderType ?? 'completed'
  const outDir = resolve(options.outDir ?? 'result')
  const limit = options.limit ?? 0
  const maxPages = options.maxPages ?? 0
  const concurrency = Math.max(1, options.concurrency ?? 8)
  const orderListTab = TAB_CODES[orderType] ?? TAB_CODES.completed

  await mkdir(outDir, { recursive: true })


  // 1. Page through search_order_list_index to collect every order id.
  log(
    `[api] fetching order index (tab=${orderListTab}` +
      `${maxPages > 0 ? `, maks ${maxPages} halaman` : ''}` +
      `${limit > 0 ? `, maks ${limit} pesanan` : ''})...`
  )
  const index: IndexEntry[] = []
  const pageSize = 40
  for (let pageNo = 1; ; pageNo++) {
    const resp = await post('/api/v3/order/search_order_list_index', {
      order_list_tab: orderListTab,
      entity_type: 1,
      pagination: { from_page_number: 1, page_number: pageNo, page_size: pageSize },
      filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
    })
    if (resp?.code !== 0) {
      // A non-zero code on the very first page usually means the session is
      // expired / not authenticated. Signal that so callers can re-login.
      if (pageNo === 1) {
        const err = new Error(
          `auth failed (code=${resp?.code} ${resp?.message ?? ''}) — session may be expired`
        ) as Error & { authFailed?: boolean }
        err.authFailed = true
        throw err
      }
      log(`[api] ⚠️  index page ${pageNo} returned code=${resp?.code} (${resp?.message}) — stopping`)
      break
    }
    const batch: IndexEntry[] = resp?.data?.index_list ?? []
    index.push(...batch)
    if (batch.length < pageSize) break
    // Page filter: stop after the requested number of pages.
    if (maxPages > 0 && pageNo >= maxPages) break
    // Order-count filter: stop once we have enough orders.
    if (limit > 0 && index.length >= limit) break
  }
  const ids = limit > 0 ? index.slice(0, limit) : index
  log(`[api] found ${index.length} orders${limit > 0 && ids.length < index.length ? ` (dibatasi ${ids.length})` : ''}`)

  // 2. Batch-fetch summaries (orderSn, status, tracking, carrier, address).
  const summaryMap = new Map<number, any>()
  const cardBatch = 5
  for (let i = 0; i < ids.length; i += cardBatch) {
    const slice = ids.slice(i, i + cardBatch)
    const resp = await post('/api/v3/order/get_order_list_card_list', {
      order_list_tab: orderListTab,
      need_count_down_desc: true,
      order_param_list: slice.map((e) => ({
        order_id: e.order_id,
        shop_id: e.shop_id,
        region_id: e.region_id,
      })),
    })
    for (const card of resp?.data?.card_list ?? []) {
      const oc = card.order_card
      const oid = oc?.order_ext_info?.order_id
      if (oid != null) summaryMap.set(oid, oc)
    }
  }
  log(`[api] fetched ${summaryMap.size} order summaries`)

  // Build OrderSummary[] for the index file.
  const summaries: OrderSummary[] = ids.map((e) => {
    const oc = summaryMap.get(e.order_id)
    const firstItem = oc?.item_info_group?.item_info_list?.[0]?.item_list?.[0]
    return {
      pathId: String(e.order_id),
      orderSn: oc?.card_header?.order_sn,
      detailUrl: `${SELLER_ORIGIN}/portal/sale/order/${e.order_id}`,
      buyerName: oc?.card_header?.buyer_info?.username,
      productName: firstItem?.name,
      qty: firstItem?.amount != null ? String(firstItem.amount) : undefined,
      totalPrice: oc?.payment_info?.total_price != null ? fmtRp(oc.payment_info.total_price) : undefined,
      status: oc?.status_info?.status,
      paymentMethod: oc?.payment_info?.payment_method,
      fulfilmentChannel: oc?.fulfilment_info?.fulfilment_channel_name,
    }
  })

  // 3. Per-order income components (products + payment) — run in parallel pool.
  const details: OrderDetail[] = new Array(ids.length)
  let nextIndex = 0
  let done = 0
  const workers = Math.min(concurrency, ids.length || 1)
  log(`[api] fetching ${ids.length} order details with ${workers} parallel request(s)`)

  const runWorker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= ids.length) break
      const e = ids[i]
      const oc = summaryMap.get(e.order_id)
      try {
        const income = await post('/api/v4/accounting/pc/seller_income/income_detail/get_order_income_components', {
          order_id: e.order_id,
          components: [2, 3, 4],
        })
        const incomeData = income?.data ?? {}
        const { breakdown, total } = buildPayment(incomeData)
        const pkg = oc?.package_ext_info_list?.[0]
        const tracking = oc?.fulfilment_info?.tracking_number_list?.[0]

        const detail: OrderDetail = {
          pathId: String(e.order_id),
          orderSn: oc?.card_header?.order_sn ?? incomeData?.order_info?.order_sn,
          detailUrl: `${SELLER_ORIGIN}/portal/sale/order/${e.order_id}`,
          status: oc?.status_info?.status,
          statusDescription: oc?.status_info?.status_description?.description_value || undefined,
          shippingAddress: {
            buyerContact: pkg ? `${pkg.shipping_name ?? ''}, ${pkg.shipping_phone ?? ''}`.trim() : undefined,
            address: pkg?.shipping_address,
          },
          shipping: {
            packageLabel: pkg ? 'Paket 1:' : undefined,
            carrier: oc?.fulfilment_info?.masked_channel_name,
            actualCarrier: oc?.fulfilment_info?.fulfilment_channel_name,
            trackingNumber: tracking ? `# ${tracking}` : undefined,
          },
          products: buildProducts(incomeData),
          paymentBreakdown: breakdown,
          total,
          scrapedAt: Date.now(),
        }
        details[i] = detail
        const fname = safeName(detail.orderSn ?? detail.pathId)
        await writeFile(resolve(outDir, `${fname}.json`), JSON.stringify(detail, null, 2), 'utf8')
        done++
        log(`[api] (${done}/${ids.length}) ✓ order ${detail.orderSn ?? detail.pathId}`)
      } catch (err) {
        log(`[api] ⚠️  failed order ${e.order_id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => runWorker()))
  const scraped = details.filter(Boolean)

  // 4. Write the index summary file.
  const result: ScrapeOrdersResult = { orderType, reportedCount: index.length, summaries, details: scraped, outDir }
  await writeFile(
    resolve(outDir, `_index-${orderType}.json`),
    JSON.stringify(
      { orderType, reportedCount: index.length, collected: summaries.length, scraped: scraped.length, summaries },
      null,
      2
    ),
    'utf8'
  )
  log(`[api] ✅ done — ${scraped.length}/${ids.length} orders saved → ${outDir}`)
  return result
}
