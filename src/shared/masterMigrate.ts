// src/shared/masterMigrate.ts
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
  {
    version: 2,
    name: "002_saas_rate_limits",
    statements: [
      // Fixed-window counters for auth-endpoint rate limiting (per-IP and
      // per-account). window embeds the window length so different rules
      // never collide. Expired rows are GC'd opportunistically on first hit
      // of a fresh window (see src/lib/saas/rateLimit.ts).
      `CREATE TABLE IF NOT EXISTS saas_rate_limits (
         bucket     TEXT NOT NULL,
         window     TEXT NOT NULL,
         count      INTEGER NOT NULL DEFAULT 0,
         expires_at TEXT NOT NULL,
         PRIMARY KEY (bucket, window)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_saas_rate_limits_expires ON saas_rate_limits(expires_at)`,
    ],
  },
  {
    version: 3,
    name: "003_connections",
    statements: [
      // BYO-infrastructure connections (Phase 2). encrypted_payload is a
      // vault envelope (see lib/saas/vault.ts) — NULL for providers with no
      // stored secret (github: only installation metadata). meta is
      // non-secret JSON safe to render (account names, previews, zone ids).
      // status: 'active' | 'invalid' | 'revoked'.
      `CREATE TABLE IF NOT EXISTS connections (
         id                TEXT PRIMARY KEY,
         customer_id       TEXT NOT NULL,
         provider          TEXT NOT NULL,
         encrypted_payload TEXT,
         meta              TEXT NOT NULL DEFAULT '{}',
         status            TEXT NOT NULL DEFAULT 'active',
         created_at        TEXT DEFAULT (datetime('now')),
         last_verified_at  TEXT,
         FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_customer_provider
         ON connections(customer_id, provider)`,
    ],
  },
  {
    version: 4,
    name: "004_provisioning",
    statements: [
      // SaaS-managed customer sites (Phase 3). Links a customer to their repo,
      // their Workers deployment, their domain, and the CMS backing workspace
      // (cms_site_id = master registry row id — linkage lives HERE so
      // resolveSite's SELECT and its cached shape stay untouched).
      // canonical_host: 'apex' | 'www' (wizard choice).
      // status: 'provisioning' | 'active' | 'failed' | 'detached'.
      `CREATE TABLE IF NOT EXISTS customer_sites (
         id              TEXT PRIMARY KEY,
         customer_id     TEXT NOT NULL,
         cms_site_id     TEXT,
         cms_hostname    TEXT,
         repo_full_name  TEXT,
         worker_name     TEXT,
         domain          TEXT NOT NULL,
         canonical_host  TEXT NOT NULL DEFAULT 'apex',
         zone_id         TEXT,
         name            TEXT NOT NULL,
         niche           TEXT,
         status          TEXT NOT NULL DEFAULT 'provisioning',
         created_at      TEXT DEFAULT (datetime('now')),
         updated_at      TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_sites_domain ON customer_sites(domain)`,
      `CREATE INDEX IF NOT EXISTS idx_customer_sites_customer ON customer_sites(customer_id)`,

      // Idempotent + resumable provisioning (spec non-negotiable): one row
      // per (run, step) with per-step status: 'pending' | 'running' | 'done'
      // | 'failed' | 'skipped'. Retry re-executes from the first non-done step.
      `CREATE TABLE IF NOT EXISTS provisioning_runs (
         id               TEXT PRIMARY KEY,
         customer_site_id TEXT NOT NULL,
         step             TEXT NOT NULL,
         ord              INTEGER NOT NULL,
         status           TEXT NOT NULL DEFAULT 'pending',
         error            TEXT,
         detail           TEXT,
         started_at       TEXT,
         finished_at      TEXT,
         created_at       TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (customer_site_id) REFERENCES customer_sites(id) ON DELETE CASCADE
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_provisioning_runs_site_step
         ON provisioning_runs(customer_site_id, step)`,
      `CREATE INDEX IF NOT EXISTS idx_provisioning_runs_site
         ON provisioning_runs(customer_site_id, ord)`,
    ],
  },
  {
    version: 5,
    name: "005_turnstile",
    statements: [
      // Per-site Turnstile widget (created on the CUSTOMER's CF account
      // during provisioning — locked in review). secret_enc is a vault
      // envelope; the contact-form relay decrypts it to call siteverify.
      `CREATE TABLE IF NOT EXISTS site_turnstile (
         customer_site_id TEXT PRIMARY KEY,
         sitekey          TEXT NOT NULL,
         secret_enc       TEXT NOT NULL,
         created_at       TEXT DEFAULT (datetime('now')),
         FOREIGN KEY (customer_site_id) REFERENCES customer_sites(id) ON DELETE CASCADE
       )`,
    ],
  },
  {
    version: 6,
    name: "006_site_kind",
    statements: [
      // Amendment 2: per-site kind (content | ecommerce | local-business |
      // portfolio). Runner applies each version exactly once (tracked in
      // _migrations), so a plain ADD COLUMN is safe — no IF NOT EXISTS needed.
      // Existing rows default to 'content' → behavior unchanged.
      `ALTER TABLE customer_sites ADD COLUMN kind TEXT NOT NULL DEFAULT 'content'`,
    ],
  },
  {
    version: 7,
    name: "007_site_metrics",
    statements: [
      // Phase 6: cached metric rollups (CWV RUM, uptime, 404s, GSC) so the
      // dashboard doesn't hammer external APIs. One row per (site, day, source).
      `CREATE TABLE IF NOT EXISTS site_metrics (
         customer_site_id TEXT NOT NULL,
         day              TEXT NOT NULL,
         source           TEXT NOT NULL,
         payload          TEXT NOT NULL DEFAULT '{}',
         updated_at       TEXT DEFAULT (datetime('now')),
         PRIMARY KEY (customer_site_id, day, source)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_site_metrics_site ON site_metrics(customer_site_id, source)`,
    ],
  },
  {
    version: 8,
    name: "008_agency",
    statements: [
      // Phase 9 — agency mode (K11). White-label branding per customer…
      `CREATE TABLE IF NOT EXISTS agency_settings (
         customer_id  TEXT PRIMARY KEY,
         enabled      INTEGER NOT NULL DEFAULT 0,
         brand_name   TEXT,
         brand_color  TEXT,
         logo_url     TEXT,
         reports_enabled INTEGER NOT NULL DEFAULT 0,
         updated_at   TEXT DEFAULT (datetime('now'))
       )`,
      // …and client seats: a scoped, read-only view of assigned sites' reports,
      // accessed by signed link (no password). site_ids is a JSON array.
      `CREATE TABLE IF NOT EXISTS client_seats (
         id           TEXT PRIMARY KEY,
         customer_id  TEXT NOT NULL,
         label        TEXT NOT NULL,
         email        TEXT NOT NULL,
         site_ids     TEXT NOT NULL DEFAULT '[]',
         last_report_at TEXT,
         created_at   TEXT DEFAULT (datetime('now'))
       )`,
      `CREATE INDEX IF NOT EXISTS idx_client_seats_customer ON client_seats(customer_id)`,
    ],
  },
  {
    version: 9,
    name: "009_platform_billing",
    statements: [
      // Phase 9b — platform subscriptions. Additive columns; plan/plan_status/
      // trial_ends_at exist since v1 and stay authoritative for gating.
      `ALTER TABLE customers ADD COLUMN stripe_customer_id TEXT`,
      `ALTER TABLE customers ADD COLUMN stripe_subscription_id TEXT`,
    ],
  },
  {
    version: 10,
    name: "010_design_options",
    statements: [
      // V1.1 — genesis design options. Additive columns; written into the site's
      // site.config.json at provisioning and consumed by the template's preset/
      // layout token system. NULL/absent falls back to the template defaults.
      `ALTER TABLE customer_sites ADD COLUMN design_preset TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN layout_variant TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN tone TEXT`,
    ],
  },
  {
    version: 11,
    name: "011_forms_sending_domain",
    statements: [
      // V1.4 F1 — optional per-site custom sending domain (Resend-verified).
      // NULL = platform default (forms@arsal.app).
      `ALTER TABLE customer_sites ADD COLUMN forms_domain TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN forms_domain_id TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN forms_domain_status TEXT`,
    ],
  },
  {
    version: 12,
    name: "012_site_mailbox",
    statements: [
      // V1.5 M1 — Site Mailbox per-site config. All additive on customer_sites.
      // Receiving: Cloudflare Email Routing on the customer's zone (status
      // tracks provisioning). Sending: a connected provider with a per-site,
      // vault-encrypted API key. inbound_secret signs the email-worker → platform
      // callback (same HMAC scheme as webhooks).
      `ALTER TABLE customer_sites ADD COLUMN mail_routing_status TEXT DEFAULT 'off'`,
      `ALTER TABLE customer_sites ADD COLUMN mail_inbound_secret TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN mail_provider TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN mail_provider_secret_enc TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN mail_provider_status TEXT`,
      `ALTER TABLE customer_sites ADD COLUMN mail_from_name TEXT`,
    ],
  },
  {
    version: 13,
    name: "013_site_analytics",
    statements: [
      // V1.5 M3 — first-party analytics. The public beacon POSTs an opaque
      // per-site token; the ingest endpoint resolves it here (master-only, no
      // hostname needed). The SAME token is mirrored into the site's CMS
      // seo_settings so the static build embeds it. NULL = analytics off.
      `ALTER TABLE customer_sites ADD COLUMN analytics_key TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_customer_sites_analytics_key ON customer_sites(analytics_key)`,
    ],
  },
  {
    version: 14,
    name: "014_sub_sites",
    statements: [
      // V1.5 M5 — sub-sites. A subdomain (or, later, subdirectory) site is a
      // full separate site that reuses its parent's Cloudflare zone. NULL =
      // top-level site (today's behavior). Self-referential FK to customer_sites.
      `ALTER TABLE customer_sites ADD COLUMN parent_site_id TEXT`,
      `CREATE INDEX IF NOT EXISTS idx_customer_sites_parent ON customer_sites(parent_site_id)`,
    ],
  },
]

// Site kinds (amendment 2). Shared core (both covenants, trust pages, SEO
// set); differ in layout + content model. Only ecommerce carries commerce.
export const SITE_KINDS = ["content", "ecommerce", "local-business", "portfolio"] as const
export type SiteKind = (typeof SITE_KINDS)[number]

export function isSiteKind(v: string): v is SiteKind {
  return (SITE_KINDS as readonly string[]).includes(v)
}

export const SITE_KIND_LABELS: Record<SiteKind, string> = {
  content: "Blog / content site",
  ecommerce: "Online store",
  "local-business": "Local business",
  portfolio: "Portfolio / services",
}

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
