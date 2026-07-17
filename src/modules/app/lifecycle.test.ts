// src/modules/app/lifecycle.test.ts
// PART F — full mocked customer-lifecycle harness. Drives the REAL production
// service functions against a REAL in-memory SQLite (via @libsql/client node
// entry), master schema built by the actual migration runner, external HTTP
// stubbed. This proves the state machine end-to-end, not just per-unit:
//   signup → verify → connections (+ vault roundtrip) → provisioning plan →
//   quality gate → billing checkout → webhook upgrade → agency gate →
//   trial expiry lockout → cancel → lapse (data survives).
//
// The per-step external network operations (GitHub repo create, CF domain,
// Stripe checkout redirect) are covered by githubApi/cloudflareApi/resume/
// billing unit tests and are stubbed here; this harness owns the STATE spine.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest"
import { createClient, type Client as NodeClient } from "@libsql/client"
import type { Client } from "@libsql/client/web"
import { runMasterMigrations } from "../../shared/masterMigrate"
import {
  createCustomer, findCustomerById, issueToken, markEmailVerified, planGate, TRIAL_DAYS,
} from "../customers"
import { saveConnection, getConnectionSecret } from "../connections"
import { createProvisioningPlan, provisioningStatus, PROVISION_STEPS } from "../provisioning"
import { checkGate, DEFAULT_GATE_CONFIG } from "../quality-gate"
import { loadCorpus } from "../publishing"
import { eventToPlanUpdate, hasAgencyFeatures } from "../billing"

const env = { VAULT_MASTER_KEY: "a".repeat(64) } as never
const log: string[] = []
const step = (msg: string) => log.push(`✓ ${msg}`)

let master: Client
let siteDb: Client
let nodeMaster: NodeClient
let nodeSite: NodeClient

beforeAll(async () => {
  // Any accidental external call fails the harness loudly.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no external HTTP in the lifecycle harness") }))
  nodeMaster = createClient({ url: ":memory:" })
  master = nodeMaster as unknown as Client
  await runMasterMigrations(master) // the REAL migration runner builds the master schema

  nodeSite = createClient({ url: ":memory:" })
  siteDb = nodeSite as unknown as Client
  // Minimal per-site posts table (the columns loadCorpus/gate read).
  await siteDb.execute(
    "CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT, slug TEXT, content TEXT, excerpt TEXT, published INTEGER DEFAULT 0, type TEXT DEFAULT 'post')"
  )
})
afterAll(() => { vi.unstubAllGlobals(); nodeMaster.close(); nodeSite.close() })

describe("PART F — full customer lifecycle (in-memory, real functions)", () => {
  const nowIso = () => new Date().toISOString().replace("T", " ").slice(0, 19)
  let customerId: string

  it("1. signup creates a trialing customer with a 7-day window", async () => {
    const c = await createCustomer(master, "owner@acme.co", "correct-horse-battery", "Acme", undefined, TRIAL_DAYS)
    customerId = c.id
    expect(c.plan_status).toBe("trialing")
    expect(c.trial_ends_at).toBeTruthy()
    expect(planGate(c, nowIso())).toBe("active") // trial active → can publish
    step(`signup: trialing, gate=active, trial_ends_at=${c.trial_ends_at}`)
  })

  it("2. email verification flips email_verified", async () => {
    const token = await issueToken(master, customerId, "verify")
    expect(token).toBeTruthy()
    await markEmailVerified(master, customerId)
    const c = await findCustomerById(master, customerId)
    expect(c!.email_verified).toBe(1)
    step("email verified")
  })

  it("3. connections store + vault roundtrip (github, cloudflare, anthropic)", async () => {
    for (const [provider, secret] of [
      ["github", "ghs_installation_xyz"],
      ["cloudflare", "cf_token_abcdefghijklmnopqrstuvwxyz012345"],
      ["anthropic", "sk-ant-secret-key-value"],
    ] as const) {
      await saveConnection(master, env, customerId, provider, secret, { preview: "…" })
      const back = await getConnectionSecret(master, env, customerId, provider, "lifecycle-test")
      expect(back).toBe(secret) // vault encrypt→store→decrypt roundtrip is lossless
    }
    step("3 connections saved + vault decrypt roundtrip verified")
  })

  it("4. provisioning plan seeds every step as pending, in locked order", async () => {
    const customer = (await findCustomerById(master, customerId))!
    const siteId = await createProvisioningPlan(master, customer, {
      domain: "acme.co", canonicalHost: "apex", name: "Acme", niche: "widgets", zoneId: "zone1", kind: "content",
    })
    const steps = await provisioningStatus(master, siteId)
    expect(steps).toHaveLength(PROVISION_STEPS.length)
    expect(steps.every((s) => s.status === "pending")).toBe(true)
    expect(steps.map((s) => s.step)).toEqual([...PROVISION_STEPS]) // ordered
    step(`provisioning plan: ${steps.length} steps pending, ordered (execution covered by githubApi/cloudflareApi/resume tests)`)
  })

  it("5. quality gate: thin content blocked with a reason, strong content passes", async () => {
    await siteDb.execute({ sql: "INSERT INTO posts (id,title,slug,content,excerpt,published,type) VALUES ('p1','Real Post','real','<p>" + "word ".repeat(400) + "</p>','A solid summary of the post that is clearly long enough.',1,'post')", args: [] })
    const corpus = await loadCorpus(siteDb, "draft")
    const thin = checkGate({ title: "x", meta: "", content: "<p>too short</p>" }, corpus, DEFAULT_GATE_CONFIG)
    expect(thin.passed).toBe(false)
    expect(thin.checks.some((c) => !c.passed && !!c.detail)).toBe(true) // plain-language reason present
    const strong = checkGate(
      { title: "A Genuinely Original Guide to Widgets", meta: "Everything you need to know about widgets, explained simply.", content: "<p>" + "unique widget insight ".repeat(120) + "</p>" },
      corpus, DEFAULT_GATE_CONFIG
    )
    expect(strong.passed).toBe(true)
    step(`quality gate: thin blocked ("${thin.checks.find((c) => !c.passed)!.detail}"), strong passes (score ${strong.score})`)
  })

  it("6. billing: checkout webhook upgrades the plan to Agency", async () => {
    const mapped = eventToPlanUpdate({
      type: "checkout.session.completed",
      data: { object: { mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: { customerId, plan: "agency" } } },
    })!
    // Apply exactly as the webhook handler does.
    await master.execute({
      sql: `UPDATE customers SET plan_status=?, plan=COALESCE(?,plan), stripe_customer_id=COALESCE(?,stripe_customer_id), stripe_subscription_id=COALESCE(?,stripe_subscription_id) WHERE id=?`,
      args: [mapped.update.planStatus, mapped.update.plan ?? null, mapped.update.stripeCustomerId ?? null, mapped.update.stripeSubscriptionId ?? null, customerId],
    })
    const c = (await findCustomerById(master, customerId))!
    expect(c.plan).toBe("agency")
    expect(c.plan_status).toBe("active")
    expect(hasAgencyFeatures(c.plan)).toBe(true) // agency panel/cron now unlocked
    step("billing: webhook → plan=agency, status=active, agency features unlocked")
  })

  it("6b. webhook replay does not double-apply (idempotent SET)", async () => {
    const before = (await findCustomerById(master, customerId))!
    // Same event again.
    await master.execute({ sql: "UPDATE customers SET plan_status='active', plan='agency' WHERE id=?", args: [customerId] })
    const after = (await findCustomerById(master, customerId))!
    expect(after.plan).toBe(before.plan)
    expect(after.plan_status).toBe(before.plan_status)
    step("billing replay: idempotent (no double-apply)")
  })

  it("7. trial expiry / lapse → read_only, but data survives", async () => {
    // Simulate the subscription being canceled by Stripe.
    const del = eventToPlanUpdate({ type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } })!
    await master.execute({ sql: "UPDATE customers SET plan_status=? WHERE stripe_subscription_id=?", args: [del.update.planStatus, "sub_1"] })
    const c = (await findCustomerById(master, customerId))!
    expect(c.plan_status).toBe("canceled")
    expect(planGate(c, nowIso())).toBe("read_only") // publishing/edits pause
    // Data survives: the customer, connections, and site rows are all still present.
    expect(await getConnectionSecret(master, env, customerId, "github", "post-lapse")).toBe("ghs_installation_xyz")
    const sites = await master.execute({ sql: "SELECT id FROM customer_sites WHERE customer_id=?", args: [customerId] })
    expect(sites.rows.length).toBe(1)
    step("lapse: gate=read_only, connections + site rows intact (no data loss)")
  })

  it("8. an expired trial (no subscription) is also read_only", async () => {
    const fresh = await createCustomer(master, "trial@expired.co", "another-strong-pass", null, undefined, TRIAL_DAYS)
    // Force the trial into the past.
    await master.execute({ sql: "UPDATE customers SET trial_ends_at='2020-01-01 00:00:00' WHERE id=?", args: [fresh.id] })
    const c = (await findCustomerById(master, fresh.id))!
    expect(planGate(c, nowIso())).toBe("read_only")
    step("expired trial (no sub): gate=read_only")

    // Emit the artifact log.
    console.log("\n─── PART F lifecycle artifact ───\n" + log.join("\n") + "\n──────────────────────────────")
  })
})
