/**
 * CLI entry for the Shopee order scraper.
 *
 * Authenticates (reusing a saved session if available, else cookies.txt),
 * walks the completed-orders list, scrapes each order detail, and writes one
 * JSON per order under `result/`.
 *
 * Usage:
 *   npm run shopee:orders                          # scrape ALL completed orders (fast API mode)
 *   npm run shopee:orders -- --browser             # use the slower browser-render mode
 *   npm run shopee:orders -- --show                # run with a visible window
 *   npm run shopee:orders -- --limit 5             # only the first 5 (handy for testing)
 *   npm run shopee:orders -- --pages 2             # only the first 2 index pages (≤80 orders)
 *   npm run shopee:orders -- --concurrency 8       # parallel requests/tabs (api default 8, browser 4)
 *   npm run shopee:orders -- --type completed      # order tab (default: completed)
 *   npm run shopee:orders -- --out ./result        # output directory
 *   npm run shopee:orders -- --no-block-resources  # load images/fonts too (browser mode, slower)
 *   npm run shopee:orders -- --use-session ./shopee/sessions/myshop.json
 *   npm run shopee:orders -- --no-use-session      # skip saved sessions, force cookies.txt
 *   npm run shopee:orders -- --cookies ./cookies.txt --proxy http://user:pass@host:port
 */

import { establishShopeeSession } from './login'
import { scrapeOrders } from './scrape-orders'
import { scrapeOrdersApi, scrapeOrdersApiDirect } from './scrape-orders-api'
import type { ShopeeLoginOptions } from './types'
import type { ScrapeOrdersOptions } from './order-types'

type Args = { login: ShopeeLoginOptions; scrape: ScrapeOrdersOptions; mode: 'api' | 'browser' }

function parseArgs(argv: string[]): Args {
  // Scraping defaults to headless so it can run unattended.
  const login: ShopeeLoginOptions = { headless: true }
  const scrape: ScrapeOrdersOptions = {}
  // Default to the fast direct-API mode.
  let mode: 'api' | 'browser' = 'api'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--api':
        mode = 'api'
        break
      case '--browser':
      case '--render':
        mode = 'browser'
        break
      case '--show':
      case '--headful':
        login.headless = false
        break
      case '--headless':
        login.headless = true
        break
      case '--cookies':
        login.cookiesPath = argv[++i]
        break
      case '--proxy':
        login.proxyUrl = argv[++i]
        break
      case '--use-session':
        login.useSession = argv[++i]
        break
      case '--no-use-session':
        login.useSession = false
        break
      case '--no-session':
        login.saveSession = false
        break
      case '--type':
        scrape.orderType = argv[++i]
        break
      case '--limit':
        scrape.limit = Number(argv[++i]) || 0
        break
      case '--pages':
        scrape.maxPages = Number(argv[++i]) || 0
        break
      case '--out':
        scrape.outDir = argv[++i]
        break
      case '--delay':
        scrape.perOrderDelayMs = Number(argv[++i]) || 0
        break
      case '--concurrency':
        scrape.concurrency = Number(argv[++i]) || 1
        break
      case '--block-resources':
        scrape.blockResources = true
        break
      case '--no-block-resources':
        scrape.blockResources = false
        break
      default:
        console.warn(`[scrape] unknown arg: ${arg}`)
    }
  }
  return { login, scrape, mode }
}

async function main(): Promise<void> {
  const { login, scrape, mode } = parseArgs(process.argv.slice(2))

  // Fast path: API mode can run WITHOUT a browser by reusing saved cookies.
  // This skips the ~30-40s Camoufox/Firefox startup entirely. If the saved
  // session is expired, we fall back to a full browser login automatically.
  if (mode === 'api' && login.useSession !== false) {
    try {
      await scrapeOrdersApiDirect(scrape, typeof login.useSession === 'string' ? login.useSession : undefined)
      return
    } catch (e) {
      const authFailed = (e as { authFailed?: boolean }).authFailed
      if (!authFailed) {
        // Genuine error (network etc.) — surface it.
        throw e
      }
      console.warn('[scrape] ⚠️  saved session expired — falling back to browser login...')
    }
  }

  // Establish auth but DO NOT hold the browser open — we drive it ourselves.
  const { session, result } = await establishShopeeSession(login)
  try {
    if (!result.success) {
      console.error('[scrape] ❌ not logged in — cannot scrape. Re-export cookies and retry.')
      process.exitCode = 1
      return
    }
    if (mode === 'api') {
      await scrapeOrdersApi(session.page, scrape)
    } else {
      await scrapeOrders(session.page, scrape)
    }
  } finally {
    await session.close()
  }
}

main().catch((err) => {
  console.error(`[scrape] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`)
  process.exit(1)
})
