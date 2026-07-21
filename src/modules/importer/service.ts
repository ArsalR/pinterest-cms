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
import { dispatchRebuild } from "../seo"
import { uploadToR2 } from "../../lib/r2"
import { cuid } from "../../lib/utils"
import {
  parseWxr, parseRestPosts, slugify, originalPath, contentPath, extractImageUrls, rewriteImageUrls,
  type WpPost, type ParseOptions,
} from "./wordpress"

export interface ImportResult {
  imported: number
  /** Of `imported`, how many were WordPress Pages (post_type='page'). */
  pagesImported: number
  /** Of `imported`, how many went live immediately (publish-as-was). */
  publishedLive: number
  skippedExisting: number
  skippedNonPost: number
  redirectsCreated: number
  imagesRehosted: number
  /** True when the per-run image budget was hit — re-run to fetch the rest. */
  imagesTruncated: boolean
  /** How many imported items carried Yoast / Rank Math SEO meta (S2). */
  seoMapped: number
  total: number
}

export interface ImportOptions {
  /** Recreate the site as it was: publish items whose WP status was 'publish'
   *  (keeping their original date) instead of importing everything as drafts. */
  publishLive?: boolean
  /** Bring WordPress Pages across too (not just posts). */
  includePages?: boolean
}

// Cap remote image fetches per import run so a big migration can't blow the
// Worker subrequest budget. Excess images keep their original URLs and the
// result flags `imagesTruncated` so the UI can invite a resume run.
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

/** Fetch external images, upload to R2, record a media row, and rewrite the
 *  content's <img src>. `truncated` is set when the budget ran out mid-way so
 *  the remaining images (still on their original URLs) can be fetched on a
 *  re-run. */
async function rehostImages(
  env: CloudflareEnv, siteDb: Client, hostname: string, html: string, budget: { left: number }
): Promise<{ html: string; rehosted: number; truncated: boolean }> {
  const urls = extractImageUrls(html)
  if (!urls.length) return { html, rehosted: 0, truncated: false }
  if (budget.left <= 0) return { html, rehosted: 0, truncated: true }
  const map = new Map<string, string>()
  let truncated = false
  for (const url of urls) {
    if (budget.left <= 0) { truncated = true; break }
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
      // Track it in the media library like a native upload (source='wordpress').
      await siteDb.execute({
        sql: `INSERT INTO media (id, url, filename, size, source, r2_key) VALUES (?, ?, ?, ?, 'wordpress', ?)`,
        args: [cuid(), up.url, name.slice(0, 200), bytes.byteLength, up.key],
      }).catch(() => {})
    } catch {
      // leave this image at its original URL
    }
  }
  return { html: map.size ? rewriteImageUrls(html, map) : html, rehosted: map.size, truncated }
}

async function importOne(
  env: CloudflareEnv,
  siteDb: Client,
  hostname: string,
  p: WpPost,
  budget: { left: number },
  opts: ImportOptions
): Promise<{ inserted: boolean; redirect: boolean; rehosted: number; truncated: boolean; seoMapped: boolean; published: boolean; isPage: boolean }> {
  const exists = await siteDb.execute({ sql: "SELECT 1 FROM posts WHERE slug = ? LIMIT 1", args: [p.slug] })
  if (exists.rows.length) return { inserted: false, redirect: false, rehosted: 0, truncated: false, seoMapped: false, published: false, isPage: p.type === "page" }

  const { html, rehosted, truncated } = await rehostImages(env, siteDb, hostname, p.contentHtml, budget)
  const categoryId = p.categories.length ? await ensureCategory(siteDb, p.categories[0]) : null
  const s = p.seo
  // Publish-as-was: when the caller asked to recreate the live site AND this
  // item was published in WordPress, it goes live immediately, keeping its
  // original date and honoring any imported noindex. Otherwise it lands as a
  // draft to clear the quality gate first (the safe default). WP Pages are
  // stored as posts (the static template renders type='post') so they go live
  // and stay editable; their old URL is 301'd below.
  const goLive = !!opts.publishLive && p.status === "publish"
  const published = goLive ? 1 : 0
  const publishedAt = goLive ? p.publishedAt || new Date().toISOString() : null
  // Pages keep type='page' so the static template renders them at the root
  // /<slug>/ (where they lived in WordPress); posts render under /posts/.
  await siteDb.execute({
    sql: `INSERT INTO posts
            (id, title, slug, content, excerpt, published, published_at, type, source, category_id,
             seo_title, seo_description, seo_keywords, og_title, og_description, og_image,
             canonical_url, no_index, nofollow)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'wordpress', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      cuid(), p.title || p.slug, p.slug, html, p.excerpt || null, published, publishedAt, p.type, categoryId,
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

  // Edge redirect map: old permalink → new path (301). ON CONFLICT keeps
  // re-import idempotent and never clobbers a manually-set redirect. Pages keep
  // their root URL (/about/ → /about/, a no-op skipped below); a moved permalink
  // (/company/about/ → /about/) still gets its redirect.
  let redirect = false
  const from = originalPath(p.originalUrl)
  const to = contentPath(p.type, p.slug)
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
  return { inserted: true, redirect, rehosted, truncated, seoMapped: !!p.seo, published: goLive, isPage: p.type === "page" }
}

/** Site context the importer needs to write content and trigger a rebuild. */
export interface ImportSite {
  cmsSiteId: string
  hostname: string
  customerId: string
  repoFullName: string | null
}

async function importPosts(env: CloudflareEnv, site: ImportSite, posts: WpPost[], skippedNonPost: number, opts: ImportOptions): Promise<ImportResult> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const siteDb = await siteDbFor(master, site.cmsSiteId)
  const res: ImportResult = {
    imported: 0, pagesImported: 0, publishedLive: 0, skippedExisting: 0, skippedNonPost,
    redirectsCreated: 0, imagesRehosted: 0, imagesTruncated: false, seoMapped: 0, total: posts.length,
  }
  if (!siteDb) return res

  const budget = { left: MAX_IMAGE_REHOSTS }
  for (const p of posts) {
    try {
      const r = await importOne(env, siteDb, site.hostname, p, budget, opts)
      if (r.inserted) {
        res.imported++
        if (r.isPage) res.pagesImported++
        if (r.published) res.publishedLive++
        if (r.redirect) res.redirectsCreated++
        if (r.seoMapped) res.seoMapped++
        res.imagesRehosted += r.rehosted
        if (r.truncated) res.imagesTruncated = true
      } else {
        res.skippedExisting++
      }
    } catch {
      res.skippedExisting++
    }
  }
  // Anything that went live needs a static rebuild to actually appear on the
  // customer's site. Best-effort — no-op when GitHub isn't connected.
  if (res.publishedLive > 0) {
    await dispatchRebuild(env, master, site.customerId, site.repoFullName, "wordpress-import").catch(() => {})
  }
  return res
}

/** Import from a pasted or uploaded WXR export string. */
export async function importWordpress(env: CloudflareEnv, site: ImportSite, wxr: string, opts: ImportOptions = {}): Promise<ImportResult> {
  const parseOpts: ParseOptions = { includePages: opts.includePages }
  const { posts, skipped } = parseWxr(wxr, parseOpts)
  return importPosts(env, site, posts, skipped, opts)
}

/**
 * Import via the WordPress REST API of a live site. Best-effort, paginated;
 * returns a friendly error string if the site isn't reachable / has REST off.
 */
export async function importWordpressRest(
  env: CloudflareEnv,
  site: ImportSite,
  siteUrl: string,
  opts: ImportOptions = {}
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
  return importPosts(env, site, all, 0, opts)
}
