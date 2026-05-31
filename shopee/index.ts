/**
 * CLI entry for Shopee auto-login.
 *
 * Usage:
 *   npm run shopee                                  # use saved session if any, else cookies; keep browser open
 *   npm run shopee -- --headless                    # headless
 *   npm run shopee -- --cookies ./cookies.txt --proxy http://user:pass@host:port
 *   npm run shopee -- --use-session ./shopee/sessions/myshop.json   # load a specific session
 *   npm run shopee -- --no-use-session              # skip saved sessions, force cookies.txt
 *   npm run shopee -- --session ./out/myshop.json   # where to SAVE the session
 *   npm run shopee -- --no-session                  # don't save the session
 *   npm run shopee -- --close                       # close browser after login (default: keep open)
 */

import { shopeeLogin } from './login'
import type { ShopeeLoginOptions } from './types'

function parseArgs(argv: string[]): ShopeeLoginOptions {
  const opts: ShopeeLoginOptions = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--headless':
        opts.headless = true
        break
      case '--cookies':
        opts.cookiesPath = argv[++i]
        break
      case '--proxy':
        opts.proxyUrl = argv[++i]
        break
      case '--use-session':
        opts.useSession = argv[++i]
        break
      case '--no-use-session':
        opts.useSession = false
        break
      case '--session':
        opts.saveSession = argv[++i]
        break
      case '--no-session':
        opts.saveSession = false
        break
      case '--close':
        opts.keepOpen = false
        break
      default:
        console.warn(`[shopee] unknown arg: ${arg}`)
    }
  }
  return opts
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const result = await shopeeLogin(opts)
  // Note: when keepOpen is true (default), shopeeLogin blocks and we never
  // reach here — the browser stays alive until Ctrl+C.
  process.exit(result.success ? 0 : 1)
}

main().catch((err) => {
  console.error(`[shopee] fatal: ${err instanceof Error ? err.stack ?? err.message : err}`)
  process.exit(1)
})
