// src/routes/frontend/sitemap.ts
// Dynamic /sitemap.xml — all published, non-noindex posts + categories + homepage.
// Includes <image:image> entries for posts (cover + gallery) so Google Images
// indexes them — critical for visual / Pinterest-style sites.

import { Hono } from "hono"
import type { AppEnv, Category } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { buildPostPath, buildCategoryPath } from "../../lib/seo"

export const sitemapRoute = new Hono<AppEnv>()

// Sitemap protocol caps a single file at 50,000 URLs. Hard limit defensively.
const MAX_URLS = 45000
// Per-URL cap for <image:image> children. Cap at 20 (cover + 19 gallery) for sane file sizes.
const IMAGES_PER_URL = 20

sitemapRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)

  const [postsRes, catsRes] = await Promise.all([
    siteDb.execute({
      sql: `
        SELECT p.id, p.slug, p.title, p.published_at, p.updated_at, p.created_at,
               p.cover_image, c.slug AS cat_slug, p.type
        FROM posts p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.published = 1 AND p.no_index = 0
        ORDER BY p.published_at DESC
        LIMIT ?`,
      args: [MAX_URLS],
    }),
    siteDb.execute("SELECT slug, cover_image, name, created_at FROM categories ORDER BY created_at DESC LIMIT 5000"),
  ])

  // Fetch gallery images for all posts in one query.
  const postIds = postsRes.rows.map((r) => r.id as string)
  const imagesByPost = new Map<string, Array<{ url: string; alt: string | null }>>()
  if (postIds.length) {
    const placeholders = postIds.map(() => "?").join(",")
    const imgRes = await siteDb.execute({
      sql: `SELECT post_id, url, alt FROM post_images
            WHERE post_id IN (${placeholders})
            ORDER BY ord ASC LIMIT ${MAX_URLS * IMAGES_PER_URL}`,
      args: postIds,
    })
    for (const r of imgRes.rows) {
      const pid = r.post_id as string
      const arr = imagesByPost.get(pid) ?? []
      if (arr.length < IMAGES_PER_URL) {
        arr.push({ url: r.url as string, alt: (r.alt as string | null) ?? null })
        imagesByPost.set(pid, arr)
      }
    }
  }

  const base = `https://${hostname}`
  const urls: string[] = []

  // Homepage.
  urls.push(buildUrlEntry(`${base}/`, new Date().toISOString(), "1.0", "daily"))

  // Posts and pages.
  for (const r of postsRes.rows) {
    const isPage = (r.type as string) === "page"
    const path = isPage
      ? `/${r.slug}/`
      : buildPostPath(
          {
            slug: r.slug as string,
            published_at: (r.published_at as string | null) ?? null,
            created_at: r.created_at as string,
          },
          r.cat_slug ? ({ slug: r.cat_slug as string } as Category) : null,
          settings
        )
    const lastmod = (r.updated_at as string) || (r.published_at as string) || (r.created_at as string)

    // Build <image:image> children: cover + gallery.
    const imgList: Array<{ url: string; alt: string | null }> = []
    const cover = r.cover_image as string | null
    if (cover) imgList.push({ url: cover, alt: r.title as string })
    const gallery = imagesByPost.get(r.id as string) ?? []
    for (const g of gallery) {
      if (imgList.length >= IMAGES_PER_URL) break
      if (imgList.some((x) => x.url === g.url)) continue
      imgList.push(g)
    }

    urls.push(
      buildUrlEntry(
        `${base}${path}`,
        lastmod,
        isPage ? "0.6" : "0.8",
        isPage ? "monthly" : "weekly",
        imgList
      )
    )
  }

  // Categories.
  for (const r of catsRes.rows) {
    const path = buildCategoryPath(r.slug as string, settings)
    const cover = r.cover_image as string | null
    const imgList = cover ? [{ url: cover, alt: r.name as string }] : []
    urls.push(
      buildUrlEntry(
        `${base}${path}`,
        (r.created_at as string) || new Date().toISOString(),
        "0.6",
        "weekly",
        imgList
      )
    )
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset
  xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
  xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.join("\n")}
</urlset>`

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  })
})

function buildUrlEntry(
  loc: string,
  lastmod: string,
  priority: string,
  changefreq: string,
  images: Array<{ url: string; alt: string | null }> = []
): string {
  const imgXml = images
    .map(
      (i) => `    <image:image>
      <image:loc>${escapeXml(i.url)}</image:loc>${i.alt ? `\n      <image:caption>${escapeXml(i.alt)}</image:caption>` : ""}
    </image:image>`
    )
    .join("\n")
  return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${escapeXml(toW3cDate(lastmod))}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>${imgXml ? "\n" + imgXml : ""}
  </url>`
}

function toW3cDate(input: string): string {
  const d = new Date(input)
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString()
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
