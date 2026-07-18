// src/modules/seo/scripts.ts
// Script controls (V1.3, decision #2 resolved): a VETTED, defer-only catalog —
// never arbitrary script injection. Each entry names the integration, declares
// its real wire cost (shown before enabling), its exact script host(s) (which
// feed the CSP and the zero-JS gate allowlist at build), and how it loads
// (defer, or delayed until first interaction). The covenant budget gate stays
// deploy-blocking: a selection that busts the script budget refuses to save
// here AND fails the template build with a plain-language report.
//
// Pure. No I/O. Unit-tested. The template's build scripts mirror the same
// catalog data via /v1/seo-settings (ids + config travel; the catalog itself
// is duplicated in the template so the build never trusts wire input).

export type ScriptStrategy = "defer" | "interaction"

export interface ScriptEntry {
  id: string
  name: string
  category: "analytics" | "chat" | "consent"
  /** Honest transferred-bytes estimate (gzipped), shown before enabling. */
  costKb: number
  strategy: ScriptStrategy
  /** Hosts the CSP must allow for script-src (and connect-src for beacons). */
  scriptHosts: string[]
  connectHosts: string[]
  /** The single config field this integration needs. */
  configLabel: string
  configPlaceholder: string
  /** Validate the config value (id/domain formats — never a URL or markup). */
  configPattern: RegExp
}

export const SCRIPT_CATALOG: readonly ScriptEntry[] = [
  {
    id: "plausible",
    name: "Plausible Analytics",
    category: "analytics",
    costKb: 1,
    strategy: "defer",
    scriptHosts: ["https://plausible.io"],
    connectHosts: ["https://plausible.io"],
    configLabel: "Site domain (as registered in Plausible)",
    configPlaceholder: "example.com",
    configPattern: /^[a-z0-9.-]+\.[a-z]{2,}$/i,
  },
  {
    id: "fathom",
    name: "Fathom Analytics",
    category: "analytics",
    costKb: 2,
    strategy: "defer",
    scriptHosts: ["https://cdn.usefathom.com"],
    connectHosts: ["https://cdn.usefathom.com"],
    configLabel: "Fathom site ID",
    configPlaceholder: "ABCDEFGH",
    configPattern: /^[A-Z0-9]{8}$/i,
  },
  {
    id: "ga4",
    name: "Google Analytics 4",
    category: "analytics",
    costKb: 55,
    strategy: "defer",
    scriptHosts: ["https://www.googletagmanager.com"],
    connectHosts: ["https://www.google-analytics.com", "https://analytics.google.com"],
    configLabel: "Measurement ID",
    configPlaceholder: "G-XXXXXXXXXX",
    configPattern: /^G-[A-Z0-9]{6,12}$/i,
  },
  {
    id: "crisp",
    name: "Crisp chat widget",
    category: "chat",
    costKb: 35,
    strategy: "interaction",
    scriptHosts: ["https://client.crisp.chat"],
    connectHosts: ["https://client.crisp.chat", "wss://client.relay.crisp.chat"],
    configLabel: "Crisp website ID",
    configPlaceholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    configPattern: /^[a-f0-9-]{36}$/i,
  },
  {
    id: "cookieyes",
    name: "CookieYes consent banner",
    category: "consent",
    costKb: 40,
    strategy: "defer",
    scriptHosts: ["https://cdn-cookieyes.com"],
    connectHosts: ["https://cdn-cookieyes.com", "https://log.cookieyes.com"],
    configLabel: "CookieYes site ID",
    configPlaceholder: "a1b2c3d4e5f6...",
    configPattern: /^[a-z0-9]{10,40}$/i,
  },
] as const

/** Total third-party script weight allowed before the deploy is blocked.
 *  Matches the performance covenant's "worst page still passes Lighthouse"
 *  posture — mirrored in the template's build gate. */
export const SCRIPT_BUDGET_KB = 100

export interface EnabledScript {
  id: string
  config: string
}

export function catalogEntry(id: string): ScriptEntry | null {
  return SCRIPT_CATALOG.find((s) => s.id === id) ?? null
}

/** Parse the stored scripts JSON; junk/unknown ids/bad config → dropped. Pure. */
export function parseEnabledScripts(raw: unknown): EnabledScript[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    if (!Array.isArray(a)) return []
    const out: EnabledScript[] = []
    for (const v of a as Array<{ id?: unknown; config?: unknown }>) {
      const id = String(v?.id ?? "")
      const config = String(v?.config ?? "").trim()
      const entry = catalogEntry(id)
      if (!entry || !entry.configPattern.test(config)) continue
      if (!out.some((e) => e.id === id)) out.push({ id, config })
    }
    return out
  } catch {
    return []
  }
}

/** Sum of enabled catalog weights, in KB. Pure. */
export function totalScriptWeightKb(enabled: EnabledScript[]): number {
  return enabled.reduce((sum, e) => sum + (catalogEntry(e.id)?.costKb ?? 0), 0)
}

export interface ScriptBudgetCheck {
  ok: boolean
  totalKb: number
  budgetKb: number
  /** Plain-language report for the blocking state. */
  report: string
}

/** The deploy-blocking budget check (covenant gate, plain-language). Pure. */
export function checkScriptBudget(enabled: EnabledScript[]): ScriptBudgetCheck {
  const totalKb = totalScriptWeightKb(enabled)
  const ok = totalKb <= SCRIPT_BUDGET_KB
  const names = enabled.map((e) => `${catalogEntry(e.id)?.name ?? e.id} (~${catalogEntry(e.id)?.costKb ?? 0}KB)`).join(", ")
  return {
    ok,
    totalKb,
    budgetKb: SCRIPT_BUDGET_KB,
    report: ok
      ? `Scripts weigh ~${totalKb}KB of the ${SCRIPT_BUDGET_KB}KB budget.`
      : `BLOCKED: enabled scripts weigh ~${totalKb}KB — over the ${SCRIPT_BUDGET_KB}KB budget that keeps pages fast. Enabled: ${names}. Turn one off (or pick a lighter alternative, e.g. Plausible ~1KB instead of GA4 ~55KB) and save again.`,
  }
}

/** CSP additions for the enabled set: hosts to append to script-src /
 *  connect-src. Empty set → empty additions → the _headers file is untouched
 *  (byte-identical). Pure — mirrored by the template's post-build script. */
export function cspAdditions(enabled: EnabledScript[]): { scriptSrc: string[]; connectSrc: string[] } {
  const scriptSrc: string[] = []
  const connectSrc: string[] = []
  for (const e of enabled) {
    const entry = catalogEntry(e.id)
    if (!entry) continue
    for (const h of entry.scriptHosts) if (!scriptSrc.includes(h)) scriptSrc.push(h)
    for (const h of entry.connectHosts) if (!connectSrc.includes(h)) connectSrc.push(h)
  }
  return { scriptSrc, connectSrc }
}
