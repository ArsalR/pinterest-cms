// src/lib/errors.ts
// Structured error helper for the public REST API.
// The code strings below are frozen cross-repo contracts — never rename or remove.

import type { Context } from "hono"
import type { AppEnv } from "./types"

export type ErrorCode =
  | "auth_missing"
  | "auth_invalid_format"
  | "auth_key_not_found"
  | "auth_key_inactive"
  | "auth_permission_denied"
  | "validation_required_field"
  | "validation_invalid_value"
  | "not_found"
  | "slug_conflict"
  | "idempotency_key_invalid"
  | "idempotency_conflict"
  | "upload_too_many_files"
  | "upload_file_too_large"
  | "upload_invalid_mime"
  | "rate_limited"
  | "internal_error"

/**
 * Return a JSON error response with a machine-readable `code` and `X-Error-Code` header.
 * The `error` string is preserved verbatim for backward compatibility.
 */
export function apiError(
  c: Context<AppEnv>,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): Response {
  const body: { error: string; code: ErrorCode; details?: Record<string, unknown> } = {
    error: message,
    code,
  }
  if (details && Object.keys(details).length) body.details = details
  return c.json(body, status as never, { "X-Error-Code": code })
}
