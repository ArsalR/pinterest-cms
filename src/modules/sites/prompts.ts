// src/modules/sites/prompts.ts
// Prompt-to-build dispatch (Phase 4). Platform-side cost guardrails (locked
// in review): hourly dispatch cap per site (quota_exceeded), plan gate
// (trial expiry pauses prompt-edits — decision B), audit log on every
// dispatch. The 15-min timeout and per-site queued concurrency live in the
// template's claude.yml. Status is derived live from the GitHub Actions runs
// (queued → running → committed → building → deployed) and each run shows
// "~X minutes used" so bills are never a surprise.

import type { Client } from "@libsql/client/web"
import type { CloudflareEnv } from "../../lib/types"
import { cuid } from "../../lib/utils"
import { audit } from "../customers"
import { allowRate } from "../../shared/rateLimit"
import { getConnection } from "../connections"
import {
  installationToken, dispatchWorkflow, listWorkflowRuns, commitSummary,
  type WorkflowRunInfo, type CommitInfo,
} from "../connections"
import type { CustomerSiteRow } from "../provisioning"

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

/** Genesis prompt (K1) — one prompt, whole site. Kind-aware (amendment 2):
 *  the shared core (design within the covenants, no protected-file edits, zero
 *  client JS) is constant; the content brief branches by site kind. */
export function genesisPrompt(name: string, niche: string, kind: string = "content", toneLine = ""): string {
  const header = [
    `SITE GENESIS for "${name}" — a brand-new ${kindLabel(kind)} about: ${niche}.`,
    ``,
    `Design is ALREADY SET by the site's chosen design preset (CSS-variable tokens in`,
    `src/lib/presets.ts, applied via site.config.json) — do NOT change colors, fonts, or`,
    `the layout system, and do NOT touch protected files (.github/**, site.config.json,`,
    `wrangler.toml, scripts/**). Focus entirely on content. Keep ZERO client JavaScript.`,
    ``,
    `ART DIRECTION — make the content itself look designed by using the theme's styled`,
    `elements well (every one is already themed by the preset; add NO inline styles, colors,`,
    `or <style>/<script>):`,
    `• Structure each page with a clear hierarchy: a strong opening line, then descriptive`,
    `  H2/H3 section headings — never a wall of text.`,
    `• Use the elements the stylesheet makes beautiful: short lead paragraph, bulleted/numbered`,
    `  lists for steps and specs, a <blockquote> for a key takeaway, a <table> for comparisons`,
    `  or specs, and semantic emphasis (<strong>). These read as "designed" for free.`,
    `• Write titles and excerpts with editorial craft — specific and concrete, never generic`,
    `  ("How X works" beats "Welcome to our blog").`,
    `• Keep paragraphs tight (2–4 sentences) so the reading rhythm and measure look intentional.`,
    ``,
    `SECTION COMPONENTS — the theme ships zero-JS, pre-styled blocks. Compose landing/service`,
    `pages from these by emitting plain HTML with these class names (no styles of your own):`,
    `• Stats band: <div class="stats"><div class="stat"><span class="n">12k</span><span class="l">happy clients</span></div>…</div>`,
    `• Testimonials: a .grid-2 of <blockquote class="card quote-card"><p>…</p><div class="who"><b>Name</b><span>Role</span></div></blockquote>`,
    `• Pricing: a .grid-3 of <div class="card price-card"><h3>Plan</h3><div class="amt">$29<small>/mo</small></div><ul><li>Feature</li>…</ul><a class="btn" href="/contact/">Choose</a></div> (add class "featured" to the recommended one)`,
    `• FAQ: repeated <details class="faq"><summary>Question?</summary><p>Answer.</p></details> (native, no JS)`,
    `• Team: a .grid-3 of <div class="card member"><div class="name">Name</div><div class="role">Title</div></div>`,
    `• Timeline: <div class="timeline"><div class="timeline-item"><div class="when">2021</div><h3>Milestone</h3><p>…</p></div>…</div>`,
    `• Logo strip: <div class="logos"><span>BrandA</span><span>BrandB</span>…</div>`,
    `• CTA band: <div class="cta-band"><h2>Ready?</h2><p>One line.</p><a class="btn" href="/contact/">Get started</a></div>`,
    `• Comparison: a normal <table> (already themed). Use these where they fit the page's job — don't force all of them.`,
    `Optional: add class "reveal" to a section BELOW the first screen for a subtle scroll-in`,
    `(never on the hero/first section). It degrades gracefully and respects reduced-motion.`,
    ``,
    `Content — do ALL of the following via the CMS API (see the rules above for how to call it).`,
    ...(toneLine ? [`TONE: ${toneLine}`] : []),
    `Create each item as a DRAFT (published: false) — it will pass through the quality gate in the`,
    `dashboard before going live, so launch content is held to the same bar as everything else.`,
    `Give each a descriptive title, a 1–2 sentence excerpt, a category, and specific, practical copy`,
    `with real detail (never filler):`,
  ]
  const brief =
    kind === "ecommerce"
      ? [
          `1. 6–8 buying guides / how-to articles for the niche that will attract search traffic and`,
          `   link naturally to the products you'll sell.`,
          `2. 2 pillar guides that establish topical authority.`,
          `NOTE: product listings + checkout are set up separately in the dashboard — for now focus on`,
          `the content that drives shoppers in. Do not add a cart or checkout UI yourself.`,
        ]
      : kind === "local-business"
        ? [
            `1. A clear homepage message + 4–6 service pages describing exactly what you offer, for whom,`,
            `   and the areas you serve (use the niche for specifics).`,
            `2. 4 local-SEO articles (guides/FAQs) that a nearby customer would search for.`,
            `Keep NAP-style clarity: make it obvious what the business does and how to get in touch`,
            `(the contact page already exists).`,
          ]
        : kind === "portfolio"
          ? [
              `1. A homepage that leads with the value you provide, plus a services/offerings section.`,
              `2. 4–6 case-study or project write-ups (problem → approach → result) relevant to the niche.`,
              `3. 2 supporting articles that demonstrate expertise.`,
            ]
          : [
              `1. A topical map first: 2 pillar guides and 8 supporting articles that link the pillars.`,
              `2. Each article 800+ words of genuinely useful, specific content.`,
              `3. Add category links to the homepage once articles exist, if it helps navigation.`,
            ]
  return [...header, ...brief].join("\n")
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "ecommerce": return "online store"
    case "local-business": return "local-business site"
    case "portfolio": return "portfolio / services site"
    default: return "content site"
  }
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
  // Key hygiene: a pasted credential would otherwise persist in the job
  // payload and the Actions run input. Refuse instead of storing.
  if (/(sk-ant-[A-Za-z0-9_-]{8,}|cms_live_[0-9a-f]{8,})/.test(prompt)) {
    return {
      ok: false,
      code: "not_ready",
      problem: "Your prompt looks like it contains an API key — please remove it. Keys are connected once in Connections and never belong in prompts.",
    }
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
