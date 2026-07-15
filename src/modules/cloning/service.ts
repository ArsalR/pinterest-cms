// src/modules/cloning/service.ts
// Drives a clone: derive a provisioning plan from the source site, provision a
// fresh independent site, and remember the clone context (source + angle) so
// the "re-theme & re-seed" genesis step can build a distinctive prompt. Reuses
// the Phase-3 provisioning pipeline wholesale — a clone is just a new site with
// a source-derived seed.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { createProvisioningPlan, runProvisioning } from "../provisioning"
import { audit, type Customer } from "../customers"
import { cuid } from "../../lib/utils"
import type { CloneInput } from "./clone"

export interface SourceSite {
  id: string
  name: string
  niche: string | null
  kind: string | null
}

/** Load a source site the customer owns (clone must be from your own site). */
export async function loadSourceSite(db: Client, sourceId: string, customerId: string): Promise<SourceSite | null> {
  const r = await db.execute({
    sql: "SELECT id, name, niche, kind FROM customer_sites WHERE id = ? AND customer_id = ? LIMIT 1",
    args: [sourceId, customerId],
  })
  return r.rows.length ? (r.rows[0] as unknown as SourceSite) : null
}

export interface CloneContext {
  newSiteId: string
  sourceSiteId: string
  sourceNiche: string
  angle: string
}

/**
 * Provision a clone of `source`. Returns the new site id. The heavy work
 * (repo, DB, DNS) runs via runProvisioning in the background, exactly like a
 * normal new site; the clone context is stored for the genesis re-seed step.
 */
export async function cloneSite(
  db: Client,
  env: CloudflareEnv,
  customer: Customer,
  source: SourceSite,
  input: CloneInput,
  waitUntil: (p: Promise<unknown>) => void
): Promise<string> {
  const kind = source.kind ?? "content"
  const newSiteId = await createProvisioningPlan(db, customer, {
    domain: input.domain.toLowerCase(),
    canonicalHost: "apex",
    name: input.name,
    niche: input.niche,
    zoneId: input.zoneId,
    kind,
  })

  // Remember the clone lineage for the re-theme/re-seed genesis prompt.
  const ctx: CloneContext = { newSiteId, sourceSiteId: source.id, sourceNiche: source.niche ?? input.niche, angle: input.angle }
  await db.execute({
    sql: "INSERT INTO jobs (id, customer_id, kind, status, payload) VALUES (?, ?, 'clone', 'done', ?)",
    args: [cuid(), customer.id, JSON.stringify(ctx)],
  })
  await audit(db, customer.id, "site.cloned", input.domain, { sourceSiteId: source.id }).catch(() => {})

  waitUntil(runProvisioning(db, env, newSiteId).catch((err) => console.error("clone provisioning crashed:", err)))
  return newSiteId
}

/** Retrieve the clone lineage for a site (null if it wasn't a clone). */
export async function loadCloneContext(db: Client, customerId: string, newSiteId: string): Promise<CloneContext | null> {
  const r = await db.execute({
    sql: "SELECT payload FROM jobs WHERE customer_id = ? AND kind = 'clone' ORDER BY created_at DESC LIMIT 50",
    args: [customerId],
  })
  for (const row of r.rows) {
    try {
      const ctx = JSON.parse(String(row.payload ?? "{}")) as CloneContext
      if (ctx.newSiteId === newSiteId) return ctx
    } catch {
      // skip malformed
    }
  }
  return null
}
