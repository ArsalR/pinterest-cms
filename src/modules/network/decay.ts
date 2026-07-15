// src/modules/network/decay.ts
// Content-decay radar (K4) — PURE logic, fully unit-tested. Given two periods
// of per-page Search Console data (a recent window vs. the prior window),
// classify each page by how much its clicks have fallen and surface the ones
// worth refreshing. No I/O; the caller supplies rows (live or from the
// site_metrics cache).
//
// Design: decay is about TREND, not absolute volume. A page that fell from 800
// to 300 clicks matters more than one that fell from 4 to 1, so we require both
// a meaningful relative drop AND a minimum prior-clicks floor before flagging —
// this keeps the radar from screaming about long-tail noise.

export interface PageClicks {
  page: string
  clicks: number
  impressions: number
  position: number
}

export type DecayStatus = "growing" | "stable" | "slipping" | "decayed"

export interface DecayConfig {
  minPriorClicks: number   // ignore pages below this in the prior window (noise floor)
  slippingDrop: number     // relative click drop to be "slipping" (0..1)
  decayedDrop: number      // relative click drop to be "decayed" (0..1)
  growthThreshold: number  // relative gain to be "growing" (0..1)
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  minPriorClicks: 10,
  slippingDrop: 0.25,
  decayedDrop: 0.5,
  growthThreshold: 0.1,
}

export interface DecayReport {
  page: string
  priorClicks: number
  recentClicks: number
  dropRatio: number        // (prior - recent) / prior, clamped to [-∞..1]; negative = growth
  status: DecayStatus
  recentPosition: number
  priorPosition: number
  positionDelta: number    // recent - prior; positive = worse (fell in rankings)
}

function classify(dropRatio: number, priorClicks: number, config: DecayConfig): DecayStatus {
  // Growth is judged regardless of volume — a brand-new or rising page is real.
  if (dropRatio <= -config.growthThreshold) return "growing"
  // The noise floor only suppresses false DECAY alarms on low-traffic pages.
  if (priorClicks < config.minPriorClicks) return "stable"
  if (dropRatio >= config.decayedDrop) return "decayed"
  if (dropRatio >= config.slippingDrop) return "slipping"
  return "stable"
}

/**
 * Compare recent vs. prior per-page rows and produce a decay report per page.
 * Pages present in EITHER window are included. Sorted worst-decay first, so the
 * dashboard shows what to fix at the top. Pure.
 */
export function detectDecay(
  recent: PageClicks[],
  prior: PageClicks[],
  config: DecayConfig = DEFAULT_DECAY_CONFIG
): DecayReport[] {
  const recentByPage = new Map(recent.map((r) => [r.page, r]))
  const priorByPage = new Map(prior.map((r) => [r.page, r]))
  const pages = new Set<string>([...recentByPage.keys(), ...priorByPage.keys()])

  const reports: DecayReport[] = []
  for (const page of pages) {
    const rec = recentByPage.get(page)
    const pri = priorByPage.get(page)
    const recentClicks = rec?.clicks ?? 0
    const priorClicks = pri?.clicks ?? 0
    // dropRatio: fraction of prior clicks lost. If there were no prior clicks,
    // any recent clicks are pure growth (ratio < 0); zero-zero is stable (0).
    const dropRatio = priorClicks > 0 ? (priorClicks - recentClicks) / priorClicks : recentClicks > 0 ? -1 : 0
    const recentPosition = rec?.position ?? 0
    const priorPosition = pri?.position ?? 0
    reports.push({
      page,
      priorClicks,
      recentClicks,
      dropRatio,
      status: classify(dropRatio, priorClicks, config),
      recentPosition,
      priorPosition,
      positionDelta: recentPosition && priorPosition ? recentPosition - priorPosition : 0,
    })
  }

  const order: Record<DecayStatus, number> = { decayed: 0, slipping: 1, stable: 2, growing: 3 }
  reports.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
    return b.dropRatio - a.dropRatio // within a bucket, biggest relative drop first
  })
  return reports
}

/** The pages worth a refresh right now (decayed or slipping). Pure. */
export function decayedPages(reports: DecayReport[]): DecayReport[] {
  return reports.filter((r) => r.status === "decayed" || r.status === "slipping")
}
