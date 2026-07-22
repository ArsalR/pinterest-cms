// src/modules/publishing/service.ts
// The gated publishing pipeline (spec Phase 5): a draft only goes live if it
// clears the quality gate (default-ON). Pass → publish + trigger the site
// rebuild; fail → record a plain-language report, leave it as a draft.
//
// Publishing writes published=1 directly to the site's CMS DB and fires a
// repository_dispatch rebuild (the same content-updated event the CMS webhook
// bridge uses), so the static site regenerates with the new page.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { getMasterDb, getSiteDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared"
import { getConnection } from "../connections"
import { installationToken, repositoryDispatch } from "../connections"
import { audit } from "../customers"
import { cuid } from "../../lib/utils"
import { checkGate, DEFAULT_GATE_CONFIG, type GateConfig, type GateItem, type GateResult } from "../quality-gate"
import { pingIndexNow } from "../seo"

/** V1.5 M6 (always-optimized): fire an IndexNow ping for freshly published URLs
 *  on EVERY site (not just News), so Bing + DuckDuckGo (which rides Bing) and the
 *  Copilot ecosystem index new/updated content fast. The per-site key is
 *  auto-provisioned on first ping (ensureIndexNowKey). Best-effort — never blocks
 *  or fails a publish. */
async function indexNowAfterPublish(siteDb: Client, domain: string, slugs: string[]): Promise<void> {
  try {
    await pingIndexNow(siteDb, domain, slugs.map((s) => `https://${domain}/posts/${s}/`))
  } catch {
    /* best-effort */
  }
}

export interface CustomerSiteRef {
  id: string
  customer_id: string
  cms_site_id: string | null
  repo_full_name: string | null
  domain: string
}

async function siteDbFor(master: Client, cmsSiteId: string): Promise<Client | null> {
  const r = await master.execute({
    sql: "SELECT turso_url, turso_token FROM sites WHERE id = ? LIMIT 1",
    args: [cmsSiteId],
  })
  if (!r.rows.length) return null
  return getSiteDb(r.rows[0].turso_url as string, r.rows[0].turso_token as string)
}

/** Published posts as the corpus for uniqueness checks. */
export async function loadCorpus(siteDb: Client, excludePostId?: string): Promise<GateItem[]> {
  const r = await siteDb.execute({
    sql: `SELECT id, title, excerpt, content FROM posts WHERE published = 1 AND type = 'post'`,
    args: [],
  })
  return r.rows
    .filter((row) => row.id !== excludePostId)
    .map((row) => ({ title: String(row.title ?? ""), meta: (row.excerpt as string | null) ?? "", content: String(row.content ?? "") }))
}

export interface DraftView {
  id: string
  title: string
  result: GateResult
}

/** Evaluate all drafts of a site against the gate (dashboard preview). */
export async function evaluateDrafts(
  master: Client,
  cmsSiteId: string,
  config: GateConfig = DEFAULT_GATE_CONFIG
): Promise<DraftView[]> {
  const siteDb = await siteDbFor(master, cmsSiteId)
  if (!siteDb) return []
  const drafts = await siteDb.execute({
    sql: `SELECT id, title, excerpt, content FROM posts WHERE published = 0 AND type = 'post' ORDER BY created_at DESC LIMIT 100`,
    args: [],
  })
  const corpus = await loadCorpus(siteDb)
  return drafts.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? "(untitled)"),
    result: checkGate(
      { title: String(row.title ?? ""), meta: (row.excerpt as string | null) ?? "", content: String(row.content ?? "") },
      corpus,
      config
    ),
  }))
}

export interface PublishOutcome {
  published: boolean
  result: GateResult | null
  error?: string
}

/** Gate a single draft and publish it if it passes. Records the report either way. */
export async function gateAndPublish(
  env: CloudflareEnv,
  site: CustomerSiteRef,
  postId: string,
  config: GateConfig = DEFAULT_GATE_CONFIG
): Promise<PublishOutcome> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  if (!site.cms_site_id) return { published: false, result: null, error: "This site has no content workspace." }

  const siteDb = await siteDbFor(master, site.cms_site_id)
  if (!siteDb) return { published: false, result: null, error: "The content workspace is unavailable." }

  const draftRow = await siteDb.execute({
    sql: "SELECT id, title, slug, excerpt, content, published FROM posts WHERE id = ? AND type = 'post' LIMIT 1",
    args: [postId],
  })
  if (!draftRow.rows.length) return { published: false, result: null, error: "That draft no longer exists." }
  const d = draftRow.rows[0]
  if (Number(d.published) === 1) return { published: true, result: null } // already live

  const item: GateItem = {
    title: String(d.title ?? ""),
    meta: (d.excerpt as string | null) ?? "",
    content: String(d.content ?? ""),
  }
  const corpus = await loadCorpus(siteDb, postId)
  const result = checkGate(item, corpus, config)

  // Record the gate report on the master jobs table (dashboard + history).
  await master
    .execute({
      sql: `INSERT INTO jobs (id, customer_id, kind, status, payload) VALUES (?, ?, 'gate_report', ?, ?)`,
      args: [cuid(), site.customer_id, result.passed ? "passed" : "failed", JSON.stringify({ siteId: site.id, postId, checks: result.checks })],
    })
    .catch(() => {})

  if (!result.passed) {
    await audit(master, site.customer_id, "post.gate_failed", site.domain, { postId })
    return { published: false, result }
  }

  // Publish + trigger rebuild.
  await siteDb.execute({
    sql: "UPDATE posts SET published = 1, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    args: [postId],
  })
  await audit(master, site.customer_id, "post.gated_published", site.domain, { postId })

  if (site.repo_full_name) {
    const github = await getConnection(master, site.customer_id, "github")
    const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
    if (installationId) {
      try {
        const token = await installationToken(env, installationId)
        await repositoryDispatch(token, site.repo_full_name, "content-updated", { reason: "gated-publish" })
      } catch (err) {
        console.error("gateAndPublish: rebuild dispatch failed:", err instanceof Error ? err.message : err)
        // Not fatal — the post is published; the next content event will rebuild.
      }
    }
  }
  await indexNowAfterPublish(siteDb, site.domain, [String(d.slug ?? "")])

  return { published: true, result }
}

/** Publish every draft that clears the gate (one rebuild at the end). Used for
 *  genesis output — the whole batch goes live in one click, still gated. */
export async function publishAllPassing(
  env: CloudflareEnv,
  site: CustomerSiteRef,
  config: GateConfig = DEFAULT_GATE_CONFIG
): Promise<{ published: number; blocked: number }> {
  const master = getMasterDb(env)
  await ensureMasterSchema(master)
  if (!site.cms_site_id) return { published: 0, blocked: 0 }
  const drafts = await evaluateDrafts(master, site.cms_site_id, config)
  const siteDb = await siteDbFor(master, site.cms_site_id)
  if (!siteDb) return { published: 0, blocked: 0 }

  let published = 0
  let blocked = 0
  const publishedIds: string[] = []
  for (const d of drafts) {
    if (!d.result.passed) { blocked++; continue }
    await siteDb
      .execute({
        sql: "UPDATE posts SET published = 1, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        args: [d.id],
      })
      .then(() => { published++; publishedIds.push(d.id) })
      .catch(() => {})
  }

  if (published > 0) {
    await audit(master, site.customer_id, "post.bulk_published", site.domain, { published, blocked })
    if (site.repo_full_name) {
      const github = await getConnection(master, site.customer_id, "github")
      const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
      if (installationId) {
        try {
          const token = await installationToken(env, installationId)
          await repositoryDispatch(token, site.repo_full_name, "content-updated", { reason: "bulk-publish" })
        } catch (err) {
          console.error("publishAllPassing: rebuild dispatch failed:", err instanceof Error ? err.message : err)
        }
      }
    }
    // News profile: one IndexNow batch for everything that just went live.
    try {
      const slugRows = await siteDb.execute({
        sql: `SELECT slug FROM posts WHERE id IN (${publishedIds.map(() => "?").join(",")})`,
        args: publishedIds,
      })
      await indexNowAfterPublish(siteDb, site.domain, slugRows.rows.map((r) => String(r.slug)))
    } catch {
      /* best-effort */
    }
  }
  return { published, blocked }
}
