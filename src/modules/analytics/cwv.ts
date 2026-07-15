// src/modules/analytics/cwv.ts
// Core Web Vitals classification + degradation alerts (Performance Covenant P8:
// "alerts when any vital degrades"). The rating thresholds and alert logic are
// pure and unit-tested; the RUM data itself comes from Cloudflare Web Analytics
// (fetchCwv, best-effort — returns null until data flows).

import type { CloudflareEnv } from "../../lib/types"

export interface Cwv {
  lcpMs: number // p75 Largest Contentful Paint
  cls: number   // p75 Cumulative Layout Shift
  inpMs: number // p75 Interaction to Next Paint
}

export type Rating = "good" | "needs-improvement" | "poor"

// Google's Core Web Vitals thresholds (p75).
export function rateLcp(ms: number): Rating {
  return ms <= 2500 ? "good" : ms <= 4000 ? "needs-improvement" : "poor"
}
export function rateCls(v: number): Rating {
  return v <= 0.1 ? "good" : v <= 0.25 ? "needs-improvement" : "poor"
}
export function rateInp(ms: number): Rating {
  return ms <= 200 ? "good" : ms <= 500 ? "needs-improvement" : "poor"
}

export interface CwvAlert {
  metric: "LCP" | "CLS" | "INP"
  rating: Rating
  message: string
}

/**
 * Alerts when a vital is poor, or when it degraded a full rating band vs. the
 * previous period (P8: "alerts when any vital degrades"). Pure — unit-tested.
 */
export function cwvAlerts(current: Cwv, previous?: Cwv | null): CwvAlert[] {
  const alerts: CwvAlert[] = []
  const rank: Record<Rating, number> = { good: 0, "needs-improvement": 1, poor: 2 }

  const rows: Array<{ metric: CwvAlert["metric"]; cur: Rating; prev: Rating | null; label: string }> = [
    { metric: "LCP", cur: rateLcp(current.lcpMs), prev: previous ? rateLcp(previous.lcpMs) : null, label: "loads slowly" },
    { metric: "CLS", cur: rateCls(current.cls), prev: previous ? rateCls(previous.cls) : null, label: "shifts layout" },
    { metric: "INP", cur: rateInp(current.inpMs), prev: previous ? rateInp(previous.inpMs) : null, label: "responds slowly" },
  ]
  for (const r of rows) {
    if (r.cur === "poor") {
      alerts.push({ metric: r.metric, rating: "poor", message: `${r.metric} is poor — the site ${r.label} for real visitors.` })
    } else if (r.prev !== null && rank[r.cur] > rank[r.prev]) {
      alerts.push({ metric: r.metric, rating: r.cur, message: `${r.metric} degraded from ${r.prev} to ${r.cur} since the last period.` })
    }
  }
  return alerts
}

/**
 * Fetch p75 CWV from Cloudflare Web Analytics (RUM) via the GraphQL Analytics
 * API, using the customer's CF token + account. Best-effort: returns null on
 * any error or when RUM has no data yet (a new site).
 */
export async function fetchCwv(
  cfToken: string,
  accountTag: string,
  siteTag: string,
  sinceIso: string,
  untilIso: string
): Promise<Cwv | null> {
  const query = `query Cwv($accountTag: String!, $siteTag: String!, $since: Time!, $until: Time!) {
    viewer { accounts(filter: { accountTag: $accountTag }) {
      rumPerformanceEventsAdaptiveGroups(
        limit: 1,
        filter: { siteTag: $siteTag, datetime_geq: $since, datetime_leq: $until }
      ) {
        quantiles { largestContentfulPaintP75 firstInputDelayP75 cumulativeLayoutShiftP75 }
      }
    } }
  }`
  try {
    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { accountTag, siteTag, since: sinceIso, until: untilIso } }),
    })
    if (!resp.ok) return null
    const body = (await resp.json().catch(() => null)) as {
      data?: { viewer?: { accounts?: Array<{ rumPerformanceEventsAdaptiveGroups?: Array<{ quantiles?: { largestContentfulPaintP75?: number; firstInputDelayP75?: number; cumulativeLayoutShiftP75?: number } }> }> } }
    } | null
    const q = body?.data?.viewer?.accounts?.[0]?.rumPerformanceEventsAdaptiveGroups?.[0]?.quantiles
    if (!q || q.largestContentfulPaintP75 == null) return null
    return {
      lcpMs: Math.round(q.largestContentfulPaintP75 ?? 0),
      cls: q.cumulativeLayoutShiftP75 ?? 0,
      inpMs: Math.round(q.firstInputDelayP75 ?? 0),
    }
  } catch {
    return null
  }
}
