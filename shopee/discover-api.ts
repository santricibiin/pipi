/**
 * API discovery — capture the internal Shopee Seller API calls that back the
 * order list + order detail pages, so we can call them directly (much faster
 * than rendering the SPA with Camoufox).
 *
 * Run:  npx tsx shopee/discover-api.ts            # uses saved session
 *       npx tsx shopee/discover-api.ts <pathId>   # also probe a detail page
 *
 * It navigates the pages, records every JSON XHR/fetch, and prints a summary of
 * the candidate endpoints (URL, method, and the top-level keys of the response).
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { establishShopeeSession } from './login'

const SELLER_ORIGIN = 'https://seller.shopee.co.id'

type Captured = {
  url: string
  method: string
  status: number
  resourceType: string
  postData?: string | null
  reqHeaders?: Record<string, string>
  keys?: string[]
  sample?: unknown
}

async function main(): Promise<void> {
  const pathId = process.argv[2] || '229491008230333'
  const outDir = resolve('referensiDOM')
  await mkdir(outDir, { recursive: true })

  const { session, result } = await establishShopeeSession({ headless: true })
  if (!result.success) {
    console.error('[discover] ❌ not logged in')
    await session.close()
    process.exit(1)
  }

  const page = session.page
  const captured: Captured[] = []

  page.on('response', async (res) => {
    try {
      const req = res.request()
      const url = res.url()
      const type = req.resourceType()
      // Only care about API-ish JSON calls on the Shopee domain.
      if (type !== 'xhr' && type !== 'fetch') return
      if (!/shopee\.co\.id/.test(url)) return
      const ct = res.headers()['content-type'] ?? ''
      if (!ct.includes('json')) return

      let body: unknown
      try {
        body = await res.json()
      } catch {
        return
      }
      const keys =
        body && typeof body === 'object' ? Object.keys(body as Record<string, unknown>) : undefined
      const isKey = /search_order_list_index|get_order_list_card_list|get_one_order|get_order_income_components|get_package|get_forder_logistics/.test(
        url
      )
      captured.push({
        url,
        method: req.method(),
        status: res.status(),
        resourceType: type,
        postData: isKey ? req.postData() : undefined,
        reqHeaders: isKey ? req.headers() : undefined,
        keys,
        sample: body,
      })
    } catch {
      // ignore individual capture errors
    }
  })

  // 1. Order list.
  const listUrl = `${SELLER_ORIGIN}/portal/sale/order?type=completed`
  console.log(`[discover] → list: ${listUrl}`)
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)

  // 2. Order detail.
  const detailUrl = `${SELLER_ORIGIN}/portal/sale/order/${pathId}`
  console.log(`[discover] → detail: ${detailUrl}`)
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)

  // Summarise: keep only the interesting API paths (drop tracking/analytics).
  const interesting = captured.filter(
    (c) =>
      /\/api\//.test(c.url) &&
      !/track|metric|log|monitor|beacon|collect|stat/i.test(c.url)
  )

  console.log(`\n[discover] captured ${captured.length} JSON calls, ${interesting.length} interesting:\n`)
  for (const c of interesting) {
    const shortUrl = c.url.split('?')[0].replace(SELLER_ORIGIN, '')
    console.log(`  ${c.method} ${c.status}  ${shortUrl}`)
    if (c.keys) console.log(`      keys: ${c.keys.join(', ')}`)
  }

  const outPath = resolve(outDir, 'api-capture.json')
  await writeFile(outPath, JSON.stringify(captured, null, 2), 'utf8')
  console.log(`\n[discover] full capture (with response bodies) → ${outPath}`)

  await session.close()
}

main().catch((e) => {
  console.error(`[discover] fatal: ${e instanceof Error ? e.stack ?? e.message : e}`)
  process.exit(1)
})
