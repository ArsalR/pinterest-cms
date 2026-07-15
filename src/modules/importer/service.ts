// src/modules/importer/service.ts
// Writes parsed WordPress posts into a customer site's CMS as DRAFTS
// (published=0, source='wordpress'), so imported content still has to clear the
// quality gate before it can go live. Slug collisions are skipped (idempotent
// re-import). Categories are created on demand and the first one is linked.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { cuid } from "../../lib/utils"
import { parseWxr, slugify, type WpPost } from "./wordpress"

export interface ImportResult {
  imported: number
  skippedExisting: number
  skippedNonPost: number
  total: number
}

async function siteDbFor(master: Client, cmsSiteId: string): Promise<Client | null> {
  const r = await master.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [cmsSiteId] })
  if (!r.rows.length) return null
  return getSiteDb(r.rows[0].turso_url as string, r.rows[0].turso_token as string)
}

async function ensureCategory(siteDb: Client, name: string): Promise<string | null> {
  const slug = slugify(name)
  const existing = await siteDb.execute({ sql: "SELECT id FROM categories WHERE slug = ? LIMIT 1", args: [slug] })
  if (existing.rows.length) return String(existing.rows[0].id)
  const id = cuid()
  try {
    await siteDb.execute({ sql: "INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)", args: [id, name, slug] })
    return id
  } catch {
    return null // race or constraint — non-fatal, post just imports uncategorized
  }
}

/** Insert one post as a draft. Returns true if inserted, false if the slug exists. */
async function importOne(siteDb: Client, p: WpPost): Promise<boolean> {
  const exists = await siteDb.execute({ sql: "SELECT 1 FROM posts WHERE slug = ? LIMIT 1", args: [p.slug] })
  if (exists.rows.length) return false
  const categoryId = p.categories.length ? await ensureCategory(siteDb, p.categories[0]) : null
  await siteDb.execute({
    sql: `INSERT INTO posts (id, title, slug, content, excerpt, published, type, source, category_id, seo_description)
          VALUES (?, ?, ?, ?, ?, 0, 'post', 'wordpress', ?, ?)`,
    args: [cuid(), p.title || p.slug, p.slug, p.contentHtml, p.excerpt || null, categoryId, p.excerpt || null],
  })
  return true
}

/**
 * Parse a WXR export and import its posts as drafts into the site's CMS.
 * Best-effort per post — one failure never aborts the batch.
 */
export async function importWordpress(env: CloudflareEnv, cmsSiteId: string, wxr: string): Promise<ImportResult> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const siteDb = await siteDbFor(master, cmsSiteId)
  const { posts, skipped } = parseWxr(wxr)
  if (!siteDb) return { imported: 0, skippedExisting: 0, skippedNonPost: skipped, total: posts.length }

  let imported = 0
  let skippedExisting = 0
  for (const p of posts) {
    try {
      if (await importOne(siteDb, p)) imported++
      else skippedExisting++
    } catch {
      skippedExisting++ // treat an insert failure as "not imported", keep going
    }
  }
  return { imported, skippedExisting, skippedNonPost: skipped, total: posts.length }
}
