// src/routes/public/v1/seo.ts
// V1.2 S1 — per-post SEO OVERRIDE fields (additive endpoint). The four columns
// added in migration 006 aren't in the frozen /v1/posts shape, so the template
// reads them here and merges by post id at build time. Read-only, Bearer-authed,
// same conventions as the rest of /v1. Absent overrides = the template's current
// output exactly.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const seoRoutes = new Hono<AppEnv>()

// GET /v1/seo — every published post's SEO override fields.
seoRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  const r = await siteDb.execute({
    sql: `SELECT id, slug, sitemap_exclude, nofollow, schema_type, faq_json
          FROM posts WHERE published = 1`,
    args: [],
  })
  const seo = r.rows.map((row) => ({
    id: String(row.id),
    slug: String(row.slug ?? ""),
    sitemapExclude: Number(row.sitemap_exclude) === 1,
    nofollow: Number(row.nofollow) === 1,
    schemaType: (row.schema_type as string | null) ?? null,
    faq: parseFaq(row.faq_json as string | null),
  }))
  await logApiRequest(siteDb, auth.keyId, "/v1/seo", "GET", 200)
  return c.json({ success: true, seo })
})

function parseFaq(raw: string | null): Array<{ question: string; answer: string }> | null {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as Array<{ question?: string; answer?: string }>
    if (!Array.isArray(arr)) return null
    const out = arr
      .map((f) => ({ question: String(f.question ?? "").trim(), answer: String(f.answer ?? "").trim() }))
      .filter((f) => f.question && f.answer)
    return out.length ? out : null
  } catch {
    return null
  }
}
