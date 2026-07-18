// src/modules/seo/newsService.ts
// News SEO data layer (V1.3 P2): authors CRUD (E-E-A-T backbone — useful to
// every profile), the site's IndexNow key, and the fast-indexing ping fired on
// publish. Best-effort throughout — indexing pings never block publishing.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { siteDbFor, dispatchRebuild } from "./service"
import { indexNowKeyFrom, indexNowPayload } from "./news"

export interface Author {
  id: string
  name: string
  slug: string
  bio: string
  photo: string
  sameAs: string[]
}

function arr(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

export async function listAuthors(master: Client, cmsSiteId: string): Promise<Author[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb.execute({ sql: "SELECT * FROM authors ORDER BY name", args: [] }).catch(() => null)
  return (r?.rows ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    slug: String(row.slug ?? ""),
    bio: String(row.bio ?? ""),
    photo: String(row.photo ?? ""),
    sameAs: arr(row.same_as),
  }))
}

export function authorSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "author"
}

export async function saveAuthor(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  id: string, input: { name: string; bio: string; photo: string; sameAs: string[] }, master: Client
): Promise<{ ok: boolean; error?: string }> {
  if (!input.name.trim()) return { ok: false, error: "The author's name is required." }
  if (input.photo && !/^https:\/\/\S+$/.test(input.photo)) return { ok: false, error: "The photo must be an https:// URL." }
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }
  if (id) {
    await siteDb.execute({
      sql: "UPDATE authors SET name=?, bio=?, photo=?, same_as=? WHERE id=?",
      args: [input.name.trim(), input.bio.trim() || null, input.photo.trim() || null, JSON.stringify(input.sameAs), id],
    })
  } else {
    await siteDb.execute({
      sql: "INSERT INTO authors (id, name, slug, bio, photo, same_as) VALUES (?, ?, ?, ?, ?, ?)",
      args: [cuid(), input.name.trim(), authorSlug(input.name), input.bio.trim() || null, input.photo.trim() || null, JSON.stringify(input.sameAs)],
    })
  }
  await dispatchRebuild(env, master, customerId, repoFullName, "authors")
  return { ok: true }
}

export async function deleteAuthor(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  id: string, master: Client
): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "UPDATE posts SET author_id = NULL WHERE author_id = ?", args: [id] }).catch(() => {})
  await siteDb.execute({ sql: "DELETE FROM authors WHERE id = ?", args: [id] }).catch(() => {})
  await dispatchRebuild(env, master, customerId, repoFullName, "authors")
}

// ─────────────────────── IndexNow ───────────────────────

/** The site's IndexNow key, generated + stored on first use. Null on failure. */
export async function ensureIndexNowKey(siteDb: Client): Promise<string | null> {
  try {
    const r = await siteDb.execute({ sql: "SELECT indexnow_key FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    const existing = r.rows.length ? (r.rows[0].indexnow_key as string | null) : null
    if (existing) return existing
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    const key = indexNowKeyFrom(bytes)
    await siteDb.execute({
      sql: `INSERT INTO seo_settings (id, indexnow_key) VALUES ('default', ?)
            ON CONFLICT(id) DO UPDATE SET indexnow_key = COALESCE(seo_settings.indexnow_key, excluded.indexnow_key)`,
      args: [key],
    })
    // Re-read in case a concurrent writer won.
    const r2 = await siteDb.execute({ sql: "SELECT indexnow_key FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    return r2.rows.length ? ((r2.rows[0].indexnow_key as string | null) ?? key) : key
  } catch {
    return null
  }
}

/** Fire an IndexNow ping for freshly published URLs. Best-effort; returns
 *  whether the ping was accepted. NEVER throws into a publish path. */
export async function pingIndexNow(siteDb: Client, host: string, urls: string[]): Promise<boolean> {
  if (!urls.length) return false
  try {
    const key = await ensureIndexNowKey(siteDb)
    if (!key) return false
    const resp = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(indexNowPayload(host, key, urls)),
    })
    return resp.ok || resp.status === 202
  } catch {
    return false
  }
}

/** Is the news profile on for this site DB? (read directly — used by the
 *  publishing hook, which holds the site DB, not the settings service). */
export async function newsProfileOn(siteDb: Client): Promise<boolean> {
  try {
    const r = await siteDb.execute({ sql: "SELECT profiles FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    if (!r.rows.length) return false
    const profiles = arr(r.rows[0].profiles)
    return profiles.includes("news")
  } catch {
    return false
  }
}
