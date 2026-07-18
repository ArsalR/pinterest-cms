// src/modules/connections/cloudflare.ts
// Customer-token Cloudflare client (BYO-infrastructure). Phase 2 scope:
// live token verification + zone listing for the wizard's domain step
// (nameserver instructions + activation polling). Workers deploys, custom
// domains, WAF arrive in Phase 3 on top of cfFetch().
//
// The token itself is only ever held transiently in memory here; storage is
// vault-encrypted by the connections layer.

const CF_API = "https://api.cloudflare.com/client/v4"

/** The exact token template shown to customers in the wizard (spec Phase 2).
 *  Create at dash.cloudflare.com/profile/api-tokens → "Create Custom Token". */
export const CF_TOKEN_TEMPLATE: ReadonlyArray<{ scope: string; permission: string; access: string }> = [
  { scope: "Account", permission: "Workers Scripts", access: "Edit" },
  { scope: "Account", permission: "Account Settings", access: "Read" },
  { scope: "Zone", permission: "Zone", access: "Read" },
  { scope: "Zone", permission: "Zone Settings", access: "Edit" },
  { scope: "Zone", permission: "DNS", access: "Edit" },
  { scope: "Zone", permission: "Cache Purge", access: "Purge" },
  { scope: "Zone", permission: "Analytics", access: "Read" },
  // V1.3 edge bot protection — lets the platform manage the AI-crawler WAF
  // rule and Bot Fight Mode on the customer's zone.
  { scope: "Zone", permission: "Firewall Services", access: "Edit" },
]

async function cfFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; result: T | null; errorMessage: string | null }> {
  try {
    const resp = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    })
    const body = (await resp.json().catch(() => null)) as
      | { success?: boolean; result?: T; errors?: Array<{ message?: string }> }
      | null
    if (!resp.ok || !body?.success) {
      return {
        ok: false,
        status: resp.status,
        result: null,
        errorMessage: body?.errors?.[0]?.message ?? `Cloudflare returned ${resp.status}`,
      }
    }
    return { ok: true, status: resp.status, result: (body.result as T) ?? null, errorMessage: null }
  } catch {
    return { ok: false, status: 0, result: null, errorMessage: "Couldn't reach Cloudflare — please try again." }
  }
}

export interface CfTokenCheck {
  valid: boolean
  /** Plain-language problem description when invalid. */
  problem: string | null
  accountId: string | null
  accountName: string | null
  zoneCount: number
}

/** Live-verify a pasted token: is it active, and can it see account + zones? */
export async function verifyCfToken(token: string): Promise<CfTokenCheck> {
  const bad = (problem: string): CfTokenCheck => ({ valid: false, problem, accountId: null, accountName: null, zoneCount: 0 })

  if (!/^[A-Za-z0-9_-]{30,}$/.test(token.trim())) {
    return bad("That doesn't look like a Cloudflare API token — it should be a long string of letters, numbers, dashes and underscores.")
  }

  const verify = await cfFetch<{ status: string }>(token, "/user/tokens/verify")
  if (!verify.ok) {
    return bad("Cloudflare says this token isn't valid. Double-check you copied the whole token (it's only shown once when created).")
  }
  if (verify.result?.status !== "active") {
    return bad(`This token exists but is ${verify.result?.status ?? "not active"} — create a fresh one.`)
  }

  const accounts = await cfFetch<Array<{ id: string; name: string }>>(token, "/accounts?per_page=5")
  if (!accounts.ok || !accounts.result?.length) {
    return bad('The token is active but can\'t read your account. Add "Account Settings: Read" to the token\'s permissions.')
  }

  const zones = await cfFetch<Array<{ id: string }>>(token, "/zones?per_page=50")
  if (!zones.ok) {
    return bad('The token can\'t list your domains. Add "Zone: Read" to the token\'s permissions (All zones).')
  }

  return {
    valid: true,
    problem: null,
    accountId: accounts.result[0].id,
    accountName: accounts.result[0].name,
    zoneCount: zones.result?.length ?? 0,
  }
}

export interface CfZone {
  id: string
  name: string
  status: string        // "active" | "pending" | …
  nameServers: string[] // assigned CF nameservers (what the registrar must point to)
  paused: boolean
}

/** List zones the token can see (drives the domain picker + activation polling). */
export async function listCfZones(token: string): Promise<CfZone[] | null> {
  const zones = await cfFetch<
    Array<{ id: string; name: string; status: string; name_servers?: string[]; paused: boolean }>
  >(token, "/zones?per_page=50")
  if (!zones.ok || !zones.result) return null
  return zones.result.map((z) => ({
    id: z.id,
    name: z.name,
    status: z.status,
    nameServers: z.name_servers ?? [],
    paused: z.paused,
  }))
}

// ─────────────── Phase 3: provisioning calls (customer token) ───────────────

/** Does the Worker script exist yet? (Provisioning polls this after the first
 *  Action-gated deploy — decision E: the Action deploys, we only observe.) */
export async function workerScriptExists(token: string, accountId: string, scriptName: string): Promise<boolean> {
  const r = await cfFetch<unknown>(token, `/accounts/${accountId}/workers/scripts/${scriptName}`)
  return r.ok
}

/** Attach a custom domain (hostname on the customer's zone) to their Worker.
 *  Cloudflare creates/updates the DNS record automatically. Idempotent. */
export async function attachWorkersDomain(
  token: string,
  accountId: string,
  zoneId: string,
  hostname: string,
  scriptName: string
): Promise<{ ok: boolean; problem: string | null }> {
  const r = await cfFetch<unknown>(token, `/accounts/${accountId}/workers/domains`, {
    method: "PUT",
    body: JSON.stringify({ zone_id: zoneId, hostname, service: scriptName, environment: "production" }),
  })
  return r.ok
    ? { ok: true, problem: null }
    : { ok: false, problem: r.errorMessage ?? "Couldn't attach the domain to the Worker." }
}

/** Disable the *.workers.dev URL for a script — a live workers.dev duplicate
 *  of the customer's site is an SEO duplicate-content bug (locked in review). */
export async function disableWorkersDevSubdomain(
  token: string,
  accountId: string,
  scriptName: string
): Promise<{ ok: boolean; problem: string | null }> {
  const r = await cfFetch<unknown>(token, `/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
    method: "POST",
    body: JSON.stringify({ enabled: false }),
  })
  return r.ok
    ? { ok: true, problem: null }
    : { ok: false, problem: r.errorMessage ?? "Couldn't disable the workers.dev URL." }
}

/** Create a Turnstile widget on the CUSTOMER's account (locked in review —
 *  per-site keys on their infrastructure, not a shared platform key). */
export async function createTurnstileWidget(
  token: string,
  accountId: string,
  name: string,
  domains: string[]
): Promise<{ sitekey: string; secret: string } | { sitekey: null; secret: null; problem: string }> {
  const r = await cfFetch<{ sitekey: string; secret: string }>(
    token,
    `/accounts/${accountId}/challenges/widgets`,
    {
      method: "POST",
      body: JSON.stringify({ name, domains, mode: "managed" }),
    }
  )
  if (!r.ok || !r.result?.sitekey) {
    return { sitekey: null, secret: null, problem: r.errorMessage ?? "Couldn't create the Turnstile widget." }
  }
  return { sitekey: r.result.sitekey, secret: r.result.secret }
}

/** The account's workers.dev subdomain (e.g. "acme" → *.acme.workers.dev).
 *  Used to derive a site's preview-worker URL for the dashboard preview window. */
export async function getWorkersSubdomain(token: string, accountId: string): Promise<string | null> {
  const r = await cfFetch<{ subdomain?: string }>(token, `/accounts/${accountId}/workers/subdomain`)
  return r.ok ? r.result?.subdomain ?? null : null
}

/** Verify a Turnstile response token (contact-form relay). */
export async function verifyTurnstileToken(secret: string, responseToken: string, ip?: string): Promise<boolean> {
  try {
    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: responseToken, ...(ip ? { remoteip: ip } : {}) }),
    })
    const body = (await resp.json().catch(() => null)) as { success?: boolean } | null
    return !!body?.success
  } catch {
    return false
  }
}

/** Turn on free WAF managed rules + bot fight mode for the zone (covenant S3).
 *  Best-effort: some settings need higher plans; failures are reported, not fatal. */
export async function enableZoneProtection(
  token: string,
  zoneId: string
): Promise<{ ok: boolean; problem: string | null }> {
  const r = await cfFetch<unknown>(token, `/zones/${zoneId}/settings/security_level`, {
    method: "PATCH",
    body: JSON.stringify({ value: "medium" }),
  })
  const bots = await cfFetch<unknown>(token, `/zones/${zoneId}/bot_management`, {
    method: "PUT",
    body: JSON.stringify({ fight_mode: true }),
  })
  if (!r.ok && !bots.ok) {
    return { ok: false, problem: "Couldn't enable zone protection settings (plan limits?) — you can turn on Bot Fight Mode in the Cloudflare dashboard." }
  }
  return { ok: true, problem: null }
}

/** Enable Cloudflare Web Analytics (RUM, cookie-free, zero-JS) for a zone so
 *  Core Web Vitals from real visitors are collected automatically (P8).
 *  Best-effort — not fatal to provisioning. */
export async function enableWebAnalytics(
  token: string,
  accountId: string,
  zoneTag: string,
  host: string
): Promise<{ ok: boolean; problem: string | null }> {
  const r = await cfFetch<unknown>(token, `/accounts/${accountId}/rum/site_info`, {
    method: "POST",
    body: JSON.stringify({ zone_tag: zoneTag, auto_install: true, host }),
  })
  return r.ok ? { ok: true, problem: null } : { ok: false, problem: r.errorMessage ?? "Couldn't enable Web Analytics." }
}

// ─────────────────────── Edge bot protection (V1.3, WAF) ───────────────────────
// Managed via ONE named custom rule in the zone's http_request_firewall_custom
// ruleset — never clobbering the customer's other rules (read → patch/add the
// single rule identified by WAF_RULE_DESCRIPTION). robots.txt asks politely;
// this rule ENFORCES at the edge.

export const WAF_RULE_DESCRIPTION = "sitenetwork: block AI crawlers (managed)"

/** The permission the WAF calls need, with the exact fix — surfaced verbatim
 *  when Cloudflare answers 403. */
export const WAF_PERMISSION_HELP =
  'Your Cloudflare token is missing the "Zone → Firewall Services → Edit" permission. ' +
  "Open dash.cloudflare.com → My Profile → API Tokens → edit the token you connected, add that permission, save — then try again here (no need to re-paste the token)."

/** Build the WAF expression that blocks a list of bot user-agents. Pure. */
export function aiBotWafExpression(bots: readonly string[]): string {
  return bots.map((b) => `(lower(http.user_agent) contains "${b.toLowerCase()}")`).join(" or ")
}

interface RulesetRule {
  id: string
  description?: string
  expression?: string
  enabled?: boolean
  action?: string
}
interface Ruleset {
  id: string
  rules?: RulesetRule[]
}

export interface EdgeBotState {
  /** null = no entrypoint ruleset / rule yet. */
  aiRule: { id: string; enabled: boolean } | null
  botFightMode: boolean | null
  /** Plain-language problem (e.g. missing permission) — null when readable. */
  problem: string | null
}

function problemFor(status: number, msg: string | null): string {
  if (status === 403) return WAF_PERMISSION_HELP
  return msg ?? `Cloudflare returned ${status}`
}

/** Read the current edge state: our managed AI rule + Bot Fight Mode. */
export async function getEdgeBotState(token: string, zoneId: string): Promise<EdgeBotState> {
  let aiRule: EdgeBotState["aiRule"] = null
  let problem: string | null = null

  const entry = await cfFetch<Ruleset>(token, `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`)
  if (entry.ok && entry.result) {
    const rule = (entry.result.rules ?? []).find((r) => r.description === WAF_RULE_DESCRIPTION)
    if (rule) aiRule = { id: rule.id, enabled: rule.enabled !== false }
  } else if (entry.status !== 404) {
    // 404 just means "no custom rules yet" — anything else is a real problem.
    problem = problemFor(entry.status, entry.errorMessage)
  }

  let botFightMode: boolean | null = null
  const bfm = await cfFetch<{ fight_mode?: boolean }>(token, `/zones/${zoneId}/bot_management`)
  if (bfm.ok && bfm.result) botFightMode = bfm.result.fight_mode === true
  // bot_management read failures are non-fatal (plan-dependent endpoint).

  return { aiRule, botFightMode, problem }
}

/** Create/update/disable the managed AI-crawler block rule. Non-clobbering:
 *  only the rule bearing WAF_RULE_DESCRIPTION is ever touched. */
export async function setAiBotWafRule(
  token: string,
  zoneId: string,
  enabled: boolean,
  expression: string
): Promise<{ ok: boolean; problem: string | null }> {
  const rulePayload = {
    description: WAF_RULE_DESCRIPTION,
    expression,
    action: "block",
    enabled,
  }

  const entry = await cfFetch<Ruleset>(token, `/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`)
  if (!entry.ok && entry.status !== 404) {
    return { ok: false, problem: problemFor(entry.status, entry.errorMessage) }
  }

  if (!entry.ok || !entry.result) {
    // No custom ruleset yet — nothing to disable, or create it with our rule.
    if (!enabled) return { ok: true, problem: null }
    const created = await cfFetch<Ruleset>(token, `/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: JSON.stringify({
        name: "default",
        kind: "zone",
        phase: "http_request_firewall_custom",
        rules: [rulePayload],
      }),
    })
    return created.ok ? { ok: true, problem: null } : { ok: false, problem: problemFor(created.status, created.errorMessage) }
  }

  const rulesetId = entry.result.id
  const existing = (entry.result.rules ?? []).find((r) => r.description === WAF_RULE_DESCRIPTION)
  const r = existing
    ? await cfFetch<Ruleset>(token, `/zones/${zoneId}/rulesets/${rulesetId}/rules/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify(rulePayload),
      })
    : await cfFetch<Ruleset>(token, `/zones/${zoneId}/rulesets/${rulesetId}/rules`, {
        method: "POST",
        body: JSON.stringify(rulePayload),
      })
  return r.ok ? { ok: true, problem: null } : { ok: false, problem: problemFor(r.status, r.errorMessage) }
}

/** Toggle Bot Fight Mode for a zone. */
export async function setBotFightMode(token: string, zoneId: string, on: boolean): Promise<{ ok: boolean; problem: string | null }> {
  const r = await cfFetch<unknown>(token, `/zones/${zoneId}/bot_management`, {
    method: "PUT",
    body: JSON.stringify({ fight_mode: on }),
  })
  return r.ok ? { ok: true, problem: null } : { ok: false, problem: problemFor(r.status, r.errorMessage) }
}
