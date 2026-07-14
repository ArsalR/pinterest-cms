// src/modules/ecommerce/stripeApi.ts
// Sell-side Stripe operations: checkout-session creation + webhook signature
// verification. Low-level primitives (form encoding, generic call, webhook
// registration) live in ../connections and are imported via the barrel —
// ecommerce sits above connections in the dependency graph, so this is a clean
// edge (no cycle). The signature-verify helpers are pure and unit-tested.

import { stripeApiCall } from "../connections"

export interface CheckoutLineItem {
  name: string
  currency: string
  unitAmountCents: number
  quantity: number
  images?: string[]
}

/** Create a Stripe Checkout Session on the customer's account. Returns the URL. */
export async function createCheckoutSession(
  secretKey: string,
  args: {
    lineItems: CheckoutLineItem[]
    successUrl: string
    cancelUrl: string
    metadata: Record<string, string>
    customerEmail?: string
  }
): Promise<{ url: string | null; error: string | null }> {
  const body: Record<string, unknown> = {
    mode: "payment",
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    metadata: args.metadata,
    line_items: args.lineItems.map((li) => ({
      quantity: li.quantity,
      price_data: {
        currency: li.currency,
        unit_amount: li.unitAmountCents,
        product_data: { name: li.name, ...(li.images?.length ? { images: li.images.slice(0, 8) } : {}) },
      },
    })),
  }
  if (args.customerEmail) body.customer_email = args.customerEmail
  const r = await stripeApiCall<{ url?: string }>(secretKey, "/v1/checkout/sessions", body)
  return { url: r.data?.url ?? null, error: r.error }
}

// ─────────────── webhook signature verification (pure, unit-tested) ───────────────

function hex(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0")
  return s
}

/** Constant-time equality for two hex strings. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message))))
}

/**
 * Verify a Stripe webhook signature (the `constructEvent` algorithm).
 * Header: `t=<unix>,v1=<hex>[,v1=<hex>…]`; signed_payload = `${t}.${rawBody}`.
 * Rejects if no v1 matches or |now - t| exceeds the tolerance (replay guard).
 */
export async function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
  nowSecs: number = Math.floor(Date.now() / 1000),
  toleranceSecs = 300
): Promise<boolean> {
  if (!signatureHeader) return false
  let t = ""
  const v1: string[] = []
  for (const part of signatureHeader.split(",")) {
    const [k, v] = part.split("=", 2)
    if (k === "t") t = v ?? ""
    else if (k === "v1" && v) v1.push(v)
  }
  const ts = parseInt(t, 10)
  if (!Number.isFinite(ts) || !v1.length) return false
  if (Math.abs(nowSecs - ts) > toleranceSecs) return false // replay guard

  const expected = await hmacSha256Hex(webhookSecret, `${t}.${rawBody}`)
  return v1.some((sig) => timingSafeEqualHex(sig, expected))
}
