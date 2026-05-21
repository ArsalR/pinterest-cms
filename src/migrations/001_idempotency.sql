-- 001_idempotency.sql
-- Adds idempotency_cache table for Phase 1 (feat/idempotency).
-- Idempotent — safe to run on any site regardless of current state.

CREATE TABLE IF NOT EXISTS idempotency_cache (
  cache_key   TEXT PRIMARY KEY,       -- sha256(authHeader:idempotencyKey)
  fingerprint TEXT NOT NULL,          -- sha256(method:path:body) — conflict detection
  status      INTEGER NOT NULL,
  body        TEXT NOT NULL,
  headers     TEXT NOT NULL DEFAULT '{}',
  expires_at  TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_cache(expires_at);
