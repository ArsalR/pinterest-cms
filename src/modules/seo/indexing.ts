// src/modules/seo/indexing.ts
// Indexing ops (S5) — PURE classification + diagnosis on top of the GSC URL
// Inspection API and sitemap coverage (network/gsc.ts does the I/O). Turns
// Google's terse coverage strings into plain-language status + a recommended
// action, and runs the deindex watch. No I/O — unit-tested.

import type { UrlInspection, SitemapStatus } from "../network"

export type IndexStatus =
  | "indexed"
  | "not_indexed"       // crawled/discovered but not indexed (fixable)
  | "excluded_noindex"  // deliberately excluded via noindex
  | "excluded_canonical"
  | "blocked"           // robots.txt / auth
  | "error"             // 404 / soft-404 / server error
  | "unknown"

export interface IndexDiagnosis {
  status: IndexStatus
  indexed: boolean
  /** Short plain-language state for the operator. */
  label: string
  /** What to do about it (empty when already indexed). */
  recommendation: string
}

const RULES: Array<{ status: IndexStatus; indexed: boolean; match: RegExp; label: string; recommendation: string }> = [
  { status: "indexed", indexed: true, match: /indexed/i, label: "Indexed", recommendation: "" },
  { status: "excluded_noindex", indexed: false, match: /noindex/i, label: "Excluded by a noindex tag", recommendation: "This page carries a noindex directive. Turn off ‘No-index’ in the SEO cockpit if it should appear in search." },
  { status: "blocked", indexed: false, match: /blocked|robots\.txt/i, label: "Blocked from crawling", recommendation: "robots.txt is blocking this URL. Check the SEO settings crawler rules." },
  { status: "excluded_canonical", indexed: false, match: /canonical|duplicate|alternate/i, label: "Treated as a duplicate", recommendation: "Google chose a different canonical. Set the canonical URL in the SEO cockpit if this page should be the original." },
  { status: "error", indexed: false, match: /not found|404|soft 404|server error|5xx|redirect/i, label: "Not reachable", recommendation: "Google hit a 404/redirect/server error. Add a redirect in the Redirects manager or fix the page." },
  { status: "not_indexed", indexed: false, match: /crawled|discovered|not indexed/i, label: "Crawled but not indexed yet", recommendation: "Google knows the URL but hasn’t indexed it. Improve the content (Content tab) and request indexing in Search Console." },
  { status: "unknown", indexed: false, match: /unknown/i, label: "Not yet seen by Google", recommendation: "Google hasn’t discovered this URL. Make sure it’s in the sitemap, then request indexing." },
]

/** Map a URL Inspection result to a plain-language diagnosis. Pure. */
export function diagnoseInspection(insp: Pick<UrlInspection, "verdict" | "coverageState">): IndexDiagnosis {
  const cov = insp.coverageState || ""
  // noindex/blocked/error take precedence over a bare "indexed" substring.
  for (const r of RULES) {
    if (r.status === "indexed") continue
    if (r.match.test(cov)) return { status: r.status, indexed: r.indexed, label: r.label, recommendation: r.recommendation }
  }
  if (/indexed/i.test(cov) && insp.verdict === "PASS") {
    return { status: "indexed", indexed: true, label: "Indexed", recommendation: "" }
  }
  if (/indexed/i.test(cov)) return { status: "indexed", indexed: true, label: "Indexed", recommendation: "" }
  return { status: "unknown", indexed: false, label: cov || "Unknown", recommendation: "Check this URL in Search Console." }
}

// Below this indexed/submitted ratio (with a meaningful sample) the deindex
// watch raises a warning — a sudden coverage drop usually means a sitewide
// mistake (accidental noindex, robots block, broken deploy).
export const DEINDEX_COVERAGE_FLOOR = 0.7
const DEINDEX_MIN_SAMPLE = 10

export interface CoverageSummary {
  submitted: number
  indexed: number
  /** 0..1 indexed/submitted; 1 when nothing submitted. */
  coverage: number
  /** True when coverage dropped below the floor with a meaningful sample. */
  deindexRisk: boolean
}

/** Aggregate sitemap coverage and run the deindex watch. Pure. */
export function indexCoverage(sitemaps: Pick<SitemapStatus, "submitted" | "indexed">[]): CoverageSummary {
  let submitted = 0, indexed = 0
  for (const s of sitemaps) { submitted += s.submitted; indexed += s.indexed }
  const coverage = submitted > 0 ? indexed / submitted : 1
  const deindexRisk = submitted >= DEINDEX_MIN_SAMPLE && coverage < DEINDEX_COVERAGE_FLOOR
  return { submitted, indexed, coverage, deindexRisk }
}

/** GSC URL Inspection deep link — our "request indexing" hand-off (the API
 *  can't trigger it directly; this opens the URL in Search Console). Pure. */
export function inspectDeepLink(siteProperty: string, url: string): string {
  return `https://search.google.com/search-console/inspect?resource_id=${encodeURIComponent(siteProperty)}&id=${encodeURIComponent(url)}`
}
