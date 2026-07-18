// src/routes/public/v1/authors.ts
// V1.3 News SEO profile — authors for the template build (additive endpoint).
// Read-only, Bearer-authed. Empty when unused → byte-identical builds.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const authorRoutes = new Hono<AppEnv>()

authorRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let authors: unknown[] = []
  try {
    const r = await siteDb.execute({ sql: "SELECT * FROM authors ORDER BY name", args: [] })
    authors = r.rows.map((row) => {
      let sameAs: string[] = []
      try {
        const a = JSON.parse(String(row.same_as ?? "[]")) as unknown
        if (Array.isArray(a)) sameAs = a.map((x) => String(x)).filter(Boolean)
      } catch {
        /* ignore */
      }
      return {
        id: String(row.id),
        name: String(row.name ?? ""),
        slug: String(row.slug ?? ""),
        bio: String(row.bio ?? ""),
        photo: String(row.photo ?? ""),
        sameAs,
      }
    })
  } catch {
    // table not migrated yet → empty
  }
  await logApiRequest(siteDb, auth.keyId, "/v1/authors", "GET", 200)
  return c.json({ success: true, authors })
})
