// src/modules/billing/routes.ts
// Platform billing UI + webhook. The billing page shows the two tiers with the
// customer's live plan state; checkout/portal redirect to Stripe-hosted pages
// (we never touch card data). The webhook is the ONLY writer of plan state —
// success redirects show "activating…" rather than trusting the query string.

import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { renderSaasLayout } from "../../shared"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { saasActive } from "../auth"
import { audit, planGate, type Customer } from "../customers"
import { verifyStripeSignature } from "../ecommerce"
import { planCatalog, isPlanId, formatUsd, eventToPlanUpdate } from "./plans"
import { billingConfigured, createSubscriptionCheckout, createPortalSession } from "./stripeBilling"

const NO_STORE = { "Cache-Control": "no-store, private" }

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

function nowSqlite(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19)
}

function back(params: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: { Location: `/app/billing?${new URLSearchParams(params)}` } })
}

// ─────────────────────── billing page ───────────────────────

export async function billingPageHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  const master = await masterDb(c)
  const url = new URL(c.req.url)
  const done = url.searchParams.get("done")
  const error = url.searchParams.get("error")

  const row = await master.execute({
    sql: "SELECT stripe_customer_id FROM customers WHERE id = ? LIMIT 1",
    args: [customer.id],
  })
  const stripeCustomerId = (row.rows[0]?.stripe_customer_id as string | null) ?? null

  const gate = planGate(customer, nowSqlite())
  const statusLine =
    customer.plan_status === "active"
      ? `You're on the <strong>${escapeHtml(customer.plan)}</strong> plan.`
      : customer.plan_status === "trialing"
        ? gate === "active"
          ? `Free trial — ends ${escapeHtml(customer.trial_ends_at ?? "")} UTC. Subscribe below to keep publishing after that.`
          : `Your trial has ended. Your sites stay live on your own infrastructure; subscribe to resume publishing and edits.`
        : `Your subscription is <strong>${escapeHtml(customer.plan_status)}</strong> — update billing below to resume.`

  const cards = planCatalog(c.env)
    .map((p) => {
      const isCurrent = customer.plan === p.id && customer.plan_status === "active"
      const cta = isCurrent
        ? `<span class="chip" style="background:rgba(34,197,94,.15);color:#86efac;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;border-radius:999px;padding:4px 12px">Current plan</span>`
        : billingConfigured(c.env)
          ? `<form method="POST" action="/app/billing/checkout" style="margin:0">
               <input type="hidden" name="plan" value="${escapeAttr(p.id)}">
               <button class="btn" type="submit">${customer.plan_status === "active" ? "Switch to" : "Choose"} ${escapeHtml(p.label)}</button>
             </form>`
          : `<p class="muted" style="font-size:12px;margin:0">Billing opens soon — your trial keeps running meanwhile.</p>`
      return `<div class="card" style="flex:1;min-width:240px">
        <h3 style="margin:0;font-size:16px">${escapeHtml(p.label)}</h3>
        <div style="font-size:28px;font-weight:700;margin:6px 0 2px">${formatUsd(p.amountCents)}<span class="muted" style="font-size:13px;font-weight:400">/month</span></div>
        <p class="muted" style="font-size:13px;margin:0 0 12px">${escapeHtml(p.blurb)}</p>
        <ul style="margin:0 0 16px;padding-left:18px">${p.features.map((f) => `<li style="font-size:13px;color:#d4d4d4;margin:3px 0">${escapeHtml(f)}</li>`).join("")}</ul>
        ${cta}
      </div>`
    })
    .join("")

  const portal =
    stripeCustomerId && billingConfigured(c.env)
      ? `<div class="card"><p class="muted" style="font-size:13px;margin:0 0 10px">Update your card, switch plans, download invoices, or cancel — all in the secure Stripe portal.</p>
          <form method="POST" action="/app/billing/portal" style="margin:0"><button class="btn ghost" type="submit">Manage billing</button></form></div>`
      : ""

  const body = `
    ${done === "success" ? `<div class="banner" style="border-color:#14532d;color:#86efac;background:#0f1a14">Payment received — your plan activates within a few seconds (refresh if you don't see it yet).</div>` : ""}
    ${done === "canceled" ? `<div class="banner">Checkout canceled — nothing was charged.</div>` : ""}
    ${error ? `<div class="banner" style="border-color:#7f1d1d;color:#fca5a5;background:#1c1212">${escapeHtml(error)}</div>` : ""}
    <div class="card"><p style="margin:0;font-size:14px">${statusLine}</p></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">${cards}</div>
    ${portal}`
  return c.html(renderSaasLayout({ title: "Billing", active: "billing", customer, bodyHtml: body }), 200, NO_STORE)
}

// ─────────────────────── checkout + portal redirects ───────────────────────

export async function billingCheckoutHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  if (!billingConfigured(c.env)) return back({ error: "Billing isn't open yet — your trial keeps running meanwhile." })

  let form: FormData
  try { form = await c.req.formData() } catch { return back({ error: "That didn't come through — try again." }) }
  const planRaw = String(form.get("plan") || "")
  const plan = planCatalog(c.env).find((p) => p.id === planRaw && isPlanId(planRaw))
  if (!plan) return back({ error: "Pick a plan." })

  const base = `https://${c.env.SAAS_APP_HOSTNAME || "arsal.app"}/app/billing`
  const r = await createSubscriptionCheckout(c.env, {
    plan,
    customerId: customer.id,
    customerEmail: customer.email,
    successUrl: `${base}?done=success`,
    cancelUrl: `${base}?done=canceled`,
  })
  if (!r.url) return back({ error: r.error ?? "Couldn't start checkout — please try again." })
  const master = await masterDb(c)
  await audit(master, customer.id, "billing.checkout_started", plan.id).catch(() => {})
  return new Response(null, { status: 302, headers: { Location: r.url } })
}

export async function billingPortalHandler(c: Context<AppEnv>): Promise<Response> {
  const customer = c.get("customer") as Customer
  if (!billingConfigured(c.env)) return back({ error: "Billing isn't open yet." })
  const master = await masterDb(c)
  const row = await master.execute({ sql: "SELECT stripe_customer_id FROM customers WHERE id = ? LIMIT 1", args: [customer.id] })
  const stripeCustomerId = (row.rows[0]?.stripe_customer_id as string | null) ?? null
  if (!stripeCustomerId) return back({ error: "No billing account yet — choose a plan first." })
  const r = await createPortalSession(c.env, stripeCustomerId, `https://${c.env.SAAS_APP_HOSTNAME || "arsal.app"}/app/billing`)
  if (!r.url) return back({ error: r.error ?? "Couldn't open the billing portal — please try again." })
  return new Response(null, { status: 302, headers: { Location: r.url } })
}

// ─────────────────────── webhook (the only plan-state writer) ───────────────────────

export const platformBillingWebhookRoutes = new Hono<AppEnv>()

platformBillingWebhookRoutes.post("/", async (c, next) => {
  if (!saasActive(c)) return next()
  const secret = c.env.PLATFORM_STRIPE_WEBHOOK_SECRET
  if (!secret) return c.json({ error: "Billing not configured", code: "not_found" }, 404)

  const rawBody = await c.req.text()
  const sig = c.req.header("stripe-signature") ?? ""
  if (!(await verifyStripeSignature(rawBody, sig, secret))) {
    return c.json({ error: "Bad signature", code: "unauthorized" }, 401)
  }

  let event: { type: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ error: "Bad payload", code: "validation_error" }, 400)
  }

  const mapped = eventToPlanUpdate(event)
  if (!mapped) return c.json({ received: true }) // not a billing event we act on

  const master = await masterDb(c)
  const { customerId, update } = mapped

  // Resolve the customer: checkout events carry our customerId in metadata;
  // subscription lifecycle events are matched by stripe_subscription_id.
  let id = customerId
  if (!id && update.stripeSubscriptionId) {
    const r = await master.execute({
      sql: "SELECT id FROM customers WHERE stripe_subscription_id = ? LIMIT 1",
      args: [update.stripeSubscriptionId],
    })
    id = r.rows.length ? String(r.rows[0].id) : null
  }
  if (!id) return c.json({ received: true }) // unknown subject — ack, don't retry-loop

  await master.execute({
    sql: `UPDATE customers SET
            plan_status = ?,
            plan = COALESCE(?, plan),
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = COALESCE(?, stripe_subscription_id)
          WHERE id = ?`,
    args: [update.planStatus, update.plan ?? null, update.stripeCustomerId ?? null, update.stripeSubscriptionId ?? null, id],
  })
  await audit(master, id, "billing.plan_updated", update.planStatus, { plan: update.plan ?? null }).catch(() => {})
  return c.json({ received: true })
})
