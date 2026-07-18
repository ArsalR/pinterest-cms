// Build-time content pull from the CMS public API (confirmed decision #3).
// Runs ONLY during `astro build` in GitHub Actions — never at serve time.

import { readFileSync } from "node:fs"

export interface SiteConfig {
  name: string
  niche: string
  kind?: "content" | "ecommerce" | "local-business" | "portfolio"
  /** Design preset (V1.1) — CSS-variable token set; see src/lib/presets.ts. */
  preset?: string
  /** Homepage layout variant (V1.1) — per-kind static switch. */
  layout?: string
  domain: string
  canonicalHost: "apex" | "www"
  cmsApiUrl: string
  ownerName: string
  ownerEmail: string
  generatedAt: string
  /** Contact-form relay (set at provisioning; absent = mailto fallback). */
  turnstileSitekey?: string
  formsEndpoint?: string
  /** Ecommerce checkout relay (set at provisioning for kind='ecommerce'). */
  checkoutEndpoint?: string
}

export interface CmsProduct {
  id: string
  slug: string
  title: string
  description: string | null
  priceCents: number
  currency: string
  images: string[]
  sku: string | null
  stockStatus: string
  digital: boolean
  published: boolean
  categorySlug: string | null
  seoTitle: string | null
  seoDescription: string | null
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
  // V1.2 SEO cockpit overrides. All optional — absent reproduces today's output.
  noIndex?: boolean
  canonicalUrl?: string | null
  ogTitle?: string | null
  ogDescription?: string | null
  ogImage?: string | null
  nofollow?: boolean
  schemaType?: string | null
  faq?: Array<{ question: string; answer: string }> | null
}

/** Canonical robots-directive rule (mirrors src/modules/seo/analyze.ts).
 *  Both flags false/absent ⇒ null ⇒ NO robots meta (byte-identical, rail #3). */
export function computeRobots(noIndex?: boolean, nofollow?: boolean): string | null {
  const parts: string[] = []
  if (noIndex) parts.push("noindex")
  if (nofollow) parts.push("nofollow")
  return parts.length > 0 ? parts.join(", ") : null
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
        noIndex?: boolean; canonicalUrl?: string | null
        ogTitle?: string | null; ogDescription?: string | null; ogImage?: string | null
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
        noIndex: p.noIndex ?? false,
        canonicalUrl: p.canonicalUrl ?? null,
        ogTitle: p.ogTitle ?? null,
        ogDescription: p.ogDescription ?? null,
        ogImage: p.ogImage ?? null,
      })
    }
    if (out.length >= data.total || data.posts.length < limit) break
  }
  // Merge V1.2 SEO override fields not carried by the frozen /v1/posts shape.
  await mergeSeoOverrides(config, out)
  return out
}

/** Fetch per-post SEO overrides from the additive /v1/seo endpoint and merge by
 *  id. Best-effort: on any error the site builds exactly as before (defaults). */
async function mergeSeoOverrides(config: SiteConfig, posts: CmsPost[]): Promise<void> {
  const key = process.env.CMS_API_KEY
  if (!key || posts.length === 0) return
  try {
    const resp = await fetch(`${config.cmsApiUrl}/seo`, { headers: { Authorization: `Bearer ${key}` } })
    if (!resp.ok) return
    const data = (await resp.json()) as { seo?: Array<{ id: string; nofollow?: boolean; schemaType?: string | null; faq?: Array<{ question: string; answer: string }> | null }> }
    const byId = new Map((data.seo ?? []).map((s) => [s.id, s]))
    for (const p of posts) {
      const o = byId.get(p.id)
      if (!o) continue
      p.nofollow = o.nofollow ?? false
      p.schemaType = o.schemaType ?? null
      p.faq = o.faq ?? null
    }
  } catch {
    // absent overrides = today's output
  }
}

/** Fetch all published products (ecommerce sites). Empty for non-store sites. */
export async function fetchAllProducts(config: SiteConfig): Promise<CmsProduct[]> {
  if (config.kind !== "ecommerce") return []
  const key = process.env.CMS_API_KEY
  if (!key) throw new Error("CMS_API_KEY is not set (repo Actions secret)")
  const out: CmsProduct[] = []
  const limit = 100
  for (let offset = 0; ; offset += limit) {
    const resp = await fetch(`${config.cmsApiUrl}/products?limit=${limit}&offset=${offset}&published=true`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!resp.ok) throw new Error(`CMS API /products returned ${resp.status}`)
    const data = (await resp.json()) as { products: CmsProduct[]; total: number }
    for (const p of data.products) out.push(p)
    if (out.length >= data.total || data.products.length < limit) break
  }
  return out
}

/** Money formatter for display (cents → localized currency string). */
export function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`
  }
}

export interface FaqPair {
  question: string
  answer: string
}

const STRIP_TAGS = /<[^>]+>/g
function textOf(html: string): string {
  return html.replace(STRIP_TAGS, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
}

const QUESTION_WORDS = /^(how|what|why|when|where|which|who|can|do|does|is|are|should|will)\b/i

/**
 * Extract question/answer pairs from post HTML for FAQPage JSON-LD (K8/AEO):
 * an h2/h3 phrased as a question, followed by the text up to the next heading.
 * Best-effort and defensive — returns [] on anything unexpected.
 */
export function extractFaqs(html: string): FaqPair[] {
  if (!html) return []
  const pairs: FaqPair[] = []
  // Split on h2/h3 boundaries, keeping the heading text.
  const re = /<h[23][^>]*>([\s\S]*?)<\/h[23]>([\s\S]*?)(?=<h[23][^>]*>|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const q = textOf(m[1])
    const a = textOf(m[2])
    const isQuestion = q.endsWith("?") || QUESTION_WORDS.test(q)
    if (isQuestion && q.length <= 200 && a.length >= 20) {
      pairs.push({ question: q, answer: a.slice(0, 600) })
    }
  }
  return pairs
}
