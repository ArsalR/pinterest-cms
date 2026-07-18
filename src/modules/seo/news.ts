// src/modules/seo/news.ts
// News SEO profile (V1.3 P2) — PURE builders, verified against Google's news-
// sitemap docs (developers.google.com/search/docs/crawling-indexing/sitemaps/
// news-sitemap): news namespace 0.9; required publication name + language,
// publication_date (W3C), title; only articles from the LAST 48 HOURS; ≤1000
// URLs. Plus IndexNow (api.indexnow.org) payload/key helpers for fast
// indexing on publish. No I/O — unit-tested.

export const NEWS_WINDOW_MS = 48 * 3600 * 1000
export const NEWS_MAX_URLS = 1000

export interface NewsItem {
  url: string
  title: string
  publishedAt: string // ISO
}

function xmlEsc(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c] ?? c)
}

/** Items eligible for the news sitemap: published within the window, newest
 *  first, capped. Pure — pass `now` explicitly. */
export function newsEligible(items: NewsItem[], nowMs: number): NewsItem[] {
  return items
    .filter((i) => {
      const t = Date.parse(i.publishedAt)
      return Number.isFinite(t) && nowMs - t <= NEWS_WINDOW_MS && t <= nowMs + 60_000
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, NEWS_MAX_URLS)
}

/** Build the Google News sitemap XML. Valid-but-empty urlset when no recent
 *  articles (stable URL for Search Console). Pure. */
export function buildNewsSitemap(publicationName: string, language: string, items: NewsItem[], nowMs: number): string {
  const eligible = newsEligible(items, nowMs)
  const urls = eligible
    .map(
      (i) => `  <url>
    <loc>${xmlEsc(i.url)}</loc>
    <news:news>
      <news:publication>
        <news:name>${xmlEsc(publicationName)}</news:name>
        <news:language>${xmlEsc(language)}</news:language>
      </news:publication>
      <news:publication_date>${xmlEsc(i.publishedAt)}</news:publication_date>
      <news:title>${xmlEsc(i.title)}</news:title>
    </news:news>
  </url>`
    )
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>
`
}

/** Insert a child sitemap reference into an existing sitemap index XML —
 *  how the news/image sitemaps join Astro's generated index. Idempotent. Pure. */
export function addSitemapToIndex(indexXml: string, childUrl: string): string {
  if (indexXml.includes(`<loc>${childUrl}</loc>`)) return indexXml
  const entry = `<sitemap><loc>${xmlEsc(childUrl)}</loc></sitemap>`
  if (indexXml.includes("</sitemapindex>")) {
    return indexXml.replace("</sitemapindex>", `${entry}</sitemapindex>`)
  }
  return indexXml
}

// ─────────────────────── IndexNow ───────────────────────

/** A fresh IndexNow key (hex). The caller persists it; the template serves it
 *  at /<key>.txt. Pure given randomness injected. */
export function indexNowKeyFrom(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** The JSON body for an IndexNow batch ping. Pure. */
export function indexNowPayload(host: string, key: string, urls: string[]): object {
  return {
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: urls.slice(0, 10000),
  }
}
