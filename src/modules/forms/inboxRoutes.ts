// src/modules/forms/inboxRoutes.ts
// Submissions Inbox (V1.4 F2): per-site inbox with filters/search/status/
// notes/CSV, detail view with reply compose (Resend, thread stored), the
// cross-site "All inboxes" page, and a retention setting (default keep-forever).

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, sendEmail, type Customer } from "../customers"
import { siteDbFor, assistAvailable } from "../seo"
import { loadFormsSite } from "./formsRoutes"
import { listForms } from "./service"
import { formsFromAddress } from "./model"
import { runDraftReply } from "./intel"
import {
  listSubmissions, getSubmission, setStatus, saveNotes, appendReply,
  submissionsToCsv, countNew, crossSiteNew,
} from "./inboxService"

const NO_STORE = { "Cache-Control": "no-store, private" }
const IN = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:13px"

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
function submissionEmail(fields: Record<string, string>): string | null {
  for (const v of Object.values(fields)) if (EMAIL_RE.test(v)) return v
  return null
}

async function retentionDays(master: Awaited<ReturnType<typeof masterDb>>, cmsSiteId: string): Promise<number> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return 0
  const r = await siteDb.execute({ sql: "SELECT value FROM settings WHERE key = 'inbox_retention_days' LIMIT 1", args: [] }).catch(() => null)
  return r?.rows.length ? Number(r.rows[0].value) || 0 : 0
}

const STATUS_COLORS: Record<string, string> = { new: "#fcd34d", read: "#a3a3a3", replied: "#86efac", archived: "#525252" }

export async function inboxHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const q = {
    formId: c.req.query("form") || undefined,
    status: c.req.query("status") || undefined,
    search: c.req.query("q") || undefined,
  }
  const retention = await retentionDays(master, site.cms_site_id)
  const subs = await listSubmissions(master, site.cms_site_id, q, retention).catch(() => [])
  // ✨ digest is an F4 surface — shown only with the customer's key connected.
  const intelOn = await assistAvailable(master, customer.id).catch(() => false)
  let digestOn = false
  if (intelOn) {
    const sdb = await siteDbFor(master, site.cms_site_id)
    const r = sdb ? await sdb.execute({ sql: "SELECT value FROM settings WHERE key = 'inbox_digest_enabled' LIMIT 1", args: [] }).catch(() => null) : null
    digestOn = String(r?.rows[0]?.value ?? "") === "1"
  }

  // CSV export of the CURRENT filter.
  if (c.req.query("export") === "csv") {
    return new Response(submissionsToCsv(subs), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="submissions-${site.domain}.csv"`,
        "Cache-Control": "no-store, private",
      },
    })
  }

  const saved = c.req.query("saved")
  const notice = saved ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)}</p></div>` : ""
  const rows = subs.length
    ? subs.map((s) => {
        const email = submissionEmail(s.fields) ?? ""
        const first = Object.values(s.fields)[0] ?? ""
        return `<tr style="border-top:1px solid #1f2937${s.status === "new" ? ";background:#101623" : ""}">
        <td style="padding:8px 6px;font-size:13px"><a href="/app/sites/${escapeAttr(siteId)}/inbox/${escapeAttr(s.id)}" style="color:#fafafa">${escapeHtml(first.slice(0, 60) || "(submission)")}</a>
          <div class="muted" style="font-size:11px">${escapeHtml(s.formTitle)} · ${escapeHtml(s.createdAt.slice(0, 16))}${email ? " · " + escapeHtml(email) : ""}${s.country ? " · " + escapeHtml(s.country) : ""}</div>
          ${s.aiSummary ? `<div style="font-size:11px;color:#93c5fd">✨ ${escapeHtml(s.aiSummary)}${s.aiScore ? ` · <strong>${escapeHtml(s.aiScore.split(":")[0])}</strong>` : ""}</div>` : ""}</td>
        <td style="padding:8px 6px;text-align:right;white-space:nowrap"><span style="color:${STATUS_COLORS[s.status] ?? "#a3a3a3"};font-size:12px">● ${escapeHtml(s.status)}</span></td>
      </tr>`
      }).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No submissions${q.formId || q.status || q.search ? " matching this filter" : " yet — they'll appear the moment a visitor sends a form"}.</td></tr>`

  const forms = await listForms(master, site.cms_site_id).catch(() => [])
  const formOpts = forms.map((f) => `<option value="${escapeAttr(f.id)}" ${q.formId === f.id ? "selected" : ""}>${escapeHtml(f.title)}</option>`).join("")
  const statusOpts = ["", "new", "read", "replied", "archived"].map((s) => `<option value="${s}" ${q.status === s ? "selected" : ""}>${s || "any status"}</option>`).join("")
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString()

  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Inbox</h2>
      <p class="muted" style="font-size:13px">Every form submission, in one place. <a href="/app/inboxes" style="color:#93c5fd">All sites →</a></p>
      <form method="get" action="/app/sites/${escapeAttr(siteId)}/inbox" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <select name="form" style="${IN};max-width:180px"><option value="">any form</option>${formOpts}</select>
        <select name="status" style="${IN};max-width:140px">${statusOpts}</select>
        <input name="q" value="${escapeAttr(q.search ?? "")}" placeholder="Search…" style="${IN};max-width:200px" />
        <button type="submit" class="btn ghost" style="font-size:12px">Filter</button>
        <a class="btn ghost" style="font-size:12px" href="/app/sites/${escapeAttr(siteId)}/inbox?${qs}${qs ? "&" : ""}export=csv">Export CSV</a>
      </form>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/inbox/retention">
      <div class="card" style="display:flex;gap:10px;align-items:center">
        <span style="font-size:13px">Auto-delete submissions after</span>
        <select name="days" style="${IN};max-width:160px">
          ${[0, 30, 90, 365].map((d) => `<option value="${d}" ${retention === d ? "selected" : ""}>${d === 0 ? "never (keep forever)" : d + " days"}</option>`).join("")}
        </select>
        <button type="submit" class="btn ghost" style="font-size:12px">Save</button>
      </div>
    </form>
    ${intelOn
      ? `<form method="post" action="/app/sites/${escapeAttr(siteId)}/inbox/digest">
          <div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <span style="font-size:13px">✨ Daily digest email</span>
            <select name="enabled" style="${IN};max-width:120px">
              <option value="0" ${digestOn ? "" : "selected"}>off</option>
              <option value="1" ${digestOn ? "selected" : ""}>on</option>
            </select>
            <button type="submit" class="btn ghost" style="font-size:12px">Save</button>
            <span class="muted" style="font-size:11px">One morning email with yesterday's submissions and lead scores — only on days there's something new.</span>
          </div>
        </form>`
      : ""}`
  await audit(master, customer.id, "site.inbox_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Inbox", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function inboxDetailHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const subId = c.req.param("subId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const sub = await getSubmission(master, site.cms_site_id, subId)
  if (!sub) return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox` } })
  if (sub.status === "new") await setStatus(master, site.cms_site_id, subId, "read")
  return renderDetail(c, master, customer, site, siteId, subId, sub, "")
}

async function renderDetail(
  c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customer: Customer,
  site: NonNullable<Awaited<ReturnType<typeof loadFormsSite>>>, siteId: string, subId: string,
  sub: NonNullable<Awaited<ReturnType<typeof getSubmission>>>, draft: string
): Promise<Response> {
  const email = submissionEmail(sub.fields)
  // ✨ surfaces exist only when the customer's own key is connected (F4).
  const intelOn = await assistAvailable(master, customer.id).catch(() => false)
  const fieldsHtml = Object.entries(sub.fields)
    .map(([k, v]) => `<p style="margin:4px 0"><span class="muted" style="font-size:11px;text-transform:uppercase">${escapeHtml(k)}</span><br>${/^https:\/\/\S+$/.test(v) ? `<a href="${escapeAttr(v)}" rel="noopener" style="color:#93c5fd">${escapeHtml(v)}</a>` : escapeHtml(v).replace(/\n/g, "<br>")}</p>`)
    .join("")
  const threadHtml = sub.thread.length
    ? sub.thread.map((t) => `<div style="border-left:2px solid #374151;padding-left:10px;margin:8px 0"><div class="muted" style="font-size:11px">${escapeHtml(t.at.slice(0, 16))} — ${escapeHtml(t.subject)}</div><div style="font-size:13px">${escapeHtml(t.body).replace(/\n/g, "<br>")}</div></div>`).join("")
    : `<p class="muted" style="font-size:12px">No replies yet.</p>`
  const saved = c.req.query("saved")
  const notice = saved ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(saved)}</p></div>` : ""
  const statusBtn = (s: string, label: string) => `<form method="post" action="/app/sites/${escapeAttr(siteId)}/inbox/${escapeAttr(subId)}/status" style="display:inline;margin:0"><input type="hidden" name="status" value="${s}" /><button type="submit" class="btn ghost" style="font-size:12px">${label}</button></form>`

  const body = `
    ${notice}
    <div class="card"><p><a href="/app/sites/${escapeAttr(siteId)}/inbox" style="color:#93c5fd">← Inbox</a></p>
      <h2 style="margin:0 0 2px;font-size:16px">${escapeHtml(sub.formTitle)} <span style="color:${STATUS_COLORS[sub.status] ?? "#a3a3a3"};font-size:12px">● ${escapeHtml(sub.status)}</span></h2>
      <p class="muted" style="font-size:12px">${escapeHtml(sub.createdAt)} · page ${escapeHtml(sub.page ?? "—")} · ${escapeHtml(sub.country ?? "")}</p>
      ${sub.aiSummary ? `<p style="font-size:13px;color:#93c5fd">✨ ${escapeHtml(sub.aiSummary)}${sub.aiScore ? ` — <strong>${escapeHtml(sub.aiScore)}</strong>` : ""}</p>` : ""}
      <div style="margin-top:6px">${statusBtn("read", "Mark read")} ${statusBtn("archived", "Archive")} ${statusBtn("new", "Mark unread")}</div>
    </div>
    <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Submission</h3>${fieldsHtml}</div>
    <form method="post" action="/app/sites/${escapeAttr(siteId)}/inbox/${escapeAttr(subId)}/notes">
      <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Internal notes <span class="muted" style="font-weight:400;font-size:11px">(never sent)</span></h3>
        <textarea name="notes" rows="3" style="${IN}">${escapeHtml(sub.notes)}</textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px"><button type="submit" class="btn ghost" style="font-size:12px">Save notes</button></div>
      </div>
    </form>
    <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Replies</h3>${threadHtml}
      ${email
        ? `<form method="post" action="/app/sites/${escapeAttr(siteId)}/inbox/${escapeAttr(subId)}/reply" style="margin-top:10px">
            <input name="subject" value="Re: ${escapeAttr(sub.formTitle)} — ${escapeAttr(site.name)}" style="${IN}" />
            <textarea name="body" rows="7" placeholder="Write your reply to ${escapeAttr(email)}…" style="${IN};margin-top:6px">${escapeHtml(draft)}</textarea>
            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:8px">
              ${intelOn ? `<button type="submit" formaction="/app/sites/${escapeAttr(siteId)}/inbox/${escapeAttr(subId)}/draft" class="btn ghost" style="font-size:12px">✨ Draft a reply</button>` : "<span></span>"}
              <button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 15px;font-size:13px;cursor:pointer">Send reply</button>
            </div>
            ${intelOn ? `<p class="muted" style="font-size:11px;margin:6px 0 0">Drafts are suggestions on your own Anthropic key — nothing is ever sent until you press Send.</p>` : ""}
          </form>`
        : `<p class="muted" style="font-size:12px">This submission has no email address — nothing to reply to.</p>`}
    </div>`
  return c.html(renderSaasLayout({ title: "Submission", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

/** ✨ Generate a reply draft and re-render the detail page with the compose
 *  box prefilled. NEVER sends — content is never logged (counts-only audit). */
export async function inboxDraftHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const subId = c.req.param("subId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const sub = await getSubmission(master, site.cms_site_id, subId)
  if (!sub) return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox` } })
  const draft = await runDraftReply(c.env, master, customer.id, { formTitle: sub.formTitle, siteName: site.name, fields: sub.fields })
  await audit(master, customer.id, "site.intel_draft", site.domain).catch(() => {})
  if (!draft) {
    return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox/${subId}?saved=${encodeURIComponent("Couldn't draft just now — check your Anthropic connection or try again.")}` } })
  }
  return renderDetail(c, master, customer, site, siteId, subId, sub, draft)
}

export async function inboxStatusHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const subId = c.req.param("subId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    await setStatus(master, site.cms_site_id, subId, String(form.status ?? ""))
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox/${subId}` } })
}

export async function inboxNotesHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const subId = c.req.param("subId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    await saveNotes(master, site.cms_site_id, subId, String(form.notes ?? ""))
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox/${subId}?saved=${encodeURIComponent("Notes saved.")}` } })
}

export async function inboxReplyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const subId = c.req.param("subId") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const back = (msg: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox/${subId}?saved=${encodeURIComponent(msg)}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return back("Your trial has ended — subscribe to reply.")

  const sub = await getSubmission(master, site.cms_site_id, subId)
  if (!sub) return back("That submission no longer exists.")
  const to = submissionEmail(sub.fields)
  if (!to) return back("No email address on this submission.")

  const form = await c.req.parseBody()
  const subject = String(form.subject ?? "").trim().slice(0, 200) || `Re: ${sub.formTitle}`
  const bodyText = String(form.body ?? "").trim().slice(0, 10000)
  if (!bodyText) return back("Write something first.")

  const domRow = await master.execute({ sql: "SELECT forms_domain, forms_domain_status FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1", args: [siteId, customer.id] })
  const d = domRow.rows[0] as unknown as { forms_domain: string | null; forms_domain_status: string | null }
  const ownerRow = await master.execute({ sql: "SELECT email FROM customers WHERE id = ? LIMIT 1", args: [customer.id] })
  const ownerEmail = String(ownerRow.rows[0]?.email ?? "")

  const ok = await sendEmail(c.env, {
    to,
    from: formsFromAddress(site.name, d?.forms_domain ?? null, d?.forms_domain_status ?? null),
    replyTo: ownerEmail || undefined,
    subject,
    html: `<p>${escapeHtml(bodyText).replace(/\n/g, "<br>")}</p><hr><p style="color:#737373;font-size:12px">In reply to your ${escapeHtml(sub.formTitle)} submission on ${escapeHtml(site.domain)}.</p>`,
  })
  if (!ok) return back("Couldn't send just now — try again.")
  await appendReply(master, site.cms_site_id, subId, subject, bodyText)
  await audit(master, customer.id, "site.inbox_replied", site.domain).catch(() => {})
  return back("Reply sent.")
}

export async function inboxRetentionHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    const days = [0, 30, 90, 365].includes(Number(form.days)) ? Number(form.days) : 0
    const siteDb = await siteDbFor(master, site.cms_site_id)
    if (siteDb) {
      await siteDb.execute({
        sql: `INSERT INTO settings (key, value) VALUES ('inbox_retention_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [String(days)],
      }).catch(() => {})
    }
    await audit(master, customer.id, "site.inbox_retention_set", site.domain, { days }).catch(() => {})
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox?saved=${encodeURIComponent("Retention saved.")}` } })
}

/** ✨ Daily digest opt-in (site setting; the walker rides the daily cron). */
export async function inboxDigestHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const siteId = c.req.param("id") ?? ""
  const master = await masterDb(c)
  const site = await loadFormsSite(master, siteId, customer.id)
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    const enabled = String(form.enabled) === "1" ? "1" : "0"
    const siteDb = await siteDbFor(master, site.cms_site_id)
    if (siteDb) {
      await siteDb.execute({
        sql: `INSERT INTO settings (key, value) VALUES ('inbox_digest_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [enabled],
      }).catch(() => {})
    }
    await audit(master, customer.id, "site.inbox_digest_set", site.domain, { enabled }).catch(() => {})
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${siteId}/inbox?saved=${encodeURIComponent("Digest setting saved.")}` } })
}

/** Cross-site "All inboxes" — network operators live here. */
export async function allInboxesHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const sitesR = await master.execute({
    sql: "SELECT id, domain, cms_site_id FROM customer_sites WHERE customer_id = ? ORDER BY created_at",
    args: [customer.id],
  })
  const sites = sitesR.rows as unknown as Array<{ id: string; domain: string; cms_site_id: string | null }>
  const items = await crossSiteNew(master, sites).catch(() => [])
  const rows = items.length
    ? items.map(({ siteId, domain, sub }) => `<tr style="border-top:1px solid #1f2937">
        <td style="padding:8px 6px;font-size:13px"><a href="/app/sites/${escapeAttr(siteId)}/inbox/${escapeAttr(sub.id)}" style="color:#fafafa">${escapeHtml(Object.values(sub.fields)[0]?.slice(0, 50) || "(submission)")}</a>
          <div class="muted" style="font-size:11px">${escapeHtml(domain)} · ${escapeHtml(sub.formTitle)} · ${escapeHtml(sub.createdAt.slice(0, 16))}</div></td>
        <td style="padding:8px 6px;text-align:right"><span style="color:#fcd34d;font-size:12px">● new</span></td></tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:10px 6px">No new submissions across your sites. 🎉</td></tr>`
  const body = `
    <div class="card"><h2 style="margin:0 0 4px;font-size:16px">All inboxes</h2>
      <p class="muted" style="font-size:13px">New submissions across every site, newest first.</p></div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>`
  return c.html(renderSaasLayout({ title: "All inboxes", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}
