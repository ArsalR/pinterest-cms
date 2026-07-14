// RSS 2.0 feed (SEO file set, amendment 3). Static, built at deploy time from
// the CMS posts — no client JS, no runtime dependency.
import type { APIRoute } from "astro"
import { loadConfig, fetchAllPosts, canonicalHost } from "../lib/cms"

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c
  )
}

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const host = canonicalHost(config)
  const base = `https://${host}`
  const posts = await fetchAllPosts(config)

  const items = posts
    .slice(0, 50)
    .map((p) => {
      const url = `${base}/posts/${p.slug}/`
      const date = p.publishedAt ? new Date(p.publishedAt.replace(" ", "T") + "Z").toUTCString() : ""
      return `    <item>
      <title>${esc(p.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      ${date ? `<pubDate>${date}</pubDate>` : ""}
      <description>${esc(p.excerpt ?? "")}</description>
    </item>`
    })
    .join("\n")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(config.name)}</title>
    <link>${base}/</link>
    <description>${esc(config.niche)}</description>
    <language>en</language>
    <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } })
}
