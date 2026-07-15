// src/modules/pinterest/pins.ts
// Pinterest traffic engine (K7) — OAuth + Pins/Boards API + pure payload and
// drip-schedule helpers. Same two-layer discipline as the GSC client:
//   • pure helpers (scopes, auth-URL, pin payload, drip scheduling) unit-tested;
//   • best-effort I/O (token exchange/refresh, createPin, listBoards) → null on
//     failure, never throws into a request or the cron.
//
// The refresh_token is the vault-encrypted `pinterest` connection secret. The
// whole feature self-gates on PINTEREST_APP_ID / PINTEREST_APP_SECRET, so it is
// inert until Pinterest grants the platform app standard access.

import type { CloudflareEnv } from "../../lib/types"

const OAUTH_AUTH = "https://www.pinterest.com/oauth/"
const OAUTH_TOKEN = "https://api.pinterest.com/v5/oauth/token"
const API = "https://api.pinterest.com/v5"

// Scopes match the standard-access request in OAUTH_SETUP.md.
export const PINTEREST_SCOPES = ["boards:read", "boards:write", "pins:read", "pins:write", "user_accounts:read"] as const

export function pinterestConfigured(env: CloudflareEnv): boolean {
  return !!(env.PINTEREST_APP_ID && env.PINTEREST_APP_SECRET)
}

export function pinterestRedirectUri(env: CloudflareEnv): string {
  const host = env.SAAS_APP_HOSTNAME || "arsal.app"
  return `https://${host}/app/connections/pinterest/callback`
}

/** Build the consent URL. Pure — unit-tested. */
export function pinterestAuthUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: PINTEREST_SCOPES.join(","),
    state,
  })
  return `${OAUTH_AUTH}?${params.toString()}`
}

/** HTTP Basic header value for the token endpoint (app id:secret). */
function basicAuth(env: CloudflareEnv): string {
  return "Basic " + btoa(`${env.PINTEREST_APP_ID}:${env.PINTEREST_APP_SECRET}`)
}

export interface PinterestTokens {
  accessToken: string
  refreshToken: string | null
  expiresIn: number
}

/** Exchange an auth code for tokens. Best-effort → null. */
export async function exchangePinterestCode(env: CloudflareEnv, code: string): Promise<PinterestTokens | null> {
  if (!pinterestConfigured(env)) return null
  try {
    const resp = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: pinterestRedirectUri(env),
      }),
    })
    if (!resp.ok) return null
    const b = (await resp.json().catch(() => null)) as
      | { access_token?: string; refresh_token?: string; expires_in?: number }
      | null
    if (!b?.access_token) return null
    return { accessToken: b.access_token, refreshToken: b.refresh_token ?? null, expiresIn: b.expires_in ?? 3600 }
  } catch {
    return null
  }
}

/** Mint a fresh access token from a stored refresh token. Best-effort → null. */
export async function refreshPinterestToken(env: CloudflareEnv, refreshToken: string): Promise<string | null> {
  if (!pinterestConfigured(env)) return null
  try {
    const resp = await fetch(OAUTH_TOKEN, {
      method: "POST",
      headers: { Authorization: basicAuth(env), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    })
    if (!resp.ok) return null
    const b = (await resp.json().catch(() => null)) as { access_token?: string } | null
    return b?.access_token ?? null
  } catch {
    return null
  }
}

export interface PinterestBoard {
  id: string
  name: string
}

/** List the connected account's boards. Best-effort → null. */
export async function listBoards(accessToken: string): Promise<PinterestBoard[] | null> {
  try {
    const resp = await fetch(`${API}/boards?page_size=100`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!resp.ok) return null
    const b = (await resp.json().catch(() => null)) as { items?: Array<{ id: string; name: string }> } | null
    return (b?.items ?? []).map((x) => ({ id: x.id, name: x.name }))
  } catch {
    return null
  }
}

export interface PinInput {
  boardId: string
  title: string
  description: string
  link: string      // destination URL (the post)
  imageUrl: string  // cover image (Pinterest requires a source image)
}

/**
 * Build the v5 create-pin request body. Title is capped at Pinterest's 100-char
 * limit, description at 500. Pure — unit-tested.
 */
export function pinPayload(input: PinInput): Record<string, unknown> {
  return {
    board_id: input.boardId,
    title: input.title.slice(0, 100),
    description: input.description.slice(0, 500),
    link: input.link,
    media_source: { source_type: "image_url", url: input.imageUrl },
  }
}

/** Create a pin. Returns the new pin id, or null on any failure. */
export async function createPin(accessToken: string, input: PinInput): Promise<string | null> {
  try {
    const resp = await fetch(`${API}/pins`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(pinPayload(input)),
    })
    if (!resp.ok) return null
    const b = (await resp.json().catch(() => null)) as { id?: string } | null
    return b?.id ?? null
  } catch {
    return null
  }
}
