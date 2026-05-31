/**
 * Detect the logged-in Shopee seller's shop / account name.
 *
 * Shopee Seller Center renders the shop name in a few places depending on
 * the build (top-right account menu, sidebar header, page title). We try a
 * prioritized list of strategies and return the first non-empty hit. None of
 * these are guaranteed stable — Shopee ships frequent DOM changes — so the
 * caller should treat a missing name as non-fatal.
 */

import type { Page } from 'playwright'

const NAME_SELECTORS = [
  // Top-right account dropdown trigger
  '.navbar-account__name',
  '.shopee-popover__ref .account-name',
  '[class*="account"] [class*="name"]',
  // Sidebar / header shop label
  '.shop-name',
  '[class*="shop-name"]',
  '[class*="ShopName"]',
  // Generic seller header
  'header [class*="seller"] [class*="name"]'
]

function clean(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const t = value.replace(/\s+/g, ' ').trim()
  return t.length > 0 && t.length < 120 ? t : undefined
}

export async function detectShopName(page: Page): Promise<string | undefined> {
  // 1. Try known DOM selectors.
  for (const sel of NAME_SELECTORS) {
    try {
      const el = page.locator(sel).first()
      if ((await el.count()) > 0) {
        const txt = clean(await el.innerText({ timeout: 1500 }))
        if (txt) return txt
      }
    } catch {
      // selector invalid on this build / element detached — keep trying
    }
  }

  // 2. Fall back to in-page heuristics: window state and the document title.
  try {
    const fromState = await page.evaluate(() => {
      const pick = (v: unknown): string | undefined =>
        typeof v === 'string' && v.trim() ? v.trim() : undefined

      // Shopee often stashes shop info on a global or in localStorage.
      const w = window as unknown as Record<string, any>
      const candidates: Array<string | undefined> = [
        pick(w?.__INITIAL_STATE__?.shop?.name),
        pick(w?.__INITIAL_STATE__?.account?.username),
        pick(w?.shopInfo?.name)
      ]
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i)
          if (!k) continue
          if (/shop.*name|username|account.*name/i.test(k)) {
            candidates.push(pick(window.localStorage.getItem(k)))
          }
        }
      } catch {}

      return candidates.find((c) => c)
    })
    const cleaned = clean(fromState)
    if (cleaned) return cleaned
  } catch {
    // page.evaluate can fail if the page navigated — ignore
  }

  // 3. Document title as a last resort (e.g. "MyShop - Shopee Seller Centre").
  try {
    const title = clean(await page.title())
    if (title && !/login|seller cent(er|re)/i.test(title)) {
      return title.split(/[-|–]/)[0]?.trim() || title
    }
  } catch {}

  return undefined
}
