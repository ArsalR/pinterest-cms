// src/modules/seo/settings.ts
// Site SEO Control Center (S3) — PURE model + builders for the per-site
// seo_settings record. CRITICAL (safety rail #3): the DEFAULT settings must
// reproduce today's build exactly — buildRobotsTxt(defaults) === null (no
// robots.txt is emitted, which is today's state), RSS/archives default on,
// global schema default off. Only a customer-configured record changes output.
//
// Pure. No I/O. Unit-tested (incl. the hard-rails guardrail).

/** AI / LLM crawlers blocked by the one-click "block AI bots" toggle. These do
 *  NOT affect search indexing — blocking them never trips the major-engine
 *  rail. Kept explicit so the list is auditable. */
export const AI_BOTS = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "CCBot",
  "Google-Extended",
  "anthropic-ai",
  "ClaudeBot",
  "Claude-Web",
  "PerplexityBot",
  "Bytespider",
  "Amazonbot",
  "Applebot-Extended",
  "Meta-ExternalAgent",
  "Diffbot",
  "cohere-ai",
] as const

/** User-agents that, if disallowed, would deindex the site from a major search
 *  engine — the hard rail. Matched case-insensitively as substrings. */
export const MAJOR_ENGINE_BOTS = ["googlebot", "bingbot", "slurp", "duckduckbot", "baiduspider", "yandex"]

import type { ProfileId } from "./profiles"
import type { EnabledScript } from "./scripts"

export interface SeoSettings {
  /** SEO profile activations (V1.3) — [] = none = today's behavior. */
  profiles: ProfileId[]
  /** Vetted script-catalog enablements (V1.3) — [] = zero-JS as today. */
  scripts: EnabledScript[]
  /** One-click block of AI/LLM training crawlers (does not affect search). */
  blockAiBots: boolean
  /** Extra user-agents to Disallow: / (freeform, advanced). */
  blockedBots: string[]
  /** Paths to Disallow for all bots (e.g. "/tag/", "/search"). */
  disallowPaths: string[]
  /** Verbatim extra lines appended to robots.txt (advanced). */
  robotsExtra: string
  /** Feeds + archives toggles (default on = today). */
  rssEnabled: boolean
  archivesEnabled: boolean
  /** Global Organization/WebSite JSON-LD (default off = today's output). */
  globalSchemaEnabled: boolean
  orgName: string
  orgLogo: string
  socialProfiles: string[]
  /** EU consent mode for ad pixels (V1.5 M4), tri-state:
   *  undefined = auto (ON when any consent-requiring pixel is enabled),
   *  true = forced ON, false = forced OFF. */
  pixelConsent?: boolean
}

export const DEFAULT_SEO_SETTINGS: SeoSettings = {
  profiles: [],
  scripts: [],
  blockAiBots: false,
  blockedBots: [],
  disallowPaths: [],
  robotsExtra: "",
  rssEnabled: true,
  archivesEnabled: true,
  globalSchemaEnabled: false,
  orgName: "",
  orgLogo: "",
  socialProfiles: [],
}

/** True when a settings record adds no crawler directive beyond the baseline.
 *  A default record ⇒ today's exact robots.txt (byte-identical, rail #3). */
export function robotsIsDefault(s: SeoSettings): boolean {
  return (
    !s.blockAiBots &&
    s.blockedBots.length === 0 &&
    s.disallowPaths.length === 0 &&
    s.robotsExtra.trim() === ""
  )
}

/**
 * Build robots.txt from settings. The site template ALREADY ships a robots.txt
 * (allow-all + Sitemap), so the baseline (default settings) must reproduce that
 * exact content byte-for-byte — the template's post-build generator mirrors this
 * rule. `sitemapUrl` is the absolute sitemap index URL. Pure.
 */
export function buildRobotsTxt(s: SeoSettings, sitemapUrl: string): string {
  // Baseline — identical to the template's current gen-redirects.mjs output.
  if (robotsIsDefault(s)) return `User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`

  const lines: string[] = []
  // Per-bot blocks first (specific user-agents get their own group).
  const perBot: string[] = []
  if (s.blockAiBots) perBot.push(...AI_BOTS)
  for (const b of s.blockedBots) {
    const name = b.trim()
    if (name && !perBot.some((p) => p.toLowerCase() === name.toLowerCase())) perBot.push(name)
  }
  for (const bot of perBot) {
    lines.push(`User-agent: ${bot}`, "Disallow: /", "")
  }

  // The catch-all group: allow everything, minus any disallowed paths.
  lines.push("User-agent: *")
  const paths = s.disallowPaths.map((p) => p.trim()).filter(Boolean)
  if (paths.length) {
    for (const p of paths) lines.push(`Disallow: ${p.startsWith("/") ? p : "/" + p}`)
  } else {
    lines.push("Allow: /")
  }
  lines.push("")

  if (s.robotsExtra.trim()) lines.push(s.robotsExtra.trim(), "")
  lines.push(`Sitemap: ${sitemapUrl}`)

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n"
}

/**
 * HARD RAIL (safety rail #2, block-engines half): would this settings record
 * bar a major search engine from the whole site? True if a major-engine bot is
 * in blockedBots, if disallowPaths blanket-blocks "/", or if robotsExtra
 * contains a catch-all "User-agent: *" + "Disallow: /" pair. The Control Center
 * refuses such a save unless the operator types the override phrase. Pure.
 */
export function robotsWouldBlockMajorEngines(s: SeoSettings): boolean {
  const named = s.blockedBots.some((b) =>
    MAJOR_ENGINE_BOTS.some((m) => b.toLowerCase().includes(m))
  )
  const blanketPath = s.disallowPaths.map((p) => p.trim()).includes("/")
  const extra = s.robotsExtra.toLowerCase()
  const extraBlanket =
    /user-agent:\s*\*/.test(extra) && /disallow:\s*\/\s*$/m.test(extra)
  return named || blanketPath || extraBlanket
}

/** Global Organization + WebSite JSON-LD, or null when disabled/unconfigured.
 *  Consumed by the site template's <head> only when present (byte-identical
 *  when off). Pure. */
export function globalSchema(s: SeoSettings, siteName: string, siteUrl: string): object | null {
  if (!s.globalSchemaEnabled) return null
  const org: Record<string, unknown> = {
    "@type": "Organization",
    name: s.orgName.trim() || siteName,
    url: siteUrl,
  }
  if (s.orgLogo.trim()) org.logo = s.orgLogo.trim()
  const profiles = s.socialProfiles.map((p) => p.trim()).filter(Boolean)
  if (profiles.length) org.sameAs = profiles
  const website = { "@type": "WebSite", name: siteName, url: siteUrl }
  return { "@context": "https://schema.org", "@graph": [org, website] }
}
