// src/lib/rateLimit.ts
// Fixed-window per-minute rate limiter for the public REST API.
//
// Keyed by the last-4-chars preview of the Bearer token — no extra DB round-trip
// for key resolution; just an increment + read on the counters table.
// Default limit: 60 req/min per API key. Set RATE_LIMIT_RPM in wrangler.toml to override.
//
// Every API response gets X-RateLimit-{Limit,Remaining,Reset} headers.
// Requests beyond the limit get 429 rate_limited immediately.
// Disabled by default — enable with FEATURE_RATE_LIMIT=1.

import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "./types"
import type { Client } from "@libsql/client/web"

const DEFAULT_LIMIT = 60

function currentWindow(): string {
  // "YYYY-MM-DDTHH:MM" in UTC — one bucket per calendar minute
  return new Date().toISOString().slice(0, 16)
}

function nextWindowReset(): number {
  const d = new Date()
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(d.getUTCMinutes() + 1)
  return Math.floor(d.getTime() / 1000)
}

export const rateLimitMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const enabled = c.env.FEATURE_RATE_LIMIT
  if (!enabled || enabled === "0" || enabled === "false") return next()

  const authHeader = c.req.header("Authorization") ?? c.req.header("authorization") ?? ""
  if (!authHeader.toLowerCase().startsWith("bearer ")) return next()

  const rawKey = authHeader.slice(7).trim()
  if (rawKey.length < 8) return next()

  const bucket = rawKey.slice(-4)
  const window = currentWindow()
  const limit = parseInt(c.env.RATE_LIMIT_RPM ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT
  const reset = nextWindowReset()

  const siteDb = c.get("siteDb")

  // Upsert: increment counter for this bucket+window.
  await siteDb
    .execute({
      sql: `INSERT INTO rate_limit_counters (bucket, window, count)
            VALUES (?, ?, 1)
            ON CONFLICT(bucket, window) DO UPDATE SET count = count + 1`,
      args: [bucket, window],
    })
    .catch(() => {})

  const countRow = await siteDb
    .execute({
      sql: "SELECT count FROM rate_limit_counters WHERE bucket = ? AND window = ? LIMIT 1",
      args: [bucket, window],
    })
    .catch(() => null)

  const count = Number(countRow?.rows[0]?.count ?? 1)
  const remaining = Math.max(0, limit - count)

  const rlHeaders = {
    "X-RateLimit-Limit": String(limit),
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(reset),
  }

  if (count >= limit) {
    return new Response(
      JSON.stringify({
        error: "Rate limit exceeded. Try again after the reset window.",
        code: "rate_limited",
        details: { limit, remaining: 0, reset },
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "X-Error-Code": "rate_limited",
          ...rlHeaders,
        },
      }
    )
  }

  await next()

  // Attach rate-limit headers to the handler's response without consuming its body.
  if (!c.res) return
  const orig = c.res
  const h = new Headers(orig.headers)
  for (const [k, v] of Object.entries(rlHeaders)) h.set(k, v)
  c.res = new Response(orig.body, { status: orig.status, headers: h })
}

/** GC: remove rate-limit counter rows from previous windows. Call from cron per site. */
export async function rateLimitGc(db: Client): Promise<void> {
  const cutoff = new Date()
  cutoff.setUTCMinutes(cutoff.getUTCMinutes() - 5)
  const cutoffStr = cutoff.toISOString().slice(0, 16)
  await db
    .execute({
      sql: "DELETE FROM rate_limit_counters WHERE window < ?",
      args: [cutoffStr],
    })
    .catch(() => {})
}
