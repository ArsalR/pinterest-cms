// src/modules/billing/billing.test.ts
// Pure-logic: the plan catalog (env-tunable defaults), the agency-tier gate,
// and the webhook event → plan-state mapping (the only writer of plan state).

import { describe, it, expect } from "vitest"
import { planCatalog, isPlanId, hasAgencyFeatures, formatUsd, eventToPlanUpdate } from "./plans"
import { trialDaysFromEnv, TRIAL_DAYS } from "../customers"

describe("plan catalog (decision #3 — $29 Starter / $79 Agency)", () => {
  it("defaults to 2900/7900 cents", () => {
    const [starter, agency] = planCatalog({})
    expect(starter).toMatchObject({ id: "starter", amountCents: 2900, currency: "usd" })
    expect(agency).toMatchObject({ id: "agency", amountCents: 7900 })
  })
  it("is env-overridable, ignoring garbage", () => {
    const [starter, agency] = planCatalog({ SAAS_PRICE_STARTER_CENTS: "4900", SAAS_PRICE_AGENCY_CENTS: "nope" })
    expect(starter.amountCents).toBe(4900)
    expect(agency.amountCents).toBe(7900) // fell back
  })
  it("gates agency features on the agency plan only", () => {
    expect(hasAgencyFeatures("agency")).toBe(true)
    expect(hasAgencyFeatures("starter")).toBe(false)
    expect(hasAgencyFeatures("free")).toBe(false)
  })
  it("isPlanId accepts only known tiers", () => {
    expect(isPlanId("starter")).toBe(true)
    expect(isPlanId("agency")).toBe(true)
    expect(isPlanId("enterprise")).toBe(false)
  })
  it("formats USD amounts", () => {
    expect(formatUsd(2900)).toBe("$29")
    expect(formatUsd(7950)).toBe("$79.50")
  })
})

describe("trial length (7-day default, env-overridable)", () => {
  it("defaults to 7 days", () => {
    expect(TRIAL_DAYS).toBe(7)
    expect(trialDaysFromEnv(undefined)).toBe(7)
  })
  it("accepts sane overrides, rejects garbage + out-of-range", () => {
    expect(trialDaysFromEnv("14")).toBe(14)
    expect(trialDaysFromEnv("0")).toBe(7)
    expect(trialDaysFromEnv("365")).toBe(7)
    expect(trialDaysFromEnv("abc")).toBe(7)
  })
})

describe("eventToPlanUpdate (webhook → plan state)", () => {
  it("activates the purchased plan from checkout metadata", () => {
    const r = eventToPlanUpdate({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { customerId: "c1", plan: "agency" } } },
    })!
    expect(r.customerId).toBe("c1")
    expect(r.update).toEqual({ planStatus: "active", plan: "agency", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" })
  })

  it("ignores sell-side (payment-mode) checkout sessions", () => {
    expect(
      eventToPlanUpdate({ type: "checkout.session.completed", data: { object: { mode: "payment", metadata: { customerId: "c1" } } } })
    ).toBeNull()
  })

  it("maps subscription lifecycle statuses; matched by subscription id", () => {
    const upd = (status: string) =>
      eventToPlanUpdate({ type: "customer.subscription.updated", data: { object: { id: "sub_1", status } } })!
    expect(upd("active").update.planStatus).toBe("active")
    expect(upd("past_due").update.planStatus).toBe("past_due")
    expect(upd("unpaid").update.planStatus).toBe("canceled")
    expect(upd("active").customerId).toBeNull() // caller resolves by sub id
    expect(upd("active").update.stripeSubscriptionId).toBe("sub_1")
  })

  it("cancels on subscription.deleted; ignores unrelated events", () => {
    const del = eventToPlanUpdate({ type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } })!
    expect(del.update.planStatus).toBe("canceled")
    expect(eventToPlanUpdate({ type: "invoice.finalized", data: { object: { id: "in_1" } } })).toBeNull()
    expect(eventToPlanUpdate({ type: "checkout.session.completed" })).toBeNull()
  })

  it("drops an unknown plan string instead of writing it", () => {
    const r = eventToPlanUpdate({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", metadata: { customerId: "c1", plan: "enterprise" } } },
    })!
    expect(r.update.plan).toBeUndefined()
    expect(r.update.planStatus).toBe("active")
  })
})
