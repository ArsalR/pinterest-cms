// src/lib/saas/rateLimit.ts
// Fixed-window rate limiting for SaaS auth endpoints, backed by the master DB
// (saas_rate_limits table, master migration v2). Protects signup/login/reset
// against credential stuffing and reset-email bombing — day-one attacks.
//
// Keyed per-IP (CF-Connecting-IP, set by Cloudflare) AND per-account where an
// account identifier exists. FAIL-OPEN on DB errors (a master-DB blip must not
// lock every customer out; the tradeoff is documented) — errors are logged.

import type { Client } from "@libsql/client/web"

export interface LimitRule {
  /** Max requests allowed per window. */
  max: number
  /** Window length in seconds. */
  windowSecs: number
}

// One place to tune every auth limit.
export const AUTH_LIMITS = {
  signupIp: { max: 5, windowSecs: 3600 } as LimitRule,
  loginIp: { max: 10, windowSecs: 300 } as LimitRule,
  loginEmail: { max: 5, windowSecs: 900 } as LimitRule,
  forgotIp: { max: 10, windowSecs: 3600 } as LimitRule,
  forgotEmail: { max: 3, windowSecs: 3600 } as LimitRule,
  resetIp: { max: 10, windowSecs: 3600 } as LimitRule,
  resendVerification: { max: 3, windowSecs: 3600 } as LimitRule,
  // Wizard credential-verification calls (CF token / Anthropic key pastes) —
  // each triggers outbound API validation; cap abuse without hurting retries.
  connectionVerify: { max: 20, windowSecs: 3600 } as LimitRule,
} as const

/** Deterministic window id for a timestamp: `<windowSecs>:<zero-padded index>`.
 *  windowSecs is part of the key so rules with different windows never collide
 *  on the same (bucket, window) row. Exported for tests. */
export function windowId(nowMs: number, windowSecs: number): string {
  const index = Math.floor(nowMs / 1000 / windowSecs)
  return `${windowSecs}:${String(index).padStart(12, "0")}`
}

/** SQLite-format expiry for a window (when its index rolls over). */
export function windowExpiry(nowMs: number, windowSecs: number): string {
  const end = (Math.floor(nowMs / 1000 / windowSecs) + 1) * windowSecs * 1000
  return new Date(end).toISOString().replace("T", " ").slice(0, 19)
}

/**
 * Count a hit against `bucket` and report whether it is allowed.
 * Returns true (allowed) on any DB error — fail-open, logged.
 */
export async function allowRate(
  db: Client,
  bucket: string,
  rule: LimitRule,
  nowMs: number = Date.now()
): Promise<boolean> {
  try {
    const window = windowId(nowMs, rule.windowSecs)
    const r = await db.execute({
      sql: `INSERT INTO saas_rate_limits (bucket, window, count, expires_at)
            VALUES (?, ?, 1, ?)
            ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1
            RETURNING count`,
      args: [bucket, window, windowExpiry(nowMs, rule.windowSecs)],
    })
    const count = Number(r.rows[0]?.count ?? 1)
    if (count === 1) {
      // First hit in a fresh window: piggyback GC of expired rows (indexed).
      await db
        .execute("DELETE FROM saas_rate_limits WHERE expires_at < datetime('now')")
        .catch(() => {})
    }
    return count <= rule.max
  } catch (err) {
    console.error("saas rateLimit: check failed (allowing):", err instanceof Error ? err.message : err)
    return true
  }
}

/** Client IP as seen by Cloudflare (trustworthy on Workers). */
export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown"
}

export const RATE_LIMIT_MESSAGE =
  "Too many attempts — please wait a few minutes and try again."
