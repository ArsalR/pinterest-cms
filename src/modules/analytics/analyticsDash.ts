// src/modules/analytics/analyticsDash.ts
// Per-site Insights dashboard (V1.5 M3) — the customer-facing view of the
// first-party analytics beacon. Reads ONLY the nightly rollups in master
// site_metrics (source='analytics'); never queries Analytics Engine live.
// Charts are server-rendered SVG/CSS (zero client JS — the platform dashboard
// itself is not covenant-bound, but we keep it dependency-free anyway).
//
// Route: GET /app/sites/:id/analytics — the report + enable/disable toggle.
//        POST /app/sites/:id/analytics/toggle — flip analytics on/off.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, type Customer } from "../customers"
import { saveAnalytics } from "../seo"
import { emptyAnalyticsDay, type AnalyticsDay } from "./analyticsRollup"

const NO_STORE = { "Cache-Control": "no-store, private" }

interface AnalyticsSite {
  id: string; customer_id: string; cms_site_id: string | null
  domain: string; name: string; repo_full_name: string | null; analytics_key: string | null
}

async function loadSite(c: Context<AppEnv>, siteId: string, customerId: string): Promise<AnalyticsSite | null> {
  const master = getMasterDb(c.env)
  await ensureMasterSchema(master)
  const r = await master.execute({
    sql: `SELECT id, customer_id, cms_site_id, domain, name, repo_full_name, analytics_key
          FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1`,
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as AnalyticsSite) : null
}

function safeDay(raw: string): AnalyticsDay {
  try {
    const o = JSON.parse(raw) as Partial<AnalyticsDay>
    const base = emptyAnalyticsDay()
    return {
      views: Number(o.views) || 0,
      paths: Array.isArray(o.paths) ? o.paths.slice(0, 50) : [],
      referrers: Array.isArray(o.referrers) ? o.referrers.slice(0, 50) : [],
      scroll: { ...base.scroll, ...(o.scroll ?? {}) },
      clicks: Array.isArray(o.clicks) ? o.clicks.slice(0, 50) : [],
      outbound: Array.isArray(o.outbound) ? o.outbound.slice(0, 50) : [],
      engagedSecondsTotal: Number(o.engagedSecondsTotal) || 0,
      engagedSamples: Number(o.engagedSamples) || 0,
    }
  } catch {
    return emptyAnalyticsDay()
  }
}

/** Sum a set of days into one aggregate for the summary tables. */
function mergeDays(days: AnalyticsDay[]): AnalyticsDay {
  const out = emptyAnalyticsDay()
  const merge = (map: Map<string, number>, list: Array<Record<string, unknown>>, keyField: string, valField: string) => {
    for (const item of list) {
      const k = String(item[keyField] ?? "")
      if (k) map.set(k, (map.get(k) ?? 0) + (Number(item[valField]) || 0))
    }
  }
  const paths = new Map<string, number>(), refs = new Map<string, number>()
  const clicks = new Map<string, number>(), outbound = new Map<string, number>()
  for (const d of days) {
    out.views += d.views
    out.scroll["25"] += d.scroll["25"]; out.scroll["50"] += d.scroll["50"]
    out.scroll["75"] += d.scroll["75"]; out.scroll["100"] += d.scroll["100"]
    out.engagedSecondsTotal += d.engagedSecondsTotal
    out.engagedSamples += d.engagedSamples
    merge(paths, d.paths as unknown as Array<Record<string, unknown>>, "path", "views")
    merge(refs, d.referrers as unknown as Array<Record<string, unknown>>, "origin", "views")
    merge(clicks, d.clicks as unknown as Array<Record<string, unknown>>, "label", "count")
    merge(outbound, d.outbound as unknown as Array<Record<string, unknown>>, "host", "count")
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  out.paths = top(paths).map(([path, views]) => ({ path, views }))
  out.referrers = top(refs).map(([origin, views]) => ({ origin, views }))
  out.clicks = top(clicks).map(([label, count]) => ({ label, count }))
  out.outbound = top(outbound).map(([host, count]) => ({ host, count }))
  return out
}

/** Inline SVG column chart of daily views. Pure, zero JS. */
function viewsChart(series: Array<{ day: string; views: number }>): string {
  if (!series.length) return ""
  const w = 640, h = 160, pad = 24, n = series.length
  const max = Math.max(1, ...series.map((s) => s.views))
  const bw = (w - pad * 2) / n
  const bars = series.map((s, i) => {
    const bh = Math.round(((h - pad * 2) * s.views) / max)
    const x = pad + i * bw + bw * 0.15
    const y = h - pad - bh
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${(bw * 0.7).toFixed(1)}" height="${bh}" rx="2" fill="#60a5fa"><title>${escapeHtml(s.day)}: ${s.views} views</title></rect>`
  }).join("")
  const labels = series.map((s, i) => {
    if (n > 10 && i % 2 === 1) return ""
    const x = pad + i * bw + bw * 0.5
    return `<text x="${x.toFixed(1)}" y="${h - 6}" font-size="9" fill="#94a3b8" text-anchor="middle">${escapeHtml(s.day.slice(5))}</text>`
  }).join("")
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Daily page views">
    <text x="${pad}" y="14" font-size="10" fill="#94a3b8">peak ${max}/day</text>${bars}${labels}</svg>`
}

/** A horizontal bar row for a labelled table (path/referrer/etc.). */
function barRow(label: string, value: number, max: number, href?: string): string {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  const text = href
    ? `<a href="${escapeAttr(href)}" style="color:#93c5fd">${escapeHtml(label)}</a>`
    : escapeHtml(label)
  return `<tr>
    <td style="padding:3px 8px 3px 0;font-size:13px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${text}</td>
    <td style="width:180px"><div style="background:#1e293b;border-radius:3px;overflow:hidden"><div style="width:${pct}%;min-width:2px;height:14px;background:#6366f1"></div></div></td>
    <td style="padding-left:8px;font-size:13px;font-variant-numeric:tabular-nums;text-align:right">${value.toLocaleString("en-US")}</td>
  </tr>`
}

function table(title: string, rows: Array<{ label: string; value: number }>, empty: string): string {
  if (!rows.length) return `<div class="card"><h3 style="margin:0 0 6px;font-size:15px">${escapeHtml(title)}</h3><p class="muted" style="font-size:13px">${escapeHtml(empty)}</p></div>`
  const max = Math.max(1, ...rows.map((r) => r.value))
  return `<div class="card"><h3 style="margin:0 0 8px;font-size:15px">${escapeHtml(title)}</h3>
    <table style="width:100%;border-collapse:collapse"><tbody>${rows.map((r) => barRow(r.label, r.value, max)).join("")}</tbody></table></div>`
}

/** Scroll-depth funnel from bucket counts. */
function scrollFunnel(scroll: AnalyticsDay["scroll"]): string {
  const buckets: Array<[string, number]> = [["25%", scroll["25"]], ["50%", scroll["50"]], ["75%", scroll["75"]], ["100%", scroll["100"]]]
  const max = Math.max(1, ...buckets.map(([, v]) => v))
  const rows = buckets.map(([label, v]) => {
    const pct = Math.round((v / max) * 100)
    return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0">
      <span style="width:38px;font-size:12px;color:#94a3b8">${label}</span>
      <div style="flex:1;background:#1e293b;border-radius:3px;overflow:hidden"><div style="width:${pct}%;min-width:2px;height:16px;background:#34d399"></div></div>
      <span style="width:56px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums">${v.toLocaleString("en-US")}</span></div>`
  }).join("")
  return `<div class="card"><h3 style="margin:0 0 8px;font-size:15px">How far people scroll</h3>${rows}
    <p class="muted" style="font-size:12px;margin:8px 0 0">Share of views that reached each depth.</p></div>`
}

export async function analyticsDashHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadSite(c, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const master = getMasterDb(c.env)
  const enabled = !!site.analytics_key

  const backLink = `<p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>`

  // The enable/disable control (state-changing POST — SameSite cookie is the
  // CSRF defense, consistent with the rest of the dashboard).
  const toggle = `<form method="post" action="/app/sites/${escapeAttr(siteId)}/analytics/toggle" style="margin:0">
      <input type="hidden" name="enabled" value="${enabled ? "0" : "1"}">
      <button class="btn ${enabled ? "ghost" : ""}" type="submit">${enabled ? "Turn analytics off" : "Turn analytics on"}</button>
    </form>`

  if (!enabled) {
    const intro = `<div class="card">
      ${backLink}
      <h2 style="margin:0 0 4px;font-size:16px">Insights</h2>
      <p class="muted" style="font-size:13px">Privacy-first, cookie-free analytics built in — no Google Analytics, no consent banner, no third-party script. One tiny (1&nbsp;KB) first-party beacon measures page views, referrers, scroll depth, time on page, and clicks. No cookies, no cross-site tracking, no IP stored.</p>
      <div style="margin-top:12px">${toggle}</div>
    </div>`
    await audit(master, customer.id, "site.analytics_viewed", site.domain).catch(() => {})
    return c.html(renderSaasLayout({ title: "Insights", active: "sites", customer, bodyHtml: intro }), 200, NO_STORE)
  }

  // Load the last 14 days of rollups.
  let rows: Array<{ day: string; payload: string }> = []
  try {
    const r = await master.execute({
      sql: `SELECT day, payload FROM site_metrics WHERE customer_site_id = ? AND source = 'analytics' ORDER BY day DESC LIMIT 14`,
      args: [siteId],
    })
    rows = r.rows as unknown as Array<{ day: string; payload: string }>
  } catch { /* table not migrated → treated as no data */ }

  const days = rows.map((r) => ({ day: String(r.day), data: safeDay(String(r.payload)) }))
  const series = [...days].reverse().map((d) => ({ day: d.day, views: d.data.views }))
  const agg = mergeDays(days.map((d) => d.data))
  const avgEngage = agg.engagedSamples > 0 ? Math.round(agg.engagedSecondsTotal / agg.engagedSamples) : 0

  if (!days.length) {
    const collecting = `<div class="card">
      ${backLink}
      <h2 style="margin:0 0 4px;font-size:16px">Insights</h2>
      <p style="color:#86efac;font-size:13px;margin:0 0 8px">● Analytics is on.</p>
      <p class="muted" style="font-size:13px">Collecting data now. Your first daily report appears after the next nightly rollup (within 24 hours of your first visitors). The beacon is live on your published site.</p>
      <div style="margin-top:12px">${toggle}</div>
    </div>`
    return c.html(renderSaasLayout({ title: "Insights", active: "sites", customer, bodyHtml: collecting }), 200, NO_STORE)
  }

  const stat = (label: string, value: string) =>
    `<div class="card" style="flex:1;min-width:120px"><div style="font-size:22px;font-weight:700">${escapeHtml(value)}</div><p class="muted" style="font-size:12px;margin:2px 0 0">${escapeHtml(label)}</p></div>`

  const body = `
    <div class="card">
      ${backLink}
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin:0 0 2px;font-size:16px">Insights</h2>
          <p class="muted" style="font-size:12px;margin:0">Cookie-free · last ${days.length} day${days.length === 1 ? "" : "s"} · times in UTC</p></div>
        ${toggle}
      </div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      ${stat("Page views", agg.views.toLocaleString("en-US"))}
      ${stat("Avg. time on page", avgEngage >= 60 ? `${Math.floor(avgEngage / 60)}m ${avgEngage % 60}s` : `${avgEngage}s`)}
      ${stat("Reached the end", `${agg.views > 0 ? Math.round((agg.scroll["100"] / agg.views) * 100) : 0}%`)}
    </div>
    <div class="card"><h3 style="margin:0 0 8px;font-size:15px">Page views per day</h3>${viewsChart(series)}</div>
    ${table("Top pages", agg.paths.map((p) => ({ label: p.path, value: p.views })), "No page views recorded yet.")}
    ${table("Where visitors came from", agg.referrers.map((r) => ({ label: r.origin, value: r.views })), "All visits were direct or from links that hide their source.")}
    ${scrollFunnel(agg.scroll)}
    ${table("Most-clicked buttons & links", agg.clicks.map((cl) => ({ label: cl.label, value: cl.count })), "No tracked clicks yet — CTAs, nav, and form buttons report automatically.")}
    ${table("Top outbound links", agg.outbound.map((o) => ({ label: o.host, value: o.count })), "No clicks to other sites yet.")}
    <p class="muted" style="font-size:12px">Powered by your own first-party beacon — the data never leaves your platform, and there's nothing to configure in Google Analytics.</p>`
  await audit(master, customer.id, "site.analytics_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Insights", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function analyticsToggleHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const site = await loadSite(c, siteId, customer.id)
  const dest = `/app/sites/${encodeURIComponent(siteId)}/analytics`
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  let enabled = false
  try {
    const form = await c.req.formData()
    enabled = String(form.get("enabled") ?? "") === "1"
  } catch { /* default off */ }

  const master = getMasterDb(c.env)
  const res = await saveAnalytics(c.env, customer.id, site.cms_site_id, site.repo_full_name, enabled, master)
  if (res.ok) {
    await audit(master, customer.id, enabled ? "site.analytics_enabled" : "site.analytics_disabled", site.domain).catch(() => {})
  }
  return new Response(null, { status: 302, headers: { Location: dest, ...NO_STORE } })
}
