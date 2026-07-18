// src/routes/public/v1/merchant.ts
// V1.3 Ecommerce SEO profile — merchant config + per-product extras for the
// template build (additive; the frozen /v1/products shape is untouched).

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const merchantRoutes = new Hono<AppEnv>()

merchantRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let config: unknown = null
  let products: unknown[] = []
  try {
    const r = await siteDb.execute({ sql: "SELECT merchant_json FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    if (r.rows.length && typeof r.rows[0].merchant_json === "string") {
      try {
        config = JSON.parse(String(r.rows[0].merchant_json))
      } catch {
        config = null
      }
    }
  } catch {
    /* not migrated */
  }
  try {
    const r = await siteDb.execute({
      sql: "SELECT id, slug, brand, gtin, mpn, condition, rating_value, rating_count FROM products WHERE published = 1",
      args: [],
    })
    products = r.rows.map((row) => ({
      id: String(row.id),
      slug: String(row.slug ?? ""),
      brand: (row.brand as string | null) ?? null,
      gtin: (row.gtin as string | null) ?? null,
      mpn: (row.mpn as string | null) ?? null,
      condition: (row.condition as string | null) ?? null,
      ratingValue: row.rating_value == null ? null : Number(row.rating_value),
      ratingCount: row.rating_count == null ? null : Number(row.rating_count),
    }))
  } catch {
    /* not migrated */
  }
  await logApiRequest(siteDb, auth.keyId, "/v1/merchant", "GET", 200)
  return c.json({ success: true, config, products })
})
