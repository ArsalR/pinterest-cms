// src/modules/seo/safety.ts
// Safety rail #2 (SEO-safety quality gate). Pure, default-ON. A deploy that
// would deindex a large share of the live site — or block the major search
// engines outright — is almost always a mistake, so the gate BLOCKS it unless
// the operator types an explicit override phrase (which the caller audit-logs).
//
// S1 owns the per-post noindex ratio check (per-post noindex ships in S1).
// The "blocks major search engines" input is wired here so S3's robots/crawler
// hub can feed it without reshaping this contract.

/** Deindex this share (or more) of published pages ⇒ blocked without override. */
export const NOINDEX_RATIO_LIMIT = 0.3

/** The exact phrase an operator must type to override a blocked SEO deploy. */
export const SEO_SAFETY_OVERRIDE_PHRASE = "NOINDEX ANYWAY"

export interface SeoSafetyInput {
  /** Count of currently-published pages the build would emit. */
  totalPublished: number
  /** Of those, how many would carry a noindex directive after this change. */
  noindexCount: number
  /** True if the effective robots policy would Disallow major crawlers site-wide. */
  blocksMajorEngines?: boolean
  /** Operator-typed override; must equal SEO_SAFETY_OVERRIDE_PHRASE to bypass. */
  typedOverride?: string | null
}

export interface SeoSafetyResult {
  /** May the deploy proceed? */
  passed: boolean
  /** Would this deploy be blocked absent an override? (independent of `passed`) */
  blocked: boolean
  /** True when the caller supplied a valid override to bypass a block. */
  overridden: boolean
  /** Human-readable reasons the deploy tripped the gate. */
  reasons: string[]
  /** Deindexed share of published pages, 0..1. */
  noindexRatio: number
}

/**
 * Evaluate the SEO-safety gate. Pure — no I/O, no audit logging (the caller
 * logs when `overridden` is true). Zero published pages ⇒ nothing to protect,
 * so the gate passes trivially.
 */
export function checkSeoSafety(input: SeoSafetyInput): SeoSafetyResult {
  const total = Math.max(0, input.totalPublished)
  const noindex = Math.max(0, Math.min(input.noindexCount, total))
  const noindexRatio = total > 0 ? noindex / total : 0

  const reasons: string[] = []
  if (total > 0 && noindexRatio > NOINDEX_RATIO_LIMIT) {
    reasons.push(
      `Would noindex ${Math.round(noindexRatio * 100)}% of published pages ` +
        `(${noindex}/${total}) — over the ${Math.round(NOINDEX_RATIO_LIMIT * 100)}% limit.`
    )
  }
  if (input.blocksMajorEngines) {
    reasons.push("Would block major search engines from the entire site.")
  }

  const blocked = reasons.length > 0
  const overridden = blocked && (input.typedOverride ?? "").trim() === SEO_SAFETY_OVERRIDE_PHRASE

  return {
    passed: !blocked || overridden,
    blocked,
    overridden,
    reasons,
    noindexRatio,
  }
}
