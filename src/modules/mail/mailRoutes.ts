// src/modules/mail/mailRoutes.ts
// Site Mailbox dashboard (V1.5 M1). Reuses the forms-inbox design language —
// one inbox for the whole platform. Threads grouped by conversation, folder
// tabs (Inbox/Archived/Spam), search, reply via the connected provider, and a
// small Addresses + Provider setup section. Honest constraints surfaced inline:
// Cloudflare receives, the provider sends, sending is blocked until verified.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema, renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { audit, planGate, type Customer } from "../customers"
import { vaultEncrypt, vaultDecrypt } from "../vault"
import {
  listThreads, getThread, markThreadRead, setThreadFolder,
  listAddresses, addAddress, setAddressActive, appendOutbound, type MailFolder,
} from "./service"
import { isMailProvider, MAIL_PROVIDERS, MAIL_PROVIDER_LABELS, providerSend, providerStatus, type MailProviderId } from "./providers"

const NO_STORE = { "Cache-Control": "no-store, private" }
const IN = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #374151;background:#0b0f17;color:#fafafa;font-size:13px"

interface MailSite {
  id: string; customer_id: string; cms_site_id: string | null; domain: string; canonical_host: string
  mail_provider: string | null; mail_provider_secret_enc: string | null; mail_provider_status: string | null
  mail_from_name: string | null; mail_routing_status: string | null
}

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}
async function loadMailSite(c: Context<AppEnv>, master: Awaited<ReturnType<typeof masterDb>>, customerId: string): Promise<MailSite | null> {
  const r = await master.execute({
    sql: `SELECT id, customer_id, cms_site_id, domain, canonical_host, mail_provider, mail_provider_secret_enc,
                 mail_provider_status, mail_from_name, mail_routing_status
          FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1`,
    args: [c.req.param("id") ?? "", customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as MailSite) : null
}
function nowSqlite(): string { return new Date().toISOString().replace("T", " ").slice(0, 19) }
const enc = (tk: string) => encodeURIComponent(tk)

// ─────────────────────── mailbox (thread list) ───────────────────────

export async function mailboxHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })

  const folder = (["inbox", "archived", "spam"].includes(c.req.query("folder") || "") ? c.req.query("folder") : "inbox") as MailFolder
  const search = c.req.query("q") || undefined
  const threads = await listThreads(master, site.cms_site_id, folder, search).catch(() => [])
  const notice = c.req.query("done")
  const err = c.req.query("error")

  const providerReady = site.mail_provider && site.mail_provider_status === "active"
  const routingOn = site.mail_routing_status === "on"
  const banner = !routingOn
    ? `<div class="card" style="border-color:#7c2d12;background:#1c1410"><p style="margin:0;font-size:13px;color:#fdba74">📬 Receiving isn't live yet. Finish the mailbox setup (Email Routing on your domain) in <a href="/app/sites/${escapeAttr(site.id)}/mailbox/setup" style="color:#fdba74">Setup &amp; addresses</a>.</p></div>`
    : !providerReady
      ? `<div class="card" style="border-color:#78350f;background:#1c1710"><p style="margin:0;font-size:13px;color:#fcd34d">You can read mail, but replying needs a verified sending provider. <a href="/app/sites/${escapeAttr(site.id)}/mailbox/setup" style="color:#fcd34d">Connect one →</a></p></div>`
      : ""

  const tab = (id: MailFolder, label: string) => `<a class="btn ghost" style="font-size:12px${folder === id ? ";border-color:#fafafa" : ""}" href="/app/sites/${escapeAttr(site.id)}/mailbox?folder=${id}">${label}</a>`
  const rows = threads.length
    ? threads.map((t) => `<tr style="border-top:1px solid #1f2937${t.unread ? ";background:#101623" : ""}">
        <td style="padding:9px 6px;font-size:13px">
          <a href="/app/sites/${escapeAttr(site.id)}/mailbox/thread/${escapeAttr(enc(t.threadKey))}" style="color:#fafafa;text-decoration:none">
            <span style="font-weight:${t.unread ? "700" : "400"}">${escapeHtml(t.who)}</span>
            <span class="muted" style="font-size:11px">${t.count > 1 ? ` · ${t.count}` : ""}</span>
            <div style="font-weight:${t.unread ? "600" : "400"}">${escapeHtml(t.subject)}</div>
            <div class="muted" style="font-size:11px">${escapeHtml(t.preview)}</div>
          </a>
        </td>
        <td style="padding:9px 6px;text-align:right;white-space:nowrap;color:#6b7280;font-size:11px">${escapeHtml(t.at.slice(0, 16))}</td>
      </tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:12px 6px">No mail in ${folder}${search ? " matching this search" : ""}.</td></tr>`

  const body = `
    ${notice ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(notice)}</p></div>` : ""}
    ${err ? `<div class="card" style="border-color:#7f1d1d;background:#1c1212"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(err)}</p></div>` : ""}
    ${banner}
    <div class="card">
      <p><a href="/app/sites/${escapeAttr(site.id)}" style="color:#93c5fd">← ${escapeHtml(site.domain)}</a></p>
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0;font-size:16px">Mailbox</h2>
        <a class="btn ghost" style="font-size:12px" href="/app/sites/${escapeAttr(site.id)}/mailbox/setup">Setup &amp; addresses</a>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${tab("inbox", "Inbox")}${tab("archived", "Archived")}${tab("spam", "Spam")}</div>
      <form method="get" action="/app/sites/${escapeAttr(site.id)}/mailbox" style="margin-top:8px;display:flex;gap:8px">
        <input type="hidden" name="folder" value="${folder}">
        <input name="q" value="${escapeAttr(search ?? "")}" placeholder="Search mail…" style="${IN};max-width:240px">
        <button class="btn ghost" style="font-size:12px" type="submit">Search</button>
      </form>
    </div>
    <div class="card"><table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table></div>`
  await audit(master, customer.id, "site.mailbox_viewed", site.domain).catch(() => {})
  return c.html(renderSaasLayout({ title: "Mailbox", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

// ─────────────────────── thread ───────────────────────

export async function mailThreadHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const tk = decodeURIComponent(c.req.param("tk") ?? "")
  const msgs = await getThread(master, site.cms_site_id, tk)
  if (!msgs.length) return new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/mailbox` } })
  await markThreadRead(master, site.cms_site_id, tk)

  const addresses = await listAddresses(master, site.cms_site_id).catch(() => [])
  const last = msgs[msgs.length - 1]
  const replyTo = last.direction === "in" ? last.from : last.to
  const fromDefault = last.direction === "in" ? last.to : last.from
  const providerReady = site.mail_provider && site.mail_provider_status === "active"

  const bubble = (m: (typeof msgs)[number]) => `<div style="border:1px solid #1f2937;border-radius:10px;padding:12px;margin:0 0 10px;${m.direction === "out" ? "background:#0e1726" : ""}">
      <div class="muted" style="font-size:11px;display:flex;justify-content:space-between;gap:8px">
        <span>${m.direction === "out" ? "→ " : ""}${escapeHtml(m.direction === "in" ? m.from : "You")} · ${escapeHtml(m.createdAt.slice(0, 16))}</span>
        ${m.spam ? `<span style="color:#f87171">spam</span>` : ""}
      </div>
      <div style="font-size:13px;margin-top:6px;white-space:pre-wrap">${escapeHtml(m.bodyText || m.bodyHtml.replace(/<[^>]+>/g, " ")).slice(0, 20000)}</div>
      ${m.attachments.length ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px">${m.attachments.map((a) => `<a href="${escapeAttr(a.url)}" rel="noopener" class="btn ghost" style="font-size:11px">📎 ${escapeHtml(a.filename)}</a>`).join("")}</div>` : ""}
    </div>`

  const fromOpts = (addresses.length ? addresses.map((a) => a.address) : [fromDefault]).map((a) => `<option value="${escapeAttr(a)}" ${a === fromDefault ? "selected" : ""}>${escapeHtml(a)}</option>`).join("")
  const body = `
    <div class="card"><p><a href="/app/sites/${escapeAttr(site.id)}/mailbox" style="color:#93c5fd">← Mailbox</a></p>
      <h2 style="margin:0 0 2px;font-size:16px">${escapeHtml(last.subject || "(no subject)")}</h2>
      <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
        ${["archive", "spam", "inbox"].map((a) => `<form method="post" action="/app/sites/${escapeAttr(site.id)}/mailbox/thread/${escapeAttr(enc(tk))}/folder" style="display:inline;margin:0"><input type="hidden" name="action" value="${a}"><button class="btn ghost" style="font-size:12px" type="submit">${a === "archive" ? "Archive" : a === "spam" ? "Mark spam" : "Move to inbox"}</button></form>`).join(" ")}
      </div>
    </div>
    <div class="card">${msgs.map(bubble).join("")}</div>
    <div class="card"><h3 style="margin:0 0 6px;font-size:14px">Reply</h3>
      ${providerReady
        ? `<form method="post" action="/app/sites/${escapeAttr(site.id)}/mailbox/thread/${escapeAttr(enc(tk))}/reply">
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px">
              <label style="font-size:12px;color:#9ca3af">From <select name="from" style="${IN};max-width:220px">${fromOpts}</select></label>
              <label style="font-size:12px;color:#9ca3af;flex:1">To <input name="to" value="${escapeAttr(replyTo)}" style="${IN}"></label>
            </div>
            <input name="subject" value="Re: ${escapeAttr((last.subject || "").replace(/^re:\s*/i, ""))}" style="${IN}">
            <textarea name="body" rows="6" placeholder="Write your reply…" style="${IN};margin-top:6px" required></textarea>
            <div style="display:flex;justify-content:flex-end;margin-top:8px"><button type="submit" style="background:#2563eb;color:#fff;border:0;border-radius:7px;padding:8px 16px;font-size:13px;cursor:pointer">Send via ${escapeHtml(MAIL_PROVIDER_LABELS[site.mail_provider as MailProviderId] ?? "provider")}</button></div>
          </form>`
        : `<p class="muted" style="font-size:12px">Connect a verified sending provider in <a href="/app/sites/${escapeAttr(site.id)}/mailbox/setup" style="color:#93c5fd">Setup</a> to reply.</p>`}
    </div>`
  return c.html(renderSaasLayout({ title: "Conversation", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function mailFolderHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  const tk = decodeURIComponent(c.req.param("tk") ?? "")
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    const action = String(form.action)
    if (["archive", "spam", "inbox"].includes(action)) await setThreadFolder(master, site.cms_site_id, tk, action as "archive" | "spam" | "inbox")
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/mailbox?done=${encodeURIComponent("Moved.")}` } })
}

export async function mailReplyHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const tk = decodeURIComponent(c.req.param("tk") ?? "")
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/mailbox/thread/${enc(tk)}?_=${q}` } })
  const home = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/mailbox?${q}` } })
  if (planGate(customer, nowSqlite()) === "read_only") return home("error=" + encodeURIComponent("Your trial has ended — subscribe to send mail."))
  if (!site.mail_provider || !isMailProvider(site.mail_provider) || site.mail_provider_status !== "active" || !site.mail_provider_secret_enc) {
    return home("error=" + encodeURIComponent("Connect a verified sending provider first."))
  }
  const form = await c.req.parseBody()
  const from = String(form.from || "").trim()
  const to = String(form.to || "").trim()
  const subject = String(form.subject || "").trim().slice(0, 300)
  const bodyText = String(form.body || "").trim().slice(0, 50000)
  if (!from || !to || !bodyText) return back(encodeURIComponent("Fill in From, To and a message."))

  const vaultKey = c.env.VAULT_MASTER_KEY
  if (!vaultKey) return home("error=" + encodeURIComponent("Server vault key not configured."))
  let key: string
  try {
    key = await vaultDecrypt(vaultKey, site.customer_id, site.mail_provider_secret_enc)
  } catch {
    return home("error=" + encodeURIComponent("Couldn't read your provider key — reconnect it."))
  }
  const html = `<p>${escapeHtml(bodyText).replace(/\n/g, "<br>")}</p>`
  const res = await providerSend(site.mail_provider, key, {
    fromEmail: from, fromName: site.mail_from_name || "", to, subject, html, text: bodyText,
  })
  await audit(master, customer.id, "site.mail_sent", site.domain, { provider: site.mail_provider, ok: res.ok }).catch(() => {})
  if (!res.ok) return back(encodeURIComponent(res.error || "Send failed."))
  await appendOutbound(master, site.cms_site_id, { threadKey: tk, from, to, subject, html, text: bodyText })
  return back(encodeURIComponent("Sent."))
}

// ─────────────────────── setup: addresses + provider ───────────────────────

export async function mailSetupHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  if (!site || !site.cms_site_id) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const addresses = await listAddresses(master, site.cms_site_id).catch(() => [])
  const notice = c.req.query("done"); const err = c.req.query("error")
  const providerReady = site.mail_provider && site.mail_provider_status === "active"

  const addrRows = addresses.length
    ? addresses.map((a) => `<tr style="border-top:1px solid #1f2937"><td style="padding:7px 6px;font-size:13px">${escapeHtml(a.address)}${a.isCatchAll ? ' <span class="muted" style="font-size:11px">(catch-all)</span>' : ""}</td>
        <td style="padding:7px 6px;text-align:right"><form method="post" action="/app/sites/${escapeAttr(site.id)}/mailbox/addresses/toggle" style="display:inline;margin:0"><input type="hidden" name="id" value="${escapeAttr(a.id)}"><input type="hidden" name="active" value="${a.active ? "0" : "1"}"><button class="btn ghost" style="font-size:11px" type="submit">${a.active ? "Disable" : "Enable"}</button></form></td></tr>`).join("")
    : `<tr><td colspan="2" class="muted" style="padding:8px 6px">No addresses yet — add one below (e.g. sales@${escapeHtml(site.domain)}).</td></tr>`

  const providerCards = MAIL_PROVIDERS.map((p) => `<option value="${p}" ${site.mail_provider === p ? "selected" : ""}>${MAIL_PROVIDER_LABELS[p]}</option>`).join("")
  const body = `
    ${notice ? `<div class="card" style="border-color:#166534;background:#052e16"><p style="margin:0;color:#86efac;font-size:13px">${escapeHtml(notice)}</p></div>` : ""}
    ${err ? `<div class="card" style="border-color:#7f1d1d;background:#1c1212"><p style="margin:0;color:#fca5a5;font-size:13px">${escapeHtml(err)}</p></div>` : ""}
    <div class="card"><p><a href="/app/sites/${escapeAttr(site.id)}/mailbox" style="color:#93c5fd">← Mailbox</a></p>
      <h2 style="margin:0 0 4px;font-size:16px">Mailbox setup</h2>
      <p class="muted" style="font-size:13px">Cloudflare Email Routing <strong>receives</strong> your mail; a connected provider <strong>sends</strong> replies. Receiving is enabled during provisioning (MX records on your domain); sending needs a provider key on a verified domain.</p>
    </div>
    <div class="card">
      <h3 style="margin:0 0 6px;font-size:14px">Addresses</h3>
      <table style="width:100%;border-collapse:collapse"><tbody>${addrRows}</tbody></table>
      <form method="post" action="/app/sites/${escapeAttr(site.id)}/mailbox/addresses/add" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <input name="local" placeholder="sales" style="${IN};max-width:140px" required>
        <span style="color:#9ca3af;align-self:center">@${escapeHtml(site.domain)}</span>
        <input name="label" placeholder="Label (optional)" style="${IN};max-width:160px">
        <button class="btn ghost" style="font-size:12px" type="submit">Add address</button>
      </form>
      <p class="muted" style="font-size:11px;margin:8px 0 0">Adding an address creates a routing rule on your domain (best-effort; takes effect once Email Routing is live).</p>
    </div>
    <div class="card">
      <h3 style="margin:0 0 6px;font-size:14px">Sending provider ${providerReady ? '<span style="color:#4ade80;font-size:12px">● connected</span>' : ""}</h3>
      <p class="muted" style="font-size:12px">Pick a provider and paste its API key — it's encrypted and used only to send your replies. The from-address must be on a domain verified in that provider.</p>
      <form method="post" action="/app/sites/${escapeAttr(site.id)}/mailbox/provider" style="margin-top:8px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <select name="provider" style="${IN};max-width:160px">${providerCards}</select>
          <input name="from_name" value="${escapeAttr(site.mail_from_name ?? "")}" placeholder="From name (e.g. Acme Support)" style="${IN};max-width:220px">
        </div>
        <input name="api_key" type="password" placeholder="Paste API key (leave blank to keep current)" style="${IN};margin-top:6px" autocomplete="off">
        <div style="margin-top:8px"><button class="btn" type="submit">Save &amp; verify</button></div>
      </form>
    </div>`
  return c.html(renderSaasLayout({ title: "Mailbox setup", active: "sites", customer, bodyHtml: body }), 200, NO_STORE)
}

export async function mailAddressAddHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  const to = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/mailbox/setup?${q}` } })
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    const local = String(form.local || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "")
    if (!local) return to("error=" + encodeURIComponent("Enter a valid mailbox name."))
    const ok = await addAddress(master, site.cms_site_id, `${local}@${site.domain}`, String(form.label || ""))
    await audit(master, customer.id, "site.mail_address_added", site.domain, { address: `${local}@${site.domain}` }).catch(() => {})
    return to(ok ? "done=" + encodeURIComponent("Address added.") : "error=" + encodeURIComponent("That address already exists."))
  }
  return to("error=" + encodeURIComponent("Site not ready."))
}

export async function mailAddressToggleHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  if (site?.cms_site_id) {
    const form = await c.req.parseBody()
    await setAddressActive(master, site.cms_site_id, String(form.id), String(form.active) === "1")
  }
  return new Response(null, { status: 302, headers: { Location: `/app/sites/${site?.id}/mailbox/setup?done=${encodeURIComponent("Updated.")}` } })
}

export async function mailProviderHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const site = await loadMailSite(c, master, customer.id)
  if (!site) return new Response(null, { status: 302, headers: { Location: "/app/sites" } })
  const to = (q: string) => new Response(null, { status: 302, headers: { Location: `/app/sites/${site.id}/mailbox/setup?${q}` } })
  const form = await c.req.parseBody()
  const provider = String(form.provider || "")
  if (!isMailProvider(provider)) return to("error=" + encodeURIComponent("Pick a provider."))
  const fromName = String(form.from_name || "").trim().slice(0, 80)
  const apiKey = String(form.api_key || "").trim()
  const vaultKey = c.env.VAULT_MASTER_KEY
  if (!vaultKey) return to("error=" + encodeURIComponent("Server vault key not configured."))

  // Keep existing key if the field is blank (edit from-name only).
  let secretEnc = site.mail_provider_secret_enc
  let keyToVerify: string | null = null
  if (apiKey) {
    secretEnc = await vaultEncrypt(vaultKey, site.customer_id, apiKey)
    keyToVerify = apiKey
  } else if (secretEnc) {
    try { keyToVerify = await vaultDecrypt(vaultKey, site.customer_id, secretEnc) } catch { keyToVerify = null }
  }
  if (!secretEnc || !keyToVerify) return to("error=" + encodeURIComponent("Paste your provider API key."))

  const status = await providerStatus(provider, keyToVerify)
  await master.execute({
    sql: "UPDATE customer_sites SET mail_provider = ?, mail_provider_secret_enc = ?, mail_provider_status = ?, mail_from_name = ? WHERE id = ?",
    args: [provider, secretEnc, status.ok ? "active" : "error", fromName || null, site.id],
  }).catch(() => {})
  await audit(master, customer.id, "site.mail_provider_saved", site.domain, { provider, ok: status.ok }).catch(() => {})
  return to(status.ok ? "done=" + encodeURIComponent(`${MAIL_PROVIDER_LABELS[provider]} connected.`) : "error=" + encodeURIComponent(status.error || "Key didn't verify."))
}

/** Unread badge for the site nav (mirrors the forms Inbox badge). */
export { countUnread as mailboxUnread } from "./service"
