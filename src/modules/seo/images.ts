// src/modules/seo/images.ts
// Image SEO (S2) — media-library hygiene: alt-text bulk edit + filename
// slugify, the Yoast/Rank Math "media SEO" feature set. Operates on the site's
// `media` table (library metadata) — it does NOT touch already-built pages, so
// it's byte-identical for the live site until images are (re)used. Direct
// site-DB writes, same pattern as the cockpit. AI-suggest (✨) is deferred with
// the rest of S1's AI assists pending the decision-#9 resolution.

import type { Client } from "@libsql/client/web"
import { siteDbFor } from "./service"

/** Slugify a filename while preserving its extension. Pure, unit-tested.
 *  "My Photo (1).JPG" → "my-photo-1.jpg". Empty base falls back to "image". */
export function slugifyFilename(name: string): string {
  const dot = name.lastIndexOf(".")
  const hasExt = dot > 0 && dot < name.length - 1
  const base = hasExt ? name.slice(0, dot) : name
  const ext = hasExt ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]+/g, "") : ""
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "image"
  return ext ? `${slug}.${ext}` : slug
}

export interface SiteImage {
  id: string
  url: string
  filename: string
  alt: string | null
  width: number | null
  height: number | null
  hasAlt: boolean
}

export interface ImageLibrary {
  images: SiteImage[]
  total: number
  missingAlt: number
}

/** List the media library with alt-coverage stats for the image-SEO page. */
export async function listSiteImages(master: Client, cmsSiteId: string, limit = 500): Promise<ImageLibrary> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { images: [], total: 0, missingAlt: 0 }
  const r = await siteDb.execute({
    sql: "SELECT id, url, filename, alt, width, height FROM media ORDER BY created_at DESC LIMIT ?",
    args: [limit],
  })
  let missingAlt = 0
  const images: SiteImage[] = r.rows.map((row) => {
    const alt = (row.alt as string | null) ?? null
    const hasAlt = !!(alt && alt.trim())
    if (!hasAlt) missingAlt++
    return {
      id: String(row.id),
      url: String(row.url ?? ""),
      filename: String(row.filename ?? ""),
      alt,
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      hasAlt,
    }
  })
  return { images, total: images.length, missingAlt }
}

export interface AltUpdate {
  id: string
  alt: string
}

export interface BulkResult {
  updated: number
  error?: string
}

/** Bulk-set alt text on media rows. Empty alt clears the field. */
export async function bulkUpdateAlt(master: Client, cmsSiteId: string, updates: AltUpdate[]): Promise<BulkResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { updated: 0, error: "The content workspace is unavailable." }
  let updated = 0
  for (const u of updates) {
    if (!u.id) continue
    const alt = (u.alt ?? "").trim()
    try {
      const res = await siteDb.execute({ sql: "UPDATE media SET alt = ? WHERE id = ?", args: [alt || null, u.id] })
      updated += Number(res.rowsAffected ?? 0)
    } catch {
      // skip a bad row, keep the batch going
    }
  }
  return { updated }
}

/** Slugify the stored filename of the given media rows (library display name). */
export async function slugifyFilenames(master: Client, cmsSiteId: string, ids: string[]): Promise<BulkResult> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { updated: 0, error: "The content workspace is unavailable." }
  let updated = 0
  for (const id of ids) {
    if (!id) continue
    try {
      const r = await siteDb.execute({ sql: "SELECT filename FROM media WHERE id = ? LIMIT 1", args: [id] })
      if (!r.rows.length) continue
      const clean = slugifyFilename(String(r.rows[0].filename ?? ""))
      const res = await siteDb.execute({ sql: "UPDATE media SET filename = ? WHERE id = ?", args: [clean, id] })
      updated += Number(res.rowsAffected ?? 0)
    } catch {
      // skip
    }
  }
  return { updated }
}
