// src/modules/provisioning/provisionSite.ts
// "Add site" orchestrator (spec Phase 3): repo from template in the CUSTOMER's
// GitHub → config + secrets → Action-gated first deploy (decision E) → custom
// domains (apex + www, canonical chosen in the wizard) → workers.dev disabled
// → zone protection → CMS backing site + rebuild webhook.
//
// Idempotent + resumable (spec non-negotiable): every step is one
// provisioning_runs row; runProvisioning executes pending/failed steps in
// order and stops at the first failure with a PLAIN-LANGUAGE error. Retry
// resumes from the failed step; completed steps never re-execute; each step's
// body is itself idempotent (existence probes before creates).

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { getSiteDb } from "../../lib/turso"
import { createSite } from "../../lib/provision"
import { audit, type Customer } from "../customers"
import { getConnection, getConnectionSecret } from "../connections"
import { vaultEncrypt, vaultDecrypt } from "../vault"
import {
  installationToken, repoExists, createRepoFromTemplate,
  setRepoSecret, putRepoFile, dispatchWorkflow,
} from "../connections"
import {
  workerScriptExists, attachWorkersDomain, disableWorkersDevSubdomain, enableZoneProtection,
  createTurnstileWidget,
} from "../connections"

export const PROVISION_STEPS = [
  "cms_site",
  "turnstile",
  "create_repo",
  "site_config",
  "repo_secrets",
  "first_deploy",
  "verify_deploy",
  "attach_domains",
  "disable_workers_dev",
  "zone_protection",
  "register_webhook",
] as const

export type ProvisionStep = (typeof PROVISION_STEPS)[number]

/** Human labels for the dashboard timeline (plain language, spec rule). */
export const STEP_LABELS: Record<ProvisionStep, string> = {
  cms_site: "Create your content workspace",
  turnstile: "Set up spam protection for the contact form",
  create_repo: "Create the site repository in your GitHub",
  site_config: "Write the site configuration",
  repo_secrets: "Store deploy credentials in your repository",
  first_deploy: "Start the first build",
  verify_deploy: "Confirm the site built and deployed",
  attach_domains: "Connect your domain (apex + www)",
  disable_workers_dev: "Turn off the workers.dev preview URL",
  zone_protection: "Enable Cloudflare protection",
  register_webhook: "Wire publish-to-rebuild",
}

export interface CustomerSiteRow {
  id: string
  customer_id: string
  cms_site_id: string | null
  cms_hostname: string | null
  repo_full_name: string | null
  worker_name: string | null
  domain: string
  canonical_host: string
  zone_id: string | null
  name: string
  niche: string | null
  kind: string
  status: string
}

export function siteSlug(domain: string): string {
  return domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50)
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  let hex = ""
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, "0")
  return hex
}

/** Create the customer_sites row + all step rows. Returns the site id. */
export async function createProvisioningPlan(
  db: Client,
  customer: Customer,
  input: { domain: string; canonicalHost: "apex" | "www"; name: string; niche: string; zoneId: string; kind: string }
): Promise<string> {
  const id = cuid()
  const slug = siteSlug(input.domain)
  await db.execute({
    sql: `INSERT INTO customer_sites (id, customer_id, domain, canonical_host, zone_id, name, niche, kind, repo_full_name, worker_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    args: [id, customer.id, input.domain, input.canonicalHost, input.zoneId, input.name, input.niche, input.kind, `site-${slug}`],
  })
  for (let i = 0; i < PROVISION_STEPS.length; i++) {
    await db.execute({
      sql: `INSERT INTO provisioning_runs (id, customer_site_id, step, ord) VALUES (?, ?, ?, ?)`,
      args: [cuid(), id, PROVISION_STEPS[i], i],
    })
  }
  await audit(db, customer.id, "site.provision_started", input.domain)
  return id
}

async function setStep(
  db: Client,
  siteId: string,
  step: ProvisionStep,
  status: "running" | "done" | "failed" | "skipped",
  error?: string,
  detail?: Record<string, unknown>
): Promise<void> {
  await db.execute({
    sql: `UPDATE provisioning_runs SET status = ?, error = ?, detail = COALESCE(?, detail),
            started_at = COALESCE(started_at, datetime('now')),
            finished_at = CASE WHEN ? IN ('done','failed','skipped') THEN datetime('now') ELSE finished_at END
          WHERE customer_site_id = ? AND step = ?`,
    args: [status, error ?? null, detail ? JSON.stringify(detail) : null, status, siteId, step],
  })
}

async function getSite(db: Client, siteId: string): Promise<CustomerSiteRow | null> {
  const r = await db.execute({ sql: "SELECT * FROM customer_sites WHERE id = ? LIMIT 1", args: [siteId] })
  return r.rows.length ? (r.rows[0] as unknown as CustomerSiteRow) : null
}

async function updateSite(db: Client, siteId: string, sets: Record<string, string | null>): Promise<void> {
  const cols = Object.keys(sets)
  await db.execute({
    sql: `UPDATE customer_sites SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`,
    args: [...cols.map((c) => sets[c]), siteId],
  })
}

async function stepDetail(db: Client, siteId: string, step: ProvisionStep): Promise<Record<string, unknown>> {
  const r = await db.execute({
    sql: "SELECT detail FROM provisioning_runs WHERE customer_site_id = ? AND step = ? LIMIT 1",
    args: [siteId, step],
  })
  try {
    return JSON.parse((r.rows[0]?.detail as string) || "{}") as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Execute all remaining steps in order; stop at the first failure.
 *  Safe to call repeatedly — done steps are skipped, running steps block. */
export async function runProvisioning(db: Client, env: CloudflareEnv, siteId: string): Promise<void> {
  const site = await getSite(db, siteId)
  if (!site) return
  const customerId = site.customer_id

  const rows = await db.execute({
    sql: "SELECT step, status, started_at FROM provisioning_runs WHERE customer_site_id = ? ORDER BY ord",
    args: [siteId],
  })

  for (const row of rows.rows) {
    const step = row.step as ProvisionStep
    const status = row.status as string
    if (status === "done" || status === "skipped") continue
    if (status === "running") return // another invocation is on it

    await setStep(db, siteId, step, "running")
    try {
      const outcome = await executeStep(db, env, siteId, step)
      await setStep(db, siteId, step, outcome.skipped ? "skipped" : "done", outcome.note, outcome.detail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong."
      console.error(`provision ${siteId} ${step} failed:`, msg)
      await setStep(db, siteId, step, "failed", msg)
      await updateSite(db, siteId, { status: "failed" })
      await audit(db, customerId, "site.provision_failed", site.domain, { step })
      return
    }
  }

  await updateSite(db, siteId, { status: "active" })
  await audit(db, customerId, "site.provision_completed", site.domain)
}

/** Reset a failed run so runProvisioning resumes from the failed step. */
export async function retryProvisioning(db: Client, siteId: string): Promise<boolean> {
  const r = await db.execute({
    sql: `UPDATE provisioning_runs SET status = 'pending', error = NULL, finished_at = NULL
          WHERE customer_site_id = ? AND status = 'failed'`,
    args: [siteId],
  })
  if ((r.rowsAffected ?? 0) > 0) {
    await db.execute({
      sql: "UPDATE customer_sites SET status = 'provisioning', updated_at = datetime('now') WHERE id = ?",
      args: [siteId],
    })
    return true
  }
  return false
}

interface StepOutcome {
  skipped?: boolean
  note?: string
  detail?: Record<string, unknown>
}

async function executeStep(
  db: Client,
  env: CloudflareEnv,
  siteId: string,
  step: ProvisionStep
): Promise<StepOutcome> {
  const site = await getSite(db, siteId)
  if (!site) throw new Error("This site no longer exists.")
  const slug = siteSlug(site.domain)
  const workerName = site.worker_name ?? `site-${slug}`

  // Connection material (fresh per step — tokens are short-lived).
  const github = await getConnection(db, site.customer_id, "github")
  const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  const ghOwner = String((JSON.parse(github?.meta || "{}") as { account?: string }).account ?? "")
  const repoFullName = site.repo_full_name ?? `${ghOwner}/${slug}`

  switch (step) {
    case "cms_site": {
      if (site.cms_site_id) return { skipped: true, note: "Already created." }
      const suffix = env.SAAS_CMS_HOST_SUFFIX || "cms.arsal.app"
      const cmsHostname = `${slug}.${suffix}`
      const customerRow = await db.execute({
        sql: "SELECT email FROM customers WHERE id = ? LIMIT 1",
        args: [site.customer_id],
      })
      const email = String(customerRow.rows[0]?.email ?? "")
      const result = await createSite(env, {
        hostname: cmsHostname,
        name: site.name,
        adminEmail: email,
        adminPassword: randomHex(16),
        configureDns: false,
      }).catch((err) => {
        throw new Error(
          `Couldn't create the content workspace (${err instanceof Error ? err.message : "unknown error"}). Retry in a minute.`
        )
      })
      await updateSite(db, siteId, { cms_site_id: result.siteId, cms_hostname: cmsHostname })
      if (!env.VAULT_MASTER_KEY) throw new Error("Credential storage isn't configured on the platform.")
      const apiKeyEnc = await vaultEncrypt(env.VAULT_MASTER_KEY, site.customer_id, result.apiKey)
      return { detail: { apiKeyEnc } }
    }

    case "turnstile": {
      const existing = await db.execute({
        sql: "SELECT sitekey FROM site_turnstile WHERE customer_site_id = ? LIMIT 1",
        args: [siteId],
      })
      if (existing.rows.length) return { skipped: true, note: "Already set up." }
      const cfToken = await getConnectionSecret(db, env, site.customer_id, "cloudflare", `turnstile:${site.domain}`)
      const cf = await getConnection(db, site.customer_id, "cloudflare")
      const accountId = String((JSON.parse(cf?.meta || "{}") as { accountId?: string }).accountId ?? "")
      if (!cfToken || !accountId) throw new Error("Cloudflare isn't connected — connect it in Connections, then retry.")
      const widget = await createTurnstileWidget(cfToken, accountId, `sitenetwork ${site.domain}`, [
        site.domain,
        `www.${site.domain}`,
      ])
      if (!widget.sitekey) {
        // Contact form falls back to mailto — never blocks the site launch.
        return { skipped: true, note: `Spam protection skipped: ${"problem" in widget ? widget.problem : "unknown"}. The contact page uses an email link instead.` }
      }
      if (!env.VAULT_MASTER_KEY) throw new Error("Credential storage isn't configured on the platform.")
      const secretEnc = await vaultEncrypt(env.VAULT_MASTER_KEY, site.customer_id, widget.secret)
      await db.execute({
        sql: "INSERT INTO site_turnstile (customer_site_id, sitekey, secret_enc) VALUES (?, ?, ?)",
        args: [siteId, widget.sitekey, secretEnc],
      })
      return {}
    }

    case "create_repo": {
      if (!installationId) throw new Error("GitHub isn't connected — connect it in Connections, then retry.")
      const token = await installationToken(env, installationId)
      if (await repoExists(token, repoFullName)) {
        await updateSite(db, siteId, { repo_full_name: repoFullName })
        return { skipped: true, note: "Repository already exists." }
      }
      const template = env.SAAS_TEMPLATE_REPO || "ArsalR/site-template"
      await createRepoFromTemplate(token, template, ghOwner, slug, `${site.name} — built with SiteNetwork`)
      await updateSite(db, siteId, { repo_full_name: repoFullName })
      return {}
    }

    case "site_config": {
      const token = await installationToken(env, installationId)
      const customerRow = await db.execute({
        sql: "SELECT email, name FROM customers WHERE id = ? LIMIT 1",
        args: [site.customer_id],
      })
      const turnstile = await db.execute({
        sql: "SELECT sitekey FROM site_turnstile WHERE customer_site_id = ? LIMIT 1",
        args: [siteId],
      })
      const sitekey = turnstile.rows.length ? String(turnstile.rows[0].sitekey) : null
      const config = {
        name: site.name,
        niche: site.niche ?? "",
        kind: site.kind ?? "content", // content | ecommerce | local-business | portfolio
        domain: site.domain,
        canonicalHost: site.canonical_host, // 'apex' | 'www'
        cmsApiUrl: `https://${site.cms_hostname}/api/public/v1`,
        ownerName: String(customerRow.rows[0]?.name ?? "") || site.name,
        ownerEmail: String(customerRow.rows[0]?.email ?? ""),
        generatedAt: new Date().toISOString().slice(0, 10),
        ...(sitekey
          ? {
              turnstileSitekey: sitekey,
              formsEndpoint: `https://${env.SAAS_APP_HOSTNAME || "arsal.app"}/api/saas/forms/${siteId}`,
            }
          : {}),
        ...(site.kind === "ecommerce"
          ? { checkoutEndpoint: `https://${env.SAAS_APP_HOSTNAME || "arsal.app"}/api/saas/checkout/${siteId}` }
          : {}),
      }
      await putRepoFile(token, repoFullName, "site.config.json", JSON.stringify(config, null, 2) + "\n", "chore: site configuration")
      await putRepoFile(
        token,
        repoFullName,
        "wrangler.toml",
        [
          `name = "${workerName}"`,
          `compatibility_date = "2025-05-01"`,
          ``,
          `[assets]`,
          `directory = "./dist"`,
          `html_handling = "auto-trailing-slash"`,
          `not_found_handling = "404-page"`,
          ``,
        ].join("\n"),
        "chore: worker configuration"
      )
      return {}
    }

    case "repo_secrets": {
      const token = await installationToken(env, installationId)
      const cfToken = await getConnectionSecret(db, env, site.customer_id, "cloudflare", `provision:${site.domain}`)
      if (!cfToken) throw new Error("Cloudflare isn't connected — connect it in Connections, then retry.")
      const cf = await getConnection(db, site.customer_id, "cloudflare")
      const accountId = String((JSON.parse(cf?.meta || "{}") as { accountId?: string }).accountId ?? "")
      const detail = await stepDetail(db, siteId, "cms_site")
      if (!env.VAULT_MASTER_KEY || typeof detail.apiKeyEnc !== "string") {
        throw new Error("The content workspace key is missing — retry from the start.")
      }
      const cmsKey = await vaultDecrypt(env.VAULT_MASTER_KEY, site.customer_id, detail.apiKeyEnc)
      await audit(db, site.customer_id, "connection.decrypt", "cms_api_key", { purpose: `repo-secrets:${site.domain}` })
      await setRepoSecret(token, repoFullName, "CF_API_TOKEN", cfToken)
      await setRepoSecret(token, repoFullName, "CF_ACCOUNT_ID", accountId)
      await setRepoSecret(token, repoFullName, "CMS_API_KEY", cmsKey)
      const anthropicKey = await getConnectionSecret(db, env, site.customer_id, "anthropic", `provision:${site.domain}`).catch(() => null)
      if (anthropicKey) await setRepoSecret(token, repoFullName, "ANTHROPIC_API_KEY", anthropicKey)
      return {}
    }

    case "first_deploy": {
      const token = await installationToken(env, installationId)
      await dispatchWorkflow(token, repoFullName, "deploy.yml").catch((err) => {
        throw new Error(
          `Couldn't start the first build (${err instanceof Error ? err.message : "unknown"}). The repository may still be initializing — retry in a minute.`
        )
      })
      return {}
    }

    case "verify_deploy": {
      const cfToken = await getConnectionSecret(db, env, site.customer_id, "cloudflare", `verify-deploy:${site.domain}`)
      const cf = await getConnection(db, site.customer_id, "cloudflare")
      const accountId = String((JSON.parse(cf?.meta || "{}") as { accountId?: string }).accountId ?? "")
      if (!cfToken || !accountId) throw new Error("Cloudflare isn't connected — reconnect it, then retry.")
      if (!(await workerScriptExists(cfToken, accountId, workerName))) {
        throw new Error("The site is still building (the first build takes a few minutes, and it must pass the speed and security checks). Retry shortly.")
      }
      return {}
    }

    case "attach_domains": {
      const cfToken = await getConnectionSecret(db, env, site.customer_id, "cloudflare", `attach-domains:${site.domain}`)
      const cf = await getConnection(db, site.customer_id, "cloudflare")
      const accountId = String((JSON.parse(cf?.meta || "{}") as { accountId?: string }).accountId ?? "")
      if (!cfToken || !accountId || !site.zone_id) throw new Error("Cloudflare details are missing — reconnect it, then retry.")
      const apex = await attachWorkersDomain(cfToken, accountId, site.zone_id, site.domain, workerName)
      if (!apex.ok) throw new Error(apex.problem ?? "Couldn't attach your domain.")
      const www = await attachWorkersDomain(cfToken, accountId, site.zone_id, `www.${site.domain}`, workerName)
      if (!www.ok) throw new Error(www.problem ?? "Couldn't attach the www variant of your domain.")
      return {}
    }

    case "disable_workers_dev": {
      const cfToken = await getConnectionSecret(db, env, site.customer_id, "cloudflare", `workers-dev:${site.domain}`)
      const cf = await getConnection(db, site.customer_id, "cloudflare")
      const accountId = String((JSON.parse(cf?.meta || "{}") as { accountId?: string }).accountId ?? "")
      if (!cfToken || !accountId) throw new Error("Cloudflare isn't connected — reconnect it, then retry.")
      const r = await disableWorkersDevSubdomain(cfToken, accountId, workerName)
      if (!r.ok) throw new Error(r.problem ?? "Couldn't disable the workers.dev URL.")
      return {}
    }

    case "zone_protection": {
      const cfToken = await getConnectionSecret(db, env, site.customer_id, "cloudflare", `zone-protection:${site.domain}`)
      if (!cfToken || !site.zone_id) return { skipped: true, note: "Cloudflare details missing — enable Bot Fight Mode manually." }
      const r = await enableZoneProtection(cfToken, site.zone_id)
      return r.ok ? {} : { skipped: true, note: r.problem ?? undefined }
    }

    case "register_webhook": {
      if (!site.cms_site_id) throw new Error("The content workspace is missing — retry from the start.")
      const master = await db.execute({
        sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1",
        args: [site.cms_site_id],
      })
      if (!master.rows.length) throw new Error("The content workspace registration is missing.")
      const siteDb = getSiteDb(master.rows[0].turso_url as string, master.rows[0].turso_token as string)
      const hookUrl = `https://${env.SAAS_APP_HOSTNAME || "arsal.app"}/api/saas/hooks/cms/${siteId}`
      const existing = await siteDb.execute({
        sql: "SELECT id FROM webhook_endpoints WHERE url = ? LIMIT 1",
        args: [hookUrl],
      })
      if (existing.rows.length) return { skipped: true, note: "Already wired." }
      const secret = randomHex(32)
      await siteDb.execute({
        sql: `INSERT INTO webhook_endpoints (id, url, secret, secret_preview, events, active)
              VALUES (?, ?, ?, ?, '["post.published","post.updated","post.deleted"]', 1)`,
        args: [cuid(), hookUrl, secret, secret.slice(-4)],
      })
      return {}
    }
  }
}

export interface StepView {
  step: ProvisionStep
  label: string
  status: string
  error: string | null
}

export async function provisioningStatus(db: Client, siteId: string): Promise<StepView[]> {
  const rows = await db.execute({
    sql: "SELECT step, status, error FROM provisioning_runs WHERE customer_site_id = ? ORDER BY ord",
    args: [siteId],
  })
  return rows.rows.map((r) => ({
    step: r.step as ProvisionStep,
    label: STEP_LABELS[r.step as ProvisionStep] ?? (r.step as string),
    status: r.status as string,
    error: (r.error as string | null) ?? null,
  }))
}
