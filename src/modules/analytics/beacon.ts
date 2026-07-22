// src/modules/analytics/beacon.ts
// PUBLIC first-party analytics ingest (V1.5 M3, Amendment 4a). Static customer
// sites POST here from the one allowed beacon (/a.js). Cookieless, no IP stored,
// no fingerprint: we persist ONLY an event type, the on-site path, the referrer
// ORIGIN (never the full URL), and a short bounded attribute (a CTA label,
// scroll bucket, outbound host, or engaged seconds). The site is identified by
// an opaque token minted when the owner enables analytics — never a hostname.
//
// Writes go to Workers Analytics Engine (cheap, high-volume, cardinality-safe);
// the nightly rollup (analyticsRollup.ts) aggregates them into site_metrics.
// The binding is optional and every write is guarded, so this is inert both when
// FEATURE_ANALYTICS is off and when the dataset isn't provisioned.

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { saasActive } from "../auth"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { allowRate } from "../../shared/rateLimit"

// The closed set of event types the beacon emits (kept in lock-step with a.js):
//   pv page view · sd scroll-depth bucket · cl tagged click · ob outbound click
//   te time-engaged (seconds)
export const BEACON_EVENT_TYPES = ["pv", "sd", "cl", "ob", "te"] as const
export type BeaconEventType = (typeof BEACON_EVENT_TYPES)[number]

export interface BeaconEvent {
  /** Site token (opaque, maps to a customer_site via analytics_key). */
  s: string
  /** Event type. */
  t: BeaconEventType
  /** On-site path (leading-slash, query/hash stripped, bounded). */
  p: string
  /** Referrer ORIGIN only ("" for none / same-origin / opaque). */
  r: string
  /** Bounded attribute: CTA label, scroll bucket, outbound host, or seconds. */
  a: string
}

const MAX_TOKEN = 80
const MAX_PATH = 512
const MAX_ATTR = 120
const MAX_REF = 255

/** Keep a path only: leading slash, no query/fragment, printable, bounded. */
function cleanPath(raw: unknown): string {
  let p = typeof raw === "string" ? raw : "/"
  const cut = p.search(/[?#]/)
  if (cut >= 0) p = p.slice(0, cut)
  if (!p.startsWith("/")) p = "/" + p
  // strip control chars; collapse to a sane length
  p = p.replace(/[\u0000-\u001f\u007f]/g, "")
  return p.slice(0, MAX_PATH) || "/"
}

/** Referrer must already be an origin from the beacon; re-validate defensively. */
function cleanReferrer(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return ""
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" && u.protocol !== "https:") return ""
    return u.origin.slice(0, MAX_REF)
  } catch {
    return ""
  }
}

/**
 * Validate + normalise one beacon payload into a stored event, or null if it's
 * malformed or carries a type we don't accept. Pure — the hot-path gate.
 */
export function parseBeaconEvent(raw: unknown): BeaconEvent | null {
  if (!raw || typeof raw !== "object") return null
  const o = raw as Record<string, unknown>
  const s = typeof o.s === "string" ? o.s.trim().slice(0, MAX_TOKEN) : ""
  const t = o.t
  if (!s) return null
  if (typeof t !== "string" || !(BEACON_EVENT_TYPES as readonly string[]).includes(t)) return null
  const type = t as BeaconEventType

  let a = typeof o.a === "string" ? o.a.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_ATTR) : ""
  // Per-type attribute discipline — never store anything unexpected.
  if (type === "sd") {
    a = ["25", "50", "75", "100"].includes(a) ? a : ""
    if (!a) return null
  } else if (type === "te") {
    const n = Math.round(Number(a))
    if (!Number.isFinite(n) || n < 0) return null
    a = String(Math.min(n, 86400)) // clamp to a day of engagement
  } else if (type === "ob") {
    // outbound host: hostname characters only
    a = /^[a-z0-9.-]+$/i.test(a) ? a.toLowerCase() : ""
    if (!a) return null
  } else if (type === "pv") {
    a = ""
  }
  // "cl" keeps its bounded label as-is.

  return { s, t: type, p: cleanPath(o.p), r: cleanReferrer(o.r), a }
}

/** Build the Analytics Engine data point for one event. Pure. */
export function beaconDataPoint(siteId: string, ev: BeaconEvent): AnalyticsEngineDataPoint {
  return {
    // index1 = the site → cheap per-site queries + sampling key.
    indexes: [siteId],
    // blobs carry the dimensions we aggregate on.
    blobs: [ev.t, ev.p, ev.r, ev.a],
    // doubles: a count of 1 (+ engaged seconds when present) for SUM rollups.
    doubles: [1, ev.t === "te" ? Number(ev.a) || 0 : 0],
  }
}

export const beaconIngestRoutes = new Hono<AppEnv>()

// OPTIONS is unnecessary for sendBeacon (a CORS-simple request), but answer it
// permissively in case a site is later wired to fetch() the endpoint.
beaconIngestRoutes.options("/", (c, next) => {
  if (!saasActive(c)) return next()
  return c.body(null, 204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  })
})

// POST /api/saas/beacon — the ingest. Always answers 204 (never leaks whether a
// token is valid); best-effort so a bad payload or missing binding is a no-op.
beaconIngestRoutes.post("/", async (c, next) => {
  if (!saasActive(c)) return next()
  const noContent = () => c.body(null, 204, { "Access-Control-Allow-Origin": "*" })
  if (c.env.FEATURE_ANALYTICS !== "1") return noContent()

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    // sendBeacon posts a JSON string as text/plain — parse the raw body too.
    try {
      payload = JSON.parse(await c.req.text())
    } catch {
      return noContent()
    }
  }
  const ev = parseBeaconEvent(payload)
  if (!ev) return noContent()

  try {
    const master = getMasterDb(c.env)
    await ensureMasterSchema(master)
    const row = await master.execute({
      sql: "SELECT id FROM customer_sites WHERE analytics_key = ? AND status != 'deleted' LIMIT 1",
      args: [ev.s],
    })
    if (!row.rows.length) return noContent()
    const siteId = String(row.rows[0].id)

    // Cheap per-token flood guard (fixed window). Generous — real page traffic
    // fires several events per view; this only trips on abuse.
    const ok = await allowRate(master, `beacon:${ev.s}`, { max: 6000, windowSecs: 60 })
    if (!ok) return noContent()

    c.env.ANALYTICS?.writeDataPoint(beaconDataPoint(siteId, ev))
  } catch (err) {
    console.error("beacon ingest failed:", err instanceof Error ? err.message : err)
  }
  return noContent()
})
