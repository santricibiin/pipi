/**
 * Multi-token store for the web UI.
 *
 * The admin token (env `WEB_TOKEN`) is the owner key — it can manage guest
 * tokens. Each *guest* token here is a separate access key you can hand out to
 * one person and revoke individually, without disturbing anyone else.
 *
 * Tokens are persisted to `.web-tokens.json` (gitignored — it grants access to
 * buyer PII). No external dependencies; plain JSON on disk.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Where guest tokens are stored. NEVER commit this file. */
const TOKENS_PATH = resolve('.web-tokens.json')

export type GuestToken = {
  /** The secret token string (goes in `?token=…`). */
  token: string
  /** Human label so you remember who it's for (e.g. "Budi"). */
  label: string
  /** When it was created (epoch ms). */
  createdAt: number
  /** Last time a request used it (epoch ms), if ever. */
  lastSeen?: number
}

// In-memory cache so we don't hit disk on every request.
let cache: GuestToken[] | null = null

async function load(): Promise<GuestToken[]> {
  if (cache) return cache
  try {
    const raw = await readFile(TOKENS_PATH, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    cache = Array.isArray(parsed) ? (parsed as GuestToken[]) : []
  } catch {
    cache = []
  }
  return cache
}

async function persist(): Promise<void> {
  await writeFile(TOKENS_PATH, JSON.stringify(cache ?? [], null, 2), 'utf8')
}

/** Public, immutable snapshot of the stored guest tokens. */
export async function listTokens(): Promise<GuestToken[]> {
  return [...(await load())]
}

/** Create a new guest token with a label. Returns the created entry. */
export async function createToken(label: string): Promise<GuestToken> {
  const tokens = await load()
  // base64url → URL- and cookie-safe (no +, /, =).
  const token = randomBytes(18).toString('base64url')
  const entry: GuestToken = {
    token,
    label: (label || '').trim() || 'Tanpa nama',
    createdAt: Date.now(),
  }
  tokens.push(entry)
  await persist()
  return entry
}

/** Remove a guest token. Returns true if something was removed. */
export async function revokeToken(token: string): Promise<boolean> {
  const tokens = await load()
  const idx = tokens.findIndex((t) => t.token === token)
  if (idx === -1) return false
  tokens.splice(idx, 1)
  await persist()
  return true
}

/** Update the lastSeen timestamp for a guest token (best-effort). */
export async function touchToken(token: string): Promise<void> {
  const tokens = await load()
  const t = tokens.find((x) => x.token === token)
  if (!t) return
  t.lastSeen = Date.now()
  // Fire-and-forget persist; don't block the request on it.
  void persist()
}
