// src/modules/forms/domainRoutes.ts
// Custom sending domain (V1.4 F1, optional per site): verify the customer's
// own domain with Resend so acknowledgments send from THEIR domain instead of
// the platform default. Same UX pattern as the main wizard: records shown,
// live verification polling via a Check button. Absent = platform default.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { loadFormsSite } from "./formsRoutes"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

interface ResendRecord {
  record: string
  name: string
  type: string
  value: string
  status?: string
}

async function resendApi<T>(env: { RESEND_API_KEY?: string }, path: string, init: RequestInit = {}): Promise<T | null> {
  if (!env.RESEND_API_KEY) return null
  try {
    const resp = await fetch(`https://api.resend.com${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    })
    if (!resp.ok) return null
    return (await resp.json()) as T
  } catch {
    return null
  }
}

export async function sendingDomainHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const row = await master.execute({
    sql: "SELECT forms_domain, forms_domain_id, forms_domain_status FROM customer_sites WHERE id = ? LIMIT 1",
    args: [siteId],
  })
  const d = row.rows[0] as unknown as { forms_domain: string | null; forms_domain_id: string | null; forms_domain_status: string | null }

  let recordsHtml = ""
  if (d?.forms_domain_id) {
    const info = await resendApi<{ status?: string; records?: ResendRecord[] }>(c.env, `/domains/${d.forms_domain_id}`)
    const records = info?.records ?? []
    recordsHtml = records.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:520px"><thead><tr class="muted" style="font-size:10px;text-transform:uppercase">
          <th style="text-align:left;padding:4px 6px">Type</th><th style="text-align:left;padding:4px 6px">Name</th><th style="text-align:left;padding:4px 6px">Value</th><th style="text-align:left;padding:4px 6px">Status</th></tr></thead><tbody>
          ${records.map((r) => `<tr style="border-top:1px solid #1f2937"><td style="padding:5px 6px">${escapeHtml(r.type)}</td><td style="padding:5px 6px"><code>${escapeHtml(r.name)}</code></td><td style="padding:5px 6px;word-break:break-all"><code>${escapeHtml(r.value)}</code></td><td style="padding:5px 6px">${r.status === "verified" ? `<span style="color:#86efac">verified</span>` : `<span class="muted">${escapeHtml(r.status ?? "pending")}</span>`}</td></tr>`).join("")}
        </tbody></table>`
      : `<p class="muted" style="font-size:12px">Couldn't load the DNS records right now — try Check status again.</p>`
  }

  const saved = c.req.query("saved")
  const error = c.req.query("error")
  const notice = saved
    ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)}</p></div>`
    : error
      ? `<div class="card" style="border-color:#7f1d1d;background:#2a0d0d"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(error)}</p></div>`
      : ""
  const verified = d?.forms_domain_status === "verified"

  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/forms" style="color:#93c5fd">← Forms</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Sending domain</h2>
      <p class="muted" style="font-size:13px">By default, form auto-replies send from the platform (forms@arsal.app) with replies going to you. Verify your own domain here and they'll send from <strong>forms@${escapeHtml(site.domain)}</strong> instead — better deliverability and branding. Optional.</p>
    </div>
    ${d?.forms_domain
      ? `<div class="card">
          <h3 style="margin:0 0 4px;font-size:14px">${escapeHtml(d.forms_domain)} ${verified ? `<span style="color:#86efac;font-size:12px">● verified</span>` : `<span class="muted" style="font-size:12px">pending DNS</span>`}</h3>
          ${verified ? `<p class="muted" style="font-size:12px">Auto-replies now send from your domain.</p>` : `<p class="muted" style="font-size:12px;margin:0 0 8px">Add these records at your DNS provider, then hit Check status (DNS can take up to an hour).</p>`}
          <div style="overflow-x:auto">${recordsHtml}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <form method="post" action="/app/sites/${escapeAttr(siteId)}/sending-domain/check" style="margin:0"><button type="submit" class="btn ghost" style="font-size:12px">Check status</button></form>
            <form method="post" action="/app/sites/${escapeAttr(siteId)}/sending-domain/remove" style="margin:0" onsubmit="return confirm('Remove the custom domain? Auto-replies go back to the platform default.')"><button type="submit" style="background:none;border:1px solid #7f1d1d;border-radius:6px;color:#fca5a5;font-size:12px;padding:5px 10px;cursor:pointer">Remove</button></form>
          </div>
        </div>`
      : `<form method="post" action="/app/sites/${escapeAttr(siteId)}/sending-domain">
          <div class="card">
            <label class="muted" style="font-size:12px">Domain to send from (usually your site's domain)</label>
            <input name="domain" value="${escapeAttr(site.domain)}" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:13px" />
            <div style="display:flex;justify-content:flex-end;margin-top:10px"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:14px;cursor:pointer">Start verification</button></div>
          </div>
        </form>`}`
  return c.html(renderSaasLayout({ title: "Sending domain", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function sendingDomainCreateHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/sending-domain${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to configure this."))

  const form = await c.req.parseBody()
  const domain = String(form.domain ?? "").trim().toLowerCase()
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return back("?error=" + encodeURIComponent("That doesn't look like a domain."))
  const created = await resendApi<{ id?: string }>(c.env, "/domains", { method: "POST", body: JSON.stringify({ name: domain }) })
  if (!created?.id) return back("?error=" + encodeURIComponent("Couldn't register the domain with the email service — try again shortly."))
  await master.execute({
    sql: "UPDATE customer_sites SET forms_domain = ?, forms_domain_id = ?, forms_domain_status = 'pending' WHERE id = ? AND customer_id = ?",
    args: [domain, created.id, siteId, customer.id],
  })
  await audit(master, customer.id, "site.sending_domain_added", site.domain, { domain }).catch(() => {})
  return back("?saved=" + encodeURIComponent("Domain registered — add the DNS records below."))
}

export async function sendingDomainCheckHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q = "") => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/sending-domain${q}` } })
  const row = await master.execute({ sql: "SELECT forms_domain_id FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1", args: [siteId, customer.id] })
  const domainId = row.rows.length ? String(row.rows[0].forms_domain_id ?? "") : ""
  if (!domainId) return back()
  await resendApi(c.env, `/domains/${domainId}/verify`, { method: "POST" })
  const info = await resendApi<{ status?: string }>(c.env, `/domains/${domainId}`)
  const status = info?.status === "verified" ? "verified" : "pending"
  await master.execute({ sql: "UPDATE customer_sites SET forms_domain_status = ? WHERE id = ? AND customer_id = ?", args: [status, siteId, customer.id] })
  return back(status === "verified" ? "?saved=" + encodeURIComponent("Verified! Auto-replies now send from your domain.") : "?saved=" + encodeURIComponent("Not verified yet — DNS can take up to an hour."))
}

export async function sendingDomainRemoveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  await master.execute({
    sql: "UPDATE customer_sites SET forms_domain = NULL, forms_domain_id = NULL, forms_domain_status = NULL WHERE id = ? AND customer_id = ?",
    args: [siteId, customer.id],
  })
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/sending-domain?saved=${encodeURIComponent("Removed — back to the platform default.")}` } })
}
