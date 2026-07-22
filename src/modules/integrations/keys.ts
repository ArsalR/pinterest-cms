// src/modules/integrations/keys.ts
// Scoped integration keys (V1.5 M2) — the "connect anything" credential.
// sk_site_… keys, hashed at rest (PBKDF2, same as passwords), with a scope set
// the public API enforces via validateApiKey → permitScope. Separate from the
// frozen cms_live_ keys so that contract stays byte-identical.

import type { Client } from "@libsql/client/web"
import { generateScopedKey, hashPassword } from "../../lib/auth"
import { cuid } from "../../lib/utils"

export const SCOPES = [
  { id: "read-posts", label: "Read posts", hint: "GET /v1/posts, /v1/categories, /v1/seo" },
  { id: "write-posts", label: "Create & edit posts", hint: "POST/PUT/DELETE /v1/posts, uploads" },
  { id: "read-forms", label: "Read form submissions", hint: "GET /v1/forms" },
  { id: "read-mail-meta", label: "Read mailbox metadata", hint: "message counts + envelopes (no bodies)" },
  { id: "read-analytics", label: "Read analytics", hint: "traffic + engagement rollups" },
  { id: "manage-redirects", label: "Manage redirects", hint: "create/update redirects" },
] as const
export const SCOPE_IDS = SCOPES.map((s) => s.id)
export function isScope(v: string): boolean { return (SCOPE_IDS as readonly string[]).includes(v) }

export interface ScopedKeyRow {
  id: string; name: string; keyPreview: string; scopes: string[]
  lastUsedAt: string | null; usageCount: number; createdAt: string
}

function rowTo(row: Record<string, unknown>): ScopedKeyRow {
  let scopes: string[] = []
  try { const p = JSON.parse(String(row.scopes ?? "[]")); scopes = Array.isArray(p) ? p.map(String) : [] } catch { /* ignore */ }
  return {
    id: String(row.id), name: String(row.name ?? ""), keyPreview: String(row.key_preview ?? ""),
    scopes, lastUsedAt: (row.last_used_at as string | null) ?? null,
    usageCount: Number(row.usage_count) || 0, createdAt: String(row.created_at ?? ""),
  }
}

export async function listScopedKeys(siteDb: Client): Promise<ScopedKeyRow[]> {
  const r = await siteDb.execute({ sql: "SELECT * FROM scoped_api_keys WHERE active = 1 ORDER BY created_at DESC LIMIT 200", args: [] }).catch(() => null)
  return (r?.rows ?? []).map((row) => rowTo(row as Record<string, unknown>))
}

/** Create a key and return the RAW value ONCE (never stored in plaintext). */
export async function createScopedKey(siteDb: Client, name: string, scopes: string[]): Promise<{ id: string; key: string } | null> {
  const clean = scopes.filter(isScope)
  if (!clean.length) return null
  const key = generateScopedKey()
  const hash = await hashPassword(key)
  const id = cuid()
  try {
    await siteDb.execute({
      sql: "INSERT INTO scoped_api_keys (id, name, key_hash, key_preview, scopes) VALUES (?, ?, ?, ?, ?)",
      args: [id, name.slice(0, 80) || "Integration key", hash, key.slice(-4), JSON.stringify(clean)],
    })
    return { id, key }
  } catch {
    return null
  }
}

export async function revokeScopedKey(siteDb: Client, id: string): Promise<void> {
  await siteDb.execute({ sql: "UPDATE scoped_api_keys SET active = 0 WHERE id = ?", args: [id] }).catch(() => {})
}
