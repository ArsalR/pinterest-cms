// src/routes/frontend/robots.ts
// /robots.txt — dynamic, driven by seo_robots_default. Always blocks /admin/* and /api/*.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { loadSettings } from "../../lib/defaults"

export const robotsRoute = new Hono<AppEnv>()

robotsRoute.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")
  const settings = await loadSettings(siteDb)

  const robots = (settings.seo_robots_default || "index,follow").toLowerCase()
  const lines: string[] = []

  if (robots.includes("noindex")) {
    lines.push("User-agent: *")
    lines.push("Disallow: /")
  } else {
    lines.push("User-agent: *")
    lines.push("Disallow: /admin/")
    lines.push("Disallow: /admin")
    lines.push("Disallow: /api/")
    lines.push("Disallow: /api")
    lines.push("Allow: /")
  }
  lines.push("")
  lines.push(`Sitemap: https://${hostname}/sitemap.xml`)

  return new Response(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  })
})
