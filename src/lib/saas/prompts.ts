// src/lib/saas/prompts.ts
// Prompt-to-build dispatch (Phase 4). Platform-side cost guardrails (locked
// in review): hourly dispatch cap per site (quota_exceeded), plan gate
// (trial expiry pauses prompt-edits — decision B), audit log on every
// dispatch. The 15-min timeout and per-site queued concurrency live in the
// template's claude.yml. Status is derived live from the GitHub Actions runs
// (queued → running → committed → building → deployed) and each run shows
// "~X minutes used" so bills are never a surprise.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../types"
import { cuid } from "../utils"
import { audit } from "./customers"
import { allowRate } from "./rateLimit"
import { getConnection } from "./connections"
import {
  installationToken, dispatchWorkflow, listWorkflowRuns, commitSummary,
  type WorkflowRunInfo, type CommitInfo,
} from "./github"
import type { CustomerSiteRow } from "./provisionSite"

export const PROMPT_DISPATCH_LIMIT = { max: 6, windowSecs: 3600 } // per site per hour

export type PromptMode = "preview" | "direct"

export interface PromptJob {
  id: string
  kind: string
  status: string
  payload: string | null
  result: string | null
  created_at: string
}

/** Genesis prompt (K1) — one prompt, whole site: design + 10 seed articles. */
export function genesisPrompt(name: string, niche: string): string {
  return [
    `SITE GENESIS for "${name}" — a brand-new site about: ${niche}.`,
    ``,
    `Do ALL of the following:`,
    `1. Design: adjust the site's colors and typography in src/layouts/Base.astro to fit the niche`,
    `   (keep the system font stack, keep total CSS small, keep zero client JavaScript).`,
    `2. Content: create 10 genuinely useful seed articles via the CMS API (see the rules above for`,
    `   how to call it). Build a topical map for the niche first: 2 pillar guides and 8 supporting`,
    `   articles that link the pillars. Each article: descriptive title, 800+ words of specific,`,
    `   practical content (real steps, real numbers — never filler), a 1-2 sentence excerpt, and a`,
    `   category. Publish them (published: true).`,
    `3. Navigation: if the homepage would benefit from category links once articles exist, add them.`,
    `Do NOT touch protected files. Do NOT add client-side JavaScript.`,
  ].join("\n")
}

/** Map a claude.yml run + follow-on deploy run to the streamed status. */
export function runPhase(
  claudeRun: Pick<WorkflowRunInfo, "status" | "conclusion"> | null,
  deployRun: Pick<WorkflowRunInfo, "status" | "conclusion"> | null
): "queued" | "running" | "committed" | "building" | "deployed" | "failed" | "unknown" {
  if (!claudeRun) return "unknown"
  if (claudeRun.status === "queued") return "queued"
  if (claudeRun.status === "in_progress") return "running"
  if (claudeRun.status === "completed" && claudeRun.conclusion !== "success") return "failed"
  // Claude run succeeded → changes are committed; deploy pipeline takes over.
  if (!deployRun) return "committed"
  if (deployRun.status === "queued" || deployRun.status === "in_progress") return "building"
  return deployRun.conclusion === "success" ? "deployed" : "failed"
}

/** "~X min" from run timing — the visible cost line (locked in review). */
export function runMinutes(run: Pick<WorkflowRunInfo, "runStartedAt" | "updatedAt"> | null): string | null {
  if (!run?.runStartedAt || !run.updatedAt) return null
  const ms = Date.parse(run.updatedAt) - Date.parse(run.runStartedAt)
  if (!Number.isFinite(ms) || ms < 0) return null
  return `~${Math.max(1, Math.round(ms / 60000))} min`
}

export interface DispatchResult {
  ok: boolean
  jobId?: string
  problem?: string
  code?: "quota_exceeded" | "not_ready" | "internal_error"
}

export async function dispatchPrompt(
  db: Client,
  env: CloudflareEnv,
  site: CustomerSiteRow,
  prompt: string,
  mode: PromptMode,
  kind: "prompt" | "genesis" = "prompt"
): Promise<DispatchResult> {
  if (site.status !== "active" || !site.repo_full_name) {
    return { ok: false, code: "not_ready", problem: "The site isn't fully set up yet — finish provisioning first." }
  }
  // Hourly cap per site (cost guardrail — locked in review).
  if (!(await allowRate(db, `prompt:site:${site.id}`, PROMPT_DISPATCH_LIMIT))) {
    return {
      ok: false,
      code: "quota_exceeded",
      problem: "This site has hit its hourly limit for Claude runs — try again in a bit. (This cap keeps your GitHub and API bills predictable.)",
    }
  }
  const github = await getConnection(db, site.customer_id, "github")
  const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  if (!installationId) {
    return { ok: false, code: "not_ready", problem: "GitHub isn't connected — reconnect it in Connections." }
  }

  const jobId = cuid()
  await db.execute({
    sql: `INSERT INTO jobs (id, customer_id, kind, status, payload) VALUES (?, ?, ?, 'dispatched', ?)`,
    args: [jobId, site.customer_id, kind, JSON.stringify({ siteId: site.id, mode, prompt: prompt.slice(0, 2000) })],
  })
  await audit(db, site.customer_id, `site.${kind}_dispatched`, site.domain, { jobId, mode })

  try {
    const token = await installationToken(env, installationId)
    await dispatchWorkflow(token, site.repo_full_name, "claude.yml", "main", {
      prompt,
      mode,
      job_id: jobId,
    })
  } catch (err) {
    await db.execute({
      sql: "UPDATE jobs SET status = 'failed', result = ?, updated_at = datetime('now') WHERE id = ?",
      args: [JSON.stringify({ error: "dispatch failed" }), jobId],
    })
    console.error("dispatchPrompt failed:", err instanceof Error ? err.message : err)
    return { ok: false, code: "internal_error", problem: "Couldn't start the run — GitHub may be briefly unavailable. Try again." }
  }
  return { ok: true, jobId }
}

export interface PromptRunView {
  jobId: string
  kind: string
  mode: string
  promptPreview: string
  phase: ReturnType<typeof runPhase>
  minutes: string | null
  runUrl: string | null
  diff: CommitInfo | null
  createdAt: string
}

/** Live status of recent prompt jobs for one site (drives the dashboard timeline). */
export async function promptRuns(
  db: Client,
  env: CloudflareEnv,
  site: CustomerSiteRow,
  limit = 5
): Promise<PromptRunView[]> {
  const jobs = await db.execute({
    sql: `SELECT id, kind, payload, created_at FROM jobs
          WHERE kind IN ('prompt','genesis') AND customer_id = ? AND payload LIKE ?
          ORDER BY created_at DESC LIMIT ?`,
    args: [site.customer_id, `%"siteId":"${site.id}"%`, limit],
  })
  if (!jobs.rows.length || !site.repo_full_name) return []

  const github = await getConnection(db, site.customer_id, "github")
  const installationId = Number((JSON.parse(github?.meta || "{}") as { installationId?: number }).installationId ?? 0)
  if (!installationId) return []

  let claudeRuns: WorkflowRunInfo[] = []
  let deployRuns: WorkflowRunInfo[] = []
  let token = ""
  try {
    token = await installationToken(env, installationId)
    claudeRuns = await listWorkflowRuns(token, site.repo_full_name, "claude.yml", 20)
    deployRuns = await listWorkflowRuns(token, site.repo_full_name, "deploy.yml", 20)
  } catch (err) {
    console.error("promptRuns: run listing failed:", err instanceof Error ? err.message : err)
  }

  const out: PromptRunView[] = []
  for (const row of jobs.rows) {
    const jobId = row.id as string
    const payload = JSON.parse((row.payload as string) || "{}") as { mode?: string; prompt?: string }
    const claudeRun = claudeRuns.find((r) => r.displayTitle.includes(jobId)) ?? null
    // The deploy triggered by this run: same head sha (direct) or later push.
    const deployRun = claudeRun
      ? deployRuns.find((d) => Date.parse(d.runStartedAt ?? "") >= Date.parse(claudeRun.updatedAt ?? "")) ?? null
      : null
    let diff: CommitInfo | null = null
    if (claudeRun && claudeRun.status === "completed" && claudeRun.conclusion === "success" && token) {
      diff = await commitSummary(token, site.repo_full_name, claudeRun.headSha).catch(() => null)
    }
    out.push({
      jobId,
      kind: row.kind as string,
      mode: payload.mode ?? "preview",
      promptPreview: (payload.prompt ?? "").slice(0, 140),
      phase: runPhase(claudeRun, deployRun),
      minutes: runMinutes(claudeRun),
      runUrl: claudeRun?.htmlUrl ?? null,
      diff,
      createdAt: row.created_at as string,
    })
  }
  return out
}
