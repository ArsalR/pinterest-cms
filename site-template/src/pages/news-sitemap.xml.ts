// Google News sitemap (V1.3 News SEO profile). Emitted ONLY when the news
// profile is on — 404 (no file) otherwise, keeping non-news sites
// byte-identical. Follows Google's news-sitemap rules (mirrors
// src/modules/seo/news.ts): news namespace 0.9, publication name + language,
// W3C publication_date, ONLY the last 48 hours, ≤1000 URLs. A valid empty
// urlset is emitted when nothing is recent so the URL stays stable for
// Search Console.
import type { APIRoute } from "astro"
import { loadConfig, fetchAllPosts, fetchSeoSettings, canonicalHost, profileOn } from "../lib/cms"

const WINDOW_MS = 48 * 3600 * 1000
const MAX_URLS = 1000

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c)
}

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  if (!profileOn(settings, "news")) return new Response(null, { status: 404 })

  const host = canonicalHost(config)
  const posts = await fetchAllPosts(config)
  const now = Date.now()
  const recent = posts
    .filter((p) => {
      if (!p.publishedAt) return false
      const t = Date.parse(p.publishedAt.includes("T") ? p.publishedAt : p.publishedAt.replace(" ", "T") + "Z")
      return Number.isFinite(t) && now - t <= WINDOW_MS
    })
    .sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, MAX_URLS)

  const urls = recent
    .map((p) => {
      const iso = new Date(Date.parse(p.publishedAt!.includes("T") ? p.publishedAt! : p.publishedAt!.replace(" ", "T") + "Z")).toISOString()
      return `  <url>
    <loc>https://${host}/posts/${p.slug}/</loc>
    <news:news>
      <news:publication>
        <news:name>${esc(config.name)}</news:name>
        <news:language>en</news:language>
      </news:publication>
      <news:publication_date>${iso}</news:publication_date>
      <news:title>${esc(p.title)}</news:title>
    </news:news>
  </url>`
    })
    .join("\n")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>
`
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } })
}
