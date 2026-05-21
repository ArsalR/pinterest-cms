-- 003_webhooks.sql
-- Adds webhook_endpoints and webhook_deliveries tables.
-- All statements are idempotent (CREATE TABLE/INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id             TEXT PRIMARY KEY,
  url            TEXT NOT NULL,
  secret         TEXT NOT NULL,       -- raw secret; shown once on creation, used for HMAC signing
  secret_preview TEXT NOT NULL,       -- last 4 chars for UI identification only
  events         TEXT NOT NULL DEFAULT '["post.created","post.updated","post.deleted","post.published"]',
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT DEFAULT (datetime('now'))
);

-- Delivery audit log and retry queue.
-- status: pending | delivered | failed | dead
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

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry    ON webhook_deliveries(status, next_retry_at)
  WHERE status = 'failed';
