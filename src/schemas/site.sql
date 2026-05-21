-- site.sql
-- Per-site Turso database schema. Run on every site provision.
-- libSQL = SQLite-compatible.

-- ───────────────── USERS ─────────────────
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  password   TEXT NOT NULL,
  name       TEXT,
  role       TEXT DEFAULT 'admin',
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─────────────── API KEYS ───────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT UNIQUE NOT NULL,
  key_preview  TEXT NOT NULL,
  permissions  TEXT DEFAULT '["read","write"]',
  last_used_at TEXT,
  usage_count  INTEGER DEFAULT 0,
  active       INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- api_key_id is nullable: when a key is deleted, logs are preserved with NULL key_id
-- so the audit trail is not silently destroyed (ON DELETE SET NULL, not CASCADE).
CREATE TABLE IF NOT EXISTS api_logs (
  id         TEXT PRIMARY KEY,
  api_key_id TEXT,
  endpoint   TEXT NOT NULL,
  method     TEXT NOT NULL,
  status     INTEGER NOT NULL,
  post_id    TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

-- ─────────────── CATEGORIES ──────────────
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  description TEXT,
  cover_image TEXT,
  seo_title   TEXT,
  seo_desc    TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ───────────────── POSTS ────────────────
CREATE TABLE IF NOT EXISTS posts (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  slug            TEXT UNIQUE NOT NULL,
  content         TEXT NOT NULL,
  excerpt         TEXT,
  cover_image     TEXT,
  published       INTEGER DEFAULT 0,
  published_at    TEXT,
  type            TEXT DEFAULT 'post',
  category_id     TEXT,
  source          TEXT DEFAULT 'manual',
  seo_title       TEXT,
  seo_description TEXT,
  seo_keywords    TEXT,
  og_title        TEXT,
  og_description  TEXT,
  og_image        TEXT,
  twitter_card    TEXT DEFAULT 'summary_large_image',
  canonical_url   TEXT,
  no_index        INTEGER DEFAULT 0,
  structured_data TEXT,
  scheduled_at    TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS post_images (
  id       TEXT PRIMARY KEY,
  post_id  TEXT NOT NULL,
  url      TEXT NOT NULL,
  alt      TEXT,
  caption  TEXT,
  ord      INTEGER DEFAULT 0,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- ─────────────── MENUS ───────────────
CREATE TABLE IF NOT EXISTS menu_items (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  post_id    TEXT,
  url        TEXT,
  ord        INTEGER DEFAULT 0,
  location   TEXT NOT NULL,
  parent_id  TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─────────────── MEDIA ───────────────
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  url        TEXT NOT NULL,
  filename   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  alt        TEXT,
  caption    TEXT,
  source     TEXT DEFAULT 'manual',
  r2_key     TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ─────────────── SETTINGS ───────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────── IDEMPOTENCY CACHE ───────────────
-- Stores API request/response pairs keyed by sha256(authHeader:Idempotency-Key).
-- GC cron deletes rows where expires_at <= now (TTL = 24 h).
CREATE TABLE IF NOT EXISTS idempotency_cache (
  cache_key   TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  status      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  headers     TEXT NOT NULL DEFAULT '{}',
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ─────────────── WEBHOOKS ───────────────
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  secret         TEXT NOT NULL,
  secret_preview TEXT NOT NULL,
  events         TEXT NOT NULL DEFAULT '["post.created","post.updated","post.deleted","post.published"]',
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
);

-- ─────────────── REDIRECTS / GONE / NOT FOUND ───────────────
-- Stores admin-managed responses for non-content URLs. `kind`:
--   '301' — permanent redirect to `target`
--   '302' — temporary redirect to `target`
--   '410' — gone (no target, returns 410 Gone with optional message)
--   '404' — explicit not-found (override for noisy 404s, optional message)
-- `from_path` is the request path WITH leading slash, no query string.
-- `match_type`: 'exact' (default) or 'prefix' (matches /old/* → /new/...).
CREATE TABLE IF NOT EXISTS redirects (
  id          TEXT PRIMARY KEY,
  from_path   TEXT NOT NULL,
  target      TEXT,
  kind        TEXT NOT NULL DEFAULT '301',
  match_type  TEXT NOT NULL DEFAULT 'exact',
  message     TEXT,
  hit_count   INTEGER DEFAULT 0,
  last_hit_at TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- ─────────────── INDEXES ───────────────
CREATE INDEX IF NOT EXISTS idx_posts_slug       ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_published  ON posts(published, published_at);
CREATE INDEX IF NOT EXISTS idx_posts_category   ON posts(category_id);
CREATE INDEX IF NOT EXISTS idx_posts_type       ON posts(type);
CREATE INDEX IF NOT EXISTS idx_posts_source     ON posts(source);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled  ON posts(scheduled_at) WHERE scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_post_images_post ON post_images(post_id);
CREATE INDEX IF NOT EXISTS idx_media_source     ON media(source);
CREATE INDEX IF NOT EXISTS idx_api_logs_key     ON api_logs(api_key_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_menu_location    ON menu_items(location, ord);
CREATE INDEX IF NOT EXISTS idx_categories_slug  ON categories(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_redirects_from ON redirects(from_path);
CREATE INDEX IF NOT EXISTS idx_redirects_active ON redirects(active);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires       ON idempotency_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry    ON webhook_deliveries(status, next_retry_at)
  WHERE status = 'failed';
