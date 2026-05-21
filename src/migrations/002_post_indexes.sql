-- 002_post_indexes.sql
-- Extra indexes to support slug/type/date lookups added in Phase 2.
-- All statements are idempotent (CREATE INDEX IF NOT EXISTS).
-- Already present in site.sql for new sites; this file backfills existing sites
-- once the migration runner (Phase 1 / feat/idempotency) is in place.

CREATE INDEX IF NOT EXISTS idx_posts_slug      ON posts(slug);
CREATE INDEX IF NOT EXISTS idx_posts_type      ON posts(type);
CREATE INDEX IF NOT EXISTS idx_posts_published ON posts(published, published_at);
-- Dedicated published_at index for date-range ORDER BY queries.
CREATE INDEX IF NOT EXISTS idx_posts_published_at ON posts(published_at);
