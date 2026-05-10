-- master.sql
-- Master Turso database — maps hostnames to per-site Turso credentials.
-- Run once on first deployment.

CREATE TABLE IF NOT EXISTS sites (
  id           TEXT PRIMARY KEY,
  hostname     TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  turso_url    TEXT NOT NULL,
  turso_token  TEXT NOT NULL,
  active       INTEGER DEFAULT 1,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sites_hostname ON sites(hostname);
CREATE INDEX IF NOT EXISTS idx_sites_active   ON sites(active);
