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
// Exported so provisioning can stamp a fresh site's _migrations to the current
// version set (a new site's CREATE TABLEs already include every column).
export const MIGRATIONS: Migration[] = [
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
  {
    version: 6,
    name: "006_seo_cockpit",
    statements: [
      // V1.2 S1 — per-post SEO overrides. Additive; defaults reproduce today's
      // output exactly (the template applies them only when set). The existing
      // seo_*/og_*/canonical_url/no_index columns already cover the rest.
      `ALTER TABLE posts ADD COLUMN sitemap_exclude INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE posts ADD COLUMN nofollow INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE posts ADD COLUMN schema_type TEXT`,
      `ALTER TABLE posts ADD COLUMN faq_json TEXT`,
    ],
  },
  {
    version: 7,
    name: "007_seo_settings",
    statements: [
      // V1.2 S3 — per-site SEO Control Center record. Additive; NO row is
      // inserted, so an unconfigured site reads defaults and stays byte-identical
      // (no robots.txt, RSS/archives on, global schema off).
      `CREATE TABLE IF NOT EXISTS seo_settings (
         id TEXT PRIMARY KEY DEFAULT 'default',
         block_ai_bots INTEGER NOT NULL DEFAULT 0,
         blocked_bots TEXT,
         disallow_paths TEXT,
         robots_extra TEXT,
         rss_enabled INTEGER NOT NULL DEFAULT 1,
         archives_enabled INTEGER NOT NULL DEFAULT 1,
         global_schema_enabled INTEGER NOT NULL DEFAULT 0,
         org_name TEXT,
         org_logo TEXT,
         social_profiles TEXT,
         updated_at TEXT DEFAULT (datetime('now'))
       )`,
    ],
  },
  {
    version: 8,
    name: "008_seo_profiles",
    statements: [
      // V1.3 — SEO profile activations (local/news/ecommerce/image/ai). JSON
      // array of profile ids on the Control Center row. Additive; NULL/absent
      // = no profiles = today's exact behavior.
      `ALTER TABLE seo_settings ADD COLUMN profiles TEXT`,
    ],
  },
  {
    version: 9,
    name: "009_script_controls",
    statements: [
      // V1.3 — vetted script-catalog enablements (JSON [{id, config}]).
      // Additive; NULL/absent = no scripts = today's zero-JS output.
      `ALTER TABLE seo_settings ADD COLUMN scripts TEXT`,
    ],
  },
  {
    version: 10,
    name: "010_business_locations",
    statements: [
      // V1.3 Local SEO profile — NAP stored once per location; multi-location
      // support (each row = a location page + its own LocalBusiness schema).
      // Additive; empty table = no local output = today's behavior.
      `CREATE TABLE IF NOT EXISTS business_locations (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         subtype TEXT,
         street TEXT, city TEXT, region TEXT, postal TEXT, country TEXT,
         phone TEXT,
         hours_json TEXT,
         latitude REAL, longitude REAL,
         service_areas TEXT,
         price_range TEXT,
         gbp_url TEXT,
         rating_value REAL, rating_count INTEGER,
         is_primary INTEGER NOT NULL DEFAULT 0,
         slug TEXT UNIQUE,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
    ],
  },
  {
    version: 11,
    name: "011_news_authors",
    statements: [
      // V1.3 News SEO profile — author system (E-E-A-T backbone, benefits every
      // profile) + IndexNow key. Additive; empty/NULL = today's behavior.
      `CREATE TABLE IF NOT EXISTS authors (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         slug TEXT UNIQUE NOT NULL,
         bio TEXT,
         photo TEXT,
         same_as TEXT,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
      `ALTER TABLE posts ADD COLUMN author_id TEXT`,
      `ALTER TABLE seo_settings ADD COLUMN indexnow_key TEXT`,
    ],
  },
  {
    version: 12,
    name: "012_merchant_seo",
    statements: [
      // V1.3 Ecommerce SEO profile — Merchant-listing depth on products +
      // site-level shipping/returns config. Additive; NULL = today's output.
      `ALTER TABLE products ADD COLUMN brand TEXT`,
      `ALTER TABLE products ADD COLUMN gtin TEXT`,
      `ALTER TABLE products ADD COLUMN mpn TEXT`,
      `ALTER TABLE products ADD COLUMN condition TEXT`,
      `ALTER TABLE products ADD COLUMN rating_value REAL`,
      `ALTER TABLE products ADD COLUMN rating_count INTEGER`,
      `ALTER TABLE seo_settings ADD COLUMN merchant_json TEXT`,
    ],
  },
]

/** True for the SQLite error a re-run of an already-applied ALTER produces.
 *  Tolerating it is what makes ALTER-based migrations idempotent: a site
 *  provisioned AFTER the column shipped (its CREATE TABLE already has it) must
 *  not crash the runner — that would also abort the rest of the site's cron
 *  tick (idempotency GC, webhook retries). */
export function isDuplicateColumnError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /duplicate column name/i.test(msg)
}

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
    // Statements run individually so an already-present column (fresh site
    // whose CREATE TABLE bakes it in) is tolerated instead of failing the
    // whole batch. Re-runs after a partial failure are safe: every statement
    // is CREATE IF NOT EXISTS or a tolerated duplicate ALTER.
    for (const sql of migration.statements) {
      try {
        await db.execute(sql)
      } catch (err) {
        if (!isDuplicateColumnError(err)) throw err
      }
    }
    await db.execute({
      sql: "INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)",
      args: [migration.version, migration.name],
    })
    console.log(`migrate: applied ${migration.name}`)
  }
}
