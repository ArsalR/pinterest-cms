// src/lib/saas/github.ts
// GitHub App client (platform-owned app, decision D). Phase 2 scope:
// App JWT (RS256) → installation lookup/verification for the connections
// wizard. Repo creation, secrets, dispatches arrive in Phase 3 on top of
// installationToken().
//
// The App private key lives ONLY in the GITHUB_APP_PRIVATE_KEY Workers
// secret (PKCS#8 PEM — see GITHUB_APP_SETUP.md for the PKCS#1 conversion).

import type { CloudflareEnv } from "../types"

const GITHUB_API = "https://api.github.com"
const UA = "sitenetwork-os/1.0"

export function githubAppConfigured(env: CloudflareEnv): boolean {
  return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_SLUG)
}

export function githubInstallUrl(env: CloudflareEnv, state: string): string {
  return `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`
}

/** Detect the classic paste mistake before WebCrypto produces a cryptic error. */
export function pemLooksPkcs1(pem: string): boolean {
  return pem.includes("BEGIN RSA PRIVATE KEY")
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  if (pemLooksPkcs1(pem)) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is PKCS#1 (GitHub's download format). Convert it once: " +
        "openssl pkcs8 -topk8 -inform PEM -in app.pem -out app-pkcs8.pem -nocrypt"
    )
  }
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "")
  if (!body) throw new Error("GITHUB_APP_PRIVATE_KEY does not look like a PEM private key")
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64Url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
  let bin = ""
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Build the App JWT claim set (pure — unit-tested). 60s backdate absorbs clock skew. */
export function appJwtClaims(appId: string, nowSecs: number): { iat: number; exp: number; iss: string } {
  return { iat: nowSecs - 60, exp: nowSecs + 9 * 60, iss: appId }
}

/** Sign a short-lived App JWT (RS256) for the GitHub Apps API. */
export async function signAppJwt(env: CloudflareEnv, nowMs: number = Date.now()): Promise<string> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GitHub App is not configured (GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY)")
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(env.GITHUB_APP_PRIVATE_KEY) as BufferSource,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const header = b64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64Url(JSON.stringify(appJwtClaims(env.GITHUB_APP_ID, Math.floor(nowMs / 1000))))
  const data = `${header}.${payload}`
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data))
  )
  return `${data}.${b64Url(sig)}`
}

async function ghApp<T>(env: CloudflareEnv, path: string, init: RequestInit = {}): Promise<T> {
  const jwt = await signAppJwt(env)
  const resp = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(init.headers ?? {}),
    },
  })
  if (!resp.ok) {
    throw new Error(`GitHub App API ${path} failed (${resp.status})`)
  }
  return (await resp.json()) as T
}

export interface InstallationInfo {
  id: number
  accountLogin: string
  accountType: string
  repositorySelection: string
}

/** Verify an installation id belongs to OUR app; returns its account info. */
export async function getInstallation(env: CloudflareEnv, installationId: string): Promise<InstallationInfo | null> {
  if (!/^\d+$/.test(installationId)) return null
  try {
    const data = await ghApp<{
      id: number
      account: { login: string; type: string }
      repository_selection: string
    }>(env, `/app/installations/${installationId}`)
    return {
      id: data.id,
      accountLogin: data.account.login,
      accountType: data.account.type,
      repositorySelection: data.repository_selection,
    }
  } catch {
    return null
  }
}

/** Mint a short-lived installation access token (Phase 3 consumes this heavily). */
export async function installationToken(env: CloudflareEnv, installationId: number): Promise<string> {
  const data = await ghApp<{ token: string }>(env, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
  })
  return data.token
}

// ─────────────── Phase 3: repo provisioning (installation-token calls) ───────────────

import { sealToPublicKey } from "./sealedBox"

async function ghInst<T>(
  token: string,
  path: string,
  init: RequestInit = {},
  okStatuses: number[] = []
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(init.headers ?? {}),
    },
  })
  if (!resp.ok && !okStatuses.includes(resp.status)) {
    throw new Error(`GitHub API ${path} failed (${resp.status})`)
  }
  const body = (await resp.json().catch(() => null)) as T | null
  return { status: resp.status, body }
}

/** True if the repo already exists (idempotent-provisioning probe). */
export async function repoExists(token: string, fullName: string): Promise<boolean> {
  const r = await ghInst(token, `/repos/${fullName}`, {}, [404])
  return r.status !== 404
}

/** Create a repo in the customer's account from the platform template. */
export async function createRepoFromTemplate(
  token: string,
  templateFullName: string,
  owner: string,
  name: string,
  description: string
): Promise<void> {
  await ghInst(token, `/repos/${templateFullName}/generate`, {
    method: "POST",
    body: JSON.stringify({ owner, name, description, private: false, include_all_branches: false }),
  })
}

/** Set a repo Actions secret (sealed to the repo's public key, as GitHub requires). */
export async function setRepoSecret(
  token: string,
  fullName: string,
  secretName: string,
  value: string
): Promise<void> {
  const keyResp = await ghInst<{ key: string; key_id: string }>(
    token,
    `/repos/${fullName}/actions/secrets/public-key`
  )
  if (!keyResp.body) throw new Error(`GitHub API: no public key for ${fullName}`)
  await ghInst(token, `/repos/${fullName}/actions/secrets/${secretName}`, {
    method: "PUT",
    body: JSON.stringify({
      encrypted_value: sealToPublicKey(keyResp.body.key, value),
      key_id: keyResp.body.key_id,
    }),
  })
}

/** Create or update a single file via the contents API (idempotent by SHA). */
export async function putRepoFile(
  token: string,
  fullName: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  const existing = await ghInst<{ sha?: string }>(token, `/repos/${fullName}/contents/${path}`, {}, [404])
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)))
  await ghInst(token, `/repos/${fullName}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: b64,
      ...(existing.status !== 404 && existing.body?.sha ? { sha: existing.body.sha } : {}),
    }),
  })
}

/** Fire a workflow_dispatch (deploys) or repository_dispatch (content rebuilds). */
export async function dispatchWorkflow(
  token: string,
  fullName: string,
  workflowFile: string,
  ref = "main",
  inputs: Record<string, string> = {}
): Promise<void> {
  await ghInst(token, `/repos/${fullName}/actions/workflows/${workflowFile}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref, inputs }),
  })
}

export async function repositoryDispatch(
  token: string,
  fullName: string,
  eventType: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  await ghInst(token, `/repos/${fullName}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  })
}
