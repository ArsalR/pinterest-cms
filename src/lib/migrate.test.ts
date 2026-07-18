// src/lib/migrate.test.ts
// V1.3 regression — the migration runner must be idempotent against a site
// whose CREATE TABLEs already include the migrated columns. Before this fix, a
// freshly provisioned site (full schema, empty _migrations) crashed at the
// first ALTER-based migration ("duplicate column name"), and the throw also
// aborted the rest of that site's cron tick (idempotency GC, webhook retries)
// on every 5-minute run. Runs against real in-memory SQLite.

import { describe, it, expect } from "vitest"
import { createClient } from "@libsql/client"
import { SITE_SCHEMA_STATEMENTS, MIGRATION_SEED_STATEMENTS } from "./provision"
import { runMigrations, MIGRATIONS, isDuplicateColumnError } from "./migrate"

async function appliedVersions(db: ReturnType<typeof createClient>): Promise<number[]> {
  const r = await db.execute("SELECT version FROM _migrations ORDER BY version")
  return r.rows.map((x) => Number(x.version))
}

describe("runMigrations idempotency", () => {
  it("a freshly provisioned site (schema + seed) has nothing to apply", async () => {
    const db = createClient({ url: ":memory:" })
    await db.batch([...SITE_SCHEMA_STATEMENTS, ...MIGRATION_SEED_STATEMENTS], "write")
    // Seed already stamped every version.
    expect(await appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    await runMigrations(db) // must be a clean no-op
    expect(await appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    db.close()
  })

  // GUARDRAIL (the production bug): full schema but EMPTY _migrations — the
  // state of every site provisioned after V1.2 shipped. The runner must
  // tolerate the duplicate ALTERs and record all versions instead of throwing.
  it("survives a full-schema site with an empty _migrations table", async () => {
    const db = createClient({ url: ":memory:" })
    await db.batch(SITE_SCHEMA_STATEMENTS as string[], "write") // no seed
    await runMigrations(db) // previously: "duplicate column name: sitemap_exclude"
    expect(await appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    // And a second run is a no-op.
    await runMigrations(db)
    expect(await appliedVersions(db)).toEqual(MIGRATIONS.map((m) => m.version))
    db.close()
  })

  it("upgrades a legacy site missing the newer columns", async () => {
    const db = createClient({ url: ":memory:" })
    // A pre-V1.2 posts table: core columns present, none of the S1 additions,
    // and no seo_settings table at all.
    await db.execute(
      `CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
         content TEXT NOT NULL, published INTEGER DEFAULT 0, published_at TEXT,
         type TEXT DEFAULT 'post', category_id TEXT, source TEXT DEFAULT 'manual',
         scheduled_at TEXT, no_index INTEGER DEFAULT 0)`
    )
    await runMigrations(db)
    const cols = await db.execute("SELECT name FROM pragma_table_info('posts')")
    const names = new Set(cols.rows.map((r) => String(r.name)))
    for (const c of ["sitemap_exclude", "nofollow", "schema_type", "faq_json"]) {
      expect(names.has(c), `missing migrated column: ${c}`).toBe(true)
    }
    const seo = await db.execute("SELECT name FROM pragma_table_info('seo_settings')")
    const seoCols = new Set(seo.rows.map((r) => String(r.name)))
    expect(seoCols.has("profiles")).toBe(true) // migration 008
    db.close()
  })
})

describe("isDuplicateColumnError", () => {
  it("matches only the duplicate-column failure", () => {
    expect(isDuplicateColumnError(new Error('SQLITE_ERROR: duplicate column name: "profiles"'))).toBe(true)
    expect(isDuplicateColumnError(new Error("no such table: posts"))).toBe(false)
  })
})

describe("provisioning seed", () => {
  it("stamps every known migration version", () => {
    // One INSERT per migration + the CREATE TABLE itself.
    expect(MIGRATION_SEED_STATEMENTS.length).toBe(MIGRATIONS.length + 1)
  })
})
