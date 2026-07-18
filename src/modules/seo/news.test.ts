// src/modules/seo/news.test.ts — News SEO profile (V1.3 P2) pure builders.
import { describe, it, expect } from "vitest"
import { newsEligible, buildNewsSitemap, addSitemapToIndex, indexNowKeyFrom, indexNowPayload, NEWS_MAX_URLS } from "./news"

const NOW = Date.parse("2026-07-18T12:00:00Z")
const item = (h: number, title = "T") => ({ url: `https://x.com/posts/p${h}/`, title, publishedAt: new Date(NOW - h * 3600 * 1000).toISOString() })

describe("newsEligible (the 48-hour rule)", () => {
  // GUARDRAIL: Google requires news sitemaps to carry ONLY the last 48 hours.
  it("keeps only items within 48 hours, newest first", () => {
    const items = [item(1), item(47), item(49), item(100)]
    const out = newsEligible(items, NOW)
    expect(out).toHaveLength(2)
    expect(out[0].url).toContain("p1")
  })
  it("drops far-future and unparseable dates, caps at 1000", () => {
    const junk = [{ url: "u", title: "t", publishedAt: "not-a-date" }, { url: "u2", title: "t", publishedAt: new Date(NOW + 864e5).toISOString() }]
    expect(newsEligible(junk, NOW)).toHaveLength(0)
    const many = Array.from({ length: 1200 }, (_, i) => ({ url: `https://x.com/${i}`, title: "t", publishedAt: new Date(NOW - i * 1000).toISOString() }))
    expect(newsEligible(many, NOW)).toHaveLength(NEWS_MAX_URLS)
  })
})

describe("buildNewsSitemap", () => {
  it("emits the news namespace with required publication tags, escaped", () => {
    const xml = buildNewsSitemap("The Daily <Grind>", "en", [item(2, 'Big "News" & More')], NOW)
    expect(xml).toContain('xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"')
    expect(xml).toContain("<news:name>The Daily &lt;Grind&gt;</news:name>")
    expect(xml).toContain("<news:language>en</news:language>")
    expect(xml).toContain("<news:publication_date>")
    expect(xml).toContain("Big &quot;News&quot; &amp; More")
  })
  it("emits a valid empty urlset when nothing is recent (stable URL)", () => {
    const xml = buildNewsSitemap("P", "en", [item(60)], NOW)
    expect(xml).toContain("<urlset")
    expect(xml).not.toContain("<url>")
  })
})

describe("addSitemapToIndex", () => {
  it("inserts the child before the closing tag, idempotently", () => {
    const idx = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.com/sitemap-0.xml</loc></sitemap></sitemapindex>`
    const once = addSitemapToIndex(idx, "https://x.com/news-sitemap.xml")
    expect(once).toContain("news-sitemap.xml")
    expect(addSitemapToIndex(once, "https://x.com/news-sitemap.xml")).toBe(once) // no dupes
  })
})

describe("IndexNow", () => {
  it("hex key from bytes + payload with key location", () => {
    expect(indexNowKeyFrom(new Uint8Array([0, 15, 255]))).toBe("000fff")
    const p = indexNowPayload("x.com", "abc123", ["https://x.com/a/"]) as Record<string, unknown>
    expect(p.keyLocation).toBe("https://x.com/abc123.txt")
    expect(p.urlList).toEqual(["https://x.com/a/"])
  })
})
