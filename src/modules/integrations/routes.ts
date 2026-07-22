// src/modules/integrations/routes.ts
// Integrations dashboard (V1.5 M2) — scoped API keys for n8n / GoHighLevel /
// any HTTP automation. Create keys with least-privilege scopes, see last-used,
// revoke. The raw key is shown exactly once at creation (hashed at rest).

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { siteDbFor } from "../seo"
import { SCOPES, listScopedKeys, createScopedKey, revokeScopedKey, isScope, type ScopedKeyRow } from "./keys"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
interface IntSite { id: string; cms_site_id: string | null; domain: string }
async function loadSite(c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<IntSite | null> {
  const r = await master.execute({ sql: "SELECT id, cms_site_id, domain FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1", args: [c.req.param("id") ?? "", customerId] })
  return r.rows.length ? (r.rows[0] as unknown as IntSite) : null
}
function nowSqlite(): string { return new Date().toISOString().replace("T", " ").slice(0, 19) }
const IN = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:13px"

function render(site: IntSite, keys: ScopedKeyRow[], customer: Customer, opts: { newKey?: string; done?: string; error?: string } = {}): string {
  const scopeChecks = SCOPES.map((s) => `<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:4px 0"><input type="checkbox" name="scope" value="${s.id}" style="margin-top:3px"><span><strong>${escapeHtml(s.label)}</strong><br><span class="muted" style="font-size:11px">${escapeHtml(s.hint)}</span></span></label>`).join("")
  const rows = keys.length
    ? keys.map((k) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:8px 6px;font-size:13px">${escapeHtml(k.name)}<div class="muted" style="font-size:11px;font-family:ui-monospace,monospace">sk_site_…${escapeHtml(k.keyPreview)} · ${k.scopes.map(escapeHtml).join(", ") || "no scopes"}</div></td>
        <td style="padding:8px 6px;text-align:right;white-space:nowrap"><span class="muted" style="font-size:11px">${k.lastUsedAt ? "used " + escapeHtml(k.lastUsedAt.slice(0, 10)) : "never used"}</span>
          <form method="post" action="/app/sites/${escapeAttr(site.id)}/integrations/keys/revoke" style="display:inline;margin:0 0 0 8px"><input type="hidden" name="id" value="${escapeAttr(k.id)}"><button class="btn ghost" style="font-size:11px" type="submit" onclick="return confirm('Revoke this key? Anything using it stops working.')">Revoke</button></form></td>
      </tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No integration keys yet.</td></tr>`
  return `
    ${opts.newKey ? `<div class="card" style="border-color:#166534;background:#052e16">
      <p style="margin:0 0 6px;color:#86efac;font-size:13px"><strong>Copy this key now — it won't be shown again.</strong></p>
      <code style="display:block;word-break:break-all;background:#0b0f17;border:1px solid #14532d;border-radius:6px;padding:10px;color:#d1fae5;font-size:12px">${escapeHtml(opts.newKey)}</code></div>` : ""}
    ${opts.done ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(opts.done)}</p></div>` : ""}
    ${opts.error ? `<div class="card" style="border-color:#7f1d1d;background:#1c1212"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(opts.error)}</p></div>` : ""}
    <div class="card"><p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Integrations</h2>
      <p class="muted" style="font-size:13px">Scoped API keys let n8n, GoHighLevel, or any tool read and write this site over HTTPS. Give each integration its own key with only the scopes it needs.</p>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>
    <form method="post" action="/app/sites/${escapeAttr(site.id)}/integrations/keys/create">
      <div class="card"><h3 style="margin:0 0 6px;font-size:14px">New key</h3>
        <input name="name" placeholder="What's this for? (e.g. n8n lead sync)" style="${IN}" required>
        <div style="margin:10px 0">${scopeChecks}</div>
        <button class="btn" type="submit">Create key</button>
      </div>
    </form>`
}

export async function integrationsHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const siteDb = await siteDbFor(master, site.cms_site_id)
  const keys = siteDb ? await listScopedKeys(siteDb).catch(() => []) : []
  await audit(master, customer.id, "site.integrations_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Integrations", active: "sites", customer, bodyHtml: render(site, keys, customer, { done: c.req.query("done"), error: c.req.query("error") }) }), 200, NO_STORE)
}

export async function integrationsCreateKeyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const siteDb = await siteDbFor(master, site.cms_site_id)
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/integrations?${q}` } })
  if (!siteDb) return back("error=" + encodeURIComponent("Site workspace unavailable."))
  if (planGate(customer, nowSqlite()) === "read_only") return back("error=" + encodeURIComponent("Your trial has ended — subscribe to create keys."))

  const form = await c.req.parseBody({ all: true })
  const name = String(form.name || "").trim()
  const raw = form.scope
  const scopes = (Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : []).filter(isScope)
  if (!scopes.length) return back("error=" + encodeURIComponent("Pick at least one scope."))
  const created = await createScopedKey(siteDb, name, scopes)
  await audit(master, customer.id, "site.integration_key_created", site.domain, { scopes }).catch(() => {})
  if (!created) return back("error=" + encodeURIComponent("Couldn't create the key — try again."))
  // Render the reveal page directly (secret never goes in a URL).
  const keys = await listScopedKeys(siteDb).catch(() => [])
  return c.html(renderSaasLayout({ title: "Integrations", active: "sites", customer, bodyHtml: render(site, keys, customer, { newKey: created.key }) }), 200, NO_STORE)
}

export async function integrationsRevokeKeyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (site?.cms_site_id) {
    const siteDb = await siteDbFor(master, site.cms_site_id)
    if (siteDb) {
      const form = await c.req.parseBody()
      await revokeScopedKey(siteDb, String(form.id))
      await audit(master, customer.id, "site.integration_key_revoked", site.domain).catch(() => {})
    }
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/integrations?done=${encodeURIComponent("Key revoked.")}` } })
}
