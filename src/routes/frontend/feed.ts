// src/routes/frontend/feed.ts
// RSS 2.0 feed — latest 20 published posts. Includes <enclosure> for cover images.

import { Hono } from "hono"
import type { AppEnv, Category } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"
import { buildPostPath } from "../../lib/seo"
import { plainExcerpt } from "../../lib/utils"

export const feedRoute = new Hono<AppEnv>()

feedRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)

  const res = await siteDb.execute(`
    SELECT p.id, p.title, p.slug, p.excerpt, p.content, p.cover_image,
           p.published_at, p.created_at, c.slug AS cat_slug, c.name AS cat_name
    FROM posts p LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.published = 1 AND p.type = 'post' AND p.no_index = 0
    ORDER BY p.published_at DESC
    LIMIT 20
  `)

  const base = `https://${hostname}`
  const siteName = settings.seo_site_name || settings.site_name || hostname
  const desc = settings.seo_default_description || settings.site_tagline || ""

  const items = res.rows
    .map((r) => {
      const path = buildPostPath(
        {
          slug: r.slug as string,
          published_at: (r.published_at as string | null) ?? null,
          created_at: r.created_at as string,
        },
        r.cat_slug ? ({ slug: r.cat_slug as string } as Category) : null,
        settings
      )
      const link = `${base}${path}`
      const pubDate = toRfc822((r.published_at as string) || (r.created_at as string))
      const excerpt =
        (r.excerpt as string | null) || plainExcerpt((r.content as string) || "", 280)
      const cover = (r.cover_image as string | null) ?? null
      return `    <item>
      <title>${esc(r.title as string)}</title>
      <link>${esc(link)}</link>
      <guid isPermaLink="true">${esc(link)}</guid>
      <pubDate>${esc(pubDate)}</pubDate>
      ${r.cat_name ? `<category>${esc(r.cat_name as string)}</category>` : ""}
      <description>${esc(excerpt)}</description>
      ${
        cover
          ? `<enclosure url="${esc(cover)}" type="${esc(guessMime(cover))}" length="0" />`
          : ""
      }
      <content:encoded><![CDATA[${(r.content as string) || ""}]]></content:encoded>
    </item>`
    })
    .join("\n")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${esc(siteName)}</title>
    <link>${esc(base)}/</link>
    <description>${esc(desc)}</description>
    <language>en</language>
    <atom:link href="${esc(base)}/feed.xml" rel="self" type="application/rss+xml" />
    <lastBuildDate>${esc(new Date().toUTCString())}</lastBuildDate>
${items}
  </channel>
</rss>`

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  })
})

function toRfc822(input: string): string {
  const d = new Date(input)
  return isNaN(d.getTime()) ? new Date().toUTCString() : d.toUTCString()
}

function guessMime(url: string): string {
  const lower = url.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".avif")) return "image/avif"
  return "image/jpeg"
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}
