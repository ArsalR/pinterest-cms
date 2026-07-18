// src/modules/seo/localService.ts
// Local SEO data layer — business_locations CRUD in the site CMS DB, then a
// covenant-gated rebuild. Same direct-write pattern as the rest of the module.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { siteDbFor, dispatchRebuild } from "./service"
import { parseHours, locationSlug, isLocalSubtype, type BusinessLocation, type HoursModel } from "./local"

function arr(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

function rowToLocation(row: Record<string, unknown>): BusinessLocation {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    subtype: String(row.subtype ?? "LocalBusiness"),
    street: String(row.street ?? ""),
    city: String(row.city ?? ""),
    region: String(row.region ?? ""),
    postal: String(row.postal ?? ""),
    country: String(row.country ?? ""),
    phone: String(row.phone ?? ""),
    hours: parseHours(row.hours_json),
    latitude: row.latitude == null ? null : Number(row.latitude),
    longitude: row.longitude == null ? null : Number(row.longitude),
    serviceAreas: arr(row.service_areas),
    priceRange: String(row.price_range ?? ""),
    gbpUrl: String(row.gbp_url ?? ""),
    ratingValue: row.rating_value == null ? null : Number(row.rating_value),
    ratingCount: row.rating_count == null ? null : Number(row.rating_count),
    isPrimary: Number(row.is_primary) === 1,
    slug: String(row.slug ?? ""),
  }
}

/** All locations, primary first. [] when the table is empty/missing. */
export async function listLocations(master: Client, cmsSiteId: string): Promise<BusinessLocation[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const r = await siteDb
    .execute({ sql: "SELECT * FROM business_locations ORDER BY is_primary DESC, created_at ASC", args: [] })
    .catch(() => null)
  return (r?.rows ?? []).map((row) => rowToLocation(row as Record<string, unknown>))
}

export interface LocationInput {
  name: string
  subtype: string
  street: string; city: string; region: string; postal: string; country: string
  phone: string
  hours: HoursModel
  latitude: number | null
  longitude: number | null
  serviceAreas: string[]
  priceRange: string
  gbpUrl: string
  ratingValue: number | null
  ratingCount: number | null
  isPrimary: boolean
}

export function validateLocation(input: LocationInput): string | null {
  if (!input.name.trim()) return "The business name is required."
  const hasAddress = !!(input.street.trim() && input.city.trim())
  if (!hasAddress && input.serviceAreas.length === 0) {
    return "Give either a street address + city, or at least one service area (for businesses without a storefront)."
  }
  if (input.subtype && !isLocalSubtype(input.subtype)) return "Unknown business type."
  if (input.gbpUrl && !/^https:\/\/\S+$/.test(input.gbpUrl)) return "The Business Profile link must be an https:// URL."
  if ((input.ratingValue == null) !== (input.ratingCount == null)) {
    return "Ratings need BOTH an average and a count — or leave both empty."
  }
  if (input.ratingValue != null && (input.ratingValue < 1 || input.ratingValue > 5)) return "Rating average must be 1-5."
  return null
}

/** Create or update a location. Empty id = create. */
export async function saveLocation(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  id: string, input: LocationInput, master: Client
): Promise<{ ok: boolean; error?: string }> {
  const err = validateLocation(input)
  if (err) return { ok: false, error: err }
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return { ok: false, error: "The content workspace is unavailable." }

  const slug = locationSlug(input.name, input.city)
  const args = [
    input.name.trim(), input.subtype || "LocalBusiness",
    input.street.trim(), input.city.trim(), input.region.trim(), input.postal.trim(), input.country.trim(),
    input.phone.trim(), JSON.stringify(input.hours),
    input.latitude, input.longitude, JSON.stringify(input.serviceAreas),
    input.priceRange.trim(), input.gbpUrl.trim(),
    input.ratingValue, input.ratingCount, input.isPrimary ? 1 : 0,
  ]
  if (input.isPrimary) {
    await siteDb.execute({ sql: "UPDATE business_locations SET is_primary = 0", args: [] }).catch(() => {})
  }
  if (id) {
    await siteDb.execute({
      sql: `UPDATE business_locations SET name=?, subtype=?, street=?, city=?, region=?, postal=?, country=?,
              phone=?, hours_json=?, latitude=?, longitude=?, service_areas=?, price_range=?, gbp_url=?,
              rating_value=?, rating_count=?, is_primary=? WHERE id = ?`,
      args: [...args, id],
    })
  } else {
    await siteDb.execute({
      sql: `INSERT INTO business_locations
              (id, name, subtype, street, city, region, postal, country, phone, hours_json,
               latitude, longitude, service_areas, price_range, gbp_url, rating_value, rating_count, is_primary, slug)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [cuid(), ...args, slug],
    })
  }
  await dispatchRebuild(env, master, customerId, repoFullName, "local-seo")
  return { ok: true }
}

export async function deleteLocation(
  env: CloudflareEnv, customerId: string, cmsSiteId: string, repoFullName: string | null,
  id: string, master: Client
): Promise<void> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return
  await siteDb.execute({ sql: "DELETE FROM business_locations WHERE id = ?", args: [id] }).catch(() => {})
  await dispatchRebuild(env, master, customerId, repoFullName, "local-seo")
}
