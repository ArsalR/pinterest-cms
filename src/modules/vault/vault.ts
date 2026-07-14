// src/modules/vault/vault.ts
// Credential vault: AES-256-GCM via WebCrypto with per-tenant key derivation
// (Security Covenant S4). Free-tier friendly by construction: HKDF-SHA256 is
// a couple of HMAC invocations (<0.1ms) — there is no iteration count to tune,
// unlike PBKDF2.
//
// Envelope format (versioned — decision #6's "config-driven, upgrade without
// data migration" requirement): `v<version>.<ivB64>.<ciphertextB64>`. The
// version selects derivation + cipher parameters at decrypt time, so a future
// stronger scheme (v2) can be introduced and old rows re-encrypt lazily on
// their next write. decrypt() accepts every historical version forever.
//
// Key hierarchy: VAULT_MASTER_KEY (Workers secret, >=32 random bytes hex)
//   → HKDF-SHA256(salt="sitenetwork-vault-v1", info=customerId)
//   → per-tenant AES-256-GCM key.
// A leaked ciphertext + master key still requires knowing WHICH customer the
// row belongs to; more importantly, per-tenant derivation means no single
// AES key ever encrypts two tenants' data.
//
// RULES (enforced by callers, stated here): plaintext credentials are never
// logged, never embedded in error messages, never returned to the browser.
// Every decrypt is audit-logged by the connections layer.

export const VAULT_CURRENT_VERSION = 1

const V1 = {
  hkdfSalt: "sitenetwork-vault-v1",
  ivBytes: 12,
  keyBits: 256,
} as const

function b64encode(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function masterKeyBytes(masterKeyHex: string): Uint8Array {
  const hex = masterKeyHex.trim()
  if (!/^[0-9a-fA-F]{64,}$/.test(hex)) {
    throw new Error("VAULT_MASTER_KEY must be at least 32 random bytes hex-encoded (openssl rand -hex 32)")
  }
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

async function deriveTenantKeyV1(masterKeyHex: string, customerId: string): Promise<CryptoKey> {
  if (!customerId) throw new Error("vault: customerId is required for key derivation")
  const ikm = await crypto.subtle.importKey(
    "raw",
    masterKeyBytes(masterKeyHex) as BufferSource,
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(V1.hkdfSalt) as BufferSource,
      info: new TextEncoder().encode(customerId) as BufferSource,
    },
    ikm,
    { name: "AES-GCM", length: V1.keyBits },
    false,
    ["encrypt", "decrypt"]
  )
}

/** Encrypt a credential for one tenant. Returns the versioned envelope string. */
export async function vaultEncrypt(
  masterKeyHex: string,
  customerId: string,
  plaintext: string
): Promise<string> {
  const key = await deriveTenantKeyV1(masterKeyHex, customerId)
  const iv = crypto.getRandomValues(new Uint8Array(V1.ivBytes))
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext)
    )
  )
  return `v${VAULT_CURRENT_VERSION}.${b64encode(iv)}.${b64encode(ct)}`
}

/** Parse an envelope without decrypting (exported for tests + lazy-upgrade checks). */
export function parseEnvelope(envelope: string): { version: number; ivB64: string; ctB64: string } | null {
  const m = /^v(\d+)\.([A-Za-z0-9+/=]+)\.([A-Za-z0-9+/=]+)$/.exec(envelope ?? "")
  if (!m) return null
  return { version: parseInt(m[1], 10), ivB64: m[2], ctB64: m[3] }
}

/** True when an envelope predates the current scheme (callers re-encrypt on next write). */
export function vaultNeedsUpgrade(envelope: string): boolean {
  const parsed = parseEnvelope(envelope)
  return !!parsed && parsed.version < VAULT_CURRENT_VERSION
}

/**
 * Decrypt a credential. Throws a GENERIC error on any failure — wrong tenant,
 * tampered ciphertext, bad version — so nothing about the failure mode (or the
 * plaintext) can leak into error messages.
 */
export async function vaultDecrypt(
  masterKeyHex: string,
  customerId: string,
  envelope: string
): Promise<string> {
  const parsed = parseEnvelope(envelope)
  if (!parsed || parsed.version !== 1) {
    throw new Error("vault: cannot decrypt credential")
  }
  try {
    const key = await deriveTenantKeyV1(masterKeyHex, customerId)
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(parsed.ivB64) as BufferSource },
      key,
      b64decode(parsed.ctB64) as BufferSource
    )
    return new TextDecoder().decode(pt)
  } catch {
    throw new Error("vault: cannot decrypt credential")
  }
}

/** Last-4 preview for UI display ("…af3c") — never more. */
export function credentialPreview(plaintext: string): string {
  return plaintext.length >= 4 ? `…${plaintext.slice(-4)}` : "…"
}
