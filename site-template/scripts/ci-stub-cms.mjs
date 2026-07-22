// scripts/ci-stub-cms.mjs — a throwaway CMS stub for CI builds (the preset
// matrix) and audit runs. Defaults return an empty-but-valid site so
// `npm run build` succeeds without a real CMS. V1.3 audit knobs (env vars,
// all optional — defaults reproduce the original empty stub exactly):
//   STUB_POSTS=N        emit N synthetic published posts
//   STUB_PROFILES=a,b   enable SEO profiles (local,news,ecommerce,image,ai)
//   STUB_PRODUCTS=N     emit N synthetic products
//   STUB_FORMS=N        emit N active forms (V1.4 audit); when >0, post 0 also
//                       carries a form-embed marker + CTA markers in content
// Listens on :8799.
import { createServer } from "node:http"

const POSTS = Number(process.env.STUB_POSTS ?? 0)
const PRODUCTS = Number(process.env.STUB_PRODUCTS ?? 0)
const FORMS = Number(process.env.STUB_FORMS ?? 0)
const SECTIONS = process.env.STUB_SECTIONS === "1" // D5.1: exercise the section library
const PAGES = Number(process.env.STUB_PAGES ?? 0)  // CMS Pages (type='page'), rendered at /<slug>/
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
    // D5.1: post 0 exercises the section component library.
    (SECTIONS && i === 0
      ? `<div class="stats"><div class="stat"><span class="n">12k</span><span class="l">clients</span></div><div class="stat"><span class="n">98%</span><span class="l">satisfaction</span></div></div>` +
        `<div class="grid-2"><blockquote class="card quote-card"><p>Genuinely the best.</p><div class="who"><b>A. Client</b><span>Founder</span></div></blockquote><blockquote class="card quote-card"><p>Fast and lovely.</p><div class="who"><b>B. Buyer</b><span>CEO</span></div></blockquote></div>` +
        `<div class="grid-3"><div class="card price-card"><h3>Starter</h3><div class="amt">$9<small>/mo</small></div><ul><li>One site</li><li>Email</li></ul><a class="btn" href="/contact/">Choose</a></div><div class="card price-card featured"><h3>Pro</h3><div class="amt">$29<small>/mo</small></div><ul><li>Ten sites</li><li>Priority</li></ul><a class="btn" href="/contact/">Choose</a></div></div>` +
        `<details class="faq"><summary>Is it fast?</summary><p>Yes — Lighthouse 1.0.</p></details><details class="faq"><summary>Zero JS?</summary><p>Correct.</p></details>` +
        `<div class="timeline"><div class="timeline-item"><div class="when">2021</div><h3>Founded</h3><p>Started up.</p></div><div class="timeline-item"><div class="when">2024</div><h3>Grew</h3><p>Scaled.</p></div></div>` +
        `<div class="logos"><span>BrandA</span><span>BrandB</span><span>BrandC</span></div>`
      : "") +
    // V1.4: post 0 exercises the form-embed + CTA injection paths.
    (FORMS > 0 && i === 0
      ? `<div class="form-embed" data-form="stub-contact"></div>` +
        `<div class="cta-block" data-cta="whatsapp" data-value="+44 7700 900123" data-prefill="Hi from article"></div>` +
        `<div class="cta-block" data-cta="book" data-value="https://cal.com/audit" data-label="Book an audit"></div>`
      : "") +
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
      profiles: PROFILES, scripts: process.env.STUB_SCRIPTS === "overbudget" ? [{ id: "ga4", config: "G-ABC123XYZ" }, { id: "crisp", config: "12345678-abcd-ef01-2345-6789abcdef01" }, { id: "cookieyes", config: "abcdef123456" }] : process.env.STUB_SCRIPTS === "light" ? [{ id: "plausible", config: "example.com" }] : [], indexnowKey: PROFILES.includes("news") ? "a".repeat(32) : "", analyticsEnabled: process.env.STUB_ANALYTICS === "1", analyticsKey: process.env.STUB_ANALYTICS === "1" ? "sitetoken123" : "",
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
  if (url.includes("/forms")) {
    // Mirrors GET /api/public/v1/forms (formDefRoutes). Form 0 is the embed
    // target; the rest render standalone /forms/<slug>/ pages.
    return res.end(JSON.stringify({ success: true, forms: Array.from({ length: FORMS }, (_, i) => ({
      id: `form-${i}`,
      slug: i === 0 ? "stub-contact" : `stub-form-${i}`,
      title: i === 0 ? "Stub contact" : `Stub form ${i}`,
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "email", label: "Email", type: "email", required: true },
        { key: "service", label: "Service", type: "select", required: false, options: ["Repair", "Install"] },
        { key: "message", label: "Message", type: "textarea", required: false },
      ],
    })) }))
  }
  if (url.includes("/seo")) {
    return res.end(JSON.stringify({ success: true, seo: Array.from({ length: POSTS }, (_, i) => seoRow(i)) }))
  }
  if (url.includes("/products")) {
    return res.end(JSON.stringify({ products: Array.from({ length: PRODUCTS }, (_, i) => product(i)), total: PRODUCTS }))
  }
  // CMS Pages (type='page') — the WordPress-migration surface, rendered at root.
  if (url.includes("type=page")) {
    const names = ["About", "Our Story", "Services", "FAQ"]
    return res.end(JSON.stringify({
      posts: Array.from({ length: PAGES }, (_, i) => ({
        id: `page-${i}`,
        title: names[i % names.length] + (i >= names.length ? ` ${i}` : ""),
        slug: (names[i % names.length].toLowerCase().replace(/[^a-z0-9]+/g, "-")) + (i >= names.length ? `-${i}` : ""),
        // Page 1 carries a form embed to prove Turnstile loads on a root page.
        content: `<p>${`Page body copy for the migrated page. `.repeat(20)}</p>` +
          (i === 1 && FORMS > 0 ? `<div class="form-embed" data-form="stub-contact"></div>` : ""),
        excerpt: `A migrated page.`, coverImage: null,
        publishedAt: new Date(now - i * 86400 * 1000).toISOString(),
        updatedAt: new Date(now - i * 3600 * 1000).toISOString(),
        category: null, seoTitle: null, seoDescription: null,
      })),
      total: PAGES,
    }))
  }
  res.end(JSON.stringify({ posts: Array.from({ length: POSTS }, (_, i) => post(i)), total: POSTS }))
}).listen(8799, () => console.log(`ci-stub-cms on :8799 (posts=${POSTS} products=${PRODUCTS} profiles=${PROFILES.join("+") || "none"})`))
