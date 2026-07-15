// src/modules/analytics/routes.ts
// Performance dashboard (Phase 6): real-user Core Web Vitals per site with
// degradation alerts. Reads cached rollups from site_metrics, refreshing from
// Cloudflare Web Analytics best-effort. Server-rendered.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { renderSaasLayout } from "../../shared"
import { getConnectionSecret } from "../connections"
import { audit, type Customer } from "../customers"
import { fetchCwv, cwvAlerts, rateLcp, rateCls, rateInp, type Cwv, type Rating } from "./cwv"

const NO_STORE = { "Cache-Control": "no-store, private" }

function badge(r: Rating): string {
  const color = r === "good" ? "#86efac" : r === "needs-improvement" ? "#fcd34d" : "#fca5a5"
  return `<span style="color:${color};font-weight:600">${r}</span>`
}

export async function performancePageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = getMasterDb(c.env)
  await ensureMasterSchema(master)
  const siteRow = await master.execute({
    sql: "SELECT id, domain, zone_id FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customer.id],
  })
  if (!siteRow.rows.length) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const site = siteRow.rows[0] as unknown as { id: string; domain: string; zone_id: string | null }

  const today = new Date().toISOString().slice(0, 10)

  // Load cached CWV, else try to refresh from Cloudflare Web Analytics.
  let current: Cwv | null = null
  let previous: Cwv | null = null
  const cached = await master.execute({
    sql: "SELECT day, payload FROM site_metrics WHERE customer_site_id = ? AND source = 'cwv' ORDER BY day DESC LIMIT 2",
    args: [siteId],
  })
  if (cached.rows.length) {
    current = safeParseCwv(String(cached.rows[0].payload))
    if (cached.rows[1]) previous = safeParseCwv(String(cached.rows[1].payload))
  }
  if (!current) {
    try {
      const cf = await getConnectionSecret(master, c.env, customer.id, "cloudflare", "cwv")
      const cfMeta = await master.execute({ sql: "SELECT meta FROM connections WHERE customer_id = ? AND provider = 'cloudflare' LIMIT 1", args: [customer.id] })
      const accountId = String((JSON.parse(String(cfMeta.rows[0]?.meta ?? "{}")) as { accountId?: string }).accountId ?? "")
      if (cf && accountId && site.zone_id) {
        const until = new Date().toISOString()
        const since = new Date(Date.now() - 7 * 864e5).toISOString()
        current = await fetchCwv(cf, accountId, site.zone_id, since, until)
        if (current) {
          await master.execute({
            sql: `INSERT INTO site_metrics (customer_site_id, day, source, payload) VALUES (?, ?, 'cwv', ?)
                  ON CONFLICT(customer_site_id, day, source) DO UPDATE SET payload = excluded.payload, updated_at = datetime('now')`,
            args: [siteId, today, JSON.stringify(current)],
          })
        }
      }
    } catch (err) {
      console.error("cwv refresh failed:", err instanceof Error ? err.message : err)
    }
  }

  const alerts = current ? cwvAlerts(current, previous) : []
  const alertsHtml = alerts.length
    ? `<div class="card" style="border-color:#7f1d1d">${alerts.map((a) => `<p style="margin:4px 0;color:#fca5a5">⚠ ${escapeHtml(a.message)} <a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">ask Claude to fix it</a></p>`).join("")}</div>`
    : ""

  const metricsHtml = current
    ? `<table style="width:100%;font-size:14px"><tbody>
        <tr><td>Largest Contentful Paint (LCP)</td><td>${(current.lcpMs / 1000).toFixed(2)}s</td><td>${badge(rateLcp(current.lcpMs))}</td></tr>
        <tr><td>Cumulative Layout Shift (CLS)</td><td>${current.cls.toFixed(3)}</td><td>${badge(rateCls(current.cls))}</td></tr>
        <tr><td>Interaction to Next Paint (INP)</td><td>${current.inpMs}ms</td><td>${badge(rateInp(current.inpMs))}</td></tr>
      </tbody></table>`
    : `<p class="muted">No real-user data yet. Cloudflare Web Analytics collects Core Web Vitals from real visitors — check back once your site has had some traffic.</p>`

  const body = `
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Performance (real visitors)</h2>
      <p class="muted" style="font-size:13px">Core Web Vitals measured from actual visits via Cloudflare Web Analytics (cookie-free, zero performance cost).</p>
    </div>
    ${alertsHtml}
    <div class="card">${metricsHtml}</div>`
  await audit(master, customer.id, "site.performance_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Performance", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

function safeParseCwv(s: string): Cwv | null {
  try {
    const o = JSON.parse(s) as Partial<Cwv>
    if (typeof o.lcpMs === "number") return { lcpMs: o.lcpMs, cls: o.cls ?? 0, inpMs: o.inpMs ?? 0 }
  } catch { /* ignore */ }
  return null
}
