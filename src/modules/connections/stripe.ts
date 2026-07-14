// src/modules/connections/stripe.ts
// BYO-Stripe (amendment 2): the customer connects their OWN Stripe account so
// ecommerce checkout runs on their Stripe, their payout — distinct from the
// platform's Phase-9 subscription billing.
//
// This file holds the low-level Stripe client primitives (form encoding, a
// generic call, webhook-endpoint registration) so both the connect flow (this
// module) and the checkout/webhook runtime (ecommerce module, which imports
// these via the barrel) can share them without a circular dependency — the
// ecommerce module sits above connections in the dependency graph.
//
// Secret material is stored vault-encrypted; only these calls touch raw keys.

/** Flatten a nested object into Stripe's bracketed form-encoding pairs
 *  (e.g. line_items[0][price_data][unit_amount]=1999). Pure, unit-tested. */
export function stripeForm(obj: unknown, prefix = ""): string {
  const parts: string[] = []
  const enc = encodeURIComponent
  const walk = (value: unknown, key: string) => {
    if (value === null || value === undefined) return
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${key}[${i}]`))
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(v, key ? `${key}[${k}]` : k)
      }
    } else {
      parts.push(`${enc(key)}=${enc(String(value))}`)
    }
  }
  walk(obj, prefix)
  return parts.join("&")
}

/** Generic authenticated Stripe POST (form-encoded). */
export async function stripeApiCall<T>(
  secretKey: string,
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: T | null; error: string | null }> {
  try {
    const resp = await fetch(`https://api.stripe.com${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2024-06-20",
      },
      body: stripeForm(body),
    })
    const data = (await resp.json().catch(() => null)) as (T & { error?: { message?: string } }) | null
    if (!resp.ok) {
      return { ok: false, status: resp.status, data: null, error: data?.error?.message ?? `Stripe ${resp.status}` }
    }
    return { ok: true, status: resp.status, data: data as T, error: null }
  } catch {
    return { ok: false, status: 0, data: null, error: "Couldn't reach Stripe." }
  }
}

export interface StripeWebhookEndpoint {
  id: string
  secret: string
}

/** Register a webhook endpoint on the customer's Stripe account (at connect). */
export async function createWebhookEndpoint(
  secretKey: string,
  url: string
): Promise<{ endpoint: StripeWebhookEndpoint | null; error: string | null }> {
  const r = await stripeApiCall<{ id?: string; secret?: string }>(secretKey, "/v1/webhook_endpoints", {
    url,
    enabled_events: ["checkout.session.completed"],
    description: "SiteNetwork order recording",
  })
  if (!r.data?.id || !r.data?.secret) return { endpoint: null, error: r.error ?? "No webhook secret returned" }
  return { endpoint: { id: r.data.id, secret: r.data.secret }, error: null }
}

export interface StripeKeyCheck {
  valid: boolean
  problem: string | null
  accountName: string | null
  livemode: boolean
}

/** Live-validate a Stripe SECRET key (sk_live_… / sk_test_…) via GET /v1/account. */
export async function verifyStripeKey(key: string): Promise<StripeKeyCheck> {
  const bad = (problem: string): StripeKeyCheck => ({ valid: false, problem, accountName: null, livemode: false })
  const k = key.trim()

  if (!/^sk_(live|test)_[A-Za-z0-9]{16,}$/.test(k)) {
    return bad(
      'That doesn\'t look like a Stripe secret key — it should start with "sk_live_" (or "sk_test_"). ' +
        "Use a Secret key from the Stripe dashboard → Developers → API keys, not a Publishable key."
    )
  }
  try {
    const resp = await fetch("https://api.stripe.com/v1/account", {
      headers: { Authorization: `Bearer ${k}`, "Stripe-Version": "2024-06-20" },
    })
    if (resp.status === 401) {
      return bad("Stripe rejected that key — double-check you copied the whole Secret key.")
    }
    if (!resp.ok) {
      return bad("Couldn't confirm the key with Stripe just now — please try again in a minute.")
    }
    const acct = (await resp.json().catch(() => null)) as
      | { settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string }; livemode?: boolean }
      | null
    return {
      valid: true,
      problem: null,
      accountName: acct?.settings?.dashboard?.display_name ?? acct?.business_profile?.name ?? null,
      livemode: k.startsWith("sk_live_"),
    }
  } catch {
    return bad("Couldn't reach Stripe to check the key — please try again.")
  }
}
