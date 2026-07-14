// src/modules/vault/vault.test.ts
// WebCrypto (crypto.subtle) is available in plain Node >= 20, so the full
// encrypt/decrypt path is testable without any Workers runtime.

import { describe, it, expect } from "vitest"
import {
  vaultEncrypt, vaultDecrypt, parseEnvelope, vaultNeedsUpgrade,
  credentialPreview, VAULT_CURRENT_VERSION,
} from "./vault"

const MASTER = "a".repeat(64) // 32 bytes hex
const OTHER_MASTER = "b".repeat(64)

describe("vault round-trip", () => {
  it("encrypts and decrypts for the same tenant", async () => {
    const secret = "cf-token-EXTREMELY-secret-value-123"
    const env = await vaultEncrypt(MASTER, "cust_1", secret)
    expect(env.startsWith(`v${VAULT_CURRENT_VERSION}.`)).toBe(true)
    expect(env).not.toContain(secret)
    expect(await vaultDecrypt(MASTER, "cust_1", env)).toBe(secret)
  })

  it("produces a fresh IV every time (no envelope reuse)", async () => {
    const a = await vaultEncrypt(MASTER, "cust_1", "same")
    const b = await vaultEncrypt(MASTER, "cust_1", "same")
    expect(a).not.toBe(b)
  })
})

describe("vault isolation + tamper detection", () => {
  it("another tenant's derived key cannot decrypt (per-tenant isolation)", async () => {
    const env = await vaultEncrypt(MASTER, "cust_1", "secret")
    await expect(vaultDecrypt(MASTER, "cust_2", env)).rejects.toThrow("cannot decrypt")
  })

  it("a different master key cannot decrypt", async () => {
    const env = await vaultEncrypt(MASTER, "cust_1", "secret")
    await expect(vaultDecrypt(OTHER_MASTER, "cust_1", env)).rejects.toThrow("cannot decrypt")
  })

  it("tampered ciphertext fails closed with a generic error", async () => {
    const env = await vaultEncrypt(MASTER, "cust_1", "secret")
    const parts = env.split(".")
    const ct = atob(parts[2])
    const flipped = String.fromCharCode(ct.charCodeAt(0) ^ 1) + ct.slice(1)
    const tampered = `${parts[0]}.${parts[1]}.${btoa(flipped)}`
    await expect(vaultDecrypt(MASTER, "cust_1", tampered)).rejects.toThrow("cannot decrypt")
  })

  it("rejects malformed master keys loudly", async () => {
    await expect(vaultEncrypt("tooshort", "cust_1", "x")).rejects.toThrow("VAULT_MASTER_KEY")
  })
})

describe("versioned envelopes (lazy-upgrade seam)", () => {
  it("parses valid envelopes and rejects garbage", async () => {
    const env = await vaultEncrypt(MASTER, "cust_1", "x")
    expect(parseEnvelope(env)?.version).toBe(1)
    expect(parseEnvelope("")).toBeNull()
    expect(parseEnvelope("not-an-envelope")).toBeNull()
    expect(parseEnvelope("v1.only-two-parts")).toBeNull()
  })

  it("current-version envelopes don't need upgrade; older ones would", async () => {
    const env = await vaultEncrypt(MASTER, "cust_1", "x")
    expect(vaultNeedsUpgrade(env)).toBe(false)
    // simulate a hypothetical v0 legacy row
    expect(vaultNeedsUpgrade(env.replace(/^v1\./, "v0."))).toBe(VAULT_CURRENT_VERSION > 0)
  })

  it("unknown future versions fail closed (never mis-decrypt)", async () => {
    const env = await vaultEncrypt(MASTER, "cust_1", "x")
    await expect(vaultDecrypt(MASTER, "cust_1", env.replace(/^v1\./, "v9."))).rejects.toThrow("cannot decrypt")
  })
})

describe("credentialPreview", () => {
  it("shows only the last four characters", () => {
    expect(credentialPreview("cms_live_abcdef")).toBe("…cdef")
    expect(credentialPreview("ab")).toBe("…")
  })
})
