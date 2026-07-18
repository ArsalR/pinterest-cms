// src/modules/seo/profiles.ts
// SEO Profiles (V1.3) — PURE registry + helpers. A profile is a site-level
// activation that lights up a curated option group with strong defaults; a
// site can enable several at once. This module is the single source of truth
// for the profile vocabulary: ids, names, plain-language descriptions, and the
// site-kind → default-profile mapping applied to NEW sites at provisioning
// (existing sites keep [] until the customer opts in — byte-identical, rail #3).
// No I/O — unit-tested.

export type ProfileId = "local" | "news" | "ecommerce" | "image" | "ai"

export interface SeoProfile {
  id: ProfileId
  name: string
  tagline: string
  /** What enabling it actually does, in plain language (hub card body). */
  lightsUp: string
}

export const SEO_PROFILES: readonly SeoProfile[] = [
  {
    id: "local",
    name: "Local SEO",
    tagline: "Rank in the map pack and 'near me' searches",
    lightsUp:
      "Business info (name, address, phone, hours) shown consistently everywhere, LocalBusiness schema with your business type, location pages, and local landing pages through the quality gate.",
  },
  {
    id: "news",
    name: "News SEO",
    tagline: "Get articles into Google News & Top Stories fast",
    lightsUp:
      "Google News sitemap (last 48 hours), NewsArticle schema, author pages with bios, and instant-indexing pings when you publish.",
  },
  {
    id: "ecommerce",
    name: "Ecommerce SEO",
    tagline: "Rich product results and a Merchant Center feed",
    lightsUp:
      "Full product schema (price, availability, brand, GTIN), a Google Merchant Center feed built on every deploy, category-page SEO, and breadcrumb trails.",
  },
  {
    id: "image",
    name: "Image SEO",
    tagline: "Get images into Google Images & licensed properly",
    lightsUp:
      "Image sitemap, personal data (EXIF/GPS) stripped from uploads, image license/creator schema, and captions on the page.",
  },
  {
    id: "ai",
    name: "AI SEO",
    tagline: "Be the answer in ChatGPT, Perplexity & AI Overviews",
    lightsUp:
      "Quotable content blocks (TL;DR, Q&A, definitions, sourced stats), a full-content llms.txt, entity schema that tells AI who you are, and a per-post AI-visibility checklist.",
  },
]

const VALID_IDS = new Set<string>(SEO_PROFILES.map((p) => p.id))

export function isProfileId(v: string): v is ProfileId {
  return VALID_IDS.has(v)
}

/** Parse a stored profiles JSON array; junk → [] (byte-identical default). Pure. */
export function parseProfiles(raw: unknown): ProfileId[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    if (!Array.isArray(a)) return []
    const out: ProfileId[] = []
    for (const v of a) {
      const s = String(v)
      if (isProfileId(s) && !out.includes(s)) out.push(s)
    }
    return out
  } catch {
    return []
  }
}

/** Normalize a user-submitted id list into a valid, deduped set. Pure. */
export function normalizeProfiles(ids: string[]): ProfileId[] {
  const out: ProfileId[] = []
  for (const v of ids) {
    if (isProfileId(v) && !out.includes(v)) out.push(v)
  }
  return out
}

/**
 * Default profiles for a site KIND, applied only to NEW sites at provisioning
 * (genesis mapping). Existing sites are never retro-activated — rail #3. The
 * AI profile is deliberately opt-in everywhere: it changes editorial output.
 */
export function defaultProfilesForKind(kind: string | null | undefined): ProfileId[] {
  switch (kind) {
    case "ecommerce":
      return ["ecommerce", "image"]
    case "local-business":
      return ["local"]
    case "content":
      return ["image"]
    default:
      return [] // portfolio and anything unknown: nothing implied
  }
}
