// src/modules/agency/service.ts
// Agency data + orchestration (K11): white-label settings, client seats
// (signed-link access to scoped reports), report metric gathering, and the
// monthly-report cron. Report metrics are gathered best-effort from cached
// rollups + live GSC when connected; a failure yields a thinner report, never
// a thrown cron.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { signJwt, verifyJwt } from "../../lib/auth"
import { cuid } from "../../lib/utils"
import { sendEmail } from "../customers"
import { gscAccessToken, fetchSiteSearchData } from "../network"
import { loadClickTotals } from "../affiliate"
import { resolveBrand, type AgencyBrand, type BrandSettings } from "./branding"
import { buildSiteReport, renderReportHtml, reportEmailSubject, type SiteMetrics } from "./reports"

// ─────────────────────── white-label settings ───────────────────────

export interface AgencySettings extends BrandSettings {
  reports_enabled?: boolean
}

export async function loadAgencySettings(master: Client, customerId: string): Promise<AgencySettings | null> {
  const r = await master.execute({ sql: "SELECT * FROM agency_settings WHERE customer_id = ? LIMIT 1", args: [customerId] })
  if (!r.rows.length) return null
  const row = r.rows[0] as Record<string, unknown>
  return {
    enabled: Number(row.enabled) === 1,
    brand_name: (row.brand_name as string | null) ?? null,
    brand_color: (row.brand_color as string | null) ?? null,
    logo_url: (row.logo_url as string | null) ?? null,
    reports_enabled: Number(row.reports_enabled) === 1,
  }
}

export async function saveAgencySettings(master: Client, customerId: string, s: AgencySettings): Promise<void> {
  await master.execute({
    sql: `INSERT INTO agency_settings (customer_id, enabled, brand_name, brand_color, logo_url, reports_enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(customer_id) DO UPDATE SET
            enabled = excluded.enabled, brand_name = excluded.brand_name, brand_color = excluded.brand_color,
            logo_url = excluded.logo_url, reports_enabled = excluded.reports_enabled, updated_at = datetime('now')`,
    args: [customerId, s.enabled ? 1 : 0, s.brand_name ?? null, s.brand_color ?? null, s.logo_url ?? null, s.reports_enabled ? 1 : 0],
  })
}

export async function loadBrand(master: Client, customerId: string): Promise<AgencyBrand> {
  return resolveBrand(await loadAgencySettings(master, customerId))
}

// ─────────────────────── client seats ───────────────────────

export interface Seat {
  id: string
  label: string
  email: string
  siteIds: string[]
  lastReportAt: string | null
}

export async function listSeats(master: Client, customerId: string): Promise<Seat[]> {
  const r = await master.execute({
    sql: "SELECT id, label, email, site_ids, last_report_at FROM client_seats WHERE customer_id = ? ORDER BY created_at DESC",
    args: [customerId],
  })
  return r.rows.map((row) => ({
    id: String(row.id),
    label: String(row.label),
    email: String(row.email),
    siteIds: safeArr(String(row.site_ids ?? "[]")),
    lastReportAt: (row.last_report_at as string | null) ?? null,
  }))
}

export async function createSeat(master: Client, customerId: string, label: string, email: string, siteIds: string[]): Promise<void> {
  await master.execute({
    sql: "INSERT INTO client_seats (id, customer_id, label, email, site_ids) VALUES (?, ?, ?, ?, ?)",
    args: [cuid(), customerId, label.slice(0, 80), email.slice(0, 200), JSON.stringify(siteIds)],
  })
}

export async function deleteSeat(master: Client, customerId: string, seatId: string): Promise<void> {
  await master.execute({ sql: "DELETE FROM client_seats WHERE id = ? AND customer_id = ?", args: [seatId, customerId] })
}

export async function loadSeat(master: Client, seatId: string): Promise<(Seat & { customerId: string }) | null> {
  const r = await master.execute({ sql: "SELECT * FROM client_seats WHERE id = ? LIMIT 1", args: [seatId] })
  if (!r.rows.length) return null
  const row = r.rows[0] as Record<string, unknown>
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    label: String(row.label),
    email: String(row.email),
    siteIds: safeArr(String(row.site_ids ?? "[]")),
    lastReportAt: (row.last_report_at as string | null) ?? null,
  }
}

/** Signed, long-lived read-only access link for a seat (no password). */
export async function signSeatToken(env: CloudflareEnv, seatId: string): Promise<string | null> {
  if (!env.SAAS_JWT_SECRET) return null
  return signJwt({ sub: seatId, aud: "client-seat" }, env.SAAS_JWT_SECRET, 400 * 24 * 3600)
}

export async function verifySeatToken(env: CloudflareEnv, token: string): Promise<string | null> {
  if (!env.SAAS_JWT_SECRET) return null
  const payload = await verifyJwt(token, env.SAAS_JWT_SECRET).catch(() => null)
  return payload && payload.aud === "client-seat" && typeof payload.sub === "string" ? payload.sub : null
}

export function seatPortalUrl(saasHost: string, token: string): string {
  return `https://${saasHost}/portal?token=${encodeURIComponent(token)}`
}

// ─────────────────────── report metrics ───────────────────────

interface SiteRef { id: string; name: string; domain: string }

async function loadSites(master: Client, customerId: string, siteIds: string[]): Promise<SiteRef[]> {
  if (!siteIds.length) return []
  const placeholders = siteIds.map(() => "?").join(",")
  const r = await master.execute({
    sql: `SELECT id, name, domain FROM customer_sites WHERE customer_id = ? AND id IN (${placeholders})`,
    args: [customerId, ...siteIds],
  })
  return r.rows as unknown as SiteRef[]
}

/** Gather one site's metrics for a report — best-effort, cached + live GSC. */
export async function gatherSiteMetrics(master: Client, env: CloudflareEnv, customerId: string, site: SiteRef, nowMs: number): Promise<SiteMetrics> {
  let clicks = 0
  let impressions = 0
  let decayingPages = 0
  try {
    const token = await gscAccessToken(master, env, customerId)
    if (token) {
      const data = await fetchSiteSearchData(token, site.domain, nowMs)
      clicks = data.totals.clicks
      impressions = data.totals.impressions
      decayingPages = data.decay.filter((d) => d.status === "decayed" || d.status === "slipping").length
    }
  } catch { /* thin report on failure */ }

  let cwv: SiteMetrics["cwv"] = null
  try {
    const c = await master.execute({
      sql: "SELECT payload FROM site_metrics WHERE customer_site_id = ? AND source = 'cwv' ORDER BY day DESC LIMIT 1",
      args: [site.id],
    })
    if (c.rows.length) {
      const p = JSON.parse(String(c.rows[0].payload)) as { lcpMs?: number; cls?: number; inpMs?: number }
      if (typeof p.lcpMs === "number") cwv = { lcpMs: p.lcpMs, cls: p.cls ?? 0, inpMs: p.inpMs ?? 0 }
    }
  } catch { /* no cwv */ }

  const affiliateClicks = (await loadClickTotals(master, site.id).catch(() => ({ total: 0 }))).total

  return { siteName: site.name, domain: site.domain, clicks, impressions, prevClicks: null, cwv, decayingPages, affiliateClicks }
}

// ─────────────────────── monthly report cron ───────────────────────

const MONTH_MS = 30 * 86_400_000

/**
 * Email each seat a white-labelled report of their assigned sites, once a
 * month. Rides the daily cron branch (SAAS_MODE-gated), self-throttled via
 * last_report_at. Best-effort.
 */
export async function runMonthlyReports(env: CloudflareEnv, nowMs: number): Promise<{ sent: number }> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  // Only customers who turned reports on AND hold an active Agency plan
  // (decision #3 — reports are the Agency-tier feature; a lapsed plan pauses
  // sends without deleting seats, so upgrading resumes cleanly).
  const agencies = await master.execute({
    sql: `SELECT a.customer_id FROM agency_settings a
          JOIN customers c ON c.id = a.customer_id
          WHERE a.reports_enabled = 1 AND c.plan = 'agency' AND c.plan_status = 'active'`,
    args: [],
  })
  const period = new Date(nowMs).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
  let sent = 0
  // Free-tier subrequest budget: each site report costs ~5 subrequests (GSC
  // refresh + search queries) and each seat ~1 email. Cap the sites processed
  // per invocation so this daily-cron task stays well under 50 subrequests
  // (shared with R2 GC + the dead-link cron). Monthly per-seat throttling means
  // unsent seats are simply picked up on the next daily tick.
  const MAX_SITES_PER_RUN = 6
  let sitesProcessed = 0

  for (const arow of agencies.rows) {
    if (sitesProcessed >= MAX_SITES_PER_RUN) break
    const customerId = String(arow.customer_id)
    const brand = await loadBrand(master, customerId)
    const seats = await listSeats(master, customerId)
    for (const seat of seats) {
      if (sitesProcessed >= MAX_SITES_PER_RUN) break
      if (seat.lastReportAt) {
        const t = Date.parse(String(seat.lastReportAt).replace(" ", "T") + "Z")
        if (!Number.isNaN(t) && nowMs - t < MONTH_MS) continue // sent within the month
      }
      const sites = await loadSites(master, customerId, seat.siteIds)
      if (!sites.length) continue
      sitesProcessed += sites.length
      const cards: string[] = []
      for (const s of sites) {
        const metrics = await gatherSiteMetrics(master, env, customerId, s, nowMs).catch(() => null)
        if (metrics) cards.push(renderReportHtml(buildSiteReport(metrics), brand, period))
      }
      if (!cards.length) continue
      const ok = await sendEmail(env, {
        to: seat.email,
        subject: reportEmailSubject(brand, period),
        html: `<div style="background:#f3f4f6;padding:24px">${cards.join('<div style="height:16px"></div>')}</div>`,
      }).catch(() => false)
      if (ok) {
        sent++
        await master.execute({ sql: "UPDATE client_seats SET last_report_at = datetime('now') WHERE id = ?", args: [seat.id] }).catch(() => {})
      }
    }
  }
  return { sent }
}

function safeArr(s: string): string[] {
  try {
    const a = JSON.parse(s) as unknown
    return Array.isArray(a) ? a.map(String) : []
  } catch {
    return []
  }
}
