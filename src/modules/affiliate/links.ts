// src/modules/affiliate/links.ts
// Affiliate link hygiene (K10) — PURE engine, fully unit-tested. Two jobs:
//   1. compliance: every outbound link to an affiliate domain must carry
//      rel="sponsored nofollow noopener" and open in a new tab (Google requires
//      sponsored/nofollow on paid links; noopener is a safety default);
//   2. disclosure: an FTC-style disclosure must appear on any page that has
//      affiliate links.
// No I/O — the caller passes HTML + config; the service layer persists results.

export interface AffiliateConfig {
  affiliateDomains: string[] // bare hostnames, e.g. ["amazon.com", "amzn.to"]
  disclosureText: string
  // When set, affiliate links are wrapped through the platform's edge
  // click-counter (K10 "edge click counting"). Opt-in — off unless configured.
  clickTracking?: { siteId: string; saasHost: string }
}

export const DEFAULT_DISCLOSURE =
  "As an affiliate, we may earn a commission from qualifying purchases made through links on this page, at no extra cost to you."

// Sentinel class so we can detect (and not duplicate) an injected disclosure.
export const DISCLOSURE_CLASS = "affiliate-disclosure"

export interface LinkInfo {
  href: string
  rel: string
  isAffiliate: boolean
  compliant: boolean // affiliate links only: has sponsored + nofollow
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "").toLowerCase()
  } catch {
    return ""
  }
}

/** Is this href to one of the configured affiliate domains? Pure. */
export function isAffiliateHref(href: string, domains: string[]): boolean {
  const host = hostOf(href)
  if (!host) return false
  return domains.some((d) => {
    const dd = d.replace(/^www\./, "").toLowerCase().trim()
    return dd && (host === dd || host.endsWith(`.${dd}`))
  })
}

function relTokens(anchorTag: string): string {
  const m = /\brel\s*=\s*"([^"]*)"/i.exec(anchorTag) || /\brel\s*=\s*'([^']*)'/i.exec(anchorTag)
  return m ? m[1] : ""
}

/** Audit every outbound anchor in the HTML against the affiliate config. Pure. */
export function auditLinks(html: string, config: AffiliateConfig): LinkInfo[] {
  const out: LinkInfo[] = []
  const re = /<a\b([^>]*?)\bhref\s*=\s*["']([^"']+)["']([^>]*)>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const tag = m[0]
    const href = m[2]
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) continue
    const isAff = isAffiliateHref(href, config.affiliateDomains)
    const rel = relTokens(tag)
    const compliant = /\bsponsored\b/i.test(rel) && /\bnofollow\b/i.test(rel)
    out.push({ href, rel, isAffiliate: isAff, compliant: isAff ? compliant : true })
  }
  return out
}

/** True if the HTML already carries an injected disclosure. Pure. */
export function hasDisclosure(html: string): boolean {
  return html.includes(DISCLOSURE_CLASS)
}

/** Every outbound (http/https) anchor href in the HTML — feeds the dead-link scan. Pure. */
export function extractOutboundLinks(html: string): string[] {
  const out: string[] = []
  const re = /<a\b[^>]*?\bhref\s*=\s*["'](https?:\/\/[^"']+)["']/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (!out.includes(m[1])) out.push(m[1])
  }
  return out
}

/** The platform edge click-counter URL for a target link. Pure. */
export function clickTrackingUrl(saasHost: string, siteId: string, target: string): string {
  return `https://${saasHost}/api/saas/go/${encodeURIComponent(siteId)}?u=${encodeURIComponent(target)}`
}

export interface RewriteResult {
  html: string
  linksFixed: number
  disclosureAdded: boolean
}

/**
 * Rewrite affiliate anchors to be compliant (add rel="sponsored nofollow
 * noopener" + target="_blank" where missing) and prepend a disclosure if the
 * page has any affiliate links and none is present yet. Idempotent — running
 * twice changes nothing the second time. Pure.
 */
export function rewriteAffiliateLinks(html: string, config: AffiliateConfig): RewriteResult {
  let linksFixed = 0
  let sawAffiliate = false

  const rewritten = html.replace(/<a\b([^>]*)>/gi, (full, attrs: string) => {
    const hrefM = /\bhref\s*=\s*["']([^"']+)["']/i.exec(attrs)
    if (!hrefM) return full
    const targetHref = hrefM[1]
    if (!isAffiliateHref(targetHref, config.affiliateDomains)) return full
    sawAffiliate = true

    let newAttrs = attrs

    // Edge click counting (opt-in): route the affiliate link through the
    // platform counter. Once wrapped, the href host is the platform's, so a
    // re-run won't match isAffiliateHref — idempotent by construction.
    if (config.clickTracking) {
      const wrapped = clickTrackingUrl(config.clickTracking.saasHost, config.clickTracking.siteId, targetHref)
      newAttrs = newAttrs.replace(/\bhref\s*=\s*["'][^"']*["']/i, `href="${wrapped}"`)
    }
    const existingRel = relTokens(`<a ${attrs}>`)
    const relSet = new Set(existingRel.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase()))
    const hadTarget = /\btarget\s*=/i.test(attrs)
    // Already fully compliant? Then this is a no-op (keeps rewrite idempotent).
    // If click-tracking is on, an affiliate-host link always still needs
    // wrapping (a wrapped link's host is the platform's, so it wouldn't reach
    // here), so it's never "already compliant".
    const wasCompliant =
      relSet.has("sponsored") && relSet.has("nofollow") && relSet.has("noopener") && hadTarget && !config.clickTracking

    relSet.add("sponsored")
    relSet.add("nofollow")
    relSet.add("noopener")
    const relValue = Array.from(relSet).join(" ")

    if (existingRel) {
      newAttrs = newAttrs.replace(/\brel\s*=\s*["'][^"']*["']/i, `rel="${relValue}"`)
    } else {
      newAttrs = `${newAttrs} rel="${relValue}"`
    }
    if (!hadTarget) newAttrs = `${newAttrs} target="_blank"`

    if (!wasCompliant) linksFixed++
    return `<a ${newAttrs.trim()}>`
  })

  let finalHtml = rewritten
  let disclosureAdded = false
  if (sawAffiliate && !hasDisclosure(finalHtml)) {
    const banner = `<p class="${DISCLOSURE_CLASS}"><em>${config.disclosureText || DEFAULT_DISCLOSURE}</em></p>\n`
    finalHtml = banner + finalHtml
    disclosureAdded = true
  }
  return { html: finalHtml, linksFixed, disclosureAdded }
}
