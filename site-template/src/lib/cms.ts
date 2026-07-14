// Build-time content pull from the CMS public API (confirmed decision #3).
// Runs ONLY during `astro build` in GitHub Actions — never at serve time.

import { readFileSync } from "node:fs"

export interface SiteConfig {
  name: string
  niche: string
  kind?: "content" | "ecommerce" | "local-business" | "portfolio"
  domain: string
  canonicalHost: "apex" | "www"
  cmsApiUrl: string
  ownerName: string
  ownerEmail: string
  generatedAt: string
  /** Contact-form relay (set at provisioning; absent = mailto fallback). */
  turnstileSitekey?: string
  formsEndpoint?: string
}

export interface CmsPost {
  id: string
  title: string
  slug: string
  content: string
  excerpt: string | null
  coverImage: string | null
  publishedAt: string | null
  updatedAt: string | null
  category: { slug: string; name: string } | null
  seoTitle: string | null
  seoDescription: string | null
}

export function loadConfig(): SiteConfig {
  return JSON.parse(readFileSync(new URL("../../site.config.json", import.meta.url), "utf8")) as SiteConfig
}

export function canonicalHost(config: SiteConfig): string {
  return config.canonicalHost === "www" ? `www.${config.domain}` : config.domain
}

/** Fetch all published posts (paged). Fails the build loudly on API errors —
 *  a silent empty site is worse than a red build. */
export async function fetchAllPosts(config: SiteConfig): Promise<CmsPost[]> {
  const key = process.env.CMS_API_KEY
  if (!key) throw new Error("CMS_API_KEY is not set (repo Actions secret)")
  const out: CmsPost[] = []
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const resp = await fetch(`${config.cmsApiUrl}/posts?limit=${limit}&offset=${offset}&published=true&type=post`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!resp.ok) throw new Error(`CMS API returned ${resp.status} — check CMS_API_KEY and cmsApiUrl`)
    const data = (await resp.json()) as {
      posts: Array<{
        id: string; title: string; slug: string; content?: string; excerpt?: string | null
        coverImage?: string | null; publishedAt?: string | null; updatedAt?: string | null
        category?: { slug: string; name: string } | null
        seoTitle?: string | null; seoDescription?: string | null
      }>
      total: number
    }
    for (const p of data.posts) {
      out.push({
        id: p.id,
        title: p.title,
        slug: p.slug,
        content: p.content ?? "",
        excerpt: p.excerpt ?? null,
        coverImage: p.coverImage ?? null,
        publishedAt: p.publishedAt ?? null,
        updatedAt: p.updatedAt ?? null,
        category: p.category ?? null,
        seoTitle: p.seoTitle ?? null,
        seoDescription: p.seoDescription ?? null,
      })
    }
    if (out.length >= data.total || data.posts.length < limit) break
  }
  return out
}
