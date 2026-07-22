// src/modules/sites/subsites.ts
// V1.5 M5 — sub-sites (subdomain half). Pure helpers for validating a subdomain
// label and composing the child hostname on the parent's apex domain. A
// subdomain site is a full separate site (own repo, preset, content) that
// reuses the parent's Cloudflare zone, so no domain purchase / www variant is
// involved. Kept pure + unit-tested — the SEO-poisoning risk lives in getting
// hostnames exactly right.

/** Reserved labels a customer can't take as a subdomain (they collide with the
 *  apex/www site or standard infra). */
export const RESERVED_SUBDOMAIN_LABELS = new Set(["www", "mail", "ftp", "cpanel", "webmail", "ns1", "ns2", "_dmarc"])

/**
 * A single DNS label: 1–63 chars, a–z 0–9 and hyphens, not starting/ending with
 * a hyphen. We lowercase first. Multi-level labels ("blog.eu") are rejected —
 * one level keeps DNS + zone reuse unambiguous.
 */
export function isValidSubdomainLabel(raw: string): boolean {
  const label = raw.trim().toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false
  if (RESERVED_SUBDOMAIN_LABELS.has(label)) return false
  return true
}

/**
 * Compose the child hostname from a validated label and the parent's apex
 * domain. Returns "" if either input is invalid, so callers fail closed.
 */
export function subdomainDomain(label: string, parentDomain: string): string {
  const l = label.trim().toLowerCase()
  const p = parentDomain.trim().toLowerCase()
  if (!isValidSubdomainLabel(l)) return ""
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(p)) return ""
  // Guard against composing onto a hostname that is already a subdomain of the
  // label (paranoia) or duplicating the label.
  if (p.startsWith(`${l}.`)) return ""
  return `${l}.${p}`
}

// ── Subdirectory sites (domain.com/blog) — V1.5 M5 part 2 ──

/** Path segments a subdirectory site can't take: they collide with a top-level
 *  site's own routes/assets (so /blog would shadow the parent's /posts, etc.). */
export const RESERVED_PATH_SEGMENTS = new Set([
  "posts", "forms", "shop", "cart", "order", "products", "category", "categories",
  "authors", "locations", "tags", "tag", "og", "js", "fonts", "_astro", "api",
  "admin", "app", "rss", "feed", "sitemap", "robots", "well-known", ".well-known",
])

/** A single path segment for a subdirectory mount: 1–40 chars, a–z 0–9 and
 *  hyphens, not a reserved route. Lowercased. */
export function isValidPathSegment(raw: string): boolean {
  const seg = raw.trim().toLowerCase().replace(/^\/+|\/+$/g, "")
  if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(seg)) return false
  if (RESERVED_PATH_SEGMENTS.has(seg)) return false
  return true
}

/** Compose the "/blog" base path from a validated segment. "" if invalid. */
export function basePathFrom(segment: string): string {
  const seg = segment.trim().toLowerCase().replace(/^\/+|\/+$/g, "")
  return isValidPathSegment(seg) ? `/${seg}` : ""
}
