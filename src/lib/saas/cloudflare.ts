// src/lib/saas/cloudflare.ts
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
