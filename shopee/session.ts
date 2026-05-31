/**
 * Persist and load an authenticated Shopee seller session.
 *
 * We use Playwright's native `context.storageState()` which captures cookies
 * plus per-origin localStorage in a format that can be fed straight back into
 * `browser.newContext({ storageState })`. We wrap it with a little metadata
 * (shop name, capture time, UA) so it's self-describing on disk.
 */

import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import type { BrowserContext, Page } from 'playwright'
import type { ShopeeSession } from './types'

/** Default directory where Shopee sessions are stored. */
export const SESSIONS_DIR = resolve('shopee', 'sessions')

/** Make a filesystem-safe slug from a shop name. */
export function slugify(name: string | undefined): string {
  if (!name) return 'shopee-session'
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'shopee-session'
  )
}

/** Capture the current authenticated session and write it to disk. */
export async function saveSession(
  context: BrowserContext,
  page: Page,
  outPath: string,
  shopName: string | undefined
): Promise<string> {
  const abs = resolve(outPath)
  await mkdir(dirname(abs), { recursive: true })

  const storageState = await context.storageState()
  let userAgent = ''
  try {
    userAgent = await page.evaluate(() => navigator.userAgent)
  } catch {}

  const session: ShopeeSession = {
    shopName,
    finalUrl: page.url(),
    capturedAt: Date.now(),
    userAgent,
    storageState
  }

  await writeFile(abs, JSON.stringify(session, null, 2), 'utf-8')
  return abs
}

/** Load a previously saved session from disk. */
export async function loadSession(path: string): Promise<ShopeeSession> {
  const abs = resolve(path)
  const raw = await readFile(abs, 'utf-8')
  return JSON.parse(raw) as ShopeeSession
}

/**
 * Find the newest saved session file in `shopee/sessions/`, by mtime.
 * Returns its absolute path, or undefined if the dir is empty / missing.
 */
export async function findLatestSession(dir: string = SESSIONS_DIR): Promise<string | undefined> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return undefined // dir doesn't exist yet
  }
  const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith('.json'))
  if (jsonFiles.length === 0) return undefined

  let newest: { path: string; mtime: number } | undefined
  for (const f of jsonFiles) {
    const p = join(dir, f)
    try {
      const s = await stat(p)
      if (!newest || s.mtimeMs > newest.mtime) {
        newest = { path: p, mtime: s.mtimeMs }
      }
    } catch {
      // skip unreadable entry
    }
  }
  return newest?.path
}
