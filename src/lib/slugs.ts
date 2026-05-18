// src/lib/slugs.ts
// Slug helpers shared between admin and public API post routes.

import type { Client } from "@libsql/client/web"

/**
 * Return `base` if it is unique in the posts table, otherwise append -2, -3…
 * until a free slot is found. Excludes `excludeId` from the uniqueness check
 * so editing a post doesn't collide with its own current slug.
 */
export async function ensureUniqueSlug(
  siteDb: Client,
  base: string,
  excludeId?: string
): Promise<string> {
  let slug = base
  let i = 2
  while (true) {
    const sql = excludeId
      ? "SELECT id FROM posts WHERE slug = ? AND id != ? LIMIT 1"
      : "SELECT id FROM posts WHERE slug = ? LIMIT 1"
    const args = excludeId ? [slug, excludeId] : [slug]
    const r = await siteDb.execute({ sql, args })
    if (!r.rows.length) return slug
    slug = `${base}-${i++}`
    if (i > 1000) throw new Error("Could not generate unique slug")
  }
}
