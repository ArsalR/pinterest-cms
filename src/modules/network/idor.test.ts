// src/modules/network/idor.test.ts
// Final-audit regression (D5 — cross-tenant IDOR, the highest-risk bug class in
// a multi-tenant system). The dashboard's site/seat loaders MUST scope by
// customer_id, so customer B can never read or act on customer A's resource by
// guessing an id. The fake DB below returns a row ONLY when BOTH the id and the
// customer_id in the query args match a known owned pair — so a loader that
// forgets to pass customer_id would return the row and fail this test.

import { describe, it, expect } from "vitest"
import type { Client } from "@libsql/client/web"
import { loadCustomerSite } from "./service"
import { loadSourceSite } from "../cloning"
import { loadSeat, deleteSeat } from "../agency"

// Ownership table: siteA belongs to custA; siteB to custB. seatA to custA.
const OWNED_SITES: Record<string, string> = { siteA: "custA", siteB: "custB" }
const OWNED_SEATS: Record<string, string> = { seatA: "custA" }

function tenantEnforcingDb(): Client & { deletes: Array<unknown[]> } {
  const deletes: Array<unknown[]> = []
  const db = {
    deletes,
    execute: async (q: { sql: string; args?: unknown[] }) => {
      const sql = q.sql
      const args = q.args ?? []
      if (/DELETE FROM client_seats/i.test(sql)) {
        // args = [seatId, customerId]; only "delete" when owned.
        const [seatId, customerId] = args as string[]
        if (OWNED_SEATS[seatId] === customerId) deletes.push(args)
        return { rows: [], rowsAffected: OWNED_SEATS[seatId] === customerId ? 1 : 0 }
      }
      // Reads: honor an id+customer_id pair only when scoped correctly.
      const scoped = /customer_id\s*=\s*\?/i.test(sql)
      // customer_sites reads: args typically [id, customerId]
      if (/FROM customer_sites/i.test(sql)) {
        const [id, customerId] = args as string[]
        const owner = OWNED_SITES[id]
        const ok = owner && (!scoped || owner === customerId)
        return { rows: ok ? [{ id, customer_id: owner, name: "n", niche: "x", kind: "content", domain: "d", cms_site_id: null, repo_full_name: null }] : [] }
      }
      // client_seats single read: loadSeat is BY DESIGN unscoped (token-gated),
      // returns the row + its owning customer_id so the caller can scope.
      if (/FROM client_seats WHERE id = \?/i.test(sql)) {
        const [seatId] = args as string[]
        const owner = OWNED_SEATS[seatId]
        return { rows: owner ? [{ id: seatId, customer_id: owner, label: "L", email: "e", site_ids: "[]", last_report_at: null }] : [] }
      }
      return { rows: [] }
    },
  }
  return db as unknown as Client & { deletes: Array<unknown[]> }
}

describe("cross-tenant IDOR is denied by customer_id scoping", () => {
  const db = tenantEnforcingDb()

  it("loadCustomerSite: owner sees the site, another customer gets null", async () => {
    expect(await loadCustomerSite(db, "siteA", "custA")).not.toBeNull()
    expect(await loadCustomerSite(db, "siteA", "custB")).toBeNull() // B cannot read A's site
  })

  it("loadSourceSite (clone from): cannot clone another customer's site", async () => {
    expect(await loadSourceSite(db, "siteB", "custB")).not.toBeNull()
    expect(await loadSourceSite(db, "siteB", "custA")).toBeNull()
  })

  it("deleteSeat: a customer cannot delete another customer's client seat", async () => {
    const db2 = tenantEnforcingDb()
    await deleteSeat(db2, "custB", "seatA") // B tries to delete A's seat
    expect(db2.deletes).toEqual([])         // nothing deleted
    await deleteSeat(db2, "custA", "seatA") // owner deletes own seat
    expect(db2.deletes).toHaveLength(1)
  })

  it("loadSeat is intentionally unscoped but only reachable via a signed seat token", async () => {
    // Documents the design: the portal authenticates the seatId via a signed
    // JWT (verifySeatToken) before calling loadSeat — the id is not attacker-
    // chosen without the SaaS signing secret.
    const seat = await loadSeat(db, "seatA")
    expect(seat?.customerId).toBe("custA")
  })
})
