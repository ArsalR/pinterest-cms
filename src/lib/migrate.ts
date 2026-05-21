// src/lib/migrate.ts
// Forward-only, idempotent migration runner for per-site Turso databases.
// SQL is inlined (no filesystem reads at Worker runtime).
// Called from the scheduled cron handler — all active sites are migrated
// within one cron tick (every 5 min) after a deploy.

import type { Client } from "@libsql/client/web"

interface Migration {
  version: number
  name: string
  statements: string[]
}

// Each entry is an ordered list of idempotent DDL statements.
// Add new migrations at the end; never edit existing entries.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "001_idempotency",
    statements: [
      `CREATE TABLE IF NOT EXISTS idempotency_cache (
         cache_key   TEXT PRIMARY KEY,
         fingerprint TEXT NOT NULL,
         status      INTEGER NOT NULL,
         body        TEXT NOT NULL,
         headers     TEXT NOT NULL DEFAULT '{}',
         expires_at  TEXT NOT NULL,
         created_at  TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_cache(expires_at)`,
    ],
  },
  {
    version: 2,
    name: "002_post_indexes",
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug)`,
      `CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type)`,
      `CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published, published_at)`,
      `CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at)`,
    ],
  },
  {
    version: 3,
    name: "003_webhooks",
    statements: [
      `CREATE TABLE IF NOT EXISTS webhook_endpoints (
         id             TEXT PRIMARY KEY,
         url            TEXT NOT NULL,
         secret         TEXT NOT NULL,
         secret_preview TEXT NOT NULL,
         events         TEXT NOT NULL DEFAULT '["post.created","post.updated","post.deleted","post.published"]',
         active         INTEGER NOT NULL DEFAULT 1,
         created_at     TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE TABLE IF NOT EXISTS webhook_deliveries (
         id              TEXT PRIMARY KEY,
         endpoint_id     TEXT NOT NULL,
         event           TEXT NOT NULL,
         payload         TEXT NOT NULL,
         attempt         INTEGER NOT NULL DEFAULT 1,
         status          TEXT NOT NULL DEFAULT 'pending',
         response_status INTEGER,
         response_body   TEXT,
         next_retry_at   TEXT,
         delivered_at    TEXT,
         created_at      TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
       )`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id)`,
      `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, next_retry_at)
         WHERE status = 'failed'`,
    ],
  },
]

export async function runMigrations(db: Client): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT DEFAULT (datetime('now'))
     )`
  )

  const applied = await db.execute("SELECT version FROM _migrations")
  const done = new Set(applied.rows.map((r) => Number(r.version)))

  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue
    for (const stmt of migration.statements) {
      await db.execute(stmt)
    }
    await db.execute({
      sql: "INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)",
      args: [migration.version, migration.name],
    })
    console.log(`migrate: applied ${migration.name}`)
  }
}
