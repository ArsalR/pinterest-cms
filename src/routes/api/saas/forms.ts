// src/routes/api/saas/forms.ts
// Contact-form relay (K1): customer sites are fully static, so their contact
// forms POST here (plain HTML navigation — no CORS needed). Turnstile-verified
// against the per-site secret, rate-limited, then emailed to the site owner
// via Resend. Redirects back to the site's contact page either way.

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { saasActive } from "../../../middleware/saasAuthMiddleware"
import { getMasterDb } from "../../../lib/turso"
import { ensureMasterSchema } from "../../../lib/masterMigrate"
import { vaultDecrypt } from "../../../lib/saas/vault"
import { verifyTurnstileToken } from "../../../lib/saas/cloudflare"
import { sendEmail } from "../../../lib/saas/email"
import { allowRate, clientIp } from "../../../lib/saas/rateLimit"
import { escapeHtml } from "../../../lib/utils"

export const saasFormsRoutes = new Hono<AppEnv>()

saasFormsRoutes.post("/:siteId", async (c, next) => {
  if (!saasActive(c)) return next()

  const siteId = c.req.param("siteId") ?? ""
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)

  const siteRow = await db.execute({
    sql: `SELECT cs.id, cs.domain, cs.canonical_host, cs.customer_id, c.email AS owner_email
          FROM customer_sites cs JOIN customers c ON c.id = cs.customer_id
          WHERE cs.id = ? LIMIT 1`,
    args: [siteId],
  })
  if (!siteRow.rows.length) return c.text("Unknown site", 404)
  const site = siteRow.rows[0] as unknown as {
    id: string; domain: string; canonical_host: string; customer_id: string; owner_email: string
  }
  const host = site.canonical_host === "www" ? `www.${site.domain}` : site.domain
  const backOk = `https://${host}/contact/?sent=1`
  const backFail = `https://${host}/contact/?sent=0`
  const redirect = (to: string) => new Response(null, { status: 303, headers: { Location: to } })

  // Rate limits: per site per IP (bursty spam) and per site overall (bombing).
  const ip = clientIp(c.req.raw)
  const ipOk = await allowRate(db, `form:${siteId}:ip:${ip}`, { max: 5, windowSecs: 3600 })
  const siteOk = await allowRate(db, `form:${siteId}:all`, { max: 50, windowSecs: 3600 })
  if (!ipOk || !siteOk) return redirect(backFail)

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return redirect(backFail)
  }
  const email = String(form.get("email") || "").trim().slice(0, 254)
  const message = String(form.get("message") || "").trim().slice(0, 4000)
  const turnstileToken = String(form.get("cf-turnstile-response") || "")
  if (!email || !message || !turnstileToken) return redirect(backFail)

  // Verify Turnstile against the per-site secret.
  const ts = await db.execute({
    sql: "SELECT secret_enc FROM site_turnstile WHERE customer_site_id = ? LIMIT 1",
    args: [siteId],
  })
  if (!ts.rows.length || !c.env.VAULT_MASTER_KEY) return redirect(backFail)
  let secret: string
  try {
    secret = await vaultDecrypt(c.env.VAULT_MASTER_KEY, site.customer_id, ts.rows[0].secret_enc as string)
  } catch {
    return redirect(backFail)
  }
  if (!(await verifyTurnstileToken(secret, turnstileToken, ip))) return redirect(backFail)

  // Relay to the owner (fire-and-forget; visitor already gets the success page).
  c.executionCtx.waitUntil(
    sendEmail(c.env, {
      to: site.owner_email,
      from: "SiteNetwork Forms <forms@arsal.app>",
      subject: `Contact form: ${site.domain}`,
      html: `<p><strong>From:</strong> ${escapeHtml(email)}</p>
             <p><strong>Site:</strong> ${escapeHtml(site.domain)}</p>
             <hr><p>${escapeHtml(message).replace(/\n/g, "<br>")}</p>`,
    })
  )
  return redirect(backOk)
})
