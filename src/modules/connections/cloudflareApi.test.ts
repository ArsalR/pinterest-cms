// src/modules/connections/cloudflareApi.test.ts
// Phase 10 audit — the Cloudflare client against a MOCKED CF API: token
// verification (valid / invalid / inactive / missing-scope), zone listing,
// custom-domain attach, workers.dev disable, Turnstile create + verify, zone
// protection, and Web Analytics. All failure paths are best-effort (never throw
// into provisioning). global fetch is stubbed per-test.

import { describe, it, expect, afterEach, vi } from "vitest"
import {
  verifyCfToken, listCfZones, attachWorkersDomain, disableWorkersDevSubdomain,
  createTurnstileWidget, verifyTurnstileToken, enableZoneProtection, enableWebAnalytics,
} from "./cloudflare"

let calls: Array<{ url: string; method: string; body: unknown }> = []

/** CF envelope: { success, result, errors }. Route by url substring + method. */
function mockCf(routes: Array<{ m?: string; u: string; status?: number; success?: boolean; result?: unknown; errors?: Array<{ message: string }> }>) {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase()
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null })
      const hit = routes.find((r) => url.includes(r.u) && (!r.m || r.m === method))
      const status = hit?.status ?? 200
      const success = hit?.success ?? (status >= 200 && status < 300)
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ success, result: hit?.result ?? null, errors: hit?.errors ?? [] }),
      } as unknown as Response
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

const TOKEN = "cf_token_abcdefghijklmnopqrstuvwxyz012345"

describe("verifyCfToken", () => {
  it("rejects an obviously malformed token before any network call", async () => {
    const r = await verifyCfToken("short")
    expect(r.valid).toBe(false)
    expect(calls.length).toBe(0)
  })
  it("accepts an active token that can read account + zones", async () => {
    mockCf([
      { u: "/user/tokens/verify", result: { status: "active" } },
      { u: "/accounts?per_page=5", result: [{ id: "acc-1", name: "Acme" }] },
      { u: "/zones?per_page=50", result: [{ id: "z1" }, { id: "z2" }] },
    ])
    const r = await verifyCfToken(TOKEN)
    expect(r).toMatchObject({ valid: true, accountId: "acc-1", accountName: "Acme", zoneCount: 2 })
  })
  it("flags an inactive token", async () => {
    mockCf([{ u: "/user/tokens/verify", result: { status: "disabled" } }])
    const r = await verifyCfToken(TOKEN)
    expect(r.valid).toBe(false)
    expect(r.problem).toMatch(/disabled/)
  })
  it("flags a token that can't read the account", async () => {
    mockCf([
      { u: "/user/tokens/verify", result: { status: "active" } },
      { u: "/accounts?per_page=5", success: false, status: 403 },
    ])
    const r = await verifyCfToken(TOKEN)
    expect(r.valid).toBe(false)
    expect(r.problem).toMatch(/Account Settings: Read/)
  })
})

describe("listCfZones", () => {
  it("maps zones incl. nameservers + paused; null on failure", async () => {
    mockCf([{ u: "/zones", result: [{ id: "z1", name: "a.com", status: "active", name_servers: ["ns1", "ns2"], paused: false }] }])
    const zones = await listCfZones(TOKEN)
    expect(zones).toEqual([{ id: "z1", name: "a.com", status: "active", nameServers: ["ns1", "ns2"], paused: false }])
    mockCf([{ u: "/zones", success: false, status: 500 }])
    expect(await listCfZones(TOKEN)).toBeNull()
  })
})

describe("custom domain + workers.dev", () => {
  it("attachWorkersDomain PUTs the binding; reports problem on failure", async () => {
    mockCf([{ m: "PUT", u: "/workers/domains", result: {} }])
    expect(await attachWorkersDomain(TOKEN, "acc-1", "z1", "a.com", "site-a")).toEqual({ ok: true, problem: null })
    expect(calls[0].body).toMatchObject({ zone_id: "z1", hostname: "a.com", service: "site-a" })
    mockCf([{ m: "PUT", u: "/workers/domains", success: false, status: 400, errors: [{ message: "nope" }] }])
    expect((await attachWorkersDomain(TOKEN, "acc-1", "z1", "a.com", "site-a")).ok).toBe(false)
  })
  it("disableWorkersDevSubdomain disables the SEO-duplicate URL", async () => {
    mockCf([{ m: "POST", u: "/subdomain", result: {} }])
    expect((await disableWorkersDevSubdomain(TOKEN, "acc-1", "site-a")).ok).toBe(true)
    expect(calls[0].body).toEqual({ enabled: false })
  })
})

describe("Turnstile", () => {
  it("createTurnstileWidget returns sitekey+secret, or a problem (never throws)", async () => {
    mockCf([{ m: "POST", u: "/challenges/widgets", result: { sitekey: "sk", secret: "se" } }])
    expect(await createTurnstileWidget(TOKEN, "acc-1", "site", ["a.com"])).toEqual({ sitekey: "sk", secret: "se" })
    mockCf([{ m: "POST", u: "/challenges/widgets", success: false, status: 403, errors: [{ message: "plan" }] }])
    const bad = await createTurnstileWidget(TOKEN, "acc-1", "site", ["a.com"])
    expect(bad.sitekey).toBeNull()
  })
  it("verifyTurnstileToken posts to siteverify and returns success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ success: true }) }) as unknown as Response))
    expect(await verifyTurnstileToken("secret", "resp")).toBe(true)
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ success: false }) }) as unknown as Response))
    expect(await verifyTurnstileToken("secret", "resp")).toBe(false)
  })
})

describe("best-effort security + analytics (never fatal)", () => {
  it("enableZoneProtection ok when either setting applies", async () => {
    mockCf([
      { m: "PATCH", u: "/settings/security_level", result: {} },
      { m: "PUT", u: "/bot_management", success: false, status: 403 },
    ])
    expect((await enableZoneProtection(TOKEN, "z1")).ok).toBe(true) // one succeeded
    mockCf([
      { m: "PATCH", u: "/settings/security_level", success: false, status: 403 },
      { m: "PUT", u: "/bot_management", success: false, status: 403 },
    ])
    expect((await enableZoneProtection(TOKEN, "z1")).ok).toBe(false)
  })
  it("enableWebAnalytics posts auto_install for the host", async () => {
    mockCf([{ m: "POST", u: "/rum/site_info", result: {} }])
    expect((await enableWebAnalytics(TOKEN, "acc-1", "z1", "a.com")).ok).toBe(true)
    expect(calls[0].body).toMatchObject({ zone_tag: "z1", auto_install: true, host: "a.com" })
  })
})
