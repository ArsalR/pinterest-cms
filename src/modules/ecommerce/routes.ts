// src/modules/ecommerce/routes.ts
// The sell-side runtime (amendment 2, static-first ecommerce):
//   POST /api/saas/checkout/:siteId       — cart → Stripe Checkout Session
//   POST /api/saas/stripe-webhook/:customerId — Stripe → per-site orders table
//
// Both are gated by saasActive (invisible on tenant hostnames). Checkout is
// browser-navigated (a form POST from the customer's static site → 303 to
// Stripe) so no cross-origin CORS is needed. The webhook is authenticated by
// Stripe's signature (per-account whsec), not a session.
//
// SECURITY INVARIANTS:
//  - Prices come ONLY from the CMS products table, never from the client.
//  - The webhook verifies the Stripe signature before recording anything.
//  - Orders are idempotent on the Stripe session id (UNIQUE column).

import { Hono } from "hono"
import type { Context } from "hono"
import type { AppEnv, CloudflareEnv } from "../../lib/types"
import type { Client } from "@libsql/client/web"
import { saasActive } from "../auth"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { getConnectionSecret } from "../connections"
import { audit } from "../customers"
import { cuid } from "../../lib/utils"
import { fireWebhooks } from "../../lib/webhooks"
import {
  createCheckoutSession, verifyStripeSignature, type CheckoutLineItem,
} from "./stripeApi"

interface SiteRow {
  id: string
  customer_id: string
  cms_site_id: string | null
  domain: string
  canonical_host: string
}

interface StripeCreds {
  secretKey: string
  webhookSecret: string | null
}

/** Decrypt + parse the customer's Stripe credentials (JSON {secretKey, webhookSecret}). */
async function getStripeCreds(
  db: Client,
  env: CloudflareEnv,
  customerId: string,
  purpose: string
): Promise<StripeCreds | null> {
  const raw = await getConnectionSecret(db, env, customerId, "stripe", purpose).catch(() => null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { secretKey?: string; webhookSecret?: string }
    if (parsed.secretKey) return { secretKey: parsed.secretKey, webhookSecret: parsed.webhookSecret ?? null }
  } catch {
    // legacy raw-key format (no webhook secret) — key only
  }
  return { secretKey: raw, webhookSecret: null }
}

async function loadSite(db: Client, siteId: string): Promise<SiteRow | null> {
  const r = await db.execute({
    sql: "SELECT id, customer_id, cms_site_id, domain, canonical_host FROM customer_sites WHERE id = ? LIMIT 1",
    args: [siteId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SiteRow) : null
}

async function siteDbFor(db: Client, cmsSiteId: string): Promise<Client | null> {
  const r = await db.execute({
    sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1",
    args: [cmsSiteId],
  })
  if (!r.rows.length) return null
  return getSiteDb(r.rows[0].turso_url as string, r.rows[0].turso_token as string)
}

function siteHost(site: SiteRow): string {
  return site.canonical_host === "www" ? `www.${site.domain}` : site.domain
}

// ─────────────────────── checkout ───────────────────────

export const saasCheckoutRoutes = new Hono<AppEnv>()

saasCheckoutRoutes.post("/:siteId", async (c, next) => {
  if (!saasActive(c)) return next()
  const siteId = c.req.param("siteId") ?? ""
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)

  const site = await loadSite(db, siteId)
  if (!site || !site.cms_site_id) return c.text("Unknown store", 404)
  const host = siteHost(site)
  const backToCart = (err?: string) =>
    new Response(null, { status: 303, headers: { Location: `https://${host}/cart/${err ? `?error=${encodeURIComponent(err)}` : ""}` } })

  // Cart items arrive as a JSON string in a form field (populated by the cart
  // island from localStorage) — a form POST, so no CORS needed.
  let items: Array<{ productId: string; qty: number }>
  try {
    const form = await c.req.formData()
    const parsed = JSON.parse(String(form.get("items") || "[]"))
    items = (Array.isArray(parsed) ? parsed : [])
      .map((i) => ({ productId: String(i.productId ?? ""), qty: Math.max(1, Math.min(99, Math.floor(Number(i.qty) || 1))) }))
      .filter((i) => i.productId)
  } catch {
    return backToCart("Your cart couldn't be read — please try again.")
  }
  if (!items.length) return backToCart("Your cart is empty.")

  const creds = await getStripeCreds(db, c.env, site.customer_id, `checkout:${site.domain}`)
  if (!creds) return backToCart("This store isn't finished setting up payments yet.")

  const siteDb = await siteDbFor(db, site.cms_site_id)
  if (!siteDb) return backToCart("Store is temporarily unavailable — please try again.")

  // SERVER-SIDE price: look up each product; ignore any client-sent price.
  const lineItems: CheckoutLineItem[] = []
  for (const item of items) {
    const pr = await siteDb.execute({
      sql: "SELECT title, price_cents, currency, images, stock_status, published FROM products WHERE id = ? OR slug = ? LIMIT 1",
      args: [item.productId, item.productId],
    })
    if (!pr.rows.length) return backToCart("One of the items is no longer available.")
    const p = pr.rows[0]
    if (Number(p.published) !== 1 || String(p.stock_status) !== "in_stock") {
      return backToCart(`"${String(p.title)}" is no longer available.`)
    }
    let images: string[] = []
    try {
      const arr = JSON.parse(String(p.images || "[]"))
      if (Array.isArray(arr)) images = arr.filter((x): x is string => typeof x === "string")
    } catch { /* ignore */ }
    lineItems.push({
      name: String(p.title),
      currency: String(p.currency || "usd"),
      unitAmountCents: Number(p.price_cents ?? 0),
      quantity: item.qty,
      images,
    })
  }

  const session = await createCheckoutSession(creds.secretKey, {
    lineItems,
    successUrl: `https://${host}/order/success/`,
    cancelUrl: `https://${host}/cart/`,
    metadata: { siteId, cmsSiteId: site.cms_site_id },
  })
  if (!session.url) {
    console.error("checkout: Stripe session failed:", session.error)
    return backToCart("Payment couldn't start just now — please try again.")
  }
  await audit(db, site.customer_id, "order.checkout_started", site.domain, { items: items.length })
  return new Response(null, { status: 303, headers: { Location: session.url } })
})

// ─────────────────────── stripe webhook → order ───────────────────────

export const saasStripeWebhookRoutes = new Hono<AppEnv>()

saasStripeWebhookRoutes.post("/:customerId", async (c, next) => {
  if (!saasActive(c)) return next()
  const customerId = c.req.param("customerId") ?? ""
  const rawBody = await c.req.text()
  const sig = c.req.header("stripe-signature") ?? ""

  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)

  const creds = await getStripeCreds(db, c.env, customerId, "stripe-webhook").catch(() => null)
  if (!creds?.webhookSecret) return c.json({ error: "not configured" }, 400)

  if (!(await verifyStripeSignature(rawBody, sig, creds.webhookSecret))) {
    return c.json({ error: "bad signature" }, 401)
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } }
  try {
    event = JSON.parse(rawBody)
  } catch {
    return c.json({ error: "bad payload" }, 400)
  }
  if (event.type !== "checkout.session.completed") return c.json({ received: true }) // ignore other events

  const s = event.data?.object ?? {}
  const metadata = (s.metadata ?? {}) as Record<string, string>
  const cmsSiteId = metadata.cmsSiteId
  const sessionId = String(s.id ?? "")
  if (!cmsSiteId || !sessionId) return c.json({ received: true })

  try {
    const siteDb = await siteDbFor(db, cmsSiteId)
    if (siteDb) {
      // Idempotent: UNIQUE(stripe_session_id) → OR IGNORE swallows replays.
      await siteDb.execute({
        sql: `INSERT OR IGNORE INTO orders (id, stripe_session_id, email, amount_total_cents, currency, items, status)
              VALUES (?, ?, ?, ?, ?, ?, 'paid')`,
        args: [
          cuid(),
          sessionId,
          String((s.customer_details as Record<string, unknown>)?.email ?? s.customer_email ?? ""),
          Number(s.amount_total ?? 0),
          String(s.currency ?? "usd"),
          JSON.stringify(metadata),
        ],
      })
      // M2: site-wide "order.created" event to any subscribed integration.
      const drow = await db.execute({ sql: "SELECT domain FROM customer_sites WHERE id = ? LIMIT 1", args: [String(metadata.siteId ?? "")] }).catch(() => null)
      const host = String(drow?.rows[0]?.domain ?? metadata.siteId ?? "")
      await fireWebhooks(siteDb, c.env.FEATURE_WEBHOOKS, host, "order.created", {
        sessionId, email: String((s.customer_details as Record<string, unknown>)?.email ?? s.customer_email ?? ""),
        amountCents: Number(s.amount_total ?? 0), currency: String(s.currency ?? "usd"),
      }).catch(() => {})
    }
    await audit(db, customerId, "order.recorded", metadata.siteId, { sessionId })
  } catch (err) {
    console.error("stripe webhook: order write failed:", err instanceof Error ? err.message : err)
    // Return 500 so Stripe retries — the order must not be silently lost.
    return c.json({ error: "record failed" }, 500)
  }
  return c.json({ received: true })
})

// exported for the connect handler (webhook registration at connect)
export { getStripeCreds }
