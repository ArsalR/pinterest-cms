// src/routes/public/v1/products.test.ts
// Pure-logic tests for the products API's money + serialization helpers.
// (Route handlers need Hono context — not testable in the plain-node vitest
// pool, same as posts/categories; covered by Phase 10 integration.)

import { describe, it, expect } from "vitest"
import { parsePriceCents, serialize } from "./products"

describe("parsePriceCents — money integrity (never trust client price math)", () => {
  it("passes through integer cents", () => {
    expect(parsePriceCents({ priceCents: 1999 })).toBe(1999)
    expect(parsePriceCents({ priceCents: 0 })).toBe(0)
  })
  it("converts dollars to cents and rounds", () => {
    expect(parsePriceCents({ price: 19.99 })).toBe(1999)
    expect(parsePriceCents({ price: 10 })).toBe(1000)
    expect(parsePriceCents({ price: 0.1 })).toBe(10)
  })
  it("prefers explicit cents over dollars when both present", () => {
    expect(parsePriceCents({ priceCents: 500, price: 9.99 })).toBe(500)
  })
  it("defaults missing price to 0 (free / lead product)", () => {
    expect(parsePriceCents({})).toBe(0)
  })
  it("rejects negative and non-finite money", () => {
    expect(parsePriceCents({ priceCents: -1 })).toBeNull()
    expect(parsePriceCents({ price: -5 })).toBeNull()
    expect(parsePriceCents({ price: Infinity })).toBeNull()
    expect(parsePriceCents({ price: NaN })).toBeNull()
  })
})

describe("serialize", () => {
  const base = {
    id: "p1", slug: "widget", title: "Widget", description: "d",
    price_cents: 2500, currency: "usd", images: '["https://x/a.jpg","https://x/b.jpg"]',
    sku: "SKU1", stock_status: "in_stock", digital: 0, published: 1,
    category_id: "c1", category_slug: "gear", seo_title: null, seo_description: null,
    created_at: "2026-01-01", updated_at: "2026-01-02",
  }
  it("maps DB row → API shape with booleans and parsed images", () => {
    const s = serialize(base)
    expect(s.priceCents).toBe(2500)
    expect(s.images).toEqual(["https://x/a.jpg", "https://x/b.jpg"])
    expect(s.digital).toBe(false)
    expect(s.published).toBe(true)
    expect(s.categorySlug).toBe("gear")
  })
  it("tolerates corrupt images JSON → empty array (never breaks the build)", () => {
    expect(serialize({ ...base, images: "not json" }).images).toEqual([])
    expect(serialize({ ...base, images: '["ok", 5, null]' }).images).toEqual(["ok"])
  })
  it("reflects digital + out_of_stock flags", () => {
    const s = serialize({ ...base, digital: 1, stock_status: "out_of_stock", published: 0 })
    expect(s.digital).toBe(true)
    expect(s.stockStatus).toBe("out_of_stock")
    expect(s.published).toBe(false)
  })
})
