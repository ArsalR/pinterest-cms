// src/modules/forms/hooks.ts
// Automation hooks (V1.4 F3): per-form outbound webhooks (the CRM/n8n/Make/
// Zapier integration — one URL, infinite automations), HMAC-signed with the
// SAME signature scheme as the existing content webhooks
// (X-Webhook-Signature: sha256=<hmac>), retried via the existing per-site
// webhook_deliveries machinery. Plus CTA block builders (pure HTML) and the
// newsletter double-opt-in pipeline.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { sendEmail } from "../customers"
import { formsFromAddress } from "./model"

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")
}

export interface HookDelivery {
  ok: boolean
  status: number | null
}

/** Fire a form's outbound webhook once (no retry here — the delivery log +
 *  the existing retry cron handle failures). Logged in webhook_deliveries
 *  with a synthetic endpoint id `form:<formId>` so the per-form log is
 *  queryable without new tables. */
export async function fireFormWebhook(
  siteDb: Client,
  form: { id: string; title: string; webhookUrl: string; webhookSecret: string },
  submission: { id: string; fields: Record<string, string>; page: string | null; country: string | null; createdAt?: string },
  domain: string
): Promise<HookDelivery> {
  if (!form.webhookUrl || !/^https:\/\/\S+$/.test(form.webhookUrl)) return { ok: false, status: null }
  const payload = JSON.stringify({
    event: "form.submission",
    form: { id: form.id, title: form.title },
    site: domain,
    submission: { id: submission.id, fields: submission.fields, page: submission.page, country: submission.country },
  })
  let status: number | null = null
  let ok = false
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (form.webhookSecret) headers["X-Webhook-Signature"] = `sha256=${await hmacHex(form.webhookSecret, payload)}`
    const resp = await fetch(form.webhookUrl, { method: "POST", headers, body: payload })
    status = resp.status
    ok = resp.ok
  } catch {
    ok = false
  }
  // Delivery log row (visible per form in the dashboard). Failed rows carry
  // next_retry_at so the EXISTING per-site retry cron re-fires them.
  await siteDb.execute({
    sql: `INSERT INTO webhook_deliveries (id, endpoint_id, event, payload, status, response_status, next_retry_at, delivered_at)
          VALUES (?, ?, 'form.submission', ?, ?, ?, ?, ?)`,
    args: [
      cuid(), `form:${form.id}`, payload,
      ok ? "delivered" : "failed", status,
      ok ? null : new Date(Date.now() + 5 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19),
      ok ? new Date().toISOString().replace("T", " ").slice(0, 19) : null,
    ],
  }).catch(() => {})
  return { ok, status }
}

/** Per-form delivery log (newest first). */
export async function formWebhookLog(siteDb: Client, formId: string, limit = 20): Promise<Array<{ at: string; status: string; httpStatus: number | null }>> {
  const r = await siteDb.execute({
    sql: `SELECT created_at, status, response_status FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [`form:${formId}`, limit],
  }).catch(() => null)
  return (r?.rows ?? []).map((row) => ({
    at: String(row.created_at ?? ""),
    status: String(row.status ?? ""),
    httpStatus: row.response_status == null ? null : Number(row.response_status),
  }))
}

// ─────────────────────── CTA blocks (pure HTML builders) ───────────────────────
// All pure HTML/CSS, token-styled — usable in post content or rendered by the
// template from markers. Zero JS.

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c)
}
const BTN = 'display:inline-block;background:var(--accent);color:#fff;text-decoration:none;border-radius:8px;padding:0.7rem 1.4rem;font-weight:600'

export const CTA_KINDS = ["whatsapp", "call", "email", "book", "download", "subscribe"] as const
export type CtaKind = (typeof CTA_KINDS)[number]

/** Build one CTA block. `value` semantics per kind (phone/url/email/form slug). Pure. */
export function ctaBlockHtml(kind: CtaKind, value: string, label?: string, prefill?: string): string {
  const v = value.trim()
  switch (kind) {
    case "whatsapp": {
      const phone = v.replace(/[^\d]/g, "")
      const url = `https://wa.me/${phone}${prefill ? `?text=${encodeURIComponent(prefill)}` : ""}`
      return `<p class="cta cta-whatsapp"><a href="${esc(url)}" rel="noopener" style="${BTN};background:#25d366">${esc(label ?? "Chat on WhatsApp")}</a></p>`
    }
    case "call":
      return `<p class="cta cta-call"><a href="tel:${esc(v.replace(/\s+/g, ""))}" style="${BTN}">${esc(label ?? "Call now")}</a></p>`
    case "email":
      return `<p class="cta cta-email"><a href="mailto:${esc(v)}" style="${BTN}">${esc(label ?? "Email us")}</a></p>`
    case "book":
      // External scheduling link-out (Cal.com / Calendly) — no embed, no JS.
      return `<p class="cta cta-book"><a href="${esc(v)}" rel="noopener" style="${BTN}">${esc(label ?? "Book a time")}</a></p>`
    case "download":
      // Lead magnet: link to the gating form page; the acknowledgment email
      // carries the file link (configured as {{download_link}} in the ack).
      return `<p class="cta cta-download"><a href="/forms/${esc(v)}/" style="${BTN}">${esc(label ?? "Get the download")}</a></p>`
    case "subscribe":
      return `<p class="cta cta-subscribe"><a href="/forms/${esc(v)}/" style="${BTN}">${esc(label ?? "Subscribe")}</a></p>`
  }
}

/** Replace <div class="cta-block" data-cta="kind" data-value=".." data-label=".."
 *  data-prefill=".."></div> markers in content. No markers = untouched. Pure. */
export function injectCtaBlocks(html: string): string {
  if (!html.includes("cta-block")) return html
  return html.replace(
    /<div class="cta-block" data-cta="([a-z]+)"([^>]*)><\/div>/gi,
    (m, kind: string, attrs: string) => {
      if (!(CTA_KINDS as readonly string[]).includes(kind)) return ""
      const attr = (name: string) => {
        const mm = new RegExp(`data-${name}="([^"]*)"`, "i").exec(attrs)
        return mm ? mm[1] : ""
      }
      return ctaBlockHtml(kind as CtaKind, attr("value"), attr("label") || undefined, attr("prefill") || undefined)
    }
  )
}

// ─────────────────────── newsletter (double-opt-in) ───────────────────────

/** Store a pending subscriber + send the confirmation email. Legally-safer
 *  double-opt-in default. Idempotent on the email. */
export async function subscribePending(
  env: CloudflareEnv, siteDb: Client, email: string,
  site: { id: string; name: string; formsDomain: string | null; formsDomainStatus: string | null },
  saasHost: string
): Promise<boolean> {
  const token = cuid() + cuid()
  await siteDb.execute({
    sql: `INSERT INTO subscribers (id, email, confirmed, confirm_token, unsubscribed)
          VALUES (?, ?, 0, ?, 0)
          ON CONFLICT(email) DO UPDATE SET confirm_token = CASE WHEN subscribers.confirmed = 0 THEN excluded.confirm_token ELSE subscribers.confirm_token END,
                                            unsubscribed = 0`,
    args: [cuid(), email.toLowerCase(), token],
  })
  const row = await siteDb.execute({ sql: "SELECT confirmed, confirm_token FROM subscribers WHERE email = ? LIMIT 1", args: [email.toLowerCase()] })
  if (!row.rows.length || Number(row.rows[0].confirmed) === 1) return true // already confirmed — nothing to send
  const confirmLink = `https://${saasHost}/api/saas/newsletter/${site.id}/confirm?t=${String(row.rows[0].confirm_token)}`
  return sendEmail(env, {
    to: email,
    from: formsFromAddress(site.name, site.formsDomain, site.formsDomainStatus),
    subject: `Confirm your subscription — ${site.name}`,
    html: `<p>One more step: confirm you want emails from ${site.name}.</p><p><a href="${confirmLink}">Confirm subscription</a></p><p style="color:#737373;font-size:12px">Didn't sign up? Ignore this and nothing happens.</p>`,
  })
}

export async function confirmSubscriber(siteDb: Client, token: string): Promise<boolean> {
  if (!token || token.length < 20) return false
  const r = await siteDb.execute({
    sql: "UPDATE subscribers SET confirmed = 1, confirm_token = NULL WHERE confirm_token = ?",
    args: [token],
  }).catch(() => null)
  return !!r && Number(r.rowsAffected) > 0
}

/** Unsubscribe by email token (the same confirm_token slot reused post-confirm
 *  would be gone — use the email directly signed? Simplest honored contract:
 *  unsubscribe links carry the subscriber id.) */
export async function unsubscribe(siteDb: Client, subscriberId: string): Promise<boolean> {
  const r = await siteDb.execute({ sql: "UPDATE subscribers SET unsubscribed = 1 WHERE id = ?", args: [subscriberId] }).catch(() => null)
  return !!r && Number(r.rowsAffected) > 0
}

export async function listSubscribers(siteDb: Client): Promise<Array<{ id: string; email: string; confirmed: boolean; unsubscribed: boolean; createdAt: string }>> {
  const r = await siteDb.execute({ sql: "SELECT * FROM subscribers ORDER BY created_at DESC LIMIT 5000", args: [] }).catch(() => null)
  return (r?.rows ?? []).map((row) => ({
    id: String(row.id),
    email: String(row.email),
    confirmed: Number(row.confirmed) === 1,
    unsubscribed: Number(row.unsubscribed) === 1,
    createdAt: String(row.created_at ?? ""),
  }))
}

/** Subscribers CSV (confirmed, not unsubscribed — the exportable list). Pure once loaded. */
export function subscribersToCsv(subs: Array<{ email: string; confirmed: boolean; unsubscribed: boolean; createdAt: string }>): string {
  const lines = ["email,confirmed,subscribed_at"]
  for (const s of subs) {
    if (s.unsubscribed) continue
    lines.push(`${s.email},${s.confirmed ? "yes" : "pending"},${s.createdAt}`)
  }
  return lines.join("\n") + "\n"
}
