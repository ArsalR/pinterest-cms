// src/modules/provisioning/resume.test.ts
// Phase 10 audit — the provisioning ORCHESTRATION invariants (dry-run +
// failure-resume), proven against a scripted in-memory DB with global fetch
// stubbed to THROW, so any accidental network call fails the test loudly. The
// per-step network operations themselves are covered by githubApi.test.ts /
// cloudflareApi.test.ts; this file proves the state machine that drives them:
//   • completed steps never re-execute (idempotent re-runs);
//   • a step already 'running' short-circuits (no double-execution);
//   • a step failure marks the step + site 'failed' and audits it;
//   • retryProvisioning resets failed steps so a re-run resumes.

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import type { Client } from "@libsql/client/web"
import { runProvisioning, retryProvisioning, PROVISION_STEPS } from "./provisionSite"

interface Write { sql: string; args: unknown[] }
type Handler = (sql: string, args: unknown[]) => { rows: unknown[]; rowsAffected?: number } | undefined

function fakeDb(handler: Handler): Client & { writes: Write[] } {
  const writes: Write[] = []
  const db = {
    writes,
    execute: async (q: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof q === "string" ? q : q.sql
      const args = (typeof q === "string" ? [] : q.args) ?? []
      writes.push({ sql, args })
      return handler(sql, args) ?? { rows: [], rowsAffected: 0 }
    },
  }
  return db as unknown as Client & { writes: Write[] }
}

const env = { SAAS_CMS_HOST_SUFFIX: "cms.arsal.app" } as never
const SITE = { id: "site_1", customer_id: "cust_1", domain: "a.com", name: "A", status: "provisioning" }

beforeEach(() => {
  // Any network during these tests is a bug — fail loudly.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network must not be called in the resume state machine") }))
})
afterEach(() => vi.unstubAllGlobals())

function runsRows(status: string) {
  return PROVISION_STEPS.map((step, i) => ({ step, status, ord: i, started_at: null }))
}

describe("provisioning resume state machine", () => {
  it("does nothing and never touches the network when the site is gone", async () => {
    const db = fakeDb((sql) => (sql.includes("FROM customer_sites") ? { rows: [] } : undefined))
    await runProvisioning(db, env, "site_1")
    // No provisioning_runs update, no status change.
    expect(db.writes.some((w) => /UPDATE\s+provisioning_runs/i.test(w.sql))).toBe(false)
  })

  it("marks the site active when every step is already done, executing none", async () => {
    const db = fakeDb((sql) => {
      if (sql.includes("FROM customer_sites")) return { rows: [SITE] }
      if (sql.includes("FROM provisioning_runs")) return { rows: runsRows("done") }
      return undefined
    })
    await runProvisioning(db, env, "site_1")
    const setActive = db.writes.find((w) => /UPDATE customer_sites/i.test(w.sql) && JSON.stringify(w.args).includes("active"))
    expect(setActive).toBeTruthy()
    // No step was set to 'running' — nothing re-executed.
    expect(db.writes.some((w) => /UPDATE\s+provisioning_runs/i.test(w.sql) && JSON.stringify(w.args).includes("running"))).toBe(false)
  })

  it("short-circuits when a step is already running (no double execution)", async () => {
    const rows = runsRows("done")
    rows[3] = { ...rows[3], status: "running" }
    const db = fakeDb((sql) => {
      if (sql.includes("FROM customer_sites")) return { rows: [SITE] }
      if (sql.includes("FROM provisioning_runs")) return { rows }
      return undefined
    })
    await runProvisioning(db, env, "site_1")
    // Returned early: never marked the site active.
    expect(db.writes.some((w) => /UPDATE customer_sites/i.test(w.sql) && JSON.stringify(w.args).includes("active"))).toBe(false)
  })

  it("on a step failure, marks the step + site 'failed' and audits it", async () => {
    // First customer_sites read (runProvisioning) returns the site; the second
    // (inside executeStep) returns empty → the step throws deterministically.
    let siteReads = 0
    const db = fakeDb((sql) => {
      if (sql.includes("FROM customer_sites")) {
        siteReads++
        return { rows: siteReads === 1 ? [SITE] : [] }
      }
      if (sql.includes("FROM provisioning_runs")) return { rows: runsRows("pending") }
      return undefined
    })
    await runProvisioning(db, env, "site_1")

    const stepFailed = db.writes.find((w) => /UPDATE\s+provisioning_runs/i.test(w.sql) && JSON.stringify(w.args).includes("failed"))
    const siteFailed = db.writes.find((w) => /UPDATE customer_sites/i.test(w.sql) && JSON.stringify(w.args).includes("failed"))
    const audited = db.writes.find((w) => /INSERT INTO audit_log/i.test(w.sql) && JSON.stringify(w.args).includes("provision_failed"))
    expect(stepFailed).toBeTruthy()
    expect(siteFailed).toBeTruthy()
    expect(audited).toBeTruthy()
  })
})

describe("retryProvisioning", () => {
  it("flips failed steps back to pending and the site to provisioning", async () => {
    const db = fakeDb((sql) => {
      if (/UPDATE provisioning_runs/i.test(sql)) return { rows: [], rowsAffected: 2 }
      return { rows: [], rowsAffected: 0 }
    })
    expect(await retryProvisioning(db, "site_1")).toBe(true)
    expect(db.writes.some((w) => /UPDATE provisioning_runs SET status = 'pending'/i.test(w.sql))).toBe(true)
    expect(db.writes.some((w) => /UPDATE customer_sites SET status = 'provisioning'/i.test(w.sql))).toBe(true)
  })

  it("returns false when there was nothing failed to reset", async () => {
    const db = fakeDb(() => ({ rows: [], rowsAffected: 0 }))
    expect(await retryProvisioning(db, "site_1")).toBe(false)
  })
})
