// src/lib/provision.ts
// Auto-provision a new site in one API call. No manual steps.
//   1. Create Turso DB
//   2. Mint auth token for that DB
//   3. Run schema migrations
//   4. Insert default settings
//   5. Create admin user
//   6. Create default API key
//   7. Register in master DB
//   8. (optional) Add Cloudflare DNS CNAME

import type { CloudflareEnv } from "./types"
import { getMasterDb, getSiteDb } from "./turso"
import { hashPassword, generateApiKey } from "./auth"
import { cuid } from "./utils"
import { insertDefaultSettings } from "./defaults"
import { MIGRATIONS } from "./migrate"

export interface ProvisionInput {
  hostname: string
  name: string
  adminEmail: string
  adminPassword: string
  /** Optional — when true, attempt to create a CNAME via Cloudflare API. */
  configureDns?: boolean
}

export interface ProvisionResult {
  hostname: string
  adminUrl: string
  apiKey: string
  tursoUrl: string
  siteId: string
}

interface TursoCreateDbResponse {
  database?: { Name: string; Hostname: string; DbId?: string }
  // Older API shapes — handle defensively.
  Name?: string
  Hostname?: string
}

interface TursoTokenResponse {
  jwt: string
}

/** Pretty-print Turso API errors and rethrow with context. */
async function tursoCall<T>(
  url: string,
  init: RequestInit,
  step: string
): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Turso API failed at "${step}" (${resp.status}): ${body}`)
  }
  return (await resp.json()) as T
}

export async function createSite(
  env: CloudflareEnv,
  input: ProvisionInput
): Promise<ProvisionResult> {
  const hostname = input.hostname.toLowerCase().trim()
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.length < 4) {
    throw new Error("Invalid hostname")
  }
  if (!input.adminPassword || input.adminPassword.length < 8) {
    throw new Error("Admin password must be at least 8 characters")
  }

  // ─── 1. Verify hostname not already registered ───
  const masterDb = getMasterDb(env)
  const existing = await masterDb.execute({
    sql: "SELECT id FROM sites WHERE hostname = ?",
    args: [hostname],
  })
  if (existing.rows.length) {
    throw new Error(`Hostname '${hostname}' is already registered`)
  }

  // ─── 2. Create Turso database ───
  // Turso DB names: lowercase letters, digits, hyphens. Dots → hyphens.
  const dbName = hostname.replace(/[^a-z0-9-]/g, "-").slice(0, 64)

  const dbResp = await tursoCall<TursoCreateDbResponse>(
    `https://api.turso.tech/v1/organizations/${env.TURSO_ORG}/databases`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURSO_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: dbName, group: env.TURSO_GROUP }),
    },
    "create database"
  )

  const tursoHost = dbResp.database?.Hostname ?? dbResp.Hostname
  if (!tursoHost) throw new Error("Turso did not return a database hostname")
  const tursoUrl = `libsql://${tursoHost}`

  // ─── 3. Mint auth token ───
  const tokenResp = await tursoCall<TursoTokenResponse>(
    `https://api.turso.tech/v1/organizations/${env.TURSO_ORG}/databases/${dbName}/auth/tokens?expiration=none&authorization=full-access`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURSO_API_TOKEN}` },
    },
    "mint auth token"
  )
  const tursoToken = tokenResp.jwt
  if (!tursoToken) throw new Error("Turso did not return an auth token")

  // ─── 4. Run schema ───
  const siteDb = getSiteDb(tursoUrl, tursoToken)
  await runSchema(siteDb)

  // ─── 5. Defaults ───
  await insertDefaultSettings(siteDb, {
    hostname,
    siteName: input.name,
    adminEmail: input.adminEmail,
  })

  // ─── 6. Admin user ───
  const passwordHash = await hashPassword(input.adminPassword)
  await siteDb.execute({
    sql: `INSERT INTO users (id, email, password, name, role) VALUES (?, ?, ?, ?, 'admin')`,
    args: [cuid(), input.adminEmail.toLowerCase(), passwordHash, input.adminEmail.split("@")[0]],
  })

  // ─── 7. Default API key ───
  const rawKey = generateApiKey()
  const keyHash = await hashPassword(rawKey)
  const keyPreview = rawKey.slice(-4)
  await siteDb.execute({
    sql: `INSERT INTO api_keys (id, name, key_hash, key_preview, permissions)
          VALUES (?, 'Automation Bot', ?, ?, '["read","write"]')`,
    args: [cuid(), keyHash, keyPreview],
  })

  // ─── 8. Register in master DB ───
  const siteId = cuid()
  await masterDb.execute({
    sql: `INSERT INTO sites (id, hostname, name, turso_url, turso_token)
          VALUES (?, ?, ?, ?, ?)`,
    args: [siteId, hostname, input.name, tursoUrl, tursoToken],
  })

  // ─── 9. DNS (best-effort) ───
  if (input.configureDns) {
    await addCloudflareDnsRecord(env, hostname).catch((err) => {
      console.error(`DNS automation failed for ${hostname}:`, err)
    })
  }

  return {
    hostname,
    adminUrl: `https://${hostname}/admin`,
    apiKey: rawKey,
    tursoUrl,
    siteId,
  }
}

// Inlined schema — avoids runtime dependency on GitHub availability.
// Keep in sync with src/schemas/site.sql (source of truth for documentation).
export const SITE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, name TEXT, role TEXT DEFAULT 'admin', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, key_preview TEXT NOT NULL, permissions TEXT DEFAULT '["read","write"]', last_used_at TEXT, usage_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS api_logs (id TEXT PRIMARY KEY, api_key_id TEXT, endpoint TEXT NOT NULL, method TEXT NOT NULL, status INTEGER NOT NULL, post_id TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL)`,
  `CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT, cover_image TEXT, seo_title TEXT, seo_desc TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, content TEXT NOT NULL, excerpt TEXT, cover_image TEXT, published INTEGER DEFAULT 0, published_at TEXT, type TEXT DEFAULT 'post', category_id TEXT, source TEXT DEFAULT 'manual', seo_title TEXT, seo_description TEXT, seo_keywords TEXT, og_title TEXT, og_description TEXT, og_image TEXT, twitter_card TEXT DEFAULT 'summary_large_image', canonical_url TEXT, no_index INTEGER DEFAULT 0, structured_data TEXT, sitemap_exclude INTEGER NOT NULL DEFAULT 0, nofollow INTEGER NOT NULL DEFAULT 0, schema_type TEXT, faq_json TEXT, scheduled_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL)`,
  `CREATE TABLE IF NOT EXISTS post_images (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, url TEXT NOT NULL, alt TEXT, caption TEXT, ord INTEGER DEFAULT 0, FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS menu_items (id TEXT PRIMARY KEY, label TEXT NOT NULL, post_id TEXT, url TEXT, ord INTEGER DEFAULT 0, location TEXT NOT NULL, parent_id TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, url TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER, alt TEXT, caption TEXT, source TEXT DEFAULT 'manual', r2_key TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS idempotency_cache (cache_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, headers TEXT NOT NULL DEFAULT '{}', expires_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS rate_limit_counters (bucket TEXT NOT NULL, window TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bucket, window))`,
  `CREATE TABLE IF NOT EXISTS webhook_endpoints (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, secret_preview TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["post.created","post.updated","post.deleted","post.published"]', active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, endpoint_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'pending', response_status INTEGER, response_body TEXT, next_retry_at TEXT, delivered_at TEXT, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS redirects (id TEXT PRIMARY KEY, from_path TEXT NOT NULL, target TEXT, kind TEXT NOT NULL DEFAULT '301', match_type TEXT NOT NULL DEFAULT 'exact', message TEXT, hit_count INTEGER DEFAULT 0, last_hit_at TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`,
  // V1.2 S3 — per-site SEO Control Center. Additive; no row until configured, so
  // an unconfigured site reads defaults and builds byte-identically.
  `CREATE TABLE IF NOT EXISTS seo_settings (id TEXT PRIMARY KEY DEFAULT 'default', block_ai_bots INTEGER NOT NULL DEFAULT 0, blocked_bots TEXT, disallow_paths TEXT, robots_extra TEXT, rss_enabled INTEGER NOT NULL DEFAULT 1, archives_enabled INTEGER NOT NULL DEFAULT 1, global_schema_enabled INTEGER NOT NULL DEFAULT 0, org_name TEXT, org_logo TEXT, social_profiles TEXT, profiles TEXT, scripts TEXT, updated_at TEXT DEFAULT (datetime('now')))`,
  // Ecommerce (amendment 2, kind='ecommerce' sites). Additive — inert for content sites.
  `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, title TEXT NOT NULL, description TEXT, price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd', images TEXT NOT NULL DEFAULT '[]', sku TEXT, stock_status TEXT NOT NULL DEFAULT 'in_stock', digital INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0, category_id TEXT, seo_title TEXT, seo_description TEXT, structured_data TEXT, source TEXT DEFAULT 'manual', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, stripe_session_id TEXT UNIQUE, email TEXT, amount_total_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd', items TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'paid', created_at TEXT DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_products_published ON products(published)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published, published_at)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_category ON posts(category_id)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(type)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_source ON posts(source)`,
  `CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at) WHERE scheduled_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_post_images_post ON post_images(post_id)`,
  `CREATE INDEX IF NOT EXISTS idx_media_source ON media(source)`,
  `CREATE INDEX IF NOT EXISTS idx_api_logs_key ON api_logs(api_key_id)`,
  `CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_menu_location ON menu_items(location, ord)`,
  `CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_redirects_from ON redirects(from_path)`,
  `CREATE INDEX IF NOT EXISTS idx_redirects_active ON redirects(active)`,
  `CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_cache(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_counters(window)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id)`,
  `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, next_retry_at) WHERE status = 'failed'`,
]

/** A fresh site's CREATE TABLEs already include every migrated column, so its
 *  _migrations table is stamped to the current version set at provisioning —
 *  the cron runner then has nothing to (re)apply. Migration names are internal
 *  constants, safe to inline. */
export const MIGRATION_SEED_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now')))`,
  ...MIGRATIONS.map(
    (m) => `INSERT OR IGNORE INTO _migrations (version, name) VALUES (${m.version}, '${m.name}')`
  ),
]

/** Apply the site schema to a freshly created Turso database. Uses a single
 *  batch (one HTTP round-trip / subrequest) instead of ~40 sequential executes
 *  — critical on Cloudflare's free tier (50 subrequests per invocation), and
 *  atomic besides. Behavior-identical: same statements, same order. */
async function runSchema(siteDb: ReturnType<typeof getSiteDb>): Promise<void> {
  await siteDb.batch([...SITE_SCHEMA_STATEMENTS, ...MIGRATION_SEED_STATEMENTS], "write")
}

/** Add a CNAME for hostname → workers.dev domain via Cloudflare API. */
async function addCloudflareDnsRecord(env: CloudflareEnv, hostname: string): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return
  // For sites on a zone you control, we add a CNAME to your worker route.
  // For arbitrary customer domains, use Cloudflare for SaaS custom hostnames instead.
  await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "CNAME",
      name: hostname,
      content: `pinterest-cms.workers.dev`,
      ttl: 1, // Auto
      proxied: true,
    }),
  })
}

/** Delete a site from the master DB. Does NOT drop the Turso DB by default. */
export async function deactivateSite(env: CloudflareEnv, siteId: string): Promise<void> {
  const db = getMasterDb(env)
  await db.execute({
    sql: "UPDATE sites SET active = 0 WHERE id = ?",
    args: [siteId],
  })
}

export async function deleteSiteFromMaster(env: CloudflareEnv, siteId: string): Promise<void> {
  const db = getMasterDb(env)
  await db.execute({ sql: "DELETE FROM sites WHERE id = ?", args: [siteId] })
}
