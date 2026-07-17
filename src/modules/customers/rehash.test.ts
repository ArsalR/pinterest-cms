// src/modules/customers/rehash.test.ts
// Paid-tier crypto bump — confirms the config-driven PBKDF2 envelope + rehash-
// on-login upgrades an EXISTING customer (hashed at the old work factor) to the
// new target on their next sign-in, with no data migration. Runs against real
// in-memory SQLite.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createClient, type Client as NodeClient } from "@libsql/client"
import type { Client } from "@libsql/client/web"
import { runMasterMigrations } from "../../shared/masterMigrate"
import { createCustomer, verifyCustomerPassword } from "./customers"
import { storedHashIterations } from "../../lib/auth"

let node: NodeClient
let db: Client
const OLD = 100_000
const NEW = 600_000

beforeAll(async () => {
  node = createClient({ url: ":memory:" })
  db = node as unknown as Client
  await runMasterMigrations(db)
})
afterAll(() => node.close())

async function storedIters(email: string): Promise<number> {
  const r = await db.execute({ sql: "SELECT password FROM customers WHERE email = ? LIMIT 1", args: [email] })
  return storedHashIterations(String(r.rows[0].password))
}

describe("rehash-on-login carries the new PBKDF2 target", () => {
  it("upgrades an old-work-factor hash to the new target on next login", async () => {
    // A customer created BEFORE the bump (hashed at the old iteration count).
    const c = await createCustomer(db, "old@user.co", "correct horse battery staple", "Old", OLD)
    expect(await storedIters("old@user.co")).toBe(OLD)

    // Next successful login verifies against the new target → transparent rehash.
    const ok = await verifyCustomerPassword(db, "old@user.co", "correct horse battery staple", NEW)
    expect(ok?.id).toBe(c.id)
    expect(await storedIters("old@user.co")).toBe(NEW) // upgraded in place, no migration

    // Idempotent: logging in again at the same target does not rehash again.
    await verifyCustomerPassword(db, "old@user.co", "correct horse battery staple", NEW)
    expect(await storedIters("old@user.co")).toBe(NEW)
  })

  it("a wrong password never rehashes (and returns null)", async () => {
    await createCustomer(db, "safe@user.co", "the-real-password", null, OLD)
    const bad = await verifyCustomerPassword(db, "safe@user.co", "wrong-password", NEW)
    expect(bad).toBeNull()
    expect(await storedIters("safe@user.co")).toBe(OLD) // untouched
  })
})
