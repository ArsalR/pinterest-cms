// src/lib/apiAuth.ts
// API key authentication for the public REST API (/api/public/v1/*).
// Stored hash format matches the password hash format from auth.ts (PBKDF2).

import type { Client } from "@libsql/client/web"
import { verifyPassword } from "./auth"
import { cuid } from "./utils"
import type { ApiKey } from "./types"
import type { ErrorCode } from "./errors"

interface AuthSuccess {
  keyId: string
  permissions: string[]
  error?: undefined
  code?: undefined
  status?: undefined
}

interface AuthFailure {
  keyId: string
  permissions: string[]
  error: string
  code: ErrorCode
  status: number
}

export type ValidationResult = AuthSuccess | AuthFailure

/**
 * Validate an API key from the Authorization header.
 *
 * Lookup strategy:
 * 1. Match candidates by key_preview (last 4 chars) — narrow set, cheap.
 * 2. PBKDF2-verify the raw key against each candidate's stored hash.
 * 3. First match wins; rest discarded.
 *
 * Permissions are stored as a JSON array in api_keys.permissions, e.g.
 * ["read","write","delete"].
 */
export async function validateApiKey(
  siteDb: Client,
  request: Request,
  requiredPermission: string
): Promise<ValidationResult> {
  const authHeader = request.headers.get("Authorization") ?? request.headers.get("authorization")
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return {
      keyId: "",
      permissions: [],
      error: "Missing or malformed Authorization header. Expected: Bearer <key>",
      code: "auth_missing",
      status: 401,
    }
  }

  const rawKey = authHeader.slice(7).trim()
  if (!rawKey || rawKey.length < 8) {
    return { keyId: "", permissions: [], error: "Invalid API key format", code: "auth_invalid_format", status: 401 }
  }

  // V1.5 M2 — scoped integration keys (sk_site_…) take a parallel path against
  // scoped_api_keys; the frozen cms_live_ contract below is untouched.
  if (rawKey.startsWith("sk_site_")) return validateScopedKey(siteDb, rawKey, requiredPermission)

  const preview = rawKey.slice(-4)

  const result = await siteDb.execute({
    sql: "SELECT id, name, key_hash, key_preview, permissions, active FROM api_keys WHERE key_preview = ? AND active = 1",
    args: [preview],
  })

  let matched: ApiKey | null = null
  for (const row of result.rows) {
    const r = row as unknown as ApiKey
    if (await verifyPassword(rawKey, r.key_hash)) {
      matched = r
      break
    }
  }

  if (!matched) {
    return { keyId: "", permissions: [], error: "Invalid API key", code: "auth_key_not_found", status: 401 }
  }

  let permissions: string[]
  try {
    const trimmed = (matched.permissions || "").trim()
    if (trimmed.startsWith("[")) {
      // JSON array form
      const parsed = JSON.parse(trimmed)
      permissions = Array.isArray(parsed) ? parsed.map(String) : []
    } else {
      // Comma-separated form: "read,write"
      permissions = trimmed.split(",").map((s) => s.trim()).filter(Boolean)
    }
  } catch {
    permissions = []
  }

  if (!permissions.includes(requiredPermission)) {
    return {
      keyId: matched.id,
      permissions,
      error: `Insufficient permissions: '${requiredPermission}' required`,
      code: "auth_permission_denied",
      status: 403,
    }
  }

  // Fire-and-forget usage stats update.
  siteDb
    .execute({
      sql: "UPDATE api_keys SET last_used_at = datetime('now'), usage_count = usage_count + 1 WHERE id = ?",
      args: [matched.id],
    })
    .catch(() => {})

  return { keyId: matched.id, permissions }
}

/**
 * Does a scoped key's scope set satisfy a required permission? Pure.
 * Existing public routes require the coarse "read"/"write"; a scoped key holds
 * fine-grained scopes (read-posts, write-posts, read-forms, …). Mapping:
 *  - exact scope match always passes (used by new scoped-only endpoints);
 *  - "read"  is satisfied by any read-* (or plain "read");
 *  - "write" is satisfied by any write-* (or plain "write") — and write implies read.
 */
export function permitScope(requiredPermission: string, scopes: string[]): boolean {
  if (scopes.includes(requiredPermission)) return true
  if (requiredPermission === "read") return scopes.some((s) => s === "read" || s.startsWith("read-") || s === "write" || s.startsWith("write-"))
  if (requiredPermission === "write") return scopes.some((s) => s === "write" || s.startsWith("write-"))
  return false
}

/** Validate an sk_site_ scoped key against scoped_api_keys (preview→PBKDF2 loop,
 *  same as cms_live_), then check the requiredPermission against its scopes. */
export async function validateScopedKey(siteDb: Client, rawKey: string, requiredPermission: string): Promise<ValidationResult> {
  const preview = rawKey.slice(-4)
  const result = await siteDb.execute({
    sql: "SELECT id, key_hash, scopes, active FROM scoped_api_keys WHERE key_preview = ? AND active = 1",
    args: [preview],
  })
  let matched: { id: string; key_hash: string; scopes: string } | null = null
  for (const row of result.rows) {
    const r = row as unknown as { id: string; key_hash: string; scopes: string }
    if (await verifyPassword(rawKey, r.key_hash)) { matched = r; break }
  }
  if (!matched) return { keyId: "", permissions: [], error: "Invalid API key", code: "auth_key_not_found", status: 401 }
  let scopes: string[] = []
  try { const p = JSON.parse(matched.scopes || "[]"); scopes = Array.isArray(p) ? p.map(String) : [] } catch { scopes = [] }
  if (!permitScope(requiredPermission, scopes)) {
    return { keyId: matched.id, permissions: scopes, error: `This key doesn't have the '${requiredPermission}' scope`, code: "auth_permission_denied", status: 403 }
  }
  siteDb.execute({ sql: "UPDATE scoped_api_keys SET last_used_at = datetime('now'), usage_count = usage_count + 1 WHERE id = ?", args: [matched.id] }).catch(() => {})
  return { keyId: matched.id, permissions: scopes }
}

/** Insert an api_logs row. Never throws — logging must not break a request. */
export async function logApiRequest(
  siteDb: Client,
  keyId: string,
  endpoint: string,
  method: string,
  status: number,
  postId?: string | null
): Promise<void> {
  if (!keyId) return
  try {
    await siteDb.execute({
      sql: `INSERT INTO api_logs (id, api_key_id, endpoint, method, status, post_id)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [cuid(), keyId, endpoint, method, status, postId ?? null],
    })
  } catch {
    /* swallow */
  }
}
