// src/lib/provision.ts
// Auto-provision a new site in one API call. No manual steps.
//   1. Create Turso DB
//   2. Mint auth token for that DB
//   3. Run schema migrations
//   4. Insert default settings
//   5. Create admin user
//   6. Create default API key
//   7. Register in master DB
//   8. (optional) Add Cloudflare DNS CNAME

import type { CloudflareEnv } from "./types"
import { getMasterDb, getSiteDb } from "./turso"
import { hashPassword, generateApiKey } from "./auth"
import { cuid } from "./utils"
import { insertDefaultSettings } from "./defaults"

export interface ProvisionInput {
  hostname: string
  name: string
  adminEmail: string
  adminPassword: string
  /** Optional — when true, attempt to create a CNAME via Cloudflare API. */
  configureDns?: boolean
}

export interface ProvisionResult {
  hostname: string
  adminUrl: string
  apiKey: string
  tursoUrl: string
  siteId: string
}

interface TursoCreateDbResponse {
  database?: { Name: string; Hostname: string; DbId?: string }
  // Older API shapes — handle defensively.
  Name?: string
  Hostname?: string
}

interface TursoTokenResponse {
  jwt: string
}

/** Pretty-print Turso API errors and rethrow with context. */
async function tursoCall<T>(
  url: string,
  init: RequestInit,
  step: string
): Promise<T> {
  const resp = await fetch(url, init)
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Turso API failed at "${step}" (${resp.status}): ${body}`)
  }
  return (await resp.json()) as T
}

export async function createSite(
  env: CloudflareEnv,
  input: ProvisionInput
): Promise<ProvisionResult> {
  const hostname = input.hostname.toLowerCase().trim()
  if (!/^[a-z0-9.-]+$/.test(hostname) || hostname.length < 4) {
    throw new Error("Invalid hostname")
  }
  if (!input.adminPassword || input.adminPassword.length < 8) {
    throw new Error("Admin password must be at least 8 characters")
  }

  // ─── 1. Verify hostname not already registered ───
  const masterDb = getMasterDb(env)
  const existing = await masterDb.execute({
    sql: "SELECT id FROM sites WHERE hostname = ?",
    args: [hostname],
  })
  if (existing.rows.length) {
    throw new Error(`Hostname '${hostname}' is already registered`)
  }

  // ─── 2. Create Turso database ───
  // Turso DB names: lowercase letters, digits, hyphens. Dots → hyphens.
  const dbName = hostname.replace(/[^a-z0-9-]/g, "-").slice(0, 64)

  const dbResp = await tursoCall<TursoCreateDbResponse>(
    `https://api.turso.tech/v1/organizations/${env.TURSO_ORG}/databases`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.TURSO_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: dbName, group: env.TURSO_GROUP }),
    },
    "create database"
  )

  const tursoHost = dbResp.database?.Hostname ?? dbResp.Hostname
  if (!tursoHost) throw new Error("Turso did not return a database hostname")
  const tursoUrl = `libsql://${tursoHost}`

  // ─── 3. Mint auth token ───
  const tokenResp = await tursoCall<TursoTokenResponse>(
    `https://api.turso.tech/v1/organizations/${env.TURSO_ORG}/databases/${dbName}/auth/tokens?expiration=none&authorization=full-access`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURSO_API_TOKEN}` },
    },
    "mint auth token"
  )
  const tursoToken = tokenResp.jwt
  if (!tursoToken) throw new Error("Turso did not return an auth token")

  // ─── 4. Run schema ───
  const siteDb = getSiteDb(tursoUrl, tursoToken)
  await runSchema(siteDb, env)

  // ─── 5. Defaults ───
  await insertDefaultSettings(siteDb, {
    hostname,
    siteName: input.name,
    adminEmail: input.adminEmail,
  })

  // ─── 6. Admin user ───
  const passwordHash = await hashPassword(input.adminPassword)
  await siteDb.execute({
    sql: `INSERT INTO users (id, email, password, name, role) VALUES (?, ?, ?, ?, 'admin')`,
    args: [cuid(), input.adminEmail.toLowerCase(), passwordHash, input.adminEmail.split("@")[0]],
  })

  // ─── 7. Default API key ───
  const rawKey = generateApiKey()
  const keyHash = await hashPassword(rawKey)
  const keyPreview = rawKey.slice(-4)
  await siteDb.execute({
    sql: `INSERT INTO api_keys (id, name, key_hash, key_preview, permissions)
          VALUES (?, 'Automation Bot', ?, ?, '["read","write"]')`,
    args: [cuid(), keyHash, keyPreview],
  })

  // ─── 8. Register in master DB ───
  const siteId = cuid()
  await masterDb.execute({
    sql: `INSERT INTO sites (id, hostname, name, turso_url, turso_token)
          VALUES (?, ?, ?, ?, ?)`,
    args: [siteId, hostname, input.name, tursoUrl, tursoToken],
  })

  // ─── 9. DNS (best-effort) ───
  if (input.configureDns) {
    await addCloudflareDnsRecord(env, hostname).catch((err) => {
      console.error(`DNS automation failed for ${hostname}:`, err)
    })
  }

  return {
    hostname,
    adminUrl: `https://${hostname}/admin/`,
    apiKey: rawKey,
    tursoUrl,
    siteId,
  }
}

/** Fetch site.sql from SITE_SCHEMA_URL and execute each statement. */
async function runSchema(siteDb: ReturnType<typeof getSiteDb>, env: CloudflareEnv): Promise<void> {
  const resp = await fetch(env.SITE_SCHEMA_URL)
  if (!resp.ok) throw new Error(`Failed to fetch schema from ${env.SITE_SCHEMA_URL}`)
  const sql = await resp.text()
  // Split on `;` at end of line, ignore comments and empty.
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("--"))
  for (const stmt of statements) {
    await siteDb.execute(stmt)
  }
}

/** Add a CNAME for hostname → workers.dev domain via Cloudflare API. */
async function addCloudflareDnsRecord(env: CloudflareEnv, hostname: string): Promise<void> {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return
  // For sites on a zone you control, we add a CNAME to your worker route.
  // For arbitrary customer domains, use Cloudflare for SaaS custom hostnames instead.
  await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "CNAME",
      name: hostname,
      content: `pinterest-cms.workers.dev`,
      ttl: 1, // Auto
      proxied: true,
    }),
  })
}

/** Delete a site from the master DB. Does NOT drop the Turso DB by default. */
export async function deactivateSite(env: CloudflareEnv, siteId: string): Promise<void> {
  const db = getMasterDb(env)
  await db.execute({
    sql: "UPDATE sites SET active = 0 WHERE id = ?",
    args: [siteId],
  })
}

export async function deleteSiteFromMaster(env: CloudflareEnv, siteId: string): Promise<void> {
  const db = getMasterDb(env)
  await db.execute({ sql: "DELETE FROM sites WHERE id = ?", args: [siteId] })
}
