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
import { SITE_EVENTS, EVENT_LABELS, listSubscriptions, createSubscription, deleteSubscription, testFireSubscription, subscriptionLog, type Subscription } from "./subscriptions"
import { recipes, n8nSiteTriggerWorkflow } from "./recipes"

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
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <a class="btn ghost" style="font-size:12px" href="/app/sites/${escapeAttr(site.id)}/integrations/webhooks">Event webhooks →</a>
        <a class="btn ghost" style="font-size:12px" href="/app/sites/${escapeAttr(site.id)}/integrations/recipes">Recipes →</a>
        <a class="btn ghost" style="font-size:12px" href="/api/public/v1/openapi.json" target="_blank">OpenAPI spec ↗</a>
      </div>
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

// ─────────────────────── event webhooks (subscriptions) ───────────────────────

function renderWebhooks(site: IntSite, subs: Subscription[], logs: Record<string, Array<{ at: string; event: string; status: string; httpStatus: number | null }>>, customer: Customer, flagOn: boolean, opts: { newSecret?: string; done?: string; error?: string } = {}): string {
  const eventChecks = SITE_EVENTS.map((e) => `<label style="display:inline-flex;gap:6px;align-items:center;font-size:12px;margin:2px 8px 2px 0"><input type="checkbox" name="event" value="${e}"> ${escapeHtml(EVENT_LABELS[e] || e)}</label>`).join("")
  const rows = subs.length
    ? subs.map((s) => {
        const log = logs[s.id] || []
        return `<div style="border-top:1px solid #1f2937;padding:10px 6px">
          <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
            <div style="font-size:13px;word-break:break-all"><strong style="font-family:ui-monospace,monospace">${escapeHtml(s.url)}</strong><div class="muted" style="font-size:11px">${s.events.map((e) => escapeHtml(EVENT_LABELS[e] || e)).join(", ")} · secret …${escapeHtml(s.secretPreview)}</div></div>
            <div style="display:flex;gap:6px">
              <form method="post" action="/app/sites/${escapeAttr(site.id)}/integrations/webhooks/test" style="margin:0"><input type="hidden" name="id" value="${escapeAttr(s.id)}"><button class="btn ghost" style="font-size:11px" type="submit">Test-fire</button></form>
              <form method="post" action="/app/sites/${escapeAttr(site.id)}/integrations/webhooks/delete" style="margin:0"><input type="hidden" name="id" value="${escapeAttr(s.id)}"><button class="btn ghost" style="font-size:11px" type="submit" onclick="return confirm('Delete this subscription?')">Delete</button></form>
            </div>
          </div>
          ${log.length ? `<div class="muted" style="font-size:11px;margin-top:6px">${log.slice(0, 5).map((d) => `${escapeHtml(d.at.slice(0, 16))} ${escapeHtml(d.event)} · ${d.status}${d.httpStatus != null ? " " + d.httpStatus : ""}`).join(" · ")}</div>` : ""}
        </div>`
      }).join("")
    : `<p class="muted" style="padding:8px 6px;font-size:13px">No subscriptions yet.</p>`
  return `
    ${opts.newSecret ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0 0 6px;color:#86efac;font-size:13px"><strong>Signing secret (shown once)</strong> — verify the X-Webhook-Signature header with it.</p><code style="display:block;word-break:break-all;background:#0b0f17;border:1px solid #14532d;border-radius:6px;padding:10px;color:#d1fae5;font-size:12px">${escapeHtml(opts.newSecret)}</code></div>` : ""}
    ${opts.done ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(opts.done)}</p></div>` : ""}
    ${opts.error ? `<div class="card" style="border-color:#7f1d1d;background:#1c1212"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(opts.error)}</p></div>` : ""}
    <div class="card"><p><a href="/app/sites/${escapeAttr(site.id)}/integrations" style="color:#93c5fd">← Integrations</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Event webhooks</h2>
      <p class="muted" style="font-size:13px">Fire a signed HTTPS request to any URL when things happen on your site — this is the n8n / GoHighLevel trigger. Point it at an n8n Webhook node or a GHL inbound webhook.</p>
      ${flagOn ? "" : `<p style="font-size:12px;color:#fcd34d;margin:6px 0 0">Note: retries need the platform's <code>FEATURE_WEBHOOKS</code> flag on. First-attempt delivery always fires.</p>`}
    </div>
    <div class="card">${rows}</div>
    <form method="post" action="/app/sites/${escapeAttr(site.id)}/integrations/webhooks/create">
      <div class="card"><h3 style="margin:0 0 6px;font-size:14px">New subscription</h3>
        <input name="url" type="url" placeholder="https://your-n8n.example/webhook/…" style="${IN}" required>
        <div style="margin:10px 0">${eventChecks}</div>
        <button class="btn" type="submit">Subscribe</button>
      </div>
    </form>`
}

export async function integrationsWebhooksHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const siteDb = await siteDbFor(master, site.cms_site_id)
  const subs = siteDb ? await listSubscriptions(siteDb).catch(() => []) : []
  const logs: Record<string, Array<{ at: string; event: string; status: string; httpStatus: number | null }>> = {}
  if (siteDb) for (const s of subs) logs[s.id] = await subscriptionLog(siteDb, s.id).catch(() => [])
  const flagOn = c.env.FEATURE_WEBHOOKS === "1"
  return c.html(renderSaasLayout({ title: "Event webhooks", active: "sites", customer, bodyHtml: renderWebhooks(site, subs, logs, customer, flagOn, { done: c.req.query("done"), error: c.req.query("error") }) }), 200, NO_STORE)
}

export async function integrationsCreateSubHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const siteDb = await siteDbFor(master, site.cms_site_id)
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/integrations/webhooks?${q}` } })
  if (!siteDb) return back("error=" + encodeURIComponent("Workspace unavailable."))
  if (planGate(customer, nowSqlite()) === "read_only") return back("error=" + encodeURIComponent("Your trial has ended — subscribe to add webhooks."))
  const form = await c.req.parseBody({ all: true })
  const url = String(form.url || "").trim()
  const rawEv = form.event
  const events = (Array.isArray(rawEv) ? rawEv.map(String) : rawEv ? [String(rawEv)] : [])
  const created = await createSubscription(siteDb, url, events)
  await audit(master, customer.id, "site.webhook_subscribed", site.domain, { events }).catch(() => {})
  if (!created) return back("error=" + encodeURIComponent("Enter an https:// URL and pick at least one event."))
  const subs = await listSubscriptions(siteDb).catch(() => [])
  const logs: Record<string, Array<{ at: string; event: string; status: string; httpStatus: number | null }>> = {}
  return c.html(renderSaasLayout({ title: "Event webhooks", active: "sites", customer, bodyHtml: renderWebhooks(site, subs, logs, customer, c.env.FEATURE_WEBHOOKS === "1", { newSecret: created.secret }) }), 200, NO_STORE)
}

export async function integrationsDeleteSubHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (site?.cms_site_id) {
    const siteDb = await siteDbFor(master, site.cms_site_id)
    if (siteDb) { const form = await c.req.parseBody(); await deleteSubscription(siteDb, String(form.id)) }
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/integrations/webhooks?done=${encodeURIComponent("Subscription deleted.")}` } })
}

// ─────────────────────── recipes + importable workflow ───────────────────────

export async function integrationsRecipesHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const host = c.env.SAAS_APP_HOSTNAME || "arsal.app"
  const cards = recipes(site.domain || host, site.id).map((r) => `<div class="card">
      <h3 style="margin:0 0 6px;font-size:14px">${escapeHtml(r.title)}</h3>
      <div style="font-size:13px;color:#cbd5e1;white-space:pre-line;line-height:1.6">${r.body}</div>
    </div>`).join("")
  const body = `
    <div class="card"><p><a href="/app/sites/${escapeAttr(site.id)}/integrations" style="color:#93c5fd">← Integrations</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Recipes</h2>
      <p class="muted" style="font-size:13px">Copy-paste guides to wire this site to n8n, GoHighLevel, or anything that speaks HTTP.</p>
      <p style="margin-top:8px"><a class="btn ghost" style="font-size:12px" href="/app/assets/n8n-site-trigger.json" download>Download the n8n starter workflow (.json)</a></p>
    </div>
    ${cards}`
  return c.html(renderSaasLayout({ title: "Recipes", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

/** Importable n8n workflow JSON (generic — no per-site data). */
export async function n8nWorkflowHandler(_c: Context<AppEnv>): Promise<Response> {
  return new Response(JSON.stringify(n8nSiteTriggerWorkflow(), null, 2), {
    headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="n8n-site-trigger.json"', "Cache-Control": "public, max-age=3600" },
  })
}

export async function integrationsTestSubHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadSite(c, master, customer.id)
  let msg = "Test sent."
  if (site?.cms_site_id) {
    const siteDb = await siteDbFor(master, site.cms_site_id)
    if (siteDb) {
      const form = await c.req.parseBody()
      const res = await testFireSubscription(siteDb, String(form.id), site.domain)
      msg = res.ok ? `Test delivered (HTTP ${res.status}).` : `Test failed${res.status ? ` (HTTP ${res.status})` : ""} — check the URL.`
    }
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/integrations/webhooks?done=${encodeURIComponent(msg)}` } })
}
