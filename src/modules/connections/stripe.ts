// src/modules/connections/stripe.ts
// BYO-Stripe (amendment 2): the customer connects their OWN Stripe account so
// ecommerce checkout runs on their Stripe, their payout — distinct from the
// platform's Phase-9 subscription billing. Phase 4.5c scope: live key
// validation + storage. Checkout-session creation + order webhooks land in the
// ecommerce module (4.5d) on top of getConnectionSecret(..., "stripe").
//
// The secret key is stored vault-encrypted like every other credential; only
// this one-shot validation ever touches the raw key on the platform side.

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
