// src/modules/billing/stripeBilling.ts
// Platform-billing Stripe calls (OUR account — PLATFORM_STRIPE_SECRET_KEY),
// distinct from the customers' BYO sell-side Stripe in `ecommerce`. Reuses the
// shared form-encoded stripeApiCall; prices are created INLINE at checkout
// (recurring price_data), so launch needs only the two platform secrets — no
// Stripe-dashboard product/price setup. Self-gates on the secrets like every
// other integration.

import type { CloudflareEnv } from "../../lib/types"
import { stripeApiCall } from "../connections"
import type { PlanDef } from "./plans"

export function billingConfigured(env: CloudflareEnv): boolean {
  return !!(env.PLATFORM_STRIPE_SECRET_KEY && env.PLATFORM_STRIPE_WEBHOOK_SECRET)
}

/**
 * Create a subscription Checkout session for a plan. The app-side trial
 * (7 days at signup) runs BEFORE checkout, so no Stripe trial is layered on —
 * subscribing charges immediately. metadata carries customerId + plan for the
 * webhook to apply.
 */
export async function createSubscriptionCheckout(
  env: CloudflareEnv,
  args: { plan: PlanDef; customerId: string; customerEmail: string; successUrl: string; cancelUrl: string }
): Promise<{ url: string | null; error: string | null }> {
  if (!env.PLATFORM_STRIPE_SECRET_KEY) return { url: null, error: "Billing isn't configured on the platform yet." }
  const r = await stripeApiCall<{ url?: string }>(env.PLATFORM_STRIPE_SECRET_KEY, "/v1/checkout/sessions", {
    mode: "subscription",
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
    customer_email: args.customerEmail,
    metadata: { customerId: args.customerId, plan: args.plan.id },
    subscription_data: { metadata: { customerId: args.customerId, plan: args.plan.id } },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: args.plan.currency,
          unit_amount: args.plan.amountCents,
          recurring: { interval: "month" },
          product_data: { name: `SiteNetwork ${args.plan.label}` },
        },
      },
    ],
  })
  return { url: r.data?.url ?? null, error: r.error }
}

/** Billing-portal session (manage card, switch plan, cancel) for a customer. */
export async function createPortalSession(
  env: CloudflareEnv,
  stripeCustomerId: string,
  returnUrl: string
): Promise<{ url: string | null; error: string | null }> {
  if (!env.PLATFORM_STRIPE_SECRET_KEY) return { url: null, error: "Billing isn't configured on the platform yet." }
  const r = await stripeApiCall<{ url?: string }>(env.PLATFORM_STRIPE_SECRET_KEY, "/v1/billing_portal/sessions", {
    customer: stripeCustomerId,
    return_url: returnUrl,
  })
  return { url: r.data?.url ?? null, error: r.error }
}
