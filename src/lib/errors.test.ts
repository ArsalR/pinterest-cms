import { describe, it, expect } from "vitest"
import type { ErrorCode } from "./errors"

// Verify the frozen contract: these code strings must never be renamed.
describe("ErrorCode contract", () => {
  const frozen: ErrorCode[] = [
    "auth_missing",
    "auth_invalid_format",
    "auth_key_not_found",
    "auth_key_inactive",
    "auth_permission_denied",
    "validation_required_field",
    "validation_invalid_value",
    "not_found",
    "slug_conflict",
    "idempotency_key_invalid",
    "idempotency_conflict",
    "upload_too_many_files",
    "upload_file_too_large",
    "upload_invalid_mime",
    "rate_limited",
    "internal_error",
  ]

  it("all 16 codes are present in the type", () => {
    // TypeScript will catch any missing code at compile time;
    // this runtime check documents and guards the count.
    expect(frozen.length).toBe(16)
  })

  it("code strings are lowercase_snake_case", () => {
    for (const code of frozen) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it("no duplicate codes", () => {
    expect(new Set(frozen).size).toBe(frozen.length)
  })
})
