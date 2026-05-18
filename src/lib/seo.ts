// src/lib/seo.ts
// SEO helpers: <head> metadata, JSON-LD structured data, canonical URLs.

import type { Post, Category, Settings } from "./types"
import { escapeHtml, escapeAttr, plainExcerpt } from "./utils"

export interface PageHead {
  title: string
  description: string
  ogImage: string
  ogTitle: string
  ogDescription: string
  ogType: "website" | "article"
  twitterCard: string
  twitterSite: string
  canonical: string
  robots: string
  googleVerification: string
  bingVerification: string
  structuredData: object | null
}

export interface PageContext {
  /** "post" | "category" | "page" | "home" */
  type: "post" | "category" | "page" | "home"
  post?: Post & { category?: Category | null; images?: { url: string }[] }
  category?: Category
  /** Full URL of the current page */
  url: string
  /** Cover image of the first post on the page — used as og:image fallback for list pages. */
  firstPostImage?: string
}

/** Build the <head> metadata for a frontend page. */
export function buildPageHead(ctx: PageContext, settings: Settings): PageHead {
  const siteUrl = (settings.site_url ?? "").replace(/\/$/, "")
  const siteName = settings.seo_site_name || settings.site_name || ""
  const sep = settings.seo_title_separator || "|"

  let title = ""
  let description = ""
  let ogImage = settings.seo_default_og_image || settings.site_og_image || ""
  let canonical = ctx.url
  let robots = settings.seo_robots_default || "index,follow"
  let structured: object | null = null

  if (ctx.type === "post" || ctx.type === "page") {
    const post = ctx.post!
    const baseTitle = post.seo_title || post.title
    title = siteName ? `${baseTitle} ${sep} ${siteName}` : baseTitle
    description =
      post.seo_description ||
      post.excerpt ||
      plainExcerpt(post.content, 160) ||
      settings.seo_default_description ||
      ""
    ogImage = post.og_image || post.cover_image || ogImage
    canonical = post.canonical_url || ctx.url
    if (post.no_index) robots = "noindex,nofollow"
    structured =
      ctx.type === "post"
        ? buildBlogPostingJsonLd(post, ctx.url, settings)
        : buildWebPageJsonLd(post, ctx.url, settings)
  } else if (ctx.type === "category") {
    const cat = ctx.category!
    const baseTitle = cat.seo_title || cat.name
    title = siteName ? `${baseTitle} ${sep} ${siteName}` : baseTitle
    description = cat.seo_desc || cat.description || settings.seo_default_description || ""
    ogImage = cat.cover_image || ogImage || ctx.firstPostImage || ""
    structured = buildCollectionPageJsonLd(cat, ctx.url, settings)
  } else {
    // home
    const baseTitle = settings.seo_default_title || siteName
    title = settings.site_tagline ? `${baseTitle} ${sep} ${settings.site_tagline}` : baseTitle
    description = settings.seo_default_description || settings.site_tagline || ""
    ogImage = ogImage || ctx.firstPostImage || ""
    structured = buildWebSiteJsonLd(siteUrl, siteName)
  }

  const ogTitle =
    (ctx.post && ctx.post.og_title) ||
    title

  const ogDescription =
    (ctx.post && ctx.post.og_description) ||
    description

  const twitterCard =
    (ctx.post && ctx.post.twitter_card) ||
    "summary_large_image"

  return {
    title,
    description,
    ogImage,
    ogTitle,
    ogDescription,
    ogType: ctx.type === "post" ? "article" : "website",
    twitterCard,
    twitterSite: settings.seo_twitter_handle || "",
    canonical,
    robots,
    googleVerification: settings.seo_google_verification || "",
    bingVerification: settings.seo_bing_verification || "",
    structuredData: structured,
  }
}

/** Render the <head> metadata as HTML tags. */
export function renderHeadHtml(head: PageHead, settings?: Settings, post?: Post): string {
  const out: string[] = []
  out.push(`<title>${escapeHtml(head.title)}</title>`)
  out.push(`<meta name="description" content="${escapeAttr(head.description)}" />`)
  out.push(`<link rel="canonical" href="${escapeAttr(head.canonical)}" />`)
  out.push(`<meta name="robots" content="${escapeAttr(head.robots)}" />`)
  if (head.ogType === "article") {
    const authorName = settings?.seo_site_name || settings?.site_name || ""
    if (authorName) out.push(`<meta name="author" content="${escapeAttr(authorName)}" />`)
  }

  // theme-color for mobile browser chrome (uses primary color if available).
  const themeColor = settings?.theme_primary_color || "#e60023"
  out.push(`<meta name="theme-color" content="${escapeAttr(themeColor)}" />`)

  // OpenGraph — type varies by page kind.
  const ogType = head.ogType || "website"
  out.push(`<meta property="og:type" content="${escapeAttr(ogType)}" />`)
  out.push(`<meta property="og:title" content="${escapeAttr(head.ogTitle)}" />`)
  out.push(`<meta property="og:description" content="${escapeAttr(head.ogDescription)}" />`)
  out.push(`<meta property="og:url" content="${escapeAttr(head.canonical)}" />`)
  const siteName = settings?.seo_site_name || settings?.site_name || ""
  if (siteName) {
    out.push(`<meta property="og:site_name" content="${escapeAttr(siteName)}" />`)
  }
  if (head.ogImage) {
    out.push(`<meta property="og:image" content="${escapeAttr(head.ogImage)}" />`)
    out.push(`<meta property="og:image:width" content="1200" />`)
    out.push(`<meta property="og:image:height" content="630" />`)
    out.push(`<meta property="og:image:alt" content="${escapeAttr(head.ogTitle)}" />`)
  }

  // article:* tags (Google Top Stories + Facebook ranking).
  if (ogType === "article" && post) {
    if (post.published_at) {
      out.push(`<meta property="article:published_time" content="${escapeAttr(post.published_at)}" />`)
    }
    if (post.updated_at) {
      out.push(`<meta property="article:modified_time" content="${escapeAttr(post.updated_at)}" />`)
    }
    if (post.seo_keywords) {
      for (const tag of post.seo_keywords.split(",").map((t) => t.trim()).filter(Boolean)) {
        out.push(`<meta property="article:tag" content="${escapeAttr(tag)}" />`)
      }
    }
  }

  // Twitter
  out.push(`<meta name="twitter:card" content="${escapeAttr(head.twitterCard)}" />`)
  if (head.twitterSite) {
    out.push(`<meta name="twitter:site" content="${escapeAttr(head.twitterSite)}" />`)
  }
  out.push(`<meta name="twitter:title" content="${escapeAttr(head.ogTitle)}" />`)
  out.push(`<meta name="twitter:description" content="${escapeAttr(head.ogDescription)}" />`)
  if (head.ogImage) {
    out.push(`<meta name="twitter:image" content="${escapeAttr(head.ogImage)}" />`)
  }
  // Verifications
  if (head.googleVerification) {
    out.push(`<meta name="google-site-verification" content="${escapeAttr(head.googleVerification)}" />`)
  }
  if (head.bingVerification) {
    out.push(`<meta name="msvalidate.01" content="${escapeAttr(head.bingVerification)}" />`)
  }
  // Pinterest Rich Pins
  out.push(`<meta name="pinterest-rich-pin" content="true" />`)
  // JSON-LD
  if (head.structuredData) {
    out.push(
      `<script type="application/ld+json">${JSON.stringify(head.structuredData)
        .replace(/</g, "\\u003c")}</script>`
    )
  }
  return out.join("\n  ")
}

// ─────────────────── JSON-LD BUILDERS ───────────────────

export function buildBlogPostingJsonLd(
  post: Post & { images?: { url: string }[] },
  url: string,
  settings: Settings
): object {
  const images = [post.cover_image, ...(post.images?.map((i) => i.url) ?? [])].filter(
    (x): x is string => Boolean(x)
  )
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.seo_title || post.title,
    description: post.seo_description || post.excerpt || plainExcerpt(post.content, 160),
    image: images.length ? images : undefined,
    datePublished: post.published_at || post.created_at,
    dateModified: post.updated_at || post.created_at,
    author: {
      "@type": "Organization",
      name: settings.seo_site_name || settings.site_name || "",
    },
    publisher: {
      "@type": "Organization",
      name: settings.seo_site_name || settings.site_name || "",
      logo: settings.site_logo
        ? { "@type": "ImageObject", url: settings.site_logo }
        : undefined,
    },
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  }
}

export function buildWebPageJsonLd(post: Post, url: string, settings: Settings): object {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: post.seo_title || post.title,
    description: post.seo_description || post.excerpt || plainExcerpt(post.content, 160),
    url,
    isPartOf: {
      "@type": "WebSite",
      name: settings.seo_site_name || settings.site_name,
      url: settings.site_url,
    },
  }
}

export function buildWebSiteJsonLd(siteUrl: string, siteName: string): object {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: siteName,
    url: siteUrl,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${siteUrl}/?s={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  }
}

export function buildCollectionPageJsonLd(
  cat: Category,
  url: string,
  settings: Settings
): object {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: cat.seo_title || cat.name,
    description: cat.seo_desc || cat.description || "",
    url,
    isPartOf: {
      "@type": "WebSite",
      name: settings.seo_site_name || settings.site_name,
      url: settings.site_url,
    },
  }
}

export function buildBreadcrumbJsonLd(
  items: Array<{ name: string; url: string }>
): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  }
}

// ─────────────────── PERMALINKS ───────────────────

/**
 * Build a path for a post given the site's permalink_structure setting.
 * Tokens supported: %slug% %category% %year% %month%
 */
/** Parse a date string as UTC regardless of whether it uses a space or T separator. */
function parseUtcDate(s: string): Date {
  // SQLite stores "YYYY-MM-DD HH:MM:SS" — replace space with T and append Z so
  // V8 always treats the value as UTC instead of local time.
  return new Date(s.replace(" ", "T").replace(/(\d{2}:\d{2}:\d{2})$/, "$1Z"))
}

export function buildPostPath(
  post: { slug: string; published_at: string | null; created_at: string },
  category: Category | null,
  settings: Settings
): string {
  const struct = settings.permalink_structure || "/%slug%/"
  const dateStr = post.published_at || post.created_at
  const date = dateStr ? parseUtcDate(dateStr) : new Date()
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")

  let path = struct
    .replace(/%slug%/g, post.slug)
    .replace(/%category%/g, category?.slug || "uncategorized")
    .replace(/%year%/g, year)
    .replace(/%month%/g, month)

  // Normalize slashes
  if (!path.startsWith("/")) path = "/" + path
  if (!path.endsWith("/")) path = path + "/"
  path = path.replace(/\/+/g, "/")
  return path
}

export function buildCategoryPath(slug: string, settings: Settings): string {
  const base = (settings.category_base || "").replace(/^\/|\/$/g, "")
  return base ? `/${base}/${slug}/` : `/${slug}/`
}

export function buildCanonicalUrl(
  post: Post & { category?: Category | null },
  settings: Settings
): string {
  const path = buildPostPath(post, post.category ?? null, settings)
  return `${(settings.site_url || "").replace(/\/$/, "")}${path}`
}
