// src/modules/importer/service.ts
// Writes parsed WordPress posts into a customer site's CMS as DRAFTS
// (published=0, source='wordpress'), so imported content still clears the
// quality gate before publishing. On the way in it also:
//   • rehosts external images into R2 and rewrites their <img src> (K9 "→ R2");
//   • records an edge redirect from each old permalink to the new /posts/slug/
//     (K9 "edge redirects map"), so inbound links + SEO survive the migration.
// Slug collisions are skipped (idempotent re-import). Everything is best-effort
// per post — one failure never aborts the batch.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { uploadToR2 } from "../../lib/r2"
import { cuid } from "../../lib/utils"
import {
  parseWxr, parseRestPosts, slugify, originalPath, extractImageUrls, rewriteImageUrls, type WpPost,
} from "./wordpress"

export interface ImportResult {
  imported: number
  skippedExisting: number
  skippedNonPost: number
  redirectsCreated: number
  imagesRehosted: number
  /** How many imported drafts carried Yoast / Rank Math SEO meta (S2). */
  seoMapped: number
  total: number
}

// Cap remote image fetches per import run so a big migration can't blow the
// Worker subrequest budget. Excess images keep their original URLs.
const MAX_IMAGE_REHOSTS = 80

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
    return null
  }
}

/** Fetch external images, upload to R2, and rewrite the content's <img src>. */
async function rehostImages(env: CloudflareEnv, hostname: string, html: string, budget: { left: number }): Promise<{ html: string; rehosted: number }> {
  const urls = extractImageUrls(html)
  if (!urls.length || budget.left <= 0) return { html, rehosted: 0 }
  const map = new Map<string, string>()
  for (const url of urls) {
    if (budget.left <= 0) break
    try {
      const resp = await fetch(url)
      if (!resp.ok) continue
      const type = resp.headers.get("content-type") || "image/jpeg"
      if (!type.startsWith("image/")) continue
      const bytes = await resp.arrayBuffer()
      if (bytes.byteLength > 10 * 1024 * 1024) continue // 10MB cap, mirrors upload API
      const name = url.split("/").pop()?.split("?")[0] || "image"
      const up = await uploadToR2(env, hostname, name, bytes, type)
      map.set(url, up.url)
      budget.left--
    } catch {
      // leave this image at its original URL
    }
  }
  return { html: map.size ? rewriteImageUrls(html, map) : html, rehosted: map.size }
}

async function importOne(
  env: CloudflareEnv,
  siteDb: Client,
  hostname: string,
  p: WpPost,
  budget: { left: number }
): Promise<{ inserted: boolean; redirect: boolean; rehosted: number; seoMapped: boolean }> {
  const exists = await siteDb.execute({ sql: "SELECT 1 FROM posts WHERE slug = ? LIMIT 1", args: [p.slug] })
  if (exists.rows.length) return { inserted: false, redirect: false, rehosted: 0, seoMapped: false }

  const { html, rehosted } = await rehostImages(env, hostname, p.contentHtml, budget)
  const categoryId = p.categories.length ? await ensureCategory(siteDb, p.categories[0]) : null
  // Yoast / Rank Math SEO meta (S2), when the export carried it. Imports as a
  // DRAFT (published=0), so a mapped noindex stays inert until the post is
  // published through the pipeline — no live page is deindexed by an import.
  const s = p.seo
  await siteDb.execute({
    sql: `INSERT INTO posts
            (id, title, slug, content, excerpt, published, type, source, category_id,
             seo_title, seo_description, seo_keywords, og_title, og_description, og_image,
             canonical_url, no_index, nofollow)
          VALUES (?, ?, ?, ?, ?, 0, 'post', 'wordpress', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      cuid(), p.title || p.slug, p.slug, html, p.excerpt || null, categoryId,
      s?.seoTitle || null,
      s?.seoDescription || p.excerpt || null,
      s?.focusKeyword || null,
      s?.ogTitle || null,
      s?.ogDescription || null,
      s?.ogImage || null,
      s?.canonicalUrl || null,
      s?.noindex ? 1 : 0,
      s?.nofollow ? 1 : 0,
    ],
  })

  // Edge redirect map: old permalink → new post path (301). ON CONFLICT keeps
  // re-import idempotent and never clobbers a manually-set redirect.
  let redirect = false
  const from = originalPath(p.originalUrl)
  const to = `/posts/${p.slug}/`
  if (from && from !== to) {
    try {
      await siteDb.execute({
        sql: `INSERT INTO redirects (id, from_path, target, kind, match_type, message)
              VALUES (?, ?, ?, '301', 'exact', 'Imported from WordPress')
              ON CONFLICT(from_path) DO NOTHING`,
        args: [cuid(), from, to],
      })
      redirect = true
    } catch {
      // non-fatal — the post still imported
    }
  }
  return { inserted: true, redirect, rehosted, seoMapped: !!p.seo }
}

async function importPosts(env: CloudflareEnv, cmsSiteId: string, hostname: string, posts: WpPost[], skippedNonPost: number): Promise<ImportResult> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const siteDb = await siteDbFor(master, cmsSiteId)
  const res: ImportResult = { imported: 0, skippedExisting: 0, skippedNonPost, redirectsCreated: 0, imagesRehosted: 0, seoMapped: 0, total: posts.length }
  if (!siteDb) return res

  const budget = { left: MAX_IMAGE_REHOSTS }
  for (const p of posts) {
    try {
      const r = await importOne(env, siteDb, hostname, p, budget)
      if (r.inserted) {
        res.imported++
        if (r.redirect) res.redirectsCreated++
        if (r.seoMapped) res.seoMapped++
        res.imagesRehosted += r.rehosted
      } else {
        res.skippedExisting++
      }
    } catch {
      res.skippedExisting++
    }
  }
  return res
}

/** Import from a pasted WXR export string. */
export async function importWordpress(env: CloudflareEnv, cmsSiteId: string, hostname: string, wxr: string): Promise<ImportResult> {
  const { posts, skipped } = parseWxr(wxr)
  return importPosts(env, cmsSiteId, hostname, posts, skipped)
}

/**
 * Import via the WordPress REST API of a live site. Best-effort, paginated;
 * returns a friendly error string if the site isn't reachable / has REST off.
 */
export async function importWordpressRest(
  env: CloudflareEnv,
  cmsSiteId: string,
  hostname: string,
  siteUrl: string
): Promise<ImportResult | { error: string }> {
  let base: string
  try {
    base = new URL(siteUrl).origin
  } catch {
    return { error: "That doesn't look like a valid site URL." }
  }
  const all: WpPost[] = []
  for (let page = 1; page <= 10; page++) {
    let batch: WpPost[] = []
    try {
      const resp = await fetch(`${base}/wp-json/wp/v2/posts?per_page=100&page=${page}&_embed=1`, {
        headers: { Accept: "application/json" },
      })
      if (resp.status === 400) break // past the last page
      if (!resp.ok) {
        if (page === 1) return { error: "Couldn't reach that site's WordPress REST API. Make sure the URL is right and the API isn't disabled." }
        break
      }
      batch = parseRestPosts(await resp.json().catch(() => null))
    } catch {
      if (page === 1) return { error: "Couldn't connect to that site — check the URL and try again." }
      break
    }
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 100) break
  }
  if (!all.length) return { error: "No posts found at that site's REST API." }
  return importPosts(env, cmsSiteId, hostname, all, 0)
}
