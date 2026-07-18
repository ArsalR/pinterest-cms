// Image sitemap (V1.3 Image SEO profile) — image-namespace entries on the
// pages that contain them (cover + in-content images per post). Emitted ONLY
// when the image profile is on; joined into the sitemap index by
// gen-redirects.mjs. 404 (no file) otherwise — byte-identical.
import type { APIRoute } from "astro"
import { loadConfig, fetchAllPosts, fetchSeoSettings, canonicalHost, profileOn, contentImageUrls } from "../lib/cms"

function esc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c)
}

export const GET: APIRoute = async () => {
  const config = loadConfig()
  const settings = await fetchSeoSettings(config)
  if (!profileOn(settings, "image")) return new Response(null, { status: 404 })

  const host = canonicalHost(config)
  const posts = await fetchAllPosts(config)

  const entries = posts
    .map((p) => {
      const images = [...(p.coverImage ? [p.coverImage] : []), ...contentImageUrls(p.content)].slice(0, 100)
      if (!images.length) return null
      const tags = images.map((u) => `    <image:image>\n      <image:loc>${esc(u)}</image:loc>\n    </image:image>`).join("\n")
      return `  <url>\n    <loc>https://${host}/posts/${esc(p.slug)}/</loc>\n${tags}\n  </url>`
    })
    .filter(Boolean)
    .join("\n")

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries}
</urlset>
`
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } })
}
