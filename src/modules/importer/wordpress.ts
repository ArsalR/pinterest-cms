// src/modules/importer/wordpress.ts
// WordPress import (K9) — PURE parser for the WXR ("WordPress eXtended RSS")
// export format, fully unit-tested. Workers have no XML DOM, and WXR is
// regular and CDATA-wrapped, so a targeted extractor is both sufficient and
// dependency-free. The service layer writes the result into a customer site's
// CMS as DRAFTS, so everything still flows through the quality gate before it
// can publish.

export interface WpPost {
  title: string
  slug: string
  contentHtml: string
  excerpt: string
  status: string        // original WP status: publish | draft | private | …
  publishedAt: string | null // ISO, from wp:post_date_gmt when present
  categories: string[]
  originalUrl: string   // the old permalink — drives the edge redirect map
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/** Pull a tag's text, unwrapping a CDATA section if present. Pure. */
export function tagText(xml: string, tag: string): string {
  // tag may contain a namespace colon (content:encoded, wp:post_name).
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i")
  const m = re.exec(xml)
  if (!m) return ""
  const inner = m[1]
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(inner)
  return cdata ? cdata[1] : decodeEntities(inner.trim())
}

function categoriesOf(itemXml: string): string[] {
  const out: string[] = []
  const re = /<category[^>]*domain="category"[^>]*>([\s\S]*?)<\/category>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(itemXml)) !== null) {
    const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(m[1])
    const name = (cdata ? cdata[1] : decodeEntities(m[1])).trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

function toIso(wpDate: string): string | null {
  // wp:post_date_gmt looks like "2024-03-01 12:00:00"; treat as UTC.
  const s = wpDate.trim()
  if (!s || s.startsWith("0000")) return null
  const t = Date.parse(s.replace(" ", "T") + "Z")
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** Slugify a title as a fallback when wp:post_name is empty. Pure. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "post"
}

export interface ParseResult {
  posts: WpPost[]
  skipped: number   // non-post items (pages, attachments, nav_menu_item, …)
}

/**
 * Parse a WXR export string into normalized posts. Only `post` items are
 * returned; pages/attachments/menu items are counted as skipped. Robust to
 * missing fields — a malformed item is skipped, never throws. Pure.
 */
export function parseWxr(xml: string): ParseResult {
  const posts: WpPost[] = []
  let skipped = 0
  const itemRe = /<item\b[\s\S]*?<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[0]
    try {
      const type = tagText(item, "wp:post_type") || "post"
      if (type !== "post") { skipped++; continue }
      const title = tagText(item, "title")
      const content = tagText(item, "content:encoded")
      // An item with neither title nor content isn't worth importing.
      if (!title && !content) { skipped++; continue }
      const slug = tagText(item, "wp:post_name") || slugify(title)
      posts.push({
        title,
        slug,
        contentHtml: content,
        excerpt: tagText(item, "excerpt:encoded"),
        status: tagText(item, "wp:status") || "draft",
        publishedAt: toIso(tagText(item, "wp:post_date_gmt") || tagText(item, "wp:post_date")),
        categories: categoriesOf(item),
        originalUrl: tagText(item, "link"),
      })
    } catch {
      skipped++
    }
  }
  return { posts, skipped }
}

// ─────────────────────── REST API import ───────────────────────

interface WpRestPost {
  slug?: string
  status?: string
  link?: string
  date_gmt?: string
  title?: { rendered?: string }
  content?: { rendered?: string }
  excerpt?: { rendered?: string }
  _embedded?: { "wp:term"?: Array<Array<{ taxonomy?: string; name?: string }>> }
}

/**
 * Normalize a WordPress REST API posts array (`/wp-json/wp/v2/posts?_embed`)
 * into the same WpPost shape as the WXR parser. Pure — unit-tested.
 */
export function parseRestPosts(json: unknown): WpPost[] {
  if (!Array.isArray(json)) return []
  const out: WpPost[] = []
  for (const raw of json as WpRestPost[]) {
    try {
      const title = decodeEntities((raw.title?.rendered ?? "").trim())
      const content = raw.content?.rendered ?? ""
      if (!title && !content) continue
      const cats: string[] = []
      for (const group of raw._embedded?.["wp:term"] ?? []) {
        for (const term of group) {
          if (term.taxonomy === "category" && term.name) cats.push(decodeEntities(term.name))
        }
      }
      out.push({
        title,
        slug: raw.slug || slugify(title),
        contentHtml: content,
        excerpt: (raw.excerpt?.rendered ?? "").replace(/<[^>]+>/g, "").trim(),
        status: raw.status || "publish",
        publishedAt: toIso(raw.date_gmt ?? ""),
        categories: cats,
        originalUrl: raw.link ?? "",
      })
    } catch {
      // skip a malformed record, keep the rest
    }
  }
  return out
}

// ─────────────────────── redirect + media helpers (pure) ───────────────────────

/** The path portion of an old permalink, for the redirect map. Pure. */
export function originalPath(url: string): string | null {
  try {
    const p = new URL(url).pathname
    return p && p !== "/" ? p : null
  } catch {
    return null
  }
}

/** All <img src> URLs in the HTML (absolute http/https only). Pure. */
export function extractImageUrls(html: string): string[] {
  const out: string[] = []
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (/^https?:\/\//i.test(m[1]) && !out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** Replace image URLs per a src→newSrc map (e.g. old host → R2). Pure. */
export function rewriteImageUrls(html: string, map: Map<string, string>): string {
  let out = html
  for (const [from, to] of map) {
    out = out.split(from).join(to)
  }
  return out
}
