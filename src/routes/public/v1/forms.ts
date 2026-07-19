// src/routes/public/v1/forms.ts
// V1.4 F1 — active form definitions for the template build (additive).
// The template renders each form as static HTML from these defs; the submit
// endpoint validates against the same stored defs. Read-only, Bearer-authed.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const formDefRoutes = new Hono<AppEnv>()

formDefRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let forms: unknown[] = []
  try {
    const r = await siteDb.execute({ sql: "SELECT id, slug, title, fields_json FROM forms WHERE active = 1 ORDER BY created_at", args: [] })
    forms = r.rows.map((row) => {
      let fields: unknown[] = []
      try {
        const a = JSON.parse(String(row.fields_json ?? "[]")) as unknown
        if (Array.isArray(a)) fields = a
      } catch {
        /* ignore */
      }
      return { id: String(row.id), slug: String(row.slug ?? ""), title: String(row.title ?? ""), fields }
    })
  } catch {
    // table not migrated yet → none
  }
  await logApiRequest(siteDb, auth.keyId, "/v1/forms", "GET", 200)
  return c.json({ success: true, forms })
})
