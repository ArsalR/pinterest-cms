// src/modules/customers/customers.ts
// Platform customer accounts: signup, login, email verification, password
// reset, sessions, audit logging. Master-DB only — never touches per-site DBs.
//
// Reuses the CMS auth primitives (PBKDF2 + HS256 JWT from src/lib/auth.ts)
// with a SEPARATE cookie (saas_session) and SEPARATE secret (SAAS_JWT_SECRET)
// so tenant admin sessions and platform sessions can never be confused.

import type { Client } from "@libsql/client/web"
import { hashPassword, verifyPassword, signJwt, verifyJwt, storedHashIterations } from "../../lib/auth"
import { cuid } from "../../lib/utils"

export const SAAS_SESSION_COOKIE = "saas_session"
export const TRIAL_DAYS = 14

const VERIFY_TTL_HOURS = 24
const RESET_TTL_HOURS = 1

// Work factor for customer password hashes. Config-driven (decision #6):
// SAAS_PBKDF2_ITERATIONS env var overrides; the pbkdf2$<iters>$… envelope is
// self-describing, so raising the value later strengthens hashes LAZILY on
// next successful login (rehash-on-login below) — no data migration.
const DEFAULT_CUSTOMER_ITERATIONS = 100_000

export function customerIterations(envValue: string | undefined): number {
  const n = parseInt(envValue ?? "", 10)
  return Number.isFinite(n) && n >= 10_000 ? n : DEFAULT_CUSTOMER_ITERATIONS
}

// Valid-format hash of a random throwaway password. verifyCustomerPassword
// verifies against this when the email has no account, so "no such account"
// and "wrong password" cost the same PBKDF2 work — no timing oracle.
const DUMMY_HASH =
  "pbkdf2$100000$LBQD4ZySnQxmn8NzofChng==$puD8a0OFSSvgmHYNo85KWNG4HxoBsqyrZ1yHj5Ccnxw="

// The canonical Customer shape lives in CMS-core types (like SiteConfig/Post)
// so the Hono context (src/lib/types.ts) can reference it WITHOUT a
// core→module dependency. Re-exported here as the customers module's own type.
export type { Customer } from "../../lib/types"
import type { Customer } from "../../lib/types"

// ─────────────────────── validation (pure — unit-tested) ───────────────────────

export function validateEmail(email: string): string | null {
  const e = email.trim().toLowerCase()
  if (!e || e.length > 254) return null
  // Pragmatic shape check; deliverability is proven by the verification email.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null
  return e
}

export function validatePassword(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters."
  if (password.length > 200) return "Password is too long."
  return null
}

/** now + N days as an SQLite-compatible UTC string. */
export function trialEnd(from: Date, days: number = TRIAL_DAYS): string {
  const d = new Date(from.getTime() + days * 24 * 60 * 60 * 1000)
  return d.toISOString().replace("T", " ").slice(0, 19)
}

// ─────────────────────── tokens (verify / reset) ───────────────────────

function randomTokenHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0")
  return hex
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  const bytes = new Uint8Array(digest)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0")
  return hex
}

/** Create a single-use token row; returns the RAW token (only the hash is stored). */
export async function issueToken(
  db: Client,
  customerId: string,
  kind: "verify" | "reset"
): Promise<string> {
  const raw = randomTokenHex()
  const ttlHours = kind === "verify" ? VERIFY_TTL_HOURS : RESET_TTL_HOURS
  await db.execute({
    sql: `INSERT INTO customer_tokens (id, customer_id, kind, token_hash, expires_at)
          VALUES (?, ?, ?, ?, datetime('now', ?))`,
    args: [cuid(), customerId, kind, await sha256Hex(raw), `+${ttlHours} hours`],
  })
  return raw
}

/** Consume a token: returns the customer_id if valid+unused+unexpired, else null. */
export async function consumeToken(
  db: Client,
  raw: string,
  kind: "verify" | "reset"
): Promise<string | null> {
  if (!raw || raw.length < 32) return null
  const hash = await sha256Hex(raw)
  const r = await db.execute({
    sql: `SELECT id, customer_id FROM customer_tokens
          WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > datetime('now')
          LIMIT 1`,
    args: [hash, kind],
  })
  if (!r.rows.length) return null
  await db.execute({
    sql: "UPDATE customer_tokens SET used_at = datetime('now') WHERE id = ?",
    args: [r.rows[0].id as string],
  })
  return r.rows[0].customer_id as string
}

// ─────────────────────── audit ───────────────────────

/** Append-only audit entry. Never throws; never logs secret material. */
export async function audit(
  db: Client,
  customerId: string | null,
  action: string,
  target?: string,
  meta?: Record<string, unknown>
): Promise<void> {
  try {
    await db.execute({
      sql: "INSERT INTO audit_log (id, customer_id, action, target, meta) VALUES (?, ?, ?, ?, ?)",
      args: [cuid(), customerId, action, target ?? null, meta ? JSON.stringify(meta) : null],
    })
  } catch (err) {
    console.error("audit: insert failed:", err instanceof Error ? err.message : err)
  }
}

// ─────────────────────── accounts ───────────────────────

export async function findCustomerByEmail(db: Client, email: string): Promise<Customer | null> {
  const r = await db.execute({
    sql: `SELECT id, email, name, plan, plan_status, trial_ends_at, email_verified, created_at
          FROM customers WHERE email = ? LIMIT 1`,
    args: [email],
  })
  return r.rows.length ? (r.rows[0] as unknown as Customer) : null
}

export async function findCustomerById(db: Client, id: string): Promise<Customer | null> {
  const r = await db.execute({
    sql: `SELECT id, email, name, plan, plan_status, trial_ends_at, email_verified, created_at
          FROM customers WHERE id = ? LIMIT 1`,
    args: [id],
  })
  return r.rows.length ? (r.rows[0] as unknown as Customer) : null
}

export async function createCustomer(
  db: Client,
  email: string,
  password: string,
  name: string | null,
  iterations: number = DEFAULT_CUSTOMER_ITERATIONS
): Promise<Customer> {
  const id = cuid()
  const passwordHash = await hashPassword(password, iterations)
  await db.execute({
    sql: `INSERT INTO customers (id, email, password, name, trial_ends_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [id, email, passwordHash, name, trialEnd(new Date())],
  })
  const created = await findCustomerById(db, id)
  if (!created) throw new Error("customer insert did not persist")
  return created
}

/**
 * Constant-work verification: unknown emails verify against a dummy hash so
 * account existence can't be inferred from response timing. On success, if
 * the stored work factor differs from the configured target, the hash is
 * transparently re-created at the target (lazy strengthening — decision #6).
 */
export async function verifyCustomerPassword(
  db: Client,
  email: string,
  password: string,
  iterations: number = DEFAULT_CUSTOMER_ITERATIONS
): Promise<Customer | null> {
  const r = await db.execute({
    sql: "SELECT id, password FROM customers WHERE email = ? LIMIT 1",
    args: [email],
  })
  if (!r.rows.length) {
    await verifyPassword(password, DUMMY_HASH) // burn the same PBKDF2 cost
    return null
  }
  const stored = r.rows[0].password as string
  const ok = await verifyPassword(password, stored)
  if (!ok) return null
  if (storedHashIterations(stored) !== iterations) {
    // Rehash at the configured work factor; best-effort, never blocks login.
    try {
      await setCustomerPassword(db, r.rows[0].id as string, password, iterations)
    } catch (err) {
      console.error("rehash-on-login failed:", err instanceof Error ? err.message : err)
    }
  }
  return findCustomerById(db, r.rows[0].id as string)
}

export async function setCustomerPassword(
  db: Client,
  id: string,
  password: string,
  iterations: number = DEFAULT_CUSTOMER_ITERATIONS
): Promise<void> {
  await db.execute({
    sql: "UPDATE customers SET password = ? WHERE id = ?",
    args: [await hashPassword(password, iterations), id],
  })
}

export async function markEmailVerified(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: "UPDATE customers SET email_verified = 1 WHERE id = ?",
    args: [id],
  })
}

// ─────────────────────── sessions ───────────────────────

export async function signCustomerSession(customer: Customer, secret: string): Promise<string> {
  return signJwt({ sub: customer.id, email: customer.email, aud: "saas" }, secret)
}

/** Verify a saas session token; enforces the `aud: "saas"` claim. */
export async function verifyCustomerSession(
  token: string,
  secret: string
): Promise<{ sub: string; email?: string } | null> {
  const payload = await verifyJwt(token, secret)
  if (!payload || payload.aud !== "saas" || !payload.sub) return null
  return { sub: payload.sub, email: payload.email }
}

// ─────────────────────── plan gate (pure — unit-tested) ───────────────────────

export type PlanGate = "active" | "read_only"

/**
 * Trial expiry behavior (decision B): sites stay live; dashboard goes
 * read-only; publishing and prompt-edits pause until subscribed.
 * `nowIso` is "YYYY-MM-DD HH:MM:SS" UTC (SQLite format) for comparability.
 */
export function planGate(c: Pick<Customer, "plan_status" | "trial_ends_at">, nowIso: string): PlanGate {
  if (c.plan_status === "active") return "active"
  if (c.plan_status === "trialing" && c.trial_ends_at && nowIso < c.trial_ends_at) return "active"
  return "read_only"
}
