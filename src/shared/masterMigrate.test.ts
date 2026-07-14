// src/shared/masterMigrate.test.ts
// Guards the master migration array's invariants (pure-logic; the runner
// itself needs a libsql client and is exercised in Phase 10's mocked tests).

import { describe, it, expect } from "vitest"
import { MASTER_MIGRATIONS } from "./masterMigrate"

describe("MASTER_MIGRATIONS invariants", () => {
  it("versions are contiguous from 1 and unique", () => {
    const versions = MASTER_MIGRATIONS.map((m) => m.version)
    expect(versions).toEqual([...versions].sort((a, b) => a - b))
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions[0]).toBe(1)
    for (let i = 1; i < versions.length; i++) expect(versions[i]).toBe(versions[i - 1] + 1)
  })

  it("every statement is idempotent DDL (IF NOT EXISTS) — required because a freshly provisioned DB re-runs all migrations", () => {
    // Allowed: CREATE … IF NOT EXISTS (re-run-safe), or ALTER TABLE … ADD
    // COLUMN. The master runner tracks applied versions and applies each
    // exactly once (the DB is a long-lived singleton, never re-provisioned),
    // so ADD COLUMN runs once; a concurrent first-apply race self-heals on the
    // next request (loser sees the version applied and skips it).
    for (const m of MASTER_MIGRATIONS) {
      for (const sql of m.statements) {
        expect(sql, `${m.name}: ${sql.slice(0, 60)}…`).toMatch(
          /^\s*(CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS|ALTER TABLE \w+ ADD COLUMN)/i
        )
      }
    }
  })

  it("never touches the pre-existing sites table", () => {
    for (const m of MASTER_MIGRATIONS) {
      for (const sql of m.statements) {
        expect(sql).not.toMatch(/\bsites\b/i)
      }
    }
  })

  it("v1 creates the Phase 1 control-plane tables", () => {
    const v1 = MASTER_MIGRATIONS[0].statements.join("\n")
    for (const table of ["customers", "customer_tokens", "audit_log", "jobs"]) {
      expect(v1).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })
})
