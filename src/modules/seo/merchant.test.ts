// src/modules/seo/merchant.test.ts — Ecommerce SEO profile (V1.3 P3).
import { describe, it, expect } from "vitest"
import { parseMerchantConfig, merchantSchemaExtras, buildMerchantFeed, DEFAULT_MERCHANT_CONFIG, type MerchantProduct } from "./merchant"

const P: MerchantProduct = {
  id: "pr1", slug: "espresso-cup", title: "Espresso Cup", description: "A fine cup.",
  priceCents: 1299, currency: "usd", images: ["https://cdn/img.jpg"], sku: "CUP-1",
  inStock: true, brand: "BrewCraft", gtin: "00012345678905", mpn: "BC-CUP-1",
  condition: "new", ratingValue: 4.6, ratingCount: 12,
}

describe("parseMerchantConfig", () => {
  it("junk → defaults (everything omitted)", () => {
    expect(parseMerchantConfig(null)).toEqual(DEFAULT_MERCHANT_CONFIG)
    expect(parseMerchantConfig("nope")).toEqual(DEFAULT_MERCHANT_CONFIG)
  })
  it("validates country and fees", () => {
    const c = parseMerchantConfig(JSON.stringify({ shippingRateCents: 499, shipCountry: "gb", returnDays: 30, returnFees: "free" }))
    expect(c.shipCountry).toBe("GB")
    expect(c.returnFees).toBe("free")
    expect(parseMerchantConfig(JSON.stringify({ shipCountry: "ZZZ" })).shipCountry).toBe("US")
  })
})

describe("merchantSchemaExtras (Google merchant-listing shape)", () => {
  it("emits brand/gtin/mpn/condition/rating + shipping + returns when configured", () => {
    const cfg = parseMerchantConfig(JSON.stringify({ shippingRateCents: 499, handlingDaysMax: 1, transitDaysMax: 5, returnDays: 30, returnFees: "free" }))
    const { product, offer } = merchantSchemaExtras(P, cfg)
    expect((product.brand as Record<string, unknown>).name).toBe("BrewCraft")
    expect(product.gtin).toBe("00012345678905")
    expect(offer.itemCondition).toBe("https://schema.org/NewCondition")
    const ship = offer.shippingDetails as Record<string, unknown>
    expect((ship.shippingRate as Record<string, unknown>).value).toBe("4.99")
    expect(ship.deliveryTime).toBeDefined()
    const ret = offer.hasMerchantReturnPolicy as Record<string, unknown>
    expect(ret.merchantReturnDays).toBe(30)
    expect(ret.returnFees).toBe("https://schema.org/FreeReturn")
  })

  // GUARDRAIL (additive/byte-identical): a bare product + empty config adds
  // NOTHING — the existing base schema is unchanged.
  it("emits nothing for a bare product and default config", () => {
    const bare: MerchantProduct = { ...P, brand: null, gtin: null, mpn: null, condition: null, ratingValue: null, ratingCount: null }
    const { product, offer } = merchantSchemaExtras(bare, DEFAULT_MERCHANT_CONFIG)
    expect(Object.keys(product)).toHaveLength(0)
    expect(Object.keys(offer)).toHaveLength(0)
  })

  // GUARDRAIL (honest ratings): same rule as everywhere — both numbers or nothing.
  it("omits aggregateRating without both real numbers", () => {
    const { product } = merchantSchemaExtras({ ...P, ratingCount: 0 }, DEFAULT_MERCHANT_CONFIG)
    expect(product.aggregateRating).toBeUndefined()
  })
})

describe("buildMerchantFeed", () => {
  it("emits the g: namespace feed with price/availability/identifiers", () => {
    const xml = buildMerchantFeed("BrewCraft", "https://brew.example/", [P])
    expect(xml).toContain('xmlns:g="http://base.google.com/ns/1.0"')
    expect(xml).toContain("<g:price>12.99 USD</g:price>")
    expect(xml).toContain("<g:availability>in_stock</g:availability>")
    expect(xml).toContain("<g:gtin>00012345678905</g:gtin>")
    expect(xml).toContain("<g:link>https://brew.example/products/espresso-cup/</g:link>")
  })
  it("marks identifier_exists=false for identifier-less products", () => {
    const xml = buildMerchantFeed("S", "https://s/", [{ ...P, brand: null, gtin: null, mpn: null }])
    expect(xml).toContain("<g:identifier_exists>false</g:identifier_exists>")
  })
})
