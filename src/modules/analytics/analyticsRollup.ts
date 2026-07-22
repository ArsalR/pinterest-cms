// src/modules/analytics/analyticsRollup.ts
// Nightly rollup for first-party analytics (V1.5 M3). Raw beacon events live in
// Workers Analytics Engine (see beacon.ts); once a day we query the AE SQL API
// for each analytics-enabled site's PREVIOUS UTC day and fold the grouped rows
// into a compact JSON payload stored in master site_metrics (source='analytics').
// The Insights dashboard reads only those rollups — it never touches AE live.
//
// Best-effort + guarded: with no CF_API_TOKEN / no dataset / no traffic the
// rollup simply writes nothing, and the dashboard shows a "collecting" state —
// exactly how the CWV path degrades. The query builder + aggregator are pure
// (unit-tested); only the fetch + upsert touch the outside world.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"

export const ANALYTICS_DATASET = "site_beacon"
const TOP_N = 20

/** One raw grouped row from the AE SQL query. */
export interface BeaconRow {
  t: string // event type (pv|sd|cl|ob|te)
  p: string // path
  r: string // referrer origin
  a: string // attribute
  n: number // event count (sample-corrected)
  secs: number // summed engaged seconds (te only)
}

/** The compact per-day payload persisted to site_metrics. */
export interface AnalyticsDay {
  views: number
  paths: Array<{ path: string; views: number }>
  referrers: Array<{ origin: string; views: number }>
  scroll: { "25": number; "50": number; "75": number; "100": number }
  clicks: Array<{ label: string; count: number }>
  outbound: Array<{ host: string; count: number }>
  engagedSecondsTotal: number
  engagedSamples: number
}

export function emptyAnalyticsDay(): AnalyticsDay {
  return {
    views: 0, paths: [], referrers: [],
    scroll: { "25": 0, "50": 0, "75": 0, "100": 0 },
    clicks: [], outbound: [], engagedSecondsTotal: 0, engagedSamples: 0,
  }
}

/** YYYY-MM-DD (UTC) for the day that ended before `nowMs`. */
export function previousUtcDay(nowMs: number): string {
  return new Date(nowMs - 86400000).toISOString().slice(0, 10)
}

/**
 * AE SQL for one site's events within [day 00:00, next 00:00) UTC. Grouped so a
 * page-path/referrer with many hits collapses to a single sample-corrected row.
 */
export function buildBeaconQuery(dataset: string, siteId: string, day: string): string {
  const esc = (v: string) => v.replace(/'/g, "''")
  return (
    `SELECT blob1 AS t, blob2 AS p, blob3 AS r, blob4 AS a, ` +
    `sum(_sample_interval) AS n, sum(double2 * _sample_interval) AS secs ` +
    `FROM ${dataset} ` +
    `WHERE index1 = '${esc(siteId)}' ` +
    `AND timestamp >= toDateTime('${esc(day)} 00:00:00') ` +
    `AND timestamp < toDateTime('${esc(day)} 00:00:00') + INTERVAL '1' DAY ` +
    `GROUP BY t, p, r, a ORDER BY n DESC LIMIT 100000`
  )
}

/** Fold grouped rows into the compact day payload. Pure. */
export function aggregateBeaconRows(rows: BeaconRow[]): AnalyticsDay {
  const out = emptyAnalyticsDay()
  const paths = new Map<string, number>()
  const refs = new Map<string, number>()
  const clicks = new Map<string, number>()
  const outbound = new Map<string, number>()
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n)

  for (const row of rows) {
    const n = Number(row.n) || 0
    if (n <= 0) continue
    switch (row.t) {
      case "pv":
        out.views += n
        if (row.p) bump(paths, row.p, n)
        if (row.r) bump(refs, row.r, n)
        break
      case "sd":
        if (row.a === "25" || row.a === "50" || row.a === "75" || row.a === "100") out.scroll[row.a] += n
        break
      case "cl":
        if (row.a) bump(clicks, row.a, n)
        break
      case "ob":
        if (row.a) bump(outbound, row.a, n)
        break
      case "te":
        out.engagedSamples += n
        out.engagedSecondsTotal += Math.round(Number(row.secs) || 0)
        break
    }
  }
  const topBy = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N)
  out.paths = topBy(paths).map(([path, views]) => ({ path, views }))
  out.referrers = topBy(refs).map(([origin, views]) => ({ origin, views }))
  out.clicks = topBy(clicks).map(([label, count]) => ({ label, count }))
  out.outbound = topBy(outbound).map(([host, count]) => ({ host, count }))
  return out
}

/** Parse the AE SQL API JSON response into typed rows. Pure. */
export function parseAeResponse(json: unknown): BeaconRow[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data.map((d) => {
    const o = (d ?? {}) as Record<string, unknown>
    return {
      t: String(o.t ?? ""), p: String(o.p ?? ""), r: String(o.r ?? ""), a: String(o.a ?? ""),
      n: Number(o.n ?? 0), secs: Number(o.secs ?? 0),
    }
  })
}

/** Query the AE SQL API for one site+day. Returns null when unavailable. */
async function queryDay(env: CloudflareEnv, siteId: string, day: string): Promise<AnalyticsDay | null> {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return null
  const sql = buildBeaconQuery(ANALYTICS_DATASET, siteId, day)
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: sql }
    )
    if (!resp.ok) return null
    return aggregateBeaconRows(parseAeResponse(await resp.json()))
  } catch {
    return null
  }
}

/**
 * Roll up yesterday's beacon events for every analytics-enabled site into
 * site_metrics (source='analytics'). Rides the daily "0 4 * * *" cron. Inert
 * unless FEATURE_ANALYTICS = "1". Best-effort per site; one failure never stops
 * the walk.
 */
export async function runAnalyticsRollup(env: CloudflareEnv, nowMs: number): Promise<void> {
  if (env.FEATURE_ANALYTICS !== "1") return
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const day = previousUtcDay(nowMs)

  let sites
  try {
    const r = await master.execute({
      sql: "SELECT id FROM customer_sites WHERE analytics_key IS NOT NULL AND status != 'deleted'",
      args: [],
    })
    sites = r.rows
  } catch {
    return
  }

  for (const s of sites) {
    const siteId = String((s as unknown as { id: unknown }).id)
    try {
      const payload = await queryDay(env, siteId, day)
      if (!payload) continue
      await upsertAnalyticsDay(master, siteId, day, payload)
    } catch (err) {
      console.error(`analytics rollup: site ${siteId} failed:`, err instanceof Error ? err.message : err)
    }
  }
}

async function upsertAnalyticsDay(master: Client, siteId: string, day: string, payload: AnalyticsDay): Promise<void> {
  await master.execute({
    sql: `INSERT INTO site_metrics (customer_site_id, day, source, payload)
          VALUES (?, ?, 'analytics', ?)
          ON CONFLICT(customer_site_id, day, source)
          DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`,
    args: [siteId, day, JSON.stringify(payload)],
  })
}
