// src/modules/agency/routes.ts
// Agency UI (K11): the white-label panel (brand + monthly-reports toggle),
// client-seat management, and the public, token-gated, white-labelled client
// portal where seats view their sites' reports.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, type Customer } from "../customers"
import { hasAgencyFeatures } from "../billing"
import { validateBrand, DEFAULT_BRAND } from "./branding"
import { renderReportHtml, buildSiteReport } from "./reports"
import {
  loadAgencySettings, saveAgencySettings, listSeats, createSeat, deleteSeat,
  signSeatToken, verifySeatToken, seatPortalUrl, loadSeat, gatherSiteMetrics, loadBrand,
} from "./service"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

async function customerSites(master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<Array<{ id: string; name: string; domain: string }>> {
  const r = await master.execute({ sql: "SELECT id, name, domain FROM customer_sites WHERE customer_id = ? ORDER BY created_at DESC", args: [customerId] })
  return r.rows as unknown as Array<{ id: string; name: string; domain: string }>
}

// ─────────────────────── white-label panel + seats ───────────────────────

export async function agencyPanelHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer

  // Agency features are the Agency-tier upsell (decision #3). Existing seats
  // and portal links keep working if a plan lapses — only MANAGEMENT is gated,
  // so an agency's clients never lose report access mid-cycle.
  if (!hasAgencyFeatures(customer.plan)) {
    const body = `
      <div class="card">
        <h2 style="margin:0 0 4px;font-size:16px">Agency &amp; white-label</h2>
        <p class="muted" style="font-size:13px">Brand client reports as your own, give each client a scoped report portal, and email them a monthly summary automatically.</p>
        <ul style="padding-left:18px;margin:12px 0 16px">
          <li style="font-size:13px;color:#d4d4d4;margin:3px 0">White-label branding (your name, color, logo)</li>
          <li style="font-size:13px;color:#d4d4d4;margin:3px 0">Client seats with read-only report portals</li>
          <li style="font-size:13px;color:#d4d4d4;margin:3px 0">Monthly auto-reports emailed to each client</li>
        </ul>
        <a class="btn" href="/app/billing">Upgrade to Agency</a>
      </div>`
    return c.html(renderSaasLayout({ title: "Agency", active: "agency", customer, bodyHtml: body }), 200, NO_STORE)
  }

  const master = await masterDb(c)
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const settings = await loadAgencySettings(master, customer.id)
  const seats = await listSeats(master, customer.id)
  const sites = await customerSites(master, customer.id)
  const saasHost = c.env.SAAS_APP_HOSTNAME || "arsal.app"

  const siteCheckboxes = (selected: string[]) =>
    sites.length
      ? sites
          .map(
            (s) => `<label style="display:block;font-size:13px;margin:2px 0"><input type="checkbox" name="site" value="${escapeAttr(s.id)}" ${selected.includes(s.id) ? "checked" : ""}> ${escapeHtml(s.name)} <span class="muted">${escapeHtml(s.domain)}</span></label>`
          )
          .join("")
      : `<p class="muted" style="font-size:13px">Add sites first to assign them to clients.</p>`

  const seatRows = seats.length
    ? await Promise.all(
        seats.map(async (seat) => {
          const token = await signSeatToken(c.env, seat.id)
          const link = token ? seatPortalUrl(saasHost, token) : "(portal link unavailable — SAAS_JWT_SECRET not set)"
          return `<div class="card" style="padding:14px">
            <div style="display:flex;justify-content:space-between;gap:12px;align-items:start">
              <div>
                <strong style="font-size:14px">${escapeHtml(seat.label)}</strong>
                <div class="muted" style="font-size:12px">${escapeHtml(seat.email)} · ${seat.siteIds.length} site${seat.siteIds.length === 1 ? "" : "s"}${seat.lastReportAt ? ` · last report ${escapeHtml(seat.lastReportAt.slice(0, 10))}` : ""}</div>
                <div style="font-size:12px;margin-top:6px"><a href="${escapeAttr(link)}" style="color:#93c5fd;word-break:break-all">${escapeHtml(link)}</a></div>
              </div>
              <form method="POST" action="/app/agency/seats/${escapeAttr(seat.id)}/delete" onsubmit="return confirm('Remove this client seat?')" style="margin:0">
                <button class="btn ghost" type="submit">Remove</button>
              </form>
            </div>
          </div>`
        })
      ).then((x) => x.join(""))
    : `<p class="muted" style="font-size:13px">No client seats yet.</p>`

  const body = `
    ${done ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">${escapeHtml(done)}</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card">
      <h2 style="margin:0 0 4px;font-size:16px">Agency &amp; white-label</h2>
      <p class="muted" style="font-size:13px">Brand the client-facing report portal and monthly emails as your own, and give each client a read-only view of their sites.</p>
    </div>
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">White-label branding</h3>
      <form method="POST" action="/app/agency">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px"><input type="checkbox" name="enabled" value="1" ${settings?.enabled ? "checked" : ""}> Enable white-label branding</label>
        <label style="display:block;font-size:13px;margin-bottom:6px">Brand name</label>
        <input name="brand_name" maxlength="40" value="${escapeAttr(settings?.brand_name ?? "")}" placeholder="${escapeAttr(DEFAULT_BRAND.name)}" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">
        <label style="display:block;font-size:13px;margin-bottom:6px">Brand color (hex)</label>
        <input name="brand_color" maxlength="7" value="${escapeAttr(settings?.brand_color ?? "")}" placeholder="#2563eb" style="width:160px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">
        <label style="display:block;font-size:13px;margin-bottom:6px">Logo URL (https)</label>
        <input name="logo_url" value="${escapeAttr(settings?.logo_url ?? "")}" placeholder="https://…/logo.png" style="width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa;margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px"><input type="checkbox" name="reports_enabled" value="1" ${settings?.reports_enabled ? "checked" : ""}> Email clients a monthly report</label>
        <button class="btn" type="submit">Save branding</button>
      </form>
    </div>
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Client seats</h3>
      <form method="POST" action="/app/agency/seats">
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <input name="label" required maxlength="80" placeholder="Client name" style="flex:1;min-width:160px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa">
          <input name="email" required type="email" maxlength="200" placeholder="client@email.com" style="flex:1;min-width:200px;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px;color:#fafafa">
        </div>
        <div style="margin-bottom:10px">${siteCheckboxes([])}</div>
        <button class="btn" type="submit">Add client seat</button>
      </form>
    </div>
    <div class="card">
      <h3 style="margin:0 0 10px;font-size:15px">Existing seats</h3>
      ${seatRows}
    </div>`
  return c.html(renderSaasLayout({ title: "Agency", active: "agency", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function agencySaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  if (!hasAgencyFeatures(customer.plan)) {
    return new Response(null, { status: 302, headers: { Location: "/app/billing" } })
  }
  const master = await masterDb(c)
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/agency?${new URLSearchParams(params)}` } })
  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That form didn't come through — try again." }) }

  const brand_name = String(form.get("brand_name") || "").trim()
  const brand_color = String(form.get("brand_color") || "").trim()
  const logo_url = String(form.get("logo_url") || "").trim()
  const v = validateBrand(brand_name || DEFAULT_BRAND.name, brand_color, logo_url)
  if (!v.ok) return back({ error: v.problem })

  await saveAgencySettings(master, customer.id, {
    enabled: form.get("enabled") === "1",
    brand_name: brand_name || null,
    brand_color: brand_color || null,
    logo_url: logo_url || null,
    reports_enabled: form.get("reports_enabled") === "1",
  })
  await audit(master, customer.id, "agency.branding_saved").catch(() => {})
  return back({ done: "Branding saved." })
}

export async function seatCreateHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  if (!hasAgencyFeatures(customer.plan)) {
    return new Response(null, { status: 302, headers: { Location: "/app/billing" } })
  }
  const master = await masterDb(c)
  const back = (params: Record<string, string>) =>
    new Response(null, { status: 302, headers: { Location: `/app/agency?${new URLSearchParams(params)}` } })
  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That form didn't come through — try again." }) }

  const label = String(form.get("label") || "").trim()
  const email = String(form.get("email") || "").trim()
  const siteIds = form.getAll("site").map(String)
  if (!label || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back({ error: "Enter a client name and a valid email." })
  if (!siteIds.length) return back({ error: "Assign at least one site to this client." })

  // Only assign sites the customer actually owns.
  const owned = new Set((await customerSites(master, customer.id)).map((s) => s.id))
  const assigned = siteIds.filter((id) => owned.has(id))
  if (!assigned.length) return back({ error: "Those sites aren't yours to assign." })

  await createSeat(master, customer.id, label, email, assigned)
  await audit(master, customer.id, "agency.seat_created", email).catch(() => {})
  return back({ done: "Client seat added — share their portal link below." })
}

export async function seatDeleteHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  await deleteSeat(master, customer.id, c.req.param("seatId") ?? "")
  await audit(master, customer.id, "agency.seat_deleted").catch(() => {})
  return new Response(null, { status: 302, headers: { Location: "/app/agency?done=" + encodeURIComponent("Client seat removed.") } })
}

// ─────────────────────── public client portal ───────────────────────

/** Public, token-gated, white-labelled report portal for a client seat. */
export async function clientPortalHandler(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const token = url.searchParams.get("token") ?? ""
  const seatId = await verifySeatToken(c.env, token)
  const master = await masterDb(c)
  const seat = seatId ? await loadSeat(master, seatId) : null
  if (!seat) {
    return c.html(portalShell(DEFAULT_BRAND, `<p style="color:#6b7280">This report link is invalid or has expired. Ask your agency for a fresh link.</p>`), 401, NO_STORE)
  }

  const brand = await loadBrand(master, seat.customerId)
  const sitesRes = await master.execute({
    sql: `SELECT id, name, domain FROM customer_sites WHERE customer_id = ? AND id IN (${seat.siteIds.map(() => "?").join(",") || "''"})`,
    args: [seat.customerId, ...seat.siteIds],
  })
  const sites = sitesRes.rows as unknown as Array<{ id: string; name: string; domain: string }>
  const period = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })

  const cards: string[] = []
  for (const s of sites) {
    const metrics = await gatherSiteMetrics(master, c.env, seat.customerId, s, Date.now()).catch(() => null)
    if (metrics) cards.push(renderReportHtml(buildSiteReport(metrics), brand, period))
  }
  const body = cards.length
    ? cards.join('<div style="height:16px"></div>')
    : `<p style="color:#6b7280">No report data yet — check back after your sites have some traffic.</p>`
  return c.html(portalShell(brand, `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(seat.label)} — ${escapeHtml(period)}</h1>${body}`), 200, NO_STORE)
}

function portalShell(brand: { name: string; color: string }, inner: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(brand.name)} — Reports</title>
<style>body{margin:0;background:#f3f4f6;font-family:ui-sans-serif,system-ui,sans-serif;color:#111827;padding:24px}main{max-width:640px;margin:0 auto}</style>
</head><body><main>${inner}</main></body></html>`
}
