/**
 * Shopee order scraper.
 *
 * Given a logged-in Playwright page, walks the completed-orders list,
 * collects every order, opens each one, and extracts the full detail.
 * Results are written one JSON file per order under `result/`.
 *
 * Selectors below were mapped from the captured DOM in `referensiDOM/`.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { BrowserContext, Page, Route } from 'playwright'
import type {
  OrderDetail,
  OrderProduct,
  OrderSummary,
  PaymentLine,
  ScrapeOrdersOptions,
  ScrapeOrdersResult,
} from './order-types'

const SELLER_ORIGIN = 'https://seller.shopee.co.id'

/** Build the order-list URL for a given tab. */
function listUrl(orderType: string): string {
  return `${SELLER_ORIGIN}/portal/sale/order?type=${encodeURIComponent(orderType)}`
}

/** Build a detail URL from a numeric path id. */
function detailUrl(pathId: string): string {
  return `${SELLER_ORIGIN}/portal/sale/order/${pathId}`
}

/** Pause helper. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Make a filesystem-safe filename from an order serial / id. */
function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
}

/**
 * Scrape completed orders end-to-end.
 *
 * @param page  a logged-in Shopee Seller Centre page (cookies/session already applied)
 */
export async function scrapeOrders(
  page: Page,
  options: ScrapeOrdersOptions = {}
): Promise<ScrapeOrdersResult> {
  const log = options.log ?? ((m: string) => console.log(m))
  const orderType = options.orderType ?? 'completed'
  const outDir = resolve(options.outDir ?? 'result')
  const perOrderDelayMs = options.perOrderDelayMs ?? 0
  const limit = options.limit ?? 0
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const blockResources = options.blockResources ?? true

  await mkdir(outDir, { recursive: true })

  const context = page.context()

  // tsx/esbuild rewrites named functions inside page.evaluate() to call a
  // `__name()` helper that doesn't exist in the browser. Define a no-op at the
  // CONTEXT level so every page (incl. parallel worker tabs) gets it.
  await context.addInitScript(() => {
    const g = globalThis as Record<string, unknown>
    if (typeof g.__name !== 'function') g.__name = (fn: unknown) => fn
  })

  // Speed: block heavy resources we never read (images/media/fonts/css).
  // Applied at the context level so all worker tabs benefit.
  if (blockResources) await installResourceBlocker(context)

  // 1. Go to the order list.
  const url = listUrl(orderType)
  log(`[scrape] → order list: ${url}`)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.order-card, .order-list-result-count', { timeout: 20000 }).catch(() => {})

  // 2. Read the total count Shopee reports (e.g. "79 Pesanan").
  const reportedCount = await readReportedCount(page)
  if (reportedCount != null) log(`[scrape] reported count: ${reportedCount} ${orderType} orders`)

  // 3. Collect every order summary, scrolling to load the full list.
  const summaries = await collectOrderSummaries(page, { reportedCount, limit, log })
  log(`[scrape] collected ${summaries.length} order summaries`)

  // 4. Visit each order detail and extract — in parallel across worker tabs.
  const max = limit > 0 ? Math.min(limit, summaries.length) : summaries.length
  const work = summaries.slice(0, max)
  const details: OrderDetail[] = new Array(work.length)
  const workers = Math.min(concurrency, work.length || 1)
  log(`[scrape] scraping ${work.length} orders with ${workers} parallel tab(s)`)

  let nextIndex = 0
  let done = 0
  const runWorker = async (workerNo: number): Promise<void> => {
    // Worker 0 reuses the main page; others open their own tab.
    const wp = workerNo === 0 ? page : await context.newPage()
    try {
      while (true) {
        const i = nextIndex++
        if (i >= work.length) break
        const s = work[i]
        try {
          const detail = await scrapeOrderDetail(wp, s)
          details[i] = detail
          const fname = safeName(detail.orderSn ?? detail.pathId)
          await writeFile(resolve(outDir, `${fname}.json`), JSON.stringify(detail, null, 2), 'utf8')
          done++
          log(`[scrape] (${done}/${work.length}) ✓ order ${detail.orderSn ?? detail.pathId}`)
        } catch (e) {
          log(`[scrape] ⚠️  failed order ${s.orderSn ?? s.pathId}: ${e instanceof Error ? e.message : String(e)}`)
        }
        if (perOrderDelayMs > 0) await sleep(perOrderDelayMs)
      }
    } finally {
      if (workerNo !== 0) await wp.close().catch(() => {})
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, n) => runWorker(n)))
  const scraped = details.filter(Boolean)

  // 5. Write an index summary file.
  const result: ScrapeOrdersResult = { orderType, reportedCount, summaries, details: scraped, outDir }
  await writeFile(
    resolve(outDir, `_index-${orderType}.json`),
    JSON.stringify(
      { orderType, reportedCount, collected: summaries.length, scraped: scraped.length, summaries },
      null,
      2
    ),
    'utf8'
  )
  log(`[scrape] ✅ done — ${scraped.length}/${work.length} orders saved → ${outDir}`)
  return result
}

/**
 * Block image/media/font/stylesheet requests on the context to speed up page
 * loads. Data extraction only needs the DOM, so this is safe.
 */
async function installResourceBlocker(context: BrowserContext): Promise<void> {
  const blocked = new Set(['image', 'media', 'font'])
  await context.route('**/*', (route: Route) => {
    const type = route.request().resourceType()
    if (blocked.has(type)) return route.abort().catch(() => {})
    return route.continue().catch(() => {})
  })
}

/** Read the "<n> Pesanan" count from the list header. */
async function readReportedCount(page: Page): Promise<number | undefined> {
  const text = await page
    .locator('.order-list-result-count')
    .first()
    .textContent()
    .catch(() => null)
  if (!text) return undefined
  const m = text.replace(/[.,]/g, '').match(/\d+/)
  return m ? Number(m[0]) : undefined
}

/**
 * Collect order summaries from the list, scrolling/clicking "load more" until
 * no new cards appear (or the reported count / limit is reached).
 */
async function collectOrderSummaries(
  page: Page,
  ctx: { reportedCount?: number; limit: number; log: (m: string) => void }
): Promise<OrderSummary[]> {
  const seen = new Map<string, OrderSummary>()
  const target = ctx.limit > 0 ? ctx.limit : ctx.reportedCount ?? Infinity

  let stagnantRounds = 0
  for (let round = 0; round < 200; round++) {
    const batch = await extractSummariesOnPage(page)
    let added = 0
    for (const s of batch) {
      if (!seen.has(s.pathId)) {
        seen.set(s.pathId, s)
        added++
      }
    }
    if (seen.size >= target) break

    // Try clicking a "load more" / pagination next, else scroll.
    const advanced = await advanceList(page)
    if (added === 0 && !advanced) {
      stagnantRounds++
      if (stagnantRounds >= 3) break
    } else {
      stagnantRounds = 0
    }
    await sleep(350)
  }

  const all = [...seen.values()]
  return ctx.limit > 0 ? all.slice(0, ctx.limit) : all
}

/** Extract all visible order-card summaries currently in the DOM. */
async function extractSummariesOnPage(page: Page): Promise<OrderSummary[]> {
  return page.evaluate((origin) => {
    const text = (el: Element | null | undefined): string | undefined => {
      const t = el?.textContent?.trim()
      return t && t.length ? t : undefined
    }
    const out: Array<Record<string, unknown>> = []
    const cards = Array.from(document.querySelectorAll('.order-card'))
    for (const card of cards) {
      // The detail link: an anchor whose href points at /portal/sale/order/<digits>
      let href =
        (card as HTMLAnchorElement).getAttribute?.('href') ??
        card.querySelector('a[href*="/portal/sale/order/"]')?.getAttribute('href') ??
        ''
      const m = href.match(/\/portal\/sale\/order\/(\d+)/)
      if (!m) continue
      const pathId = m[1]

      const snText = text(card.querySelector('.order-sn'))
      const orderSn = snText?.replace(/^.*?(?:No\.?\s*Pesanan)\s*/i, '').trim() || snText

      out.push({
        pathId,
        orderSn,
        detailUrl: `${origin}/portal/sale/order/${pathId}`,
        buyerName: text(card.querySelector('.buyer-username')),
        productName: text(card.querySelector('.item-name')),
        variation: text(card.querySelector('.item-description')),
        qty: text(card.querySelector('.item-amount')),
        totalPrice: text(card.querySelector('.total-price')),
        status: text(card.querySelector('.status')),
        paymentMethod: text(card.querySelector('.payment-method')),
        fulfilmentChannel: text(card.querySelector('.fulfilment-channel-name')),
      })
    }
    return out as unknown as OrderSummary[]
  }, SELLER_ORIGIN)
}

/**
 * Advance the order list: click a "next page" / "load more" control if present,
 * otherwise scroll the window to trigger lazy loading.
 * Returns true if it took a navigation/click action.
 */
async function advanceList(page: Page): Promise<boolean> {
  // Common Shopee pagination: a "next" button in .shopee-react-pagination or
  // .eds-pagination. Try a few likely "next" controls.
  const nextSelectors = [
    'button.shopee-icon-button--right:not([disabled])',
    '.eds-pagination__next:not(.is-disabled):not([disabled])',
    'li.shopee-react-pagination__next:not(.shopee-react-pagination__next--disabled)',
    'button[aria-label="Next Page"]:not([disabled])',
  ]
  for (const sel of nextSelectors) {
    const btn = page.locator(sel).first()
    if (await btn.count().then((c) => c > 0).catch(() => false)) {
      const visible = await btn.isVisible().catch(() => false)
      const enabled = await btn.isEnabled().catch(() => false)
      if (visible && enabled) {
        await btn.click().catch(() => {})
        return true
      }
    }
  }
  // No pager → scroll to bottom to lazy-load more cards.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  return false
}

/** Open an order detail page and extract its full data, retrying if incomplete. */
async function scrapeOrderDetail(page: Page, summary: OrderSummary): Promise<OrderDetail> {
  const maxAttempts = 3
  let last: Awaited<ReturnType<typeof extractDetail>> | undefined

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto(summary.detailUrl, { waitUntil: 'domcontentloaded' })

    // Wait for the detail shell.
    await page
      .locator('.order-detail')
      .first()
      .waitFor({ state: 'visible', timeout: 20000 })
      .catch(() => {})

    // Wait for the data-bearing sections to actually render (they load via XHR
    // AFTER the shell). This is the core fix for "sometimes data is missing".
    await page
      .locator('.product-list .product-list-item:not(.product-list-head)')
      .first()
      .waitFor({ state: 'attached', timeout: 12000 })
      .catch(() => {})
    await page
      .locator('.payment-info-details .income-item')
      .first()
      .waitFor({ state: 'attached', timeout: 12000 })
      .catch(() => {})

    const extracted = await extractDetail(page)
    last = extracted

    // Complete = we got at least one product AND a total/payment line.
    const complete =
      extracted.products.length > 0 &&
      (extracted.paymentBreakdown.length > 0 || extracted.total != null)
    if (complete || attempt === maxAttempts) break
    await sleep(800) // brief backoff before reload
  }

  const extracted = last!
  const detail: OrderDetail = {
    pathId: summary.pathId,
    orderSn: extracted.orderSn ?? summary.orderSn,
    detailUrl: summary.detailUrl,
    status: extracted.status ?? summary.status,
    statusDescription: extracted.statusDescription,
    shippingAddress: extracted.shippingAddress,
    shipping: extracted.shipping,
    products: (extracted.products as OrderProduct[]) ?? [],
    paymentBreakdown: (extracted.paymentBreakdown as PaymentLine[]) ?? [],
    total: extracted.total as PaymentLine | undefined,
    scrapedAt: Date.now(),
  }
  return detail
}

/** Pull all order-detail fields out of the currently-loaded detail page. */
async function extractDetail(page: Page) {
  return page.evaluate(() => {
    const text = (el: Element | null | undefined): string | undefined => {
      const t = el?.textContent?.replace(/\s+/g, ' ').trim()
      return t && t.length ? t : undefined
    }
    const q = (root: ParentNode, sel: string) => root.querySelector(sel)

    // Read a label cleanly: Shopee injects an SVG "?" icon + tooltip popover
    // inside the label, which pollutes textContent. Prefer the first text node,
    // else clone-and-strip the icon/tooltip nodes.
    const cleanLabel = (el: Element | null | undefined): string | undefined => {
      if (!el) return undefined
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) {
          const t = n.textContent?.replace(/\s+/g, ' ').trim()
          if (t) return t
        }
      }
      const clone = el.cloneNode(true) as Element
      clone
        .querySelectorAll('svg, .question, [class*="tooltip"], [class*="popover"]')
        .forEach((x) => x.remove())
      const t = clone.textContent?.replace(/\s+/g, ' ').trim()
      return t && t.length ? t : undefined
    }

    // Status block.
    const statusWrap = q(document, '.order-status-wrapper')
    const status = text(q(document, '.order-status-wrapper .header .status') ?? q(document, '.status'))
    const statusDescription = text(statusWrap?.querySelector('.status-description'))

    // Order SN.
    const orderSn = text(document.querySelector('[data-testid="odp-label-order-id"]'))
      ?.replace(/^.*?(?:No\.?\s*Pesanan)\s*/i, '')
      .trim()

    // Shipping address.
    const addrSection = document.querySelector('[data-testid="odp-label-address"]')
    const shippingAddress = addrSection
      ? {
          buyerContact: text(addrSection.querySelector('.buyer-contact-information')),
          address: text(addrSection.querySelector('.ship-address')),
        }
      : undefined

    // Shipping / courier info.
    const shipSection = document.querySelector('[data-testid="odp-shipping-summary"]')
    const shipping = shipSection
      ? {
          packageLabel: text(shipSection.querySelector('.package-label')),
          carrier: text(shipSection.querySelector('.carrier')),
          actualCarrier: text(shipSection.querySelector('.actual-carrier-name')),
          trackingNumber: text(shipSection.querySelector('.tracking-number-wrapper .label')),
        }
      : undefined

    // Product list — exclude the header row (it carries both
    // .product-list-item and .product-list-head classes).
    const products: Array<Record<string, unknown>> = []
    const rows = Array.from(
      document.querySelectorAll('.product-list .product-list-item:not(.product-list-head)')
    )
    for (const row of rows) {
      const productCell = row.querySelector('.product-item.product') ?? row
      products.push({
        index: text(row.querySelector('.no')),
        name: text(productCell.querySelector('.product-name')) ?? '',
        variation: text(productCell.querySelector('.product-meta')),
        imageUrl:
          (productCell.querySelector('.product-image img') as HTMLImageElement | null)?.src ??
          undefined,
        price: text(row.querySelector('.price')),
        qty: text(row.querySelector('.qty')),
        subtotal: text(row.querySelector('.subtotal')),
      })
    }

    // Seller-income payment breakdown. Label = .income-label-text (cleaned),
    // amount = .income-value.
    const paymentBreakdown: Array<{ label: string; amount: string }> = []
    const incomeItems = Array.from(document.querySelectorAll('.payment-info-details .income-item'))
    for (const item of incomeItems) {
      const label = cleanLabel(item.querySelector('.income-label-text'))
      const amount = text(item.querySelector('.income-value')) ?? ''
      if (label) paymentBreakdown.push({ label, amount })
    }

    // Total ("Total Penghasilan") — the highlighted subtotal row.
    const totalEl = document.querySelector('.income-subtotal.strong.highlighted')
    let total: { label: string; amount: string } | undefined
    if (totalEl) {
      const label = cleanLabel(totalEl.querySelector('.income-label-text')) ?? 'Total Penghasilan'
      const amount = text(totalEl.querySelector('.income-value')) ?? ''
      total = { label, amount }
    }

    return {
      orderSn,
      status,
      statusDescription,
      shippingAddress,
      shipping,
      products,
      paymentBreakdown,
      total,
    }
  })
}
