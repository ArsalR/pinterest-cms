// scripts/ci-stub-cms.mjs — a throwaway CMS stub for CI builds (the preset
// matrix) and audit runs. Defaults return an empty-but-valid site so
// `npm run build` succeeds without a real CMS. V1.3 audit knobs (env vars,
// all optional — defaults reproduce the original empty stub exactly):
//   STUB_POSTS=N        emit N synthetic published posts
//   STUB_PROFILES=a,b   enable SEO profiles (local,news,ecommerce,image,ai)
//   STUB_PRODUCTS=N     emit N synthetic products
// Listens on :8799.
import { createServer } from "node:http"

const POSTS = Number(process.env.STUB_POSTS ?? 0)
const PRODUCTS = Number(process.env.STUB_PRODUCTS ?? 0)
const PROFILES = (process.env.STUB_PROFILES ?? "").split(",").map((s) => s.trim()).filter(Boolean)

const now = Date.now()
const post = (i) => ({
  id: `post-${i}`,
  title: `Synthetic article ${i}: how does the audit build scale?`,
  slug: `synthetic-article-${i}`,
  content:
    `<div class="aeo-tldr"><p><strong>TL;DR</strong></p><ul><li>Point A of article ${i}</li><li>Point B</li></ul></div>` +
    `<h2>What is section one about?</h2>` +
    `<p>${`Substantive sentence ${i} with enough words to look real. `.repeat(40)}</p>` +
    `<div class="aeo-definition"><p><dfn>Term ${i}</dfn> — the thing article ${i} defines.</p></div>` +
    `<h2>How does it work in practice?</h2>` +
    `<p>${"More paragraphs of body copy for weight. ".repeat(40)}</p>` +
    `<div class="aeo-stat"><p>Adoption grew 42% last year. <a href="https://example.org/report">Source</a></p></div>` +
    // no remote images: the audit stub stays hermetic (Astro fetches +
    // optimizes remote images at build, which would need real hosts).
    ``,
  excerpt: `A tight, quotable summary of synthetic article ${i}.`,
  coverImage: null,
  publishedAt: new Date(now - i * 3600 * 1000).toISOString(),
  updatedAt: new Date(now - i * 1800 * 1000).toISOString(),
  category: null,
  seoTitle: null,
  seoDescription: null,
})
const seoRow = (i) => ({
  id: `post-${i}`, slug: `synthetic-article-${i}`, sitemapExclude: false, nofollow: false,
  schemaType: null, authorId: i % 3 === 0 ? "author-1" : null, llmsExclude: i % 10 === 0,
  focusKeyword: `topic ${i}`, faq: null,
})
const product = (i) => ({
  id: `prod-${i}`, slug: `product-${i}`, title: `Product ${i}`, description: `Description of product ${i}.`,
  priceCents: 1000 + i, currency: "usd", images: [], sku: `SKU-${i}`,
  stockStatus: "in_stock", digital: false, published: true, categorySlug: null, seoTitle: null, seoDescription: null,
})

createServer((req, res) => {
  res.setHeader("content-type", "application/json")
  const url = req.url ?? ""
  if (url.includes("/seo-settings")) {
    return res.end(JSON.stringify({ success: true, settings: {
      blockAiBots: false, blockedBots: [], disallowPaths: [], robotsExtra: "",
      rssEnabled: true, archivesEnabled: true, globalSchemaEnabled: PROFILES.length > 0,
      orgName: "Audit Org", orgLogo: "", socialProfiles: [],
      profiles: PROFILES, scripts: process.env.STUB_SCRIPTS === "overbudget" ? [{ id: "ga4", config: "G-ABC123XYZ" }, { id: "crisp", config: "12345678-abcd-ef01-2345-6789abcdef01" }, { id: "cookieyes", config: "abcdef123456" }] : process.env.STUB_SCRIPTS === "light" ? [{ id: "plausible", config: "example.com" }] : [], indexnowKey: PROFILES.includes("news") ? "a".repeat(32) : "",
      imageLicense: PROFILES.includes("image") ? { licenseUrl: "https://example.com/license/", acquireLicenseUrl: "https://example.com/contact/", creatorName: "Audit Creator" } : null,
    } }))
  }
  if (url.includes("/authors")) {
    return res.end(JSON.stringify({ success: true, authors: PROFILES.includes("news")
      ? [{ id: "author-1", name: "Avery Audit", slug: "avery-audit", bio: "Writes synthetic articles for load tests.", photo: "", sameAs: ["https://example.com/avery"] }]
      : [] }))
  }
  if (url.includes("/local")) {
    return res.end(JSON.stringify({ success: true, locations: PROFILES.includes("local")
      ? [{ id: "loc-1", name: "Audit Shop", subtype: "Store", street: "1 Bench Rd", city: "Leeds", region: "", postal: "LS1", country: "GB",
           phone: "+44 113 000", hours: { weekly: { mon: "09:00-17:00" }, holidays: [] }, latitude: 53.8, longitude: -1.55,
           serviceAreas: [], priceRange: "$$", gbpUrl: "", ratingValue: null, ratingCount: null, isPrimary: true, slug: "audit-shop-leeds" }]
      : [] }))
  }
  if (url.includes("/merchant")) {
    return res.end(JSON.stringify({ success: true,
      config: PROFILES.includes("ecommerce") ? { shippingRateCents: 499, shippingCurrency: "usd", shipCountry: "GB", handlingDaysMax: 1, transitDaysMax: 5, returnDays: 30, returnFees: "free" } : null,
      products: PROFILES.includes("ecommerce") ? Array.from({ length: PRODUCTS }, (_, i) => ({ id: `prod-${i}`, slug: `product-${i}`, brand: "AuditBrand", gtin: null, mpn: `MPN-${i}`, condition: "new", ratingValue: 4.5, ratingCount: 7 })) : [] }))
  }
  if (url.includes("/seo")) {
    return res.end(JSON.stringify({ success: true, seo: Array.from({ length: POSTS }, (_, i) => seoRow(i)) }))
  }
  if (url.includes("/products")) {
    return res.end(JSON.stringify({ products: Array.from({ length: PRODUCTS }, (_, i) => product(i)), total: PRODUCTS }))
  }
  res.end(JSON.stringify({ posts: Array.from({ length: POSTS }, (_, i) => post(i)), total: POSTS }))
}).listen(8799, () => console.log(`ci-stub-cms on :8799 (posts=${POSTS} products=${PRODUCTS} profiles=${PROFILES.join("+") || "none"})`))
