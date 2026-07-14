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
  {
    version: 4,
    name: "004_rate_limit",
    statements: [
      `CREATE TABLE IF NOT EXISTS rate_limit_counters (
         bucket  TEXT NOT NULL,
         window  TEXT NOT NULL,
         count   INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (bucket, window)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_counters(window)`,
    ],
  },
  {
    version: 5,
    name: "005_ecommerce",
    statements: [
      // Ecommerce data model (amendment 2). Additive; inert for non-store sites.
      `CREATE TABLE IF NOT EXISTS products (
         id            TEXT PRIMARY KEY,
         slug          TEXT UNIQUE NOT NULL,
         title         TEXT NOT NULL,
         description   TEXT,
         price_cents   INTEGER NOT NULL DEFAULT 0,
         currency      TEXT NOT NULL DEFAULT 'usd',
         images        TEXT NOT NULL DEFAULT '[]',
         sku           TEXT,
         stock_status  TEXT NOT NULL DEFAULT 'in_stock',
         digital       INTEGER NOT NULL DEFAULT 0,
         published     INTEGER NOT NULL DEFAULT 0,
         category_id   TEXT,
         seo_title     TEXT,
         seo_description TEXT,
         structured_data TEXT,
         source        TEXT DEFAULT 'manual',
         created_at    TEXT DEFAULT (datetime('now')),
         updated_at    TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
       )`,
      // stripe_session_id UNIQUE = order idempotency (the 4.5e webhook may fire twice).
      `CREATE TABLE IF NOT EXISTS orders (
         id                 TEXT PRIMARY KEY,
         stripe_session_id  TEXT UNIQUE,
         email              TEXT,
         amount_total_cents INTEGER NOT NULL DEFAULT 0,
         currency           TEXT NOT NULL DEFAULT 'usd',
         items              TEXT NOT NULL DEFAULT '[]',
         status             TEXT NOT NULL DEFAULT 'paid',
         created_at         TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug)`,
      `CREATE INDEX IF NOT EXISTS idx_products_published ON products(published)`,
      `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)`,
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
    // Execute all DDL statements + record the migration atomically so a partial
    // failure cannot leave the schema half-applied.
    await db.batch(
      [
        ...migration.statements.map((sql) => ({ sql, args: [] as never[] })),
        {
          sql: "INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)",
          args: [migration.version, migration.name] as [number, string],
        },
      ],
      "write"
    )
    console.log(`migrate: applied ${migration.name}`)
  }
}
