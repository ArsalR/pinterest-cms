// src/lib/idempotency.ts
// Idempotency middleware for the public REST API.
//
// Usage: send `Idempotency-Key: <uuid>` with any mutating request.
// On the first call the response is cached for 24 h (scoped per API key).
// Subsequent calls with the same key return the cached response plus
// `Idempotency-Replayed: true`. A different request body on the same key
// returns 409 idempotency_conflict.
//
// Disabled by default — enable by setting FEATURE_IDEMPOTENCY=1.

import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "./types"
import { apiError } from "./errors"

const MAX_KEY_LENGTH = 255

async function sha256hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export const idempotencyMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const enabled = c.env.FEATURE_IDEMPOTENCY
  if (!enabled || enabled === "0" || enabled === "false") return next()

  const idempKey = c.req.header("Idempotency-Key")
  if (!idempKey) return next()

  if (idempKey.length > MAX_KEY_LENGTH) {
    return apiError(c, 400, "idempotency_key_invalid", `Idempotency-Key must be ≤ ${MAX_KEY_LENGTH} characters`)
  }

  const siteDb = c.get("siteDb")

  // Scope key: sha256(raw-auth-header + ":" + idempotency-key)
  // This scopes the idempotency namespace per API key without storing the key.
  const authRaw = c.req.header("Authorization") ?? c.req.header("authorization") ?? ""
  const cacheKey = await sha256hex(`${authRaw}:${idempKey}`)

  // Request fingerprint: sha256(method + path + body)
  // Hono caches req.text() so calling it here doesn't consume the body stream.
  const bodyText = await c.req.text().catch(() => "")
  const fingerprint = await sha256hex(
    `${c.req.method}:${new URL(c.req.url).pathname}:${bodyText}`
  )

  // Check cache — include expiry guard so stale rows are invisible.
  const cached = await siteDb
    .execute({
      sql: `SELECT status, body, headers, fingerprint
            FROM idempotency_cache
            WHERE cache_key = ? AND expires_at > datetime('now')
            LIMIT 1`,
      args: [cacheKey],
    })
    .catch(() => null)

  if (cached?.rows.length) {
    const row = cached.rows[0]
    if (row.fingerprint !== fingerprint) {
      return apiError(c, 409, "idempotency_conflict",
        "Idempotency-Key was already used for a different request")
    }

    // Replay cached response.
    let headers: Record<string, string> = {}
    try {
      headers = JSON.parse(row.headers as string) as Record<string, string>
    } catch { /* use empty headers */ }
    headers["Idempotency-Replayed"] = "true"

    return new Response(row.body as string, {
      status: row.status as number,
      headers,
    })
  }

  // Let the handler run.
  await next()

  // Cache the response for 24 h (fire-and-forget — never block the response).
  const status = c.res.status
  const responseBody = await c.res.clone().text().catch(() => "")
  const responseHeaders: Record<string, string> = {}
  c.res.headers.forEach((v, k) => {
    responseHeaders[k] = v
  })

  c.executionCtx.waitUntil(
    siteDb
      .execute({
        sql: `INSERT OR REPLACE INTO idempotency_cache
                (cache_key, fingerprint, status, body, headers, expires_at)
              VALUES (?, ?, ?, ?, ?, datetime('now', '+24 hours'))`,
        args: [cacheKey, fingerprint, status, responseBody, JSON.stringify(responseHeaders)],
      })
      .catch(() => {})
  )
}

/** GC: remove expired idempotency rows. Call from scheduled cron per site. */
export async function idempotencyGc(db: import("@libsql/client/web").Client): Promise<void> {
  await db
    .execute("DELETE FROM idempotency_cache WHERE expires_at <= datetime('now')")
    .catch(() => {})
}
