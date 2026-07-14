// src/modules/connections/github.test.ts
// Pure-logic tests: App JWT claim shape + the PKCS#1 paste-mistake detector.
// (Network calls + full RS256 signing are exercised in Phase 10 mocked tests.)

import { describe, it, expect } from "vitest"
import { appJwtClaims, pemLooksPkcs1 } from "./github"

describe("appJwtClaims", () => {
  const now = 1_760_000_000
  it("backdates iat 60s to absorb clock skew (GitHub requirement)", () => {
    expect(appJwtClaims("12345", now).iat).toBe(now - 60)
  })
  it("expires within GitHub's 10-minute maximum", () => {
    const c = appJwtClaims("12345", now)
    expect(c.exp - now).toBeLessThanOrEqual(600)
    expect(c.exp).toBeGreaterThan(now)
  })
  it("iss is the App ID string", () => {
    expect(appJwtClaims("12345", now).iss).toBe("12345")
  })
})

describe("pemLooksPkcs1 (GitHub downloads PKCS#1; WebCrypto needs PKCS#8)", () => {
  it("flags GitHub's download format", () => {
    expect(pemLooksPkcs1("-----BEGIN RSA PRIVATE KEY-----\nMII...\n-----END RSA PRIVATE KEY-----")).toBe(true)
  })
  it("accepts converted PKCS#8", () => {
    expect(pemLooksPkcs1("-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----")).toBe(false)
  })
})
