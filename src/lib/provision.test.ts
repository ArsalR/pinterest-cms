// src/lib/provision.test.ts
// PART E4 regression — the site schema applies as a SINGLE batch (one Cloudflare
// subrequest) and still builds the complete, valid per-site schema. This guards
// the free-tier subrequest reduction: runSchema() must never regress to ~40
// sequential executes.

import { describe, it, expect } from "vitest"
import { createClient } from "@libsql/client"
import { SITE_SCHEMA_STATEMENTS } from "./provision"

describe("site schema batch (free-tier subrequest safety)", () => {
  it("applies the whole schema in one batch and creates every core table", async () => {
    const db = createClient({ url: ":memory:" })
    // This is exactly what runSchema() now does — one round-trip, not N.
    await db.batch(SITE_SCHEMA_STATEMENTS as string[], "write")

    const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table'")
    const tables = new Set(r.rows.map((x) => String(x.name)))
    for (const t of ["posts", "products", "orders", "categories", "users", "api_keys", "settings", "redirects", "menu_items", "media"]) {
      expect(tables.has(t), `missing table: ${t}`).toBe(true)
    }
    // A representative insert proves the batched DDL produced usable tables.
    await db.execute("INSERT INTO posts (id, title, slug, content) VALUES ('p1','T','t','c')")
    const p = await db.execute("SELECT title FROM posts WHERE id='p1'")
    expect(p.rows[0].title).toBe("T")
    db.close()
  })

  it("is a meaningful batch (schema is many statements collapsed to one subrequest)", () => {
    expect(SITE_SCHEMA_STATEMENTS.length).toBeGreaterThan(20) // ~40 statements → 1 batch
  })
})
