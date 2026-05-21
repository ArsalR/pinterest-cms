-- 004_rate_limit.sql
-- Fixed-window per-minute rate limit counters keyed by API key preview.
-- Rows older than the current window are pruned by the cron GC.

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket  TEXT NOT NULL,  -- last-4-chars preview of the API key
  window  TEXT NOT NULL,  -- "YYYY-MM-DDTHH:MM" (UTC, 1-minute bucket)
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_counters(window);
