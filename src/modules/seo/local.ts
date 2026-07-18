// src/modules/seo/local.ts
// Local SEO profile (V1.3 P1) — PURE model + builders. NAP (name/address/
// phone) is stored ONCE per location and injected everywhere consistently;
// LocalBusiness JSON-LD follows Google's current requirements (verified against
// developers.google.com/search/docs/appearance/structured-data/local-business):
// name + address required; geo, openingHoursSpecification, telephone,
// priceRange, sameAs recommended; use the most specific subtype.
// AggregateRating is emitted ONLY when the customer has real ratings — no
// fake-review scaffolding (Google penalizes it; the UI says so).
// No I/O — unit-tested.

/** Closed subtype list (most-specific-type guidance). Values are schema.org
 *  type names; "LocalBusiness" is the generic fallback. */
export const LOCAL_SUBTYPES = [
  "LocalBusiness",
  "Restaurant",
  "CafeOrCoffeeShop",
  "Bakery",
  "Store",
  "Dentist",
  "MedicalBusiness",
  "Plumber",
  "Electrician",
  "GeneralContractor",
  "AutoRepair",
  "HairSalon",
  "BeautySalon",
  "LegalService",
  "RealEstateAgent",
] as const

export function isLocalSubtype(v: string): boolean {
  return (LOCAL_SUBTYPES as readonly string[]).includes(v)
}

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
const DAY_SCHEMA: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
}

export interface WeeklyHours {
  /** "09:00-17:00" or null (closed). */
  [day: string]: string | null
}

export interface HolidayOverride {
  date: string          // YYYY-MM-DD
  hours: string | null  // "10:00-14:00" or null = closed
}

export interface HoursModel {
  weekly: WeeklyHours
  holidays: HolidayOverride[]
}

const HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Parse the stored hours JSON; junk → empty model. Pure. */
export function parseHours(raw: unknown): HoursModel {
  const empty: HoursModel = { weekly: {}, holidays: [] }
  if (typeof raw !== "string" || !raw.trim()) return empty
  try {
    const o = JSON.parse(raw) as { weekly?: Record<string, unknown>; holidays?: Array<{ date?: unknown; hours?: unknown }> }
    const weekly: WeeklyHours = {}
    for (const d of DAY_KEYS) {
      const v = o.weekly?.[d]
      if (typeof v === "string" && HOURS_RE.test(v)) weekly[d] = v
      else if (v === null) weekly[d] = null
    }
    const holidays: HolidayOverride[] = []
    for (const h of o.holidays ?? []) {
      const date = String(h?.date ?? "")
      if (!DATE_RE.test(date)) continue
      const hours = typeof h?.hours === "string" && HOURS_RE.test(h.hours) ? h.hours : null
      holidays.push({ date, hours })
    }
    return { weekly, holidays }
  } catch {
    return empty
  }
}

export interface BusinessLocation {
  id: string
  name: string
  subtype: string
  street: string
  city: string
  region: string
  postal: string
  country: string
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
  slug: string
}

/** openingHoursSpecification array from weekly hours (+ holiday special
 *  specs). Empty array when no hours set. Pure. */
export function openingHoursSpec(hours: HoursModel): object[] {
  const out: object[] = []
  // Group identical spans across days for compactness.
  const bySpan = new Map<string, string[]>()
  for (const d of DAY_KEYS) {
    const span = hours.weekly[d]
    if (!span) continue
    const list = bySpan.get(span) ?? []
    list.push(DAY_SCHEMA[d])
    bySpan.set(span, list)
  }
  for (const [span, days] of bySpan) {
    const [opens, closes] = span.split("-")
    out.push({ "@type": "OpeningHoursSpecification", dayOfWeek: days, opens, closes })
  }
  for (const h of hours.holidays) {
    if (h.hours) {
      const [opens, closes] = h.hours.split("-")
      out.push({ "@type": "OpeningHoursSpecification", validFrom: h.date, validThrough: h.date, opens, closes })
    } else {
      // Closed all day: opens === closes signals closed per Google's docs.
      out.push({ "@type": "OpeningHoursSpecification", validFrom: h.date, validThrough: h.date, opens: "00:00", closes: "00:00" })
    }
  }
  return out
}

/**
 * LocalBusiness JSON-LD for one location. Returns null when the REQUIRED
 * fields (name + a usable address or service area) are missing — never emits
 * half-valid markup. AggregateRating only with real numbers. Pure.
 */
export function localBusinessJsonLd(loc: BusinessLocation, siteUrl: string, pageUrl: string): object | null {
  const hasAddress = !!(loc.street && loc.city)
  const hasArea = loc.serviceAreas.length > 0
  if (!loc.name || (!hasAddress && !hasArea)) return null

  const node: Record<string, unknown> = {
    "@type": isLocalSubtype(loc.subtype) ? loc.subtype : "LocalBusiness",
    "@id": `${pageUrl}#business`,
    name: loc.name,
    url: siteUrl,
  }
  if (hasAddress) {
    node.address = {
      "@type": "PostalAddress",
      streetAddress: loc.street,
      addressLocality: loc.city,
      ...(loc.region ? { addressRegion: loc.region } : {}),
      ...(loc.postal ? { postalCode: loc.postal } : {}),
      ...(loc.country ? { addressCountry: loc.country } : {}),
    }
  }
  if (hasArea) node.areaServed = loc.serviceAreas.map((a) => ({ "@type": "Place", name: a }))
  if (loc.phone) node.telephone = loc.phone
  if (loc.latitude != null && loc.longitude != null) {
    node.geo = { "@type": "GeoCoordinates", latitude: loc.latitude, longitude: loc.longitude }
  }
  const spec = openingHoursSpec(loc.hours)
  if (spec.length) node.openingHoursSpecification = spec
  if (loc.priceRange) node.priceRange = loc.priceRange
  if (loc.gbpUrl) node.sameAs = [loc.gbpUrl]
  // Real reviews only: both a value AND a count, both positive.
  if (loc.ratingValue != null && loc.ratingCount != null && loc.ratingValue > 0 && loc.ratingCount > 0) {
    node.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: loc.ratingValue,
      reviewCount: loc.ratingCount,
    }
  }
  return node
}

/** Static map <img> URL (no JS map — covenant P1). OSM-based static renderer;
 *  the CSP already allows any https image. Pure. */
export function staticMapUrl(lat: number, lon: number, zoom = 15, w = 600, h = 300): string {
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lon}&zoom=${zoom}&size=${w}x${h}&markers=${lat},${lon},red-pushpin`
}

/** Slug for an extra location page. Pure. */
export function locationSlug(name: string, city: string): string {
  const base = `${name} ${city}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return base.slice(0, 80) || "location"
}

/** Pre-filled city/service matrix template for the EXISTING pSEO engine —
 *  local landing pages go through the same generator + quality gate (unique
 *  local content enforced; the gate is the moat against doorway spam). Pure. */
export function localLandingPreset(service: string, cities: string[]): { csv: string; titleTemplate: string; bodyTemplate: string } {
  const rows = cities.map((c) => `${c.trim()},${service.trim()}`).filter((r) => r !== ",")
  return {
    csv: `city,service\n${rows.join("\n")}\n`,
    titleTemplate: `{service} in {city} — what locals should know`,
    bodyTemplate:
      `<h2>{service} in {city}</h2>\n` +
      `<p>[Write what's genuinely different about {service} in {city}: local regulations, typical prices, ` +
      `neighborhoods you serve, response times. The quality gate blocks thin or duplicate pages — ` +
      `each city page must carry real local substance.]</p>`,
  }
}
