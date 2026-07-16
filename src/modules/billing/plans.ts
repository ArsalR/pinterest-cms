// src/modules/billing/plans.ts
// Platform subscription plans (decision #3) — PURE catalog + webhook-event
// mapping, unit-tested. Two tiers: Starter ($29/mo) runs sites; Agency ($79/mo)
// adds white-label, client seats, and monthly reports (K11 is the expansion
// tier — the classic upgrade lever for operators who start selling to clients).
// Amounts are env-overridable; these are launch defaults, not dashboard state
// (prices are created inline at checkout, so there's nothing to click together
// in Stripe first).

import type { CloudflareEnv } from "../../lib/types"

export type PlanId = "starter" | "agency"

export interface PlanDef {
  id: PlanId
  label: string
  amountCents: number
  currency: string
  blurb: string
  features: string[]
}

const DEFAULT_STARTER_CENTS = 2900
const DEFAULT_AGENCY_CENTS = 7900

function cents(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? "", 10)
  return Number.isFinite(n) && n >= 100 ? n : fallback
}

/** The live plan catalog, env-tunable without a redeploy of copy. Pure given env. */
export function planCatalog(env: Pick<CloudflareEnv, "SAAS_PRICE_STARTER_CENTS" | "SAAS_PRICE_AGENCY_CENTS">): PlanDef[] {
  return [
    {
      id: "starter",
      label: "Starter",
      amountCents: cents(env.SAAS_PRICE_STARTER_CENTS, DEFAULT_STARTER_CENTS),
      currency: "usd",
      blurb: "Run your own network of sites — everything except agency tools.",
      features: [
        "Unlimited sites on your own GitHub + Cloudflare",
        "Prompt-to-build, quality gate, publishing engine",
        "Search Console, decay radar, AI visibility",
        "Pinterest drip, WordPress import, affiliate tools",
      ],
    },
    {
      id: "agency",
      label: "Agency",
      amountCents: cents(env.SAAS_PRICE_AGENCY_CENTS, DEFAULT_AGENCY_CENTS),
      currency: "usd",
      blurb: "Everything in Starter, plus white-label client reporting.",
      features: [
        "Everything in Starter",
        "White-label branding on reports + portal",
        "Client seats with scoped report access",
        "Monthly auto-reports emailed to clients",
      ],
    },
  ]
}

export function isPlanId(v: string): v is PlanId {
  return v === "starter" || v === "agency"
}

/** Agency features gate (panel, seats, report cron). Pure. */
export function hasAgencyFeatures(plan: string): boolean {
  return plan === "agency"
}

export function formatUsd(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(amountCents % 100 === 0 ? 0 : 2)}`
}

// ─────────────── webhook event → plan update (pure) ───────────────

export interface PlanUpdate {
  planStatus: "active" | "past_due" | "canceled"
  plan?: PlanId          // set when the event names the tier (checkout metadata)
  stripeCustomerId?: string
  stripeSubscriptionId?: string
}

interface StripeEventLike {
  type: string
  data?: {
    object?: {
      mode?: string
      status?: string
      customer?: string
      subscription?: string
      id?: string
      metadata?: Record<string, string>
    }
  }
}

/**
 * Map a Stripe billing event to the customer-row update it implies, or null
 * when the event is not ours to act on. Pure — unit-tested. planGate() already
 * treats anything except 'active'/valid-trial as read_only, so past_due and
 * canceled need no extra gating logic anywhere else.
 */
export function eventToPlanUpdate(event: StripeEventLike): { customerId: string | null; update: PlanUpdate } | null {
  const obj = event.data?.object
  if (!obj) return null

  if (event.type === "checkout.session.completed") {
    if (obj.mode !== "subscription") return null // sell-side sessions are handled elsewhere
    const planRaw = obj.metadata?.plan ?? ""
    return {
      customerId: obj.metadata?.customerId ?? null,
      update: {
        planStatus: "active",
        ...(isPlanId(planRaw) ? { plan: planRaw } : {}),
        ...(obj.customer ? { stripeCustomerId: obj.customer } : {}),
        ...(obj.subscription ? { stripeSubscriptionId: obj.subscription } : {}),
      },
    }
  }

  if (event.type === "customer.subscription.updated") {
    const status = obj.status ?? ""
    const planStatus: PlanUpdate["planStatus"] =
      status === "active" || status === "trialing" ? "active" : status === "past_due" ? "past_due" : "canceled"
    // Matched by subscription id (customerId resolved by the caller).
    return { customerId: null, update: { planStatus, stripeSubscriptionId: obj.id } }
  }

  if (event.type === "customer.subscription.deleted") {
    return { customerId: null, update: { planStatus: "canceled", stripeSubscriptionId: obj.id } }
  }

  return null
}
