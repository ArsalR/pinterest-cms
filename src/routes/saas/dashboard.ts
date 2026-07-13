// src/routes/saas/dashboard.ts
// /app — dashboard shell (Phase 1). Sites/connections pages arrive in
// Phases 2–3; the shell shows account state + trial status + verify banner.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { escapeHtml } from "../../lib/utils"
import { renderSaasLayout } from "../../views/saas/Layout"
import { planGate, type Customer } from "../../lib/saas/customers"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../lib/masterMigrate"
import { issueToken, audit } from "../../lib/saas/customers"
import { sendEmail, verificationEmailHtml } from "../../lib/saas/email"
import { allowRate, AUTH_LIMITS } from "../../lib/saas/rateLimit"

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

export async function saasHomeHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const gate = planGate(customer, nowSqlite())

  let banner: string | undefined
  if (!customer.email_verified) {
    banner = `Please verify your email — check your inbox.
      <form method="POST" action="/app/resend-verification" style="display:inline;margin-left:8px">
        <button type="submit" style="background:none;border:none;color:#fcd34d;text-decoration:underline;cursor:pointer;font:inherit;padding:0">Resend link</button>
      </form>`
  } else if (gate === "read_only") {
    banner = `Your trial has ended. Your sites are still live on your own infrastructure — nothing was taken down — but publishing and edits are paused until you subscribe.`
  }

  const trialLine =
    customer.plan_status === "trialing" && customer.trial_ends_at
      ? `<p class="muted">Trial ends ${escapeHtml(customer.trial_ends_at)} UTC.</p>`
      : ""

  const body = `
    <div class="card">
      <h2 style="margin:0 0 8px;font-size:16px">Welcome${customer.name ? ", " + escapeHtml(customer.name) : ""}</h2>
      <p class="muted">Plan: ${escapeHtml(customer.plan)} · Status: ${escapeHtml(customer.plan_status)}</p>
      ${trialLine}
    </div>
    <div class="card">
      <h2 style="margin:0 0 8px;font-size:16px">Get started</h2>
      <p class="muted">Connect your GitHub and Cloudflare accounts, then add your first site. The connections wizard arrives with the next platform update.</p>
      <a class="btn ghost" href="/app/connections">Connections</a>
    </div>
  `

  return c.html(
    renderSaasLayout({ title: "Overview", active: "home", customer, bodyHtml: body, banner }),
    200,
    { "Cache-Control": "no-store, private" }
  )
}

export async function resendVerificationHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  if (!customer.email_verified) {
    try {
      const db = getMasterDb(c.env)
      await ensureMasterSchema(db)
      if (!(await allowRate(db, `resend:customer:${customer.id}`, AUTH_LIMITS.resendVerification))) {
        return new Response(null, { status: 302, headers: { Location: "/app" } })
      }
      const token = await issueToken(db, customer.id, "verify")
      await audit(db, customer.id, "customer.verification_resent")
      c.executionCtx.waitUntil(
        sendEmail(c.env, {
          to: customer.email,
          subject: "Verify your email",
          html: verificationEmailHtml(`https://${c.get("hostname")}/app/verify?token=${token}`),
        })
      )
    } catch (err) {
      console.error("resend-verification failed:", err instanceof Error ? err.message : err)
    }
  }
  return new Response(null, { status: 302, headers: { Location: "/app" } })
}

/** Placeholder pages for nav targets that land in Phases 2–3. */
export function saasStubHandler(title: string, active: string, message: string) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const customer = c.get("customer") as Customer
    return c.html(
      renderSaasLayout({
        title,
        active,
        customer,
        bodyHtml: `<div class="card"><p class="muted">${escapeHtml(message)}</p></div>`,
      }),
      200,
      { "Cache-Control": "no-store, private" }
    )
  }
}
