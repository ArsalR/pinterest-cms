// src/modules/connections/connections.ts
// Storage layer for BYO-infrastructure connections. All secret material goes
// through the vault; every decrypt is audit-logged (Security Covenant S4).
// `meta` holds only non-secret, render-safe JSON.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { vaultEncrypt, vaultDecrypt } from "../vault"
import { audit } from "../customers"

export type ConnectionProvider = "github" | "cloudflare" | "anthropic" | "pinterest" | "gsc"

export interface ConnectionRow {
  id: string
  customer_id: string
  provider: string
  encrypted_payload: string | null
  meta: string
  status: string
  created_at: string
  last_verified_at: string | null
}

export interface ConnectionView {
  provider: ConnectionProvider
  status: string
  meta: Record<string, unknown>
  createdAt: string
  lastVerifiedAt: string | null
}

function requireVaultKey(env: CloudflareEnv): string {
  if (!env.VAULT_MASTER_KEY) {
    throw new Error("VAULT_MASTER_KEY is not configured")
  }
  return env.VAULT_MASTER_KEY
}

/** Upsert a connection. `secret` (if any) is vault-encrypted before storage. */
export async function saveConnection(
  db: Client,
  env: CloudflareEnv,
  customerId: string,
  provider: ConnectionProvider,
  secret: string | null,
  meta: Record<string, unknown>
): Promise<void> {
  const encrypted = secret === null ? null : await vaultEncrypt(requireVaultKey(env), customerId, secret)
  await db.execute({
    sql: `INSERT INTO connections (id, customer_id, provider, encrypted_payload, meta, status, last_verified_at)
          VALUES (?, ?, ?, ?, ?, 'active', datetime('now'))
          ON CONFLICT(customer_id, provider) DO UPDATE SET
            encrypted_payload = excluded.encrypted_payload,
            meta = excluded.meta,
            status = 'active',
            last_verified_at = datetime('now')`,
    args: [cuid(), customerId, provider, encrypted, JSON.stringify(meta)],
  })
  await audit(db, customerId, "connection.saved", provider)
}

export async function getConnection(
  db: Client,
  customerId: string,
  provider: ConnectionProvider
): Promise<ConnectionRow | null> {
  const r = await db.execute({
    sql: "SELECT * FROM connections WHERE customer_id = ? AND provider = ? LIMIT 1",
    args: [customerId, provider],
  })
  return r.rows.length ? (r.rows[0] as unknown as ConnectionRow) : null
}

/** Decrypt a connection's secret. Audit-logged on every call — no exceptions. */
export async function getConnectionSecret(
  db: Client,
  env: CloudflareEnv,
  customerId: string,
  provider: ConnectionProvider,
  purpose: string
): Promise<string | null> {
  const row = await getConnection(db, customerId, provider)
  if (!row?.encrypted_payload) return null
  await audit(db, customerId, "connection.decrypt", provider, { purpose })
  return vaultDecrypt(requireVaultKey(env), customerId, row.encrypted_payload)
}

/** Render-safe listing (no encrypted payloads, ever). */
export async function listConnections(db: Client, customerId: string): Promise<ConnectionView[]> {
  const r = await db.execute({
    sql: `SELECT provider, status, meta, created_at, last_verified_at
          FROM connections WHERE customer_id = ? ORDER BY provider`,
    args: [customerId],
  })
  return r.rows.map((row) => {
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse((row.meta as string) || "{}") as Record<string, unknown>
    } catch {
      // corrupt meta renders as empty — never blocks the page
    }
    return {
      provider: row.provider as ConnectionProvider,
      status: row.status as string,
      meta,
      createdAt: row.created_at as string,
      lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
    }
  })
}

export async function deleteConnection(
  db: Client,
  customerId: string,
  provider: ConnectionProvider
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM connections WHERE customer_id = ? AND provider = ?",
    args: [customerId, provider],
  })
  await audit(db, customerId, "connection.deleted", provider)
}
