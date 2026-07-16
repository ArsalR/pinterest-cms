// src/modules/sites/security.test.ts
// Phase 10 audit — the prompt key-scrub guard: a pasted API key must never make
// it into a job payload or an Actions run input. dispatchPrompt refuses before
// any DB write or network call.

import { describe, it, expect, afterEach, vi } from "vitest"
import type { Client } from "@libsql/client/web"
import { dispatchPrompt } from "./prompts"
import type { CustomerSiteRow } from "../provisioning"

const noopDb = { execute: vi.fn(async () => ({ rows: [], rowsAffected: 0 })) } as unknown as Client
const env = { SAAS_APP_HOSTNAME: "arsal.app" } as never
const activeSite = { id: "s1", customer_id: "c1", status: "active", repo_full_name: "acme/site-a", domain: "a.com" } as unknown as CustomerSiteRow

afterEach(() => vi.clearAllMocks())

describe("dispatchPrompt key-scrub (Security Covenant)", () => {
  it("refuses a prompt containing an Anthropic key — no DB write, no dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("must not dispatch a key-bearing prompt") }))
    const r = await dispatchPrompt(noopDb, env, activeSite, "Please use sk-ant-abcd1234efgh to build this", "direct")
    expect(r.ok).toBe(false)
    expect(r.problem).toMatch(/API key/i)
    expect((noopDb.execute as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("refuses a prompt containing a CMS live key", async () => {
    const r = await dispatchPrompt(noopDb, env, activeSite, "here is cms_live_deadbeef12345678 to publish", "direct")
    expect(r.ok).toBe(false)
    expect(r.problem).toMatch(/API key/i)
  })

  it("refuses to dispatch before the site is fully provisioned", async () => {
    const notReady = { ...activeSite, status: "provisioning", repo_full_name: null } as unknown as CustomerSiteRow
    const r = await dispatchPrompt(noopDb, env, notReady, "make the header blue", "direct")
    expect(r.ok).toBe(false)
    expect(r.code).toBe("not_ready")
  })
})
