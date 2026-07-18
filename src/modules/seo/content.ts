// src/modules/seo/content.ts
// Content analysis (S2) — the live "Content" cockpit tab. CRITICAL: this shares
// the quality gate's OWN primitives and thresholds (wordCount / stripHtml /
// DEFAULT_GATE_CONFIG imported from ../quality-gate) so "will this pass the
// gate?" feedback in the editor matches the gate that actually blocks publish —
// one rule module, two surfaces. The cockpit JS mirrors this for zero-latency
// as-you-type feedback (same pattern as pixelWidth in analyze.ts).
//
// Pure. No I/O. Unit-tested.

import { wordCount, stripHtml, DEFAULT_GATE_CONFIG } from "../quality-gate"
import { truncateToPixels, SERP_TITLE_PX, SERP_DESC_PX } from "./analyze"

export type CheckStatus = "good" | "warn" | "bad"

export interface ContentCheck {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export interface ContentAnalysisInput {
  title: string
  /** Effective meta description (seo description, else excerpt). */
  metaDescription: string
  /** Post body HTML. */
  content: string
  /** Optional focus keyword — unlocks the keyword-placement checks. */
  focusKeyword?: string
}

export interface ContentAnalysis {
  score: number // 0..100
  checks: ContentCheck[]
  /** True when nothing scored `bad` — i.e. the post would clear the gate's
   *  per-page rules (corpus-uniqueness is checked separately at publish). */
  wouldPass: boolean
}

function countMatches(haystack: string, needle: string): number {
  if (!needle) return 0
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let i = 0, c = 0
  for (;;) {
    const at = h.indexOf(n, i)
    if (at < 0) break
    c++
    i = at + n.length
  }
  return c
}

function firstParagraph(html: string): string {
  const m = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(html)
  return stripHtml(m ? m[1] : html.slice(0, 500))
}

function headings(html: string): string[] {
  const out: string[] = []
  const re = /<h[2-6][^>]*>([\s\S]*?)<\/h[2-6]>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(stripHtml(m[1]))
  return out
}

/** <img> tags that lack a non-empty alt attribute (S2 image-SEO tie-in). */
export function imagesMissingAlt(html: string): number {
  let missing = 0
  const re = /<img\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(m[0])
    if (!alt || !alt[1].trim()) missing++
  }
  return missing
}

function countLinks(html: string): number {
  return (html.match(/<a\b[^>]*\bhref\s*=/gi) || []).length
}

/**
 * Analyze a post for the live "Content" tab. Returns a status per check plus a
 * 0..100 score. The word-count and meta checks reuse the gate's exact
 * thresholds, so a `bad` here means the same rule will block publish.
 */
export function analyzeContent(input: ContentAnalysisInput): ContentAnalysis {
  const checks: ContentCheck[] = []
  const cfg = DEFAULT_GATE_CONFIG
  const text = stripHtml(input.content)
  const words = wordCount(input.content)
  const kw = (input.focusKeyword || "").trim()

  // 1. Word count — SAME minimum as the quality gate (shared threshold).
  checks.push({
    id: "word_count",
    label: "Content length",
    status: words >= cfg.minWords ? "good" : words >= cfg.minWords / 2 ? "warn" : "bad",
    detail: `${words} words (gate minimum ${cfg.minWords})`,
  })

  // 2. Title present + fits the SERP width.
  const title = input.title.trim()
  const tt = truncateToPixels(title, SERP_TITLE_PX)
  checks.push({
    id: "title",
    label: "SEO title",
    status: !title ? "bad" : tt.truncated ? "warn" : "good",
    detail: !title ? "missing title" : tt.truncated ? "will be truncated in search results" : "good length",
  })

  // 3. Meta description — gate requires ≥ 20 chars; warn if it won't fill SERP.
  const meta = input.metaDescription.trim()
  const md = truncateToPixels(meta, SERP_DESC_PX)
  checks.push({
    id: "meta_description",
    label: "Meta description",
    status: meta.length < 20 ? "bad" : md.truncated ? "warn" : "good",
    detail: meta.length < 20 ? "missing or too short (gate needs ≥ 20 chars)" : md.truncated ? "longer than search results show" : "good length",
  })

  // 4. Subheadings for scannability.
  const hs = headings(input.content)
  checks.push({
    id: "headings",
    label: "Subheadings",
    status: hs.length >= 1 ? "good" : "warn",
    detail: hs.length >= 1 ? `${hs.length} subheading${hs.length === 1 ? "" : "s"}` : "no H2–H6 subheadings",
  })

  // 5. At least one link.
  const links = countLinks(input.content)
  checks.push({
    id: "links",
    label: "Links",
    status: links >= 1 ? "good" : "warn",
    detail: links >= 1 ? `${links} link${links === 1 ? "" : "s"}` : "no links in the content",
  })

  // 6. Image alt text (ties to the image-SEO tools).
  const missingAlt = imagesMissingAlt(input.content)
  const imgTotal = (input.content.match(/<img\b/gi) || []).length
  if (imgTotal > 0) {
    checks.push({
      id: "image_alt",
      label: "Image alt text",
      status: missingAlt === 0 ? "good" : "bad",
      detail: missingAlt === 0 ? "every image has alt text" : `${missingAlt} of ${imgTotal} images missing alt text`,
    })
  }

  // 7. Focus-keyword placement (only when a keyword is set).
  if (kw) {
    const inTitle = countMatches(title, kw) > 0
    checks.push({
      id: "kw_title",
      label: "Keyword in title",
      status: inTitle ? "good" : "warn",
      detail: inTitle ? "focus keyword is in the title" : "focus keyword not in the title",
    })
    const inFirst = countMatches(firstParagraph(input.content), kw) > 0
    checks.push({
      id: "kw_intro",
      label: "Keyword in intro",
      status: inFirst ? "good" : "warn",
      detail: inFirst ? "focus keyword appears early" : "focus keyword missing from the first paragraph",
    })
    const inHeading = hs.some((h) => countMatches(h, kw) > 0)
    checks.push({
      id: "kw_heading",
      label: "Keyword in a subheading",
      status: inHeading ? "good" : "warn",
      detail: inHeading ? "focus keyword is in a subheading" : "focus keyword not in any subheading",
    })
    const occurrences = countMatches(text, kw)
    const density = words > 0 ? (occurrences * (kw.split(/\s+/).length)) / words : 0
    const pct = Math.round(density * 1000) / 10
    checks.push({
      id: "kw_density",
      label: "Keyword density",
      // Over-optimization is a real penalty risk, so a stuffed keyword is `bad`.
      status: density === 0 ? "warn" : density > 0.035 ? "bad" : density < 0.003 ? "warn" : "good",
      detail: `${pct}% (${occurrences}×) — aim for 0.3–3%`,
    })
  }

  const weight: Record<CheckStatus, number> = { good: 1, warn: 0.5, bad: 0 }
  const score = checks.length
    ? Math.round((checks.reduce((s, c) => s + weight[c.status], 0) / checks.length) * 100)
    : 100
  return { score, checks, wouldPass: !checks.some((c) => c.status === "bad") }
}
