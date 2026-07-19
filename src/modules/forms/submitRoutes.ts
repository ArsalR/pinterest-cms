// src/modules/forms/submitRoutes.ts
// PUBLIC submission pipeline (V1.4 F1): static customer sites POST here (plain
// HTML navigation, no CORS). Pipeline: rate-limit → honeypot → Turnstile →
// validate against the STORED definition (the same one the HTML was rendered
// from) → file uploads to R2 (closed type allowlist, magic-byte-checked,
// unguessable keys) → store (country only, never raw IP) → notify owner →
// acknowledgment to the SUBMITTER ONLY (address from the submission's own
// email field — no arbitrary recipients, no spam relay).

import { Hono } from "hono"
import type { AppEnv } from "../../lib/types"
import { saasActive } from "../auth"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { allowRate, clientIp } from "../../shared/rateLimit"
import { vaultDecrypt } from "../vault"
import { verifyTurnstileToken } from "../connections"
import { sendEmail } from "../customers"
import { uploadToR2 } from "../../lib/r2"
import { escapeHtml, cuid } from "../../lib/utils"
import {
  validateSubmission, submitterEmail, renderAckTemplate,
  HONEYPOT_FIELD, UPLOAD_ALLOWED, UPLOAD_MAX_BYTES,
} from "./model"
import { getActiveForm, storeSubmission } from "./service"
import { formsFromAddress } from "./domainRoutes"

export const formSubmitRoutes = new Hono<AppEnv>()

function sniffUploadMime(bytes: Uint8Array): string | null {
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg"
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes.length > 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif"
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  if (bytes.length > 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf"
  return null
}

formSubmitRoutes.post("/:siteId/:formId", async (c, next) => {
  if (!saasActive(c)) return next()

  const siteId = c.req.param("siteId") ?? ""
  const formId = c.req.param("formId") ?? ""
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)

  const siteRow = await db.execute({
    sql: `SELECT cs.id, cs.domain, cs.canonical_host, cs.customer_id, cs.cms_site_id, cs.name,
                 cs.forms_domain, cs.forms_domain_status, c.email AS owner_email
          FROM customer_sites cs JOIN customers c ON c.id = cs.customer_id
          WHERE cs.id = ? LIMIT 1`,
    args: [siteId],
  })
  if (!siteRow.rows.length) return c.text("Unknown site", 404)
  const site = siteRow.rows[0] as unknown as {
    id: string; domain: string; canonical_host: string; customer_id: string
    cms_site_id: string | null; name: string; owner_email: string
    forms_domain: string | null; forms_domain_status: string | null
  }
  const host = site.canonical_host === "www" ? `www.${site.domain}` : site.domain

  // Redirect target: the page the form was on (same-site path only), else home.
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.text("Bad request", 400)
  }
  const rawPage = String(form.get("_page") || "/")
  const page = /^\/[a-z0-9\-/_.]*$/i.test(rawPage) ? rawPage : "/"
  const sep = page.includes("?") ? "&" : "?"
  const redirect = (ok: boolean) =>
    new Response(null, { status: 303, headers: { Location: `https://${host}${page}${sep}sent=${ok ? "1" : "0"}` } })

  // Rate limits (existing pattern): per IP per form + per site overall.
  const ip = clientIp(c.req.raw)
  const ipOk = await allowRate(db, `formsub:${formId}:ip:${ip}`, { max: 5, windowSecs: 3600 })
  const siteOk = await allowRate(db, `formsub:${siteId}:all`, { max: 100, windowSecs: 3600 })
  if (!ipOk || !siteOk) return redirect(false)

  // Honeypot: any value = bot. Pretend success (don't teach the bot).
  if (String(form.get(HONEYPOT_FIELD) || "")) return redirect(true)

  // Turnstile (per-site secret, existing vault pattern).
  const token = String(form.get("cf-turnstile-response") || "")
  const ts = await db.execute({ sql: "SELECT secret_enc FROM site_turnstile WHERE customer_site_id = ? LIMIT 1", args: [siteId] })
  if (!ts.rows.length || !c.env.VAULT_MASTER_KEY || !token) return redirect(false)
  let secret: string
  try {
    secret = await vaultDecrypt(c.env.VAULT_MASTER_KEY, site.customer_id, ts.rows[0].secret_enc as string)
  } catch {
    return redirect(false)
  }
  if (!(await verifyTurnstileToken(secret, token, ip))) return redirect(false)

  // Load the STORED definition and validate against it (one schema, two surfaces).
  if (!site.cms_site_id) return redirect(false)
  const reg = await db.execute({ sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1", args: [site.cms_site_id] })
  if (!reg.rows.length) return redirect(false)
  const siteDb = getSiteDb(String(reg.rows[0].turso_url), String(reg.rows[0].turso_token))
  const def = await getActiveForm(siteDb, formId)
  if (!def) return c.text("Unknown form", 404)

  const raw: Record<string, string> = {}
  for (const d of def.fields) {
    if (d.type === "file") continue
    const v = form.get(d.key)
    if (typeof v === "string") raw[d.key] = v
  }
  const result = validateSubmission(def.fields, raw)
  if (!result.ok) return redirect(false)

  // File uploads: closed allowlist, magic-byte-sniffed, size-capped,
  // unguessable R2 keys (cuid + no original filename in the key).
  for (const d of def.fields) {
    if (d.type !== "file") continue
    const f = form.get(d.key)
    if (!(f instanceof File) || f.size === 0) {
      if (d.required) return redirect(false)
      continue
    }
    if (f.size > UPLOAD_MAX_BYTES) return redirect(false)
    const bytes = new Uint8Array(await f.arrayBuffer())
    const mime = sniffUploadMime(bytes)
    if (!mime || !(UPLOAD_ALLOWED as readonly string[]).includes(mime)) return redirect(false)
    const ext = mime === "application/pdf" ? "pdf" : mime.split("/")[1]
    const { url } = await uploadToR2(c.env, `${host}/form-uploads`, `${cuid()}.${ext}`, bytes.buffer as ArrayBuffer, mime)
    result.values[d.key] = url
  }

  // Store: page + IP-derived country ONLY (spec: no raw IP retention).
  const country = (c.req.raw as { cf?: { country?: string } }).cf?.country ?? c.req.header("cf-ipcountry") ?? null
  const submissionId = await storeSubmission(siteDb, formId, result.values, page, country ? String(country).slice(0, 2) : null)

  // Notify owner + acknowledge submitter — fire-and-forget.
  const fieldsHtml = def.fields
    .filter((d) => result.values[d.key])
    .map((d) => `<p><strong>${escapeHtml(d.label)}:</strong> ${escapeHtml(result.values[d.key]).replace(/\n/g, "<br>")}</p>`)
    .join("")
  c.executionCtx.waitUntil(
    (async () => {
      await sendEmail(c.env, {
        to: site.owner_email,
        from: "SiteNetwork Forms <forms@arsal.app>",
        subject: `${def.title}: new submission — ${site.domain}`,
        html: `${fieldsHtml}<hr><p>Form: ${escapeHtml(def.title)} · Page: ${escapeHtml(page)} · ${escapeHtml(String(country ?? ""))}</p>
               <p><a href="https://${c.env.SAAS_APP_HOSTNAME || "arsal.app"}/app/sites/${site.id}/inbox">Open in your inbox</a></p>`,
      }).catch(() => {})
      if (def.ackEnabled) {
        const to = submitterEmail(def.fields, result.values)
        if (to) {
          const extra = { site_name: site.name, form_title: def.title, submission_id: submissionId }
          await sendEmail(c.env, {
            to,
            from: formsFromAddress(site.name, site.forms_domain, site.forms_domain_status),
            replyTo: site.owner_email,
            subject: renderAckTemplate(def.ackSubject || "We received your message — {{site_name}}", result.values, extra).replace(/<[^>]+>/g, ""),
            html: renderAckTemplate(def.ackBody || "<p>Thanks — we received your submission and will reply soon.</p>", result.values, extra),
          }).catch(() => {})
        }
      }
    })()
  )
  return redirect(true)
})
