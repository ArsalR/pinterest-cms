// src/modules/seo/composition.test.ts — V1.3 audit: profiles COMPOSE.
// A site can run Ecommerce + Local + News + Image + AI simultaneously; the
// schema graphs and sitemap children must merge without collision.
import { describe, it, expect } from "vitest"
import { localBusinessJsonLd, type BusinessLocation } from "./local"
import { merchantSchemaExtras, parseMerchantConfig, type MerchantProduct } from "./merchant"
import { extractAeoBlocks, definedTermsLd, tldrBlockHtml, definitionBlockHtml } from "./aeo"
import { addSitemapToIndex } from "./news"

const LOC: BusinessLocation = {
  id: "l1", name: "Shop", subtype: "Store", street: "1 Way", city: "Leeds", region: "", postal: "", country: "GB",
  phone: "+44", hours: { weekly: {}, holidays: [] }, latitude: 1, longitude: 2, serviceAreas: [],
  priceRange: "$$", gbpUrl: "", ratingValue: null, ratingCount: null, isPrimary: true, slug: "shop-leeds",
}
const PROD: MerchantProduct = {
  id: "p1", slug: "cup", title: "Cup", description: "d", priceCents: 100, currency: "usd", images: [],
  sku: null, inStock: true, brand: "B", gtin: null, mpn: null, condition: "new", ratingValue: 4.5, ratingCount: 3,
}

describe("all-profiles-on schema graph", () => {
  it("merges every profile's nodes without duplicate or colliding @ids", () => {
    // Build the worst-case page graph: article-ish nodes + local + merchant +
    // AEO DefinedTerms, the way the template composes them.
    const html = tldrBlockHtml(["a", "b"]) + definitionBlockHtml("Term", "Meaning of term.")
    const blocks = extractAeoBlocks(html)
    const graph: Array<Record<string, unknown>> = [
      { "@type": "Article", "@id": "https://x.com/posts/p/#article", headline: "H" },
      { "@type": "BreadcrumbList" },
      { "@type": "Person", "@id": "https://x.com/authors/a/#person", name: "A" },
      localBusinessJsonLd(LOC, "https://x.com/", "https://x.com/") as Record<string, unknown>,
      ...definedTermsLd(blocks).map((n) => n as Record<string, unknown>),
    ]
    const { product, offer } = merchantSchemaExtras(PROD, parseMerchantConfig(JSON.stringify({ shippingRateCents: 100, returnDays: 30 })))
    graph.push({ "@type": "Product", name: "Cup", ...product, offers: { "@type": "Offer", ...offer } })

    // No node is null/undefined (every builder returned a real node).
    expect(graph.every((n) => n && typeof n === "object" && n["@type"])).toBe(true)
    // @ids that exist are UNIQUE — no collisions across profiles.
    const ids = graph.map((n) => n["@id"]).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    // The LocalBusiness node uses its own #business fragment — distinct from
    // #article/#person by construction.
    expect(graph.find((n) => n["@type"] === "Store")!["@id"]).toBe("https://x.com/#business")
  })
})

describe("sitemap index composition (news + image + …)", () => {
  it("multiple child sitemaps join one index, each once, order-independent", () => {
    const idx = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.com/sitemap-0.xml</loc></sitemap></sitemapindex>`
    let out = addSitemapToIndex(idx, "https://x.com/news-sitemap.xml")
    out = addSitemapToIndex(out, "https://x.com/image-sitemap.xml")
    out = addSitemapToIndex(out, "https://x.com/news-sitemap.xml") // re-run = idempotent
    expect(out.match(/news-sitemap\.xml/g)).toHaveLength(1)
    expect(out.match(/image-sitemap\.xml/g)).toHaveLength(1)
    expect(out).toContain("sitemap-0.xml")
    // still a single well-formed index
    expect(out.match(/<\/sitemapindex>/g)).toHaveLength(1)
  })
})
