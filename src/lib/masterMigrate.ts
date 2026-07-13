// src/lib/masterMigrate.ts
// Forward-only, idempotent migration runner for the MASTER Turso database.
// Mirror of src/lib/migrate.ts (per-site runner) — the master DB previously had
// no migration mechanism at all (schemas/master.sql was applied by hand once).
// All SaaS control-plane tables are created here; the pre-existing `sites`
// table is never touched.
//
// Invocation: lazily from SaaS request paths via ensureMasterSchema(), which
// runs at most once per isolate. Safe to call concurrently — every statement
// is idempotent (IF NOT EXISTS) and version inserts use INSERT OR IGNORE.

import type { Client } from "@libsql/client/web"

interface MasterMigration {
  version: number
  name: string
  statements: string[]
}

// Each entry is an ordered list of idempotent DDL statements.
// Add new migrations at the end; never edit existing entries.
export const MASTER_MIGRATIONS: MasterMigration[] = [
  {
    version: 1,
    name: "001_saas_foundation",
    statements: [
      // Platform customers. `plan` is the tier seam (decision B): flat
      // 'unlimited_sites' at launch; new tiers are new values, no migration.
      // plan_status: 'trialing' | 'active' | 'expired' | 'canceled'.
      `CREATE TABLE IF NOT EXISTS customers (
         id             TEXT PRIMARY KEY,
         email          TEXT UNIQUE NOT NULL,
         password       TEXT NOT NULL,
         name           TEXT,
         plan           TEXT NOT NULL DEFAULT 'unlimited_sites',
         plan_status    TEXT NOT NULL DEFAULT 'trialing',
         trial_ends_at  TEXT,
         email_verified INTEGER NOT NULL DEFAULT 0,
         created_at     TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email)`,

      // Single-use tokens for email verification + password reset.
      // Raw token is emailed; only its SHA-256 hex is stored.
      `CREATE TABLE IF NOT EXISTS customer_tokens (
         id          TEXT PRIMARY KEY,
         customer_id TEXT NOT NULL,
         kind        TEXT NOT NULL,
         token_hash  TEXT UNIQUE NOT NULL,
         expires_at  TEXT NOT NULL,
         used_at     TEXT,
         created_at  TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_customer_tokens_customer ON customer_tokens(customer_id, kind)`,

      // Audit trail — every credential use / security-relevant action
      // (spec Security Covenant S4). Append-only.
      `CREATE TABLE IF NOT EXISTS audit_log (
         id          TEXT PRIMARY KEY,
         customer_id TEXT,
         action      TEXT NOT NULL,
         target      TEXT,
         meta        TEXT,
         created_at  TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_log_customer ON audit_log(customer_id, created_at)`,

      // Generic async-work records (prompt dispatches, rebuild jobs, …).
      // Modeled on webhook_deliveries. Provisioning gets its own
      // provisioning_runs table in Phase 3.
      `CREATE TABLE IF NOT EXISTS jobs (
         id          TEXT PRIMARY KEY,
         customer_id TEXT,
         kind        TEXT NOT NULL,
         status      TEXT NOT NULL DEFAULT 'pending',
         payload     TEXT,
         result      TEXT,
         created_at  TEXT DEFAULT (datetime('now')),
         updated_at  TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id, kind, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`,
    ],
  },
]

/** Apply all unapplied master migrations. Idempotent; safe to re-run. */
export async function runMasterMigrations(db: Client): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT DEFAULT (datetime('now'))
     )`
  )
  const applied = new Set<number>()
  const rows = await db.execute("SELECT version FROM _migrations")
  for (const r of rows.rows) applied.add(Number(r.version))

  for (const m of MASTER_MIGRATIONS) {
    if (applied.has(m.version)) continue
    // Single write batch so a partial failure cannot half-apply a version.
    await db.batch(
      [
        ...m.statements.map((sql) => ({ sql, args: [] as never[] })),
        {
          sql: "INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)",
          args: [m.version, m.name] as unknown as never[],
        },
      ],
      "write"
    )
  }
}

// Once-per-isolate latch. A failed run clears the latch so the next request
// retries instead of permanently caching the failure.
let ensured: Promise<void> | null = null

/** Ensure the master schema exists. Runs migrations at most once per isolate. */
export function ensureMasterSchema(db: Client): Promise<void> {
  if (!ensured) {
    ensured = runMasterMigrations(db).catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}
