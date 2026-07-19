// src/modules/forms/formsRoutes.ts
// Forms builder dashboard (V1.4 F1): /app/sites/:id/forms — create from the 12
// templates, edit fields (add / remove / reorder via up-down buttons — server-
// rendered, keyboard-accessible, no client JS), acknowledgment settings.
// Field order note (surfaced): the spec's "drag order" ships as ↑/↓ buttons —
// same capability, zero client script, keyboard accessible.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { FORM_TEMPLATES, FIELD_TYPES, formTemplate, parseFields, type FieldDef, type FieldType } from "./model"
import { listForms, getForm, createForm, updateForm, deleteForm, setFormWebhook, type FormInput } from "./service"
import { formWebhookLog, fireFormWebhook, listSubscribers, subscribersToCsv } from "./hooks"
import { siteDbFor } from "../seo"

const NO_STORE = { "Cache-Control": "no-store, private" }
const IN = "width:100%;padding:7px 9px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:12px"

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}
export interface FormsSite { id: string; cms_site_id: string | null; domain: string; name: string; repo_full_name: string | null }
export async function loadFormsSite(master: Awaited<ReturnType<typeof masterDb>>, siteId: string, customerId: string): Promise<FormsSite | null> {
  const r = await master.execute({
    sql: "SELECT id, cms_site_id, domain, name, repo_full_name FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [siteId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as FormsSite) : null
}

function notice(c: Context<AppEnv>): string {
  const saved = c.req.query("saved")
  const error = c.req.query("error")
  if (saved) return `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)} Your site is rebuilding (usually ~2 minutes).</p></div>`
  if (error) return `<div class="card" style="border-color:#7f1d1d;background:#2a0d0d"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(error)}</p></div>`
  return ""
}

// ─────────────────────── list + create ───────────────────────

export async function formsListHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const forms = site.cms_site_id ? await listForms(master, site.cms_site_id).catch(() => []) : []

  const rows = forms.length
    ? forms.map((f) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:8px 6px;font-size:13px"><a href="/app/sites/${escapeAttr(siteId)}/forms/${escapeAttr(f.id)}" style="color:#fafafa">${escapeHtml(f.title)}</a>
          <div class="muted" style="font-size:11px">/forms/${escapeHtml(f.slug)}/ · ${f.fields.length} field${f.fields.length === 1 ? "" : "s"}${f.ackEnabled ? " · auto-reply on" : ""}</div></td>
        <td style="padding:8px 6px;text-align:right">${f.active ? `<span style="color:#86efac;font-size:12px">live</span>` : `<span class="muted" style="font-size:12px">off</span>`}</td>
      </tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No forms yet — pick a template below. Every form is spam-protected (Turnstile + honeypot) and rate-limited automatically.</td></tr>`

  const templates = FORM_TEMPLATES.map((t) => `
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/forms/create" style="margin:0;display:inline-block">
      <input type="hidden" name="template" value="${t.id}" />
      <button type="submit" class="btn ghost" style="font-size:12px;margin:3px">${escapeHtml(t.name)}</button>
    </form>`).join("")

  const body = `
    ${notice(c)}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Forms</h2>
      <p class="muted" style="font-size:13px">Contact, quotes, applications, feedback — one engine, many forms. Each form gets its own page (/forms/…) and can be embedded in any post with <code>&lt;div class="form-embed" data-form="slug"&gt;&lt;/div&gt;</code>. Submissions land in your <a href="/app/sites/${escapeAttr(siteId)}/inbox" style="color:#93c5fd">Inbox</a>.</p>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>
    <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Start from a template</h3>${templates}</div>`
  await audit(master, customer.id, "site.forms_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Forms", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function formsCreateHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/forms${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to add forms."))

  const form = await c.req.parseBody()
  const t = formTemplate(String(form.template ?? ""))
  if (!t) return back("?error=" + encodeURIComponent("Unknown template."))
  const input: FormInput = {
    title: t.name, fields: [...t.fields], ackEnabled: true,
    ackSubject: t.ackSubject, ackBody: t.ackBody, active: true,
  }
  const r = await createForm(c.env, customer.id, site.cms_site_id, site.repo_full_name, input, master)
  if (!r.ok) return back("?error=" + encodeURIComponent(r.error ?? "Couldn't create the form."))
  await audit(master, customer.id, "site.form_created", site.domain, { template: t.id }).catch(() => {})
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/forms/${r.id}?saved=${encodeURIComponent("Form created — customize it below.")}` } })
}

// ─────────────────────── edit ───────────────────────

export async function formEditHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const formId = c.req.param("formId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const f = await getForm(master, site.cms_site_id, formId)
  if (!f) return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/forms` } })

  const typeOpts = (cur: FieldType) => FIELD_TYPES.map((t) => `<option value="${t}" ${t === cur ? "selected" : ""}>${t}</option>`).join("")
  const fieldRows = f.fields.map((d, i) => `<tr style="border-top:1px solid #1f2937">
      <td style="padding:6px"><input name="fkey_${i}" value="${escapeAttr(d.key)}" style="${IN};width:110px" /></td>
      <td style="padding:6px"><input name="flabel_${i}" value="${escapeAttr(d.label)}" style="${IN}" /></td>
      <td style="padding:6px"><select name="ftype_${i}" style="${IN};width:100px">${typeOpts(d.type)}</select></td>
      <td style="padding:6px;text-align:center"><input type="checkbox" name="freq_${i}" ${d.required ? "checked" : ""} /></td>
      <td style="padding:6px"><input name="fopts_${i}" value="${escapeAttr((d.options ?? []).join(", "))}" placeholder="options, comma-sep" style="${IN};width:140px" /></td>
      <td style="padding:6px;white-space:nowrap;text-align:right">
        <button type="submit" name="move_up" value="${i}" title="Move up" style="background:none;border:1px solid #374151;border-radius:5px;color:#a3a3a3;cursor:pointer;padding:2px 7px">↑</button>
        <button type="submit" name="move_down" value="${i}" title="Move down" style="background:none;border:1px solid #374151;border-radius:5px;color:#a3a3a3;cursor:pointer;padding:2px 7px">↓</button>
        <button type="submit" name="remove" value="${i}" title="Remove" style="background:none;border:1px solid #7f1d1d;border-radius:5px;color:#fca5a5;cursor:pointer;padding:2px 7px">✕</button>
      </td></tr>`).join("")

  const siteDb = await siteDbFor(master, site.cms_site_id)
  const log = siteDb ? await formWebhookLog(siteDb, f.id).catch(() => []) : []
  const webhookLogHtml = log.length
    ? `<div style="margin-top:10px"><div class="muted" style="font-size:11px;text-transform:uppercase">Recent deliveries</div>${log.map((l) => `<div style="font-size:12px;padding:3px 0;border-top:1px solid #1f2937">${escapeHtml(l.at.slice(0, 16))} — <span style="color:${l.status === "delivered" ? "#86efac" : "#fca5a5"}">${escapeHtml(l.status)}</span>${l.httpStatus ? ` (HTTP ${l.httpStatus})` : ""}</div>`).join("")}</div>`
    : ""
  const subs = f.slug.startsWith("newsletter") && siteDb ? await listSubscribers(siteDb).catch(() => []) : []
  const subscriberStats = `${subs.filter((x) => x.confirmed && !x.unsubscribed).length} confirmed · ${subs.filter((x) => !x.confirmed && !x.unsubscribed).length} pending · ${subs.filter((x) => x.unsubscribed).length} unsubscribed`

  const body = `
    ${notice(c)}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/forms" style="color:#93c5fd">← Forms</a></p>
      <h2 style="margin:0 0 2px;font-size:16px">${escapeHtml(f.title)}</h2>
      <p class="muted" style="font-size:12px">Live at https://${escapeHtml(site.domain)}/forms/${escapeHtml(f.slug)}/ · embed anywhere with <code>&lt;div class="form-embed" data-form="${escapeHtml(f.slug)}"&gt;&lt;/div&gt;</code></p>
    </div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/forms/${escapeAttr(f.id)}">
      <div class="card">
        <label class="muted" style="font-size:12px">Form title</label>
        <input name="title" value="${escapeAttr(f.title)}" required style="${IN}" />
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:10px 0 0"><input type="checkbox" name="active" ${f.active ? "checked" : ""} /> Form is live</label>
      </div>
      <div class="card" style="overflow-x:auto">
        <h3 style="margin:0 0 6px;font-size:14px">Fields <span class="muted" style="font-weight:400;font-size:11px">— ↑/↓ to reorder; changes save with the button below</span></h3>
        <table style="width:100%;border-collapse:collapse;min-width:680px"><thead><tr class="muted" style="font-size:10px;text-transform:uppercase">
          <th style="text-align:left;padding:4px 6px">Key</th><th style="text-align:left;padding:4px 6px">Label</th><th style="text-align:left;padding:4px 6px">Type</th><th style="padding:4px 6px">Req</th><th style="text-align:left;padding:4px 6px">Options</th><th></th>
        </tr></thead><tbody>${fieldRows}</tbody></table>
        <div style="display:flex;gap:8px;align-items:center;margin-top:10px">
          <button type="submit" name="add_field" value="1" class="btn ghost" style="font-size:12px">+ Add field</button>
          <span class="muted" style="font-size:11px">New fields start as optional text — set key/label/type, then save.</span>
        </div>
      </div>
      <div class="card">
        <h3 style="margin:0 0 6px;font-size:14px">Auto-reply to the submitter</h3>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:6px 0"><input type="checkbox" name="ackEnabled" ${f.ackEnabled ? "checked" : ""} /> Send an acknowledgment email <span class="muted">(to the address they typed — placeholders like {{name}}, {{site_name}}, {{form_title}} work)</span></label>
        <label class="muted" style="font-size:12px;display:block;margin-top:6px">Subject</label>
        <input name="ackSubject" value="${escapeAttr(f.ackSubject)}" style="${IN}" />
        <label class="muted" style="font-size:12px;display:block;margin-top:6px">Body (HTML)</label>
        <textarea name="ackBody" rows="4" style="${IN}">${escapeHtml(f.ackBody)}</textarea>
      </div>
      <div class="card" style="display:flex;justify-content:space-between">
        <button type="submit" name="delete" value="1" onclick="return confirm('Delete this form and keep its submissions?')" style="background:#7f1d1d;color:#fff;border:0;border-radius:7px;padding:9px 14px;font-size:13px;cursor:pointer">Delete form</button>
        <button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font-size:14px;cursor:pointer">Save form</button>
      </div>
    </form>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/forms/${escapeAttr(f.id)}/webhook">
      <div class="card">
        <h3 style="margin:0 0 4px;font-size:14px">Automation webhook</h3>
        <p class="muted" style="font-size:12px;margin:0 0 8px">POST each submission (JSON, HMAC-signed with your secret as <code>X-Webhook-Signature</code>) to any URL — n8n, Make, Zapier, your CRM. One field, infinite automations.</p>
        <label class="muted" style="font-size:12px">Webhook URL</label>
        <input name="webhookUrl" value="${escapeAttr(f.webhookUrl)}" placeholder="https://hooks.example.com/…" style="${IN}" />
        <label class="muted" style="font-size:12px;display:block;margin-top:6px">Signing secret (optional)</label>
        <input name="webhookSecret" value="${escapeAttr(f.webhookSecret)}" style="${IN}" />
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
          ${f.webhookUrl ? `<button type="submit" name="testfire" value="1" class="btn ghost" style="font-size:12px">Send test event</button>` : ""}
          <button type="submit" style="background:#374151;color:#fff;border:0;border-radius:7px;padding:8px 15px;font-size:13px;cursor:pointer">Save webhook</button>
        </div>
        ${webhookLogHtml}
      </div>
    </form>
    ${f.slug.startsWith("newsletter") ? `<div class="card">
      <h3 style="margin:0 0 4px;font-size:14px">Subscribers</h3>
      <p class="muted" style="font-size:12px;margin:0 0 8px">Double-opt-in: people confirm by email before they count. No campaign sending here — <a href="#" style="color:#93c5fd" onclick="return false">connect your email tool via the webhook above</a> or export CSV.</p>
      <p style="font-size:13px">${subscriberStats}</p>
      <a class="btn ghost" style="font-size:12px" href="/app/sites/${escapeAttr(siteId)}/subscribers.csv">Export subscribers CSV</a>
    </div>` : ""}`
  return c.html(renderSaasLayout({ title: f.title, active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

function fieldsFromForm(form: Record<string, unknown>): FieldDef[] {
  const out: FieldDef[] = []
  for (let i = 0; i < 60; i++) {
    if (form[`fkey_${i}`] === undefined) continue
    const opts = String(form[`fopts_${i}`] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    out.push({
      key: String(form[`fkey_${i}`] ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) || `field_${i}`,
      label: String(form[`flabel_${i}`] ?? "").slice(0, 120) || `Field ${i + 1}`,
      type: (FIELD_TYPES as readonly string[]).includes(String(form[`ftype_${i}`])) ? (String(form[`ftype_${i}`]) as FieldType) : "text",
      required: form[`freq_${i}`] === "on",
      ...(opts.length ? { options: opts } : {}),
    })
  }
  // Round-trip through the validator so stored defs are always canonical.
  return parseFields(JSON.stringify(out))
}

export async function formSaveHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const formId = c.req.param("formId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/forms/${formId}${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to edit."))

  const form = (await c.req.parseBody()) as Record<string, unknown>

  if (form.delete === "1") {
    await deleteForm(c.env, customer.id, site.cms_site_id, site.repo_full_name, formId, master)
    await audit(master, customer.id, "site.form_deleted", site.domain).catch(() => {})
    return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/forms?saved=${encodeURIComponent("Form deleted (submissions kept in the inbox).")}` } })
  }

  let fields = fieldsFromForm(form)
  // Structural buttons: reorder / remove / add, then save the result.
  const idx = (k: string) => (form[k] !== undefined ? Number(form[k]) : -1)
  const up = idx("move_up"), down = idx("move_down"), rm = idx("remove")
  if (up > 0 && up < fields.length) [fields[up - 1], fields[up]] = [fields[up], fields[up - 1]]
  if (down >= 0 && down < fields.length - 1) [fields[down], fields[down + 1]] = [fields[down + 1], fields[down]]
  if (rm >= 0 && rm < fields.length) fields = fields.filter((_, i) => i !== rm)
  if (form.add_field === "1") fields.push({ key: `field_${fields.length + 1}`, label: `Field ${fields.length + 1}`, type: "text", required: false })

  const input: FormInput = {
    title: String(form.title ?? ""),
    fields,
    ackEnabled: form.ackEnabled === "on",
    ackSubject: String(form.ackSubject ?? "").slice(0, 200),
    ackBody: String(form.ackBody ?? "").slice(0, 5000),
    active: form.active === "on",
  }
  const r = await updateForm(c.env, customer.id, site.cms_site_id, site.repo_full_name, formId, input, master)
  if (!r.ok) return back("?error=" + encodeURIComponent(r.error ?? "Couldn't save."))
  await audit(master, customer.id, "site.form_saved", site.domain).catch(() => {})
  return back("?saved=" + encodeURIComponent("Form saved."))
}


export async function formWebhookHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const formId = c.req.param("formId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/forms/${formId}${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("?error=" + encodeURIComponent("Your trial has ended — subscribe to edit."))

  const form = (await c.req.parseBody()) as Record<string, unknown>
  const url = String(form.webhookUrl ?? "")
  const secret = String(form.webhookSecret ?? "")
  const r = await setFormWebhook(master, site.cms_site_id, formId, url, secret)
  if (!r.ok) return back("?error=" + encodeURIComponent(r.error ?? "Couldn't save."))

  if (form.testfire === "1" && url.trim()) {
    const siteDb = await siteDbFor(master, site.cms_site_id)
    const def = await getForm(master, site.cms_site_id, formId)
    if (siteDb && def?.webhookUrl) {
      const res = await fireFormWebhook(siteDb, def, {
        id: "test-" + Date.now().toString(36),
        fields: Object.fromEntries(def.fields.map((fd) => [fd.key, `(test ${fd.type})`])),
        page: "/test/", country: "XX",
      }, site.domain)
      await audit(master, customer.id, "site.form_webhook_tested", site.domain, { ok: res.ok }).catch(() => {})
      return back("?saved=" + encodeURIComponent(res.ok ? `Test event delivered (HTTP ${res.status}).` : `Test event FAILED${res.status ? ` (HTTP ${res.status})` : " (unreachable)"} — check the URL.`))
    }
  }
  await audit(master, customer.id, "site.form_webhook_saved", site.domain).catch(() => {})
  return back("?saved=" + encodeURIComponent("Webhook saved."))
}

export async function subscribersCsvHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response("not found", { status: 404 })
  const siteDb = await siteDbFor(master, site.cms_site_id)
  const subs = siteDb ? await listSubscribers(siteDb).catch(() => []) : []
  return new Response(subscribersToCsv(subs), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="subscribers-${site.domain}.csv"`,
      "Cache-Control": "no-store, private",
    },
  })
}
