// src/routes/public/v1/local.ts
// V1.3 Local SEO profile — business locations for the template build (additive
// endpoint). Read-only, Bearer-authed, same conventions as /v1. Empty when the
// profile is unused, so the build stays byte-identical.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"

export const localRoutes = new Hono<AppEnv>()

function jsonArr(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

function hoursObj(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw.trim()) return { weekly: {}, holidays: [] }
  try {
    return JSON.parse(raw)
  } catch {
    return { weekly: {}, holidays: [] }
  }
}

// GET /v1/local — every business location (primary first).
localRoutes.get("/", async (c) => {
  const siteDb = c.get("siteDb")
  const auth = await validateApiKey(siteDb, c.req.raw, "read")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let locations: unknown[] = []
  try {
    const r = await siteDb.execute({
      sql: "SELECT * FROM business_locations ORDER BY is_primary DESC, created_at ASC",
      args: [],
    })
    locations = r.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      subtype: String(row.subtype ?? "LocalBusiness"),
      street: String(row.street ?? ""),
      city: String(row.city ?? ""),
      region: String(row.region ?? ""),
      postal: String(row.postal ?? ""),
      country: String(row.country ?? ""),
      phone: String(row.phone ?? ""),
      hours: hoursObj(row.hours_json),
      latitude: row.latitude == null ? null : Number(row.latitude),
      longitude: row.longitude == null ? null : Number(row.longitude),
      serviceAreas: jsonArr(row.service_areas),
      priceRange: String(row.price_range ?? ""),
      gbpUrl: String(row.gbp_url ?? ""),
      ratingValue: row.rating_value == null ? null : Number(row.rating_value),
      ratingCount: row.rating_count == null ? null : Number(row.rating_count),
      isPrimary: Number(row.is_primary) === 1,
      slug: String(row.slug ?? ""),
    }))
  } catch {
    // table not migrated yet → empty (byte-identical)
  }
  await logApiRequest(siteDb, auth.keyId, "/v1/local", "GET", 200)
  return c.json({ success: true, locations })
})
