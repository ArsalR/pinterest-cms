// src/modules/seo/analyze.ts
// PURE SEO logic shared by the cockpit (live preview) and — from S2 — the
// quality gate (one rule module, two surfaces). No I/O. Everything here is
// unit-tested and safe to run client-side (mirrored into the cockpit JS).

// ─────────────────────── pixel-width SERP truncation ───────────────────────
// Google truncates by rendered WIDTH, not character count, so char limits lie.
// This is an approximation of Arial rendering at Google's title/description
// sizes — good enough to show an honest "will be cut" state.

const CHAR_PX: Record<string, number> = { " ": 4, i: 3, l: 3, j: 4, f: 5, t: 5, r: 5, I: 4, "!": 4, ".": 4, ",": 4, "'": 3 }
const WIDE = new Set(["m", "w", "M", "W", "G", "O", "Q", "@"])

/** Approximate rendered width (px) of a string at SERP title size. Pure. */
export function pixelWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    if (ch in CHAR_PX) w += CHAR_PX[ch]
    else if (WIDE.has(ch)) w += 12
    else if (ch >= "A" && ch <= "Z") w += 9
    else w += 7
  }
  return w
}

// Google's practical pixel budgets (title ~600px, description ~920px desktop).
export const SERP_TITLE_PX = 600
export const SERP_DESC_PX = 920

export interface Truncation {
  text: string
  full: string
  truncated: boolean
  px: number
}

/** Truncate to a pixel budget, ellipsizing on a word boundary. Pure. */
export function truncateToPixels(text: string, maxPx: number): Truncation {
  const full = text.trim()
  if (pixelWidth(full) <= maxPx) return { text: full, full, truncated: false, px: pixelWidth(full) }
  const ellipsisPx = pixelWidth("…")
  let out = ""
  for (const word of full.split(/(\s+)/)) {
    if (pixelWidth(out + word) + ellipsisPx > maxPx) break
    out += word
  }
  out = out.trimEnd()
  return { text: `${out}…`, full, truncated: true, px: pixelWidth(out) + ellipsisPx }
}

// ─────────────────────── effective SERP / social values ───────────────────────

export interface PostSeoInput {
  title: string
  excerpt: string | null
  metaTitle: string | null
  metaDescription: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogImage: string | null
  coverImage: string | null
}

/** Resolve the title/description a search engine will show (with fallbacks). Pure. */
export function serpPreview(p: PostSeoInput, siteName: string, url: string): { title: Truncation; description: Truncation; url: string } {
  const rawTitle = (p.metaTitle && p.metaTitle.trim()) || (p.title ? `${p.title} — ${siteName}` : siteName)
  const rawDesc = (p.metaDescription && p.metaDescription.trim()) || (p.excerpt ?? "").trim()
  return {
    title: truncateToPixels(rawTitle, SERP_TITLE_PX),
    description: truncateToPixels(rawDesc, SERP_DESC_PX),
    url,
  }
}

/** Resolve the OG/Twitter card values (with fallbacks). Pure. */
export function socialPreview(p: PostSeoInput, siteName: string): { title: string; description: string; image: string | null } {
  return {
    title: (p.ogTitle && p.ogTitle.trim()) || (p.metaTitle && p.metaTitle.trim()) || p.title || siteName,
    description: (p.ogDescription && p.ogDescription.trim()) || (p.metaDescription && p.metaDescription.trim()) || (p.excerpt ?? "").trim(),
    image: (p.ogImage && p.ogImage.trim()) || (p.coverImage && p.coverImage.trim()) || null,
  }
}

// ─────────────────────── FAQ → FAQPage JSON-LD ───────────────────────

export interface FaqItem {
  question: string
  answer: string
}

/** Build FAQPage JSON-LD from a FAQ builder, or null if fewer than 1 valid pair. Pure. */
export function faqToJsonLd(items: FaqItem[]): object | null {
  const clean = items
    .map((f) => ({ q: f.question.trim(), a: f.answer.trim() }))
    .filter((f) => f.q.length > 0 && f.a.length > 0)
  if (!clean.length) return null
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: clean.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  }
}

export const SCHEMA_TYPES = ["Article", "HowTo", "FAQ", "Product", "Review"] as const
export function isSchemaType(v: string): boolean {
  return (SCHEMA_TYPES as readonly string[]).includes(v)
}

// ─────────────────────── slug ───────────────────────

export function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "page"
}

/** A valid slug is lowercase, url-safe, no leading/trailing/double hyphens. Pure. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 96
}

// ─────────────────────── robots directive (canonical rule) ───────────────────────
// The single source of truth for the per-post <meta name="robots"> value. The
// site template ([slug].astro) mirrors this exact rule. CRITICAL (safety rail
// #3, byte-identical): both flags false ⇒ null ⇒ NO robots meta is emitted,
// which is today's behavior for every existing post.

/** Compose the robots directive from index/follow toggles, or null if default. Pure. */
export function computeRobots(noIndex?: boolean, nofollow?: boolean): string | null {
  const parts: string[] = []
  if (noIndex) parts.push("noindex")
  if (nofollow) parts.push("nofollow")
  return parts.length > 0 ? parts.join(", ") : null
}
