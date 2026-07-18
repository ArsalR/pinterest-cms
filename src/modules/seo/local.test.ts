// src/modules/seo/local.test.ts — Local SEO profile (V1.3 P1) pure builders.
import { describe, it, expect } from "vitest"
import {
  parseHours, openingHoursSpec, localBusinessJsonLd, staticMapUrl,
  locationSlug, localLandingPreset, isLocalSubtype, type BusinessLocation,
} from "./local"

const LOC: BusinessLocation = {
  id: "l1", name: "Brew & Bean", subtype: "CafeOrCoffeeShop",
  street: "12 High St", city: "Leeds", region: "West Yorkshire", postal: "LS1 1AA", country: "GB",
  phone: "+44 113 000 0000",
  hours: { weekly: { mon: "09:00-17:00", tue: "09:00-17:00", sat: "10:00-14:00" }, holidays: [{ date: "2026-12-25", hours: null }] },
  latitude: 53.8, longitude: -1.55, serviceAreas: [], priceRange: "$$",
  gbpUrl: "https://maps.google.com/?cid=123", ratingValue: 4.7, ratingCount: 31,
  isPrimary: true, slug: "brew-bean-leeds",
}

describe("parseHours", () => {
  it("keeps only valid spans and dates", () => {
    const h = parseHours(JSON.stringify({ weekly: { mon: "09:00-17:00", tue: "25:00-99:99", wed: null }, holidays: [{ date: "2026-12-25", hours: null }, { date: "junk" }] }))
    expect(h.weekly.mon).toBe("09:00-17:00")
    expect(h.weekly.tue).toBeUndefined()
    expect(h.weekly.wed).toBeNull()
    expect(h.holidays).toEqual([{ date: "2026-12-25", hours: null }])
  })
  it("junk → empty model", () => {
    expect(parseHours("nope")).toEqual({ weekly: {}, holidays: [] })
  })
})

describe("openingHoursSpec", () => {
  it("groups identical spans and emits holiday overrides", () => {
    const spec = openingHoursSpec(LOC.hours) as Array<Record<string, unknown>>
    const grouped = spec.find((s) => Array.isArray(s.dayOfWeek) && (s.dayOfWeek as string[]).includes("Monday"))!
    expect(grouped.dayOfWeek).toEqual(["Monday", "Tuesday"])
    expect(grouped.opens).toBe("09:00")
    const holiday = spec.find((s) => s.validFrom === "2026-12-25")!
    expect(holiday.opens).toBe("00:00") // closed-all-day signal
  })
})

describe("localBusinessJsonLd (Google requirements)", () => {
  it("emits the full node for a complete location", () => {
    const n = localBusinessJsonLd(LOC, "https://brew.example", "https://brew.example/") as Record<string, unknown>
    expect(n["@type"]).toBe("CafeOrCoffeeShop")
    expect((n.address as Record<string, unknown>).addressLocality).toBe("Leeds")
    expect(n.geo).toBeDefined()
    expect(n.priceRange).toBe("$$")
    expect(n.sameAs).toEqual(["https://maps.google.com/?cid=123"])
    expect((n.aggregateRating as Record<string, unknown>).reviewCount).toBe(31)
  })

  // GUARDRAIL (required fields): never emit half-valid markup — no name or no
  // address/areaServed ⇒ null, not a broken node.
  it("returns null without the required name + address/areaServed", () => {
    expect(localBusinessJsonLd({ ...LOC, name: "" }, "u", "p")).toBeNull()
    expect(localBusinessJsonLd({ ...LOC, street: "", city: "", serviceAreas: [] }, "u", "p")).toBeNull()
    // service-area-only business (no storefront) is valid
    expect(localBusinessJsonLd({ ...LOC, street: "", city: "", serviceAreas: ["Leeds", "York"] }, "u", "p")).not.toBeNull()
  })

  // GUARDRAIL (honest reviews): rating markup only when BOTH real numbers exist.
  it("omits aggregateRating without real ratings", () => {
    const none = localBusinessJsonLd({ ...LOC, ratingValue: null, ratingCount: null }, "u", "p") as Record<string, unknown>
    expect(none.aggregateRating).toBeUndefined()
    const zero = localBusinessJsonLd({ ...LOC, ratingValue: 4.5, ratingCount: 0 }, "u", "p") as Record<string, unknown>
    expect(zero.aggregateRating).toBeUndefined()
  })

  it("falls back to the generic type for unknown subtypes", () => {
    const n = localBusinessJsonLd({ ...LOC, subtype: "SpaceElevator" }, "u", "p") as Record<string, unknown>
    expect(n["@type"]).toBe("LocalBusiness")
    expect(isLocalSubtype("SpaceElevator")).toBe(false)
  })
})

describe("helpers", () => {
  it("static map URL is a plain https image (no JS)", () => {
    const u = staticMapUrl(53.8, -1.55)
    expect(u).toContain("staticmap")
    expect(u).toContain("53.8,-1.55")
  })
  it("location slug", () => {
    expect(locationSlug("Brew & Bean", "Leeds")).toBe("brew-bean-leeds")
  })
  it("landing preset routes through the pSEO engine shape", () => {
    const p = localLandingPreset("Emergency plumbing", ["Leeds", "York"])
    expect(p.csv).toBe("city,service\nLeeds,Emergency plumbing\nYork,Emergency plumbing\n")
    expect(p.titleTemplate).toContain("{city}")
    expect(p.bodyTemplate).toContain("quality gate")
  })
})
