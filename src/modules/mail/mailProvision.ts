// src/modules/mail/mailProvision.ts
// Turns on RECEIVING for a site (V1.5 M1). Idempotent + resumable — safe to
// re-run from the setup page after fixing a token scope or clicking the
// Cloudflare address-verification email. Steps mirror the spec:
//   mint inbound secret → enable Email Routing → deploy the Email Worker into
//   the customer's account → point the catch-all at it → read the DNS records.
// Live Cloudflare only (no CI E2E) — every call returns a plain-language
// problem so the UI can tell the owner exactly what to fix.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { getConnection, getConnectionSecret, verifyCfToken, enableEmailRouting, setCatchAllToWorker, putEmailWorker, emailRoutingDns } from "../connections"
import { renderEmailWorker } from "./emailWorker"

export interface MailboxSite { id: string; customer_id: string; domain: string; zone_id: string | null; mail_inbound_secret: string | null }
export interface DnsRecord { type: string; name: string; value: string; priority?: number; purpose: string }

export interface ProvisionMailboxResult {
  ok: boolean
  problem: string | null
  dns: DnsRecord[]
}

/** The customer-account worker name for a site's mailbox. Deterministic. */
export function mailWorkerName(siteId: string): string {
  return `mail-${siteId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 50)}`
}

export async function provisionMailbox(env: CloudflareEnv, master: Client, site: MailboxSite): Promise<ProvisionMailboxResult> {
  if (!site.zone_id) return { ok: false, problem: "This site has no Cloudflare zone yet.", dns: [] }

  // Customer Cloudflare token + account id.
  const conn = await getConnection(master, site.customer_id, "cloudflare").catch(() => null)
  if (!conn) return { ok: false, problem: "Connect your Cloudflare account first (Connections).", dns: [] }
  const token = await getConnectionSecret(master, env, site.customer_id, "cloudflare", "mailbox").catch(() => null)
  if (!token) return { ok: false, problem: "Your Cloudflare token isn't available — reconnect it.", dns: [] }
  let accountId = (JSON.parse(conn.meta || "{}") as { accountId?: string }).accountId ?? ""
  if (!accountId) {
    const chk = await verifyCfToken(token)
    if (!chk.valid || !chk.accountId) return { ok: false, problem: chk.problem ?? "Couldn't read your Cloudflare account.", dns: [] }
    accountId = chk.accountId
  }

  // 1. Ensure the inbound HMAC secret (mint once; persisted).
  let secret = site.mail_inbound_secret
  if (!secret) {
    secret = cuid() + cuid()
    await master.execute({ sql: "UPDATE customer_sites SET mail_inbound_secret = ? WHERE id = ?", args: [secret, site.id] }).catch(() => {})
  }

  // 2. Enable Email Routing on the zone.
  const routing = await enableEmailRouting(token, site.zone_id)
  if (!routing.ok) return { ok: false, problem: routing.problem, dns: [] }

  // 3. Deploy the Email Worker into the customer's account.
  const name = mailWorkerName(site.id)
  const endpoint = `https://${env.SAAS_APP_HOSTNAME || "arsal.app"}/api/saas/mail/inbound/${site.id}`
  const upload = await putEmailWorker(token, accountId, name, renderEmailWorker({ endpoint, secret }))
  if (!upload.ok) return { ok: false, problem: upload.problem, dns: [] }

  // 4. Point the catch-all at the worker.
  const catchAll = await setCatchAllToWorker(token, site.zone_id, name)
  if (!catchAll.ok) return { ok: false, problem: catchAll.problem, dns: [] }

  // 5. Read the DNS records (MX/SPF) for the combined table + mark live.
  const dns = await emailRoutingDns(token, site.zone_id)
  await master.execute({ sql: "UPDATE customer_sites SET mail_routing_status = 'on' WHERE id = ?", args: [site.id] }).catch(() => {})

  return {
    ok: true,
    problem: null,
    dns: (dns.records || []).map((r) => ({ ...r, purpose: r.type === "MX" ? "Receiving (Cloudflare)" : "Receiving auth (SPF)" })),
  }
}
