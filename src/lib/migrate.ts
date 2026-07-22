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
  {
    version: 13,
    name: "013_image_license",
    statements: [
      // V1.3 Image SEO profile — site-level image license/creator for
      // licensable-images eligibility. Additive; NULL = no ImageObject nodes.
      `ALTER TABLE seo_settings ADD COLUMN image_license_json TEXT`,
    ],
  },
  {
    version: 14,
    name: "014_llms_exclude",
    statements: [
      // V1.3 AI-SEO profile — per-page llms-full.txt inclusion control.
      // Additive; 0 = included = default.
      `ALTER TABLE posts ADD COLUMN llms_exclude INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 15,
    name: "015_forms_engine",
    statements: [
      // V1.4 F1 — Forms Engine. One machinery, template variants. Additive;
      // empty tables = no forms = today's behavior.
      `CREATE TABLE IF NOT EXISTS forms (
         id TEXT PRIMARY KEY,
         slug TEXT UNIQUE NOT NULL,
         title TEXT NOT NULL,
         fields_json TEXT NOT NULL,
         ack_enabled INTEGER NOT NULL DEFAULT 0,
         ack_subject TEXT,
         ack_body TEXT,
         webhook_url TEXT,
         webhook_secret TEXT,
         active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE TABLE IF NOT EXISTS form_submissions (
         id TEXT PRIMARY KEY,
         form_id TEXT NOT NULL,
         fields_json TEXT NOT NULL,
         page TEXT,
         country TEXT,
         status TEXT NOT NULL DEFAULT 'new',
         notes TEXT,
         thread_json TEXT,
         ai_summary TEXT,
         ai_score TEXT,
         created_at TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (form_id) REFERENCES forms(id) ON DELETE CASCADE
       )`,
      `CREATE TABLE IF NOT EXISTS subscribers (
         id TEXT PRIMARY KEY,
         email TEXT UNIQUE NOT NULL,
         confirmed INTEGER NOT NULL DEFAULT 0,
         confirm_token TEXT,
         unsubscribed INTEGER NOT NULL DEFAULT 0,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions(form_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_form_submissions_status ON form_submissions(status)`,
    ],
  },
  {
    version: 16,
    name: "016_site_mailbox",
    statements: [
      // V1.5 M1 — Site Mailbox. Cloudflare Email Routing receives, a connected
      // provider sends. Additive; empty tables = no mailbox = today's behavior.
      // Messages (both directions) grouped into conversations by thread_key.
      `CREATE TABLE IF NOT EXISTS mail_addresses (
         id TEXT PRIMARY KEY,
         address TEXT UNIQUE NOT NULL,
         label TEXT,
         is_catch_all INTEGER NOT NULL DEFAULT 0,
         active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE TABLE IF NOT EXISTS mail_messages (
         id TEXT PRIMARY KEY,
         thread_key TEXT NOT NULL,
         direction TEXT NOT NULL DEFAULT 'in',
         from_addr TEXT NOT NULL,
         to_addr TEXT NOT NULL,
         subject TEXT,
         body_text TEXT,
         body_html TEXT,
         message_id TEXT,
         in_reply_to TEXT,
         refs TEXT,
         attachments_json TEXT,
         status TEXT NOT NULL DEFAULT 'new',
         spam INTEGER NOT NULL DEFAULT 0,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_mail_thread ON mail_messages(thread_key, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_mail_status ON mail_messages(status, spam)`,
      `CREATE INDEX IF NOT EXISTS idx_mail_msgid ON mail_messages(message_id)`,
    ],
  },
  {
    version: 17,
    name: "017_scoped_api_keys",
    statements: [
      // V1.5 M2 — scoped integration keys (sk_site_…) for n8n/GoHighLevel/etc.
      // Separate from the frozen cms_live_ keys (api_keys) so that contract is
      // untouched. Hashed the same way (PBKDF2), scopes as a JSON array.
      `CREATE TABLE IF NOT EXISTS scoped_api_keys (
         id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         key_hash TEXT UNIQUE NOT NULL,
         key_preview TEXT NOT NULL,
         scopes TEXT NOT NULL DEFAULT '[]',
         last_used_at TEXT,
         usage_count INTEGER NOT NULL DEFAULT 0,
         active INTEGER NOT NULL DEFAULT 1,
         created_at TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_scoped_keys_preview ON scoped_api_keys(key_preview, active)`,
    ],
  },
  {
    version: 18,
    name: "018_analytics_flag",
    statements: [
      // V1.5 M3 — first-party analytics opt-in (Amendment 4a). OFF by default.
      // analytics_key is the public per-site token the beacon carries in a
      // data-attr; it is NOT a secret (no PII is ever collected).
      `ALTER TABLE seo_settings ADD COLUMN analytics_enabled INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE seo_settings ADD COLUMN analytics_key TEXT`,
    ],
  },
  {
    version: 19,
    name: "019_pixel_consent",
    statements: [
      // V1.5 M4 — EU consent mode for ad pixels (Amendment 4b). Tri-state:
      // NULL = auto (ON when any consent-requiring pixel is enabled), 1 = forced
      // ON, 0 = forced OFF. Pixels themselves ride the existing scripts column.
      `ALTER TABLE seo_settings ADD COLUMN pixel_consent INTEGER`,
    ],
  },
  {
    version: 20,
    name: "020_bing_verify",
    statements: [
      // V1.5 M6 — Bing Webmaster Tools verification (meta-tag method). The
      // template emits <meta name="msvalidate.01"> when set. DuckDuckGo rides
      // Bing's index, so this covers both. "" / NULL = no tag (byte-identical).
      `ALTER TABLE seo_settings ADD COLUMN bing_verify TEXT`,
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
