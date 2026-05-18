// src/lib/utils.ts
// Tiny utility functions used everywhere. No dependencies.

/** Collision-resistant ID using crypto.randomUUID (available in Workers). */
export function cuid(): string {
  return "c" + crypto.randomUUID().replace(/-/g, "").slice(0, 24)
}

/** URL-safe slug from any string. */
export function slugify(input: string): string {
  return input
    .toString()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100) || "post"
}

/** Strip path/whitespace/unsafe chars from a filename for storage keys. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase()
    .slice(0, 120) || "file"
}

/** Escape user content for safe HTML rendering. */
export function escapeHtml(input: string | null | undefined): string {
  if (input === null || input === undefined) return ""
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** Escape attribute values (more aggressive than html). */
export function escapeAttr(input: string | null | undefined): string {
  return escapeHtml(input)
}

/** Human-readable date for blog posts. */
export function formatDate(input: string | null | undefined): string {
  if (!input) return ""
  const d = new Date(input)
  if (isNaN(d.getTime())) return ""
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  })
}

/** ISO 8601 datetime in UTC. */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Approx reading time in minutes from HTML or plain text. */
export function readingTime(text: string): number {
  const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
  const words = stripped ? stripped.split(" ").length : 0
  return Math.max(1, Math.ceil(words / 200))
}

/** Strip HTML tags, decode common entities, collapse whitespace, truncate. Used for excerpts. */
export function plainExcerpt(html: string, max = 160): string {
  const txt = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (txt.length <= max) return txt
  return txt.slice(0, max - 1).replace(/\s+\S*$/, "") + "…"
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * Strip dangerous tags and attributes from admin/API-authored post HTML.
 * Uses HTMLRewriter (available in Cloudflare Workers) to remove script/style/
 * iframe/object/embed/form elements, then a regex pass removes on* event
 * handlers and javascript: URLs from any surviving attributes.
 */
export async function sanitizePostHtml(html: string): Promise<string> {
  let rewriter = new HTMLRewriter()
  for (const tag of ["script", "style", "iframe", "object", "embed", "form"]) {
    rewriter = rewriter.on(tag, { element(el) { el.remove() } })
  }
  const clean = await rewriter
    .transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } }))
    .text()
  return clean
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|\S*)/gi, "")
    .replace(/(href|src|action)\s*=\s*["']?\s*javascript\s*:/gi, '$1="#"')
}

/** Read a JSON body with error handling. */
export async function readJson<T = unknown>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}
