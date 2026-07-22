// src/lib/auth.ts
// JWT (HS256) + password hashing for Cloudflare Workers.
//
// Why PBKDF2 instead of bcrypt?
// — Workers runtime does not include bcrypt natively, and the popular
//   `bcryptjs` package is pure JS but slow per-iteration.
// — PBKDF2 with SHA-256 is built into Web Crypto, fast, audited,
//   and produces a verifier in the standard `pbkdf2$<iters>$<salt>$<hash>` format.
// — The "bcrypt" naming in the spec is conceptual; we use a stronger Web-Crypto
//   primitive while keeping the same key-hash storage interface.

import { timingSafeEqual } from "./utils"

const PBKDF2_ITERATIONS = 100_000
const PBKDF2_HASH_BYTES = 32
const PBKDF2_SALT_BYTES = 16

// ─────────────────────── PASSWORD HASHING ───────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
  byteLength: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    byteLength * 8
  )
  return new Uint8Array(bits)
}

/** Hash a password. Output format: pbkdf2$<iters>$<saltB64>$<hashB64>
 *  The format is self-describing (verifyPassword reads the embedded iteration
 *  count), so callers may pass a different work factor — used by the SaaS
 *  layer's config-driven iterations + lazy rehash-on-login. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const iters = Number.isFinite(iterations) && iterations >= 1000 ? Math.floor(iterations) : PBKDF2_ITERATIONS
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES))
  const hash = await pbkdf2(password, salt, iters, PBKDF2_HASH_BYTES)
  return `pbkdf2$${iters}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`
}

/** Read the iteration count embedded in a stored hash (0 if unparseable). */
export function storedHashIterations(stored: string): number {
  if (!stored || !stored.startsWith("pbkdf2$")) return 0
  const iters = parseInt(stored.split("$")[1] ?? "", 10)
  return Number.isFinite(iters) ? iters : 0
}

/** Verify a password against a stored hash. Constant-time on the hash compare. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (!stored || !stored.startsWith("pbkdf2$")) return false
  const parts = stored.split("$")
  if (parts.length !== 4) return false
  const iters = parseInt(parts[1], 10)
  if (!Number.isFinite(iters) || iters < 1000) return false
  let salt: Uint8Array, expected: Uint8Array
  try {
    salt = base64ToBytes(parts[2])
    expected = base64ToBytes(parts[3])
  } catch {
    return false
  }
  const got = await pbkdf2(password, salt, iters, expected.length)
  // Constant-time comparison.
  let mismatch = expected.length ^ got.length
  for (let i = 0; i < expected.length; i++) mismatch |= expected[i] ^ got[i]
  return mismatch === 0
}

// ─────────────────────── JWT (HS256) ───────────────────────

function b64UrlEncode(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  return bytesToBase64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4)
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad)
  return base64ToBytes(b64)
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("JWT_SECRET is not configured")
  const keyBytes = new TextEncoder().encode(secret)
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

export interface JwtPayload {
  sub: string
  email?: string
  role?: string
  iat?: number
  exp?: number
  [k: string]: unknown
}

/** Sign a JWT with HS256. ttlSeconds defaults to 7 days. */
export async function signJwt(
  payload: { sub: string; email?: string; role?: string; [k: string]: unknown },
  secret: string,
  ttlSeconds = 60 * 60 * 24 * 7
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: "HS256", typ: "JWT" }
  const body: JwtPayload = { ...payload, iat: now, exp: now + ttlSeconds }
  const headerB64 = b64UrlEncode(JSON.stringify(header))
  const bodyB64 = b64UrlEncode(JSON.stringify(body))
  const data = `${headerB64}.${bodyB64}`
  const key = await hmacKey(secret)
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))
  return `${data}.${b64UrlEncode(sig)}`
}

/** Verify and decode a JWT. Returns null if invalid or expired. */
export async function verifyJwt(token: string, secret: string): Promise<JwtPayload | null> {
  if (!token || token.split(".").length !== 3) return null
  const [h, p, s] = token.split(".")
  const data = `${h}.${p}`
  const key = await hmacKey(secret)
  let sig: Uint8Array
  try {
    sig = b64UrlDecode(s)
  } catch {
    return null
  }
  const ok = await crypto.subtle.verify("HMAC", key, sig as BufferSource, new TextEncoder().encode(data))
  if (!ok) return null
  let payload: JwtPayload
  try {
    payload = JSON.parse(new TextDecoder().decode(b64UrlDecode(p))) as JwtPayload
  } catch {
    return null
  }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
  return payload
}

/** Generate a long-lived API key string. Format: cms_live_<32 hex>. */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0")
  return `cms_live_${hex}`
}

/** Scoped integration key (V1.5 M2) — distinct prefix so it's never confused
 *  with a frozen cms_live_ key. 24 random bytes. */
export function generateScopedKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0")
  return `sk_site_${hex}`
}

