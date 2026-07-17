// src/modules/analytics/uptime.ts
// Uptime monitoring (un-deferred on Workers Paid — PLAN.md decision #6). Every
// */5 cron tick probes each active site and rolls the result into a per-day
// site_metrics row (source='uptime'). Pure classification + summary are unit-
// tested; the probe + walk are best-effort I/O.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"

// Paid tier allows 1000 subrequests/invocation; cap anyway so one tick stays
// bounded regardless of portfolio size (the rest are covered next tick).
const MAX_SITES_PER_TICK = 100
const PROBE_TIMEOUT_MS = 8000

export type SiteHealth = "up" | "down"

/** A site is "up" on any non-5xx, non-network response. Pure. */
export function classifyHttp(status: number): SiteHealth {
  if (status === 0) return "down"            // network error / timeout
  return status >= 500 ? "down" : "up"       // 2xx/3xx/4xx served = reachable
}

export interface UptimeRollup {
  checks: number
  up: number
  lastStatus: number
  lastLatencyMs: number
  lastCheckedAt: string
}

/** Uptime % from a rollup (0..100). Pure. */
export function uptimePct(r: Pick<UptimeRollup, "checks" | "up">): number {
  return r.checks > 0 ? Math.round((r.up / r.checks) * 1000) / 10 : 100
}

/** Fold a new sample into a day's rollup. Pure. */
export function foldSample(prev: UptimeRollup | null, sample: { up: boolean; status: number; latencyMs: number; at: string }): UptimeRollup {
  const base = prev ?? { checks: 0, up: 0, lastStatus: 0, lastLatencyMs: 0, lastCheckedAt: "" }
  return {
    checks: base.checks + 1,
    up: base.up + (sample.up ? 1 : 0),
    lastStatus: sample.status,
    lastLatencyMs: sample.latencyMs,
    lastCheckedAt: sample.at,
  }
}

/** Probe one site. Best-effort — a thrown/timed-out request is status 0 (down). */
export async function probeSite(url: string, nowMs: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ up: boolean; status: number; latencyMs: number }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const start = nowMs
  try {
    const resp = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal })
    return { up: classifyHttp(resp.status) === "up", status: resp.status, latencyMs: Math.max(0, Date.now() - start) }
  } catch {
    return { up: false, status: 0, latencyMs: 0 }
  } finally {
    clearTimeout(timer)
  }
}

function safeRollup(s: string): UptimeRollup | null {
  try {
    const o = JSON.parse(s) as Partial<UptimeRollup>
    if (typeof o.checks === "number") return o as UptimeRollup
  } catch { /* ignore */ }
  return null
}

/**
 * Cron entry (rides the 5-minute branch, SAAS_MODE-gated): probe active sites
 * and roll results into site_metrics (source='uptime', one row per site/day).
 */
export async function runUptimeChecks(env: CloudflareEnv, nowMs: number): Promise<{ checked: number }> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  const sites = await master.execute({
    sql: "SELECT id, domain FROM customer_sites WHERE status = 'active' AND domain IS NOT NULL ORDER BY created_at ASC LIMIT ?",
    args: [MAX_SITES_PER_TICK],
  })
  const day = new Date(nowMs).toISOString().slice(0, 10)
  let checked = 0
  for (const row of sites.rows) {
    const siteId = String(row.id)
    const domain = String(row.domain)
    if (!domain) continue
    const sample = await probeSite(`https://${domain}/`, nowMs).catch(() => ({ up: false, status: 0, latencyMs: 0 }))
    const existing = await master.execute({
      sql: "SELECT payload FROM site_metrics WHERE customer_site_id = ? AND day = ? AND source = 'uptime' LIMIT 1",
      args: [siteId, day],
    })
    const rolled = foldSample(existing.rows.length ? safeRollup(String(existing.rows[0].payload)) : null, {
      up: sample.up, status: sample.status, latencyMs: sample.latencyMs, at: new Date(nowMs).toISOString(),
    })
    await master.execute({
      sql: `INSERT INTO site_metrics (customer_site_id, day, source, payload) VALUES (?, ?, 'uptime', ?)
            ON CONFLICT(customer_site_id, day, source) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`,
      args: [siteId, day, JSON.stringify(rolled)],
    })
    checked++
  }
  return { checked }
}

/** Latest uptime rollup for a site (for the performance page). */
export async function loadUptime(master: Client, siteId: string): Promise<UptimeRollup | null> {
  const r = await master.execute({
    sql: "SELECT payload FROM site_metrics WHERE customer_site_id = ? AND source = 'uptime' ORDER BY day DESC LIMIT 1",
    args: [siteId],
  })
  return r.rows.length ? safeRollup(String(r.rows[0].payload)) : null
}
