// src/modules/sites/guardrails.test.ts
// The three merge-review proofs (Phase 4):
//   (a) the claude.yml post-run guard actually rejects protected-path edits
//       (tested against the REAL workflow file, not a copy of the regex),
//   (b) rollback after a bad deploy restores the pre-break tree — verified
//       against a stubbed GitHub API, including the failure path,
//   (c) the hourly dispatch cap denies the 7th run with quota_exceeded.

import { describe, it, expect, afterEach, vi } from "vitest"
import { readFileSync } from "node:fs"
import type { Client } from "@libsql/client/web"
import { rollbackToCommit } from "../connections"
import { allowRate } from "../../shared/rateLimit"
import { dispatchPrompt, PROMPT_DISPATCH_LIMIT } from "./prompts"
import type { CustomerSiteRow } from "../provisioning"

// ───────────── (a) protected-path guard, from the real claude.yml ─────────────

const CLAUDE_YML = readFileSync(
  new URL("../../../site-template/.github/workflows/claude.yml", import.meta.url),
  "utf8"
)

function extractGuardRegex(): RegExp {
  const m = /grep -E '([^']+)'/.exec(CLAUDE_YML)
  if (!m) throw new Error("protected-path guard grep not found in claude.yml")
  return new RegExp(m[1])
}

describe("(a) claude.yml protected-path guard", () => {
  const guard = extractGuardRegex()

  it("rejects every protected path", () => {
    for (const path of [
      ".github/workflows/deploy.yml",
      ".github/workflows/claude.yml",
      "site.config.json",
      "wrangler.toml",
      "scripts/check-zero-js.mjs",
    ]) {
      expect(guard.test(path), path).toBe(true)
    }
  })

  it("allows normal site files", () => {
    for (const path of [
      "src/pages/index.astro",
      "src/layouts/Base.astro",
      "public/favicon.svg",
      "package.json",
    ]) {
      expect(guard.test(path), path).toBe(false)
    }
  })

  it("the guard step fails the job (exit 1) when triggered, and runs BEFORE any push", () => {
    const guardIdx = CLAUDE_YML.indexOf("Guard — protected paths untouched")
    const pushIdx = CLAUDE_YML.indexOf("git push")
    expect(guardIdx).toBeGreaterThan(-1)
    expect(pushIdx).toBeGreaterThan(guardIdx)
    // The step's body must exit non-zero on a match.
    const stepBody = CLAUDE_YML.slice(guardIdx, CLAUDE_YML.indexOf("- name:", guardIdx + 1))
    expect(stepBody).toContain("exit 1")
  })

  it("cost + hygiene rails are present in the workflow file", () => {
    expect(CLAUDE_YML).toContain("timeout-minutes: 15")
    expect(CLAUDE_YML).toContain("cancel-in-progress: false") // queued, not parallel
    expect(CLAUDE_YML).toContain("group: site-claude")
    expect(CLAUDE_YML).toContain("no secrets in the diff")
    expect(CLAUDE_YML).toContain("sk-ant-")
  })
})

// ───────────── (b) rollback restores the pre-break tree ─────────────

type FetchCall = { url: string; method: string; body: unknown }

function stubGitHub(responses: Record<string, { status?: number; json: unknown }>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
    const key = Object.keys(responses).find((k) => url.includes(k.split(" ")[1] ?? k) && (k.split(" ")[0] === method || !k.includes(" ")))
    const resp = key ? responses[key] : { status: 404, json: {} }
    return new Response(JSON.stringify(resp.json), {
      status: resp.status ?? 200,
      headers: { "Content-Type": "application/json" },
    })
  })
  return calls
}

afterEach(() => vi.unstubAllGlobals())

describe("(b) rollbackToCommit after a bad deploy", () => {
  it("creates a NEW commit carrying the GOOD tree on top of the BAD head, no force", async () => {
    const calls = stubGitHub({
      "GET /repos/o/r/commits/GOODSHA": { json: { commit: { tree: { sha: "TREE_GOOD" } } } },
      "GET /repos/o/r/git/ref/heads/main": { json: { object: { sha: "HEAD_BAD" } } },
      "POST /repos/o/r/git/commits": { json: { sha: "ROLLBACK_SHA" } },
      "PATCH /repos/o/r/git/refs/heads/main": { json: { object: { sha: "ROLLBACK_SHA" } } },
    })

    const newSha = await rollbackToCommit("tok", "o/r", "GOODSHA")
    expect(newSha).toBe("ROLLBACK_SHA")

    const createCommit = calls.find((c) => c.method === "POST" && c.url.includes("/git/commits"))
    expect(createCommit?.body).toMatchObject({
      tree: "TREE_GOOD",           // ← the pre-break state
      parents: ["HEAD_BAD"],       // ← on top of the broken head (history preserved)
    })

    const updateRef = calls.find((c) => c.method === "PATCH" && c.url.includes("/git/refs/heads/main"))
    expect(updateRef?.body).toMatchObject({ sha: "ROLLBACK_SHA", force: false }) // ← never force-push
  })

  it("fails closed with a plain error when the target commit doesn't exist", async () => {
    stubGitHub({
      "GET /repos/o/r/git/ref/heads/main": { json: { object: { sha: "HEAD" } } },
      // target commit intentionally missing → 404
    })
    await expect(rollbackToCommit("tok", "o/r", "NOPE")).rejects.toThrow(/failed \(404\)/)
  })
})

// ───────────── (c) hourly cap → quota_exceeded on the 7th dispatch ─────────────

/** In-memory stand-in for the saas_rate_limits fixed-window table. */
function fakeRateDb(): Client {
  const counters = new Map<string, number>()
  return {
    execute: async (q: { sql: string; args: unknown[] } | string) => {
      const sql = typeof q === "string" ? q : q.sql
      const args = typeof q === "string" ? [] : q.args
      if (sql.includes("INSERT INTO saas_rate_limits")) {
        const key = `${args[0]}|${args[1]}`
        const count = (counters.get(key) ?? 0) + 1
        counters.set(key, count)
        return { rows: [{ count }], rowsAffected: 1 }
      }
      return { rows: [], rowsAffected: 0 } // GC delete etc.
    },
  } as unknown as Client
}

describe("(c) hourly dispatch cap", () => {
  it(`allowRate permits ${PROMPT_DISPATCH_LIMIT.max} runs then denies the next in the same window`, async () => {
    const db = fakeRateDb()
    const now = Date.parse("2026-07-13T12:00:00Z")
    for (let i = 1; i <= PROMPT_DISPATCH_LIMIT.max; i++) {
      expect(await allowRate(db, "prompt:site:s1", PROMPT_DISPATCH_LIMIT, now + i), `run ${i}`).toBe(true)
    }
    expect(await allowRate(db, "prompt:site:s1", PROMPT_DISPATCH_LIMIT, now + 999)).toBe(false) // the 7th
  })

  it("dispatchPrompt surfaces the denial as quota_exceeded with a plain-language message", async () => {
    // A db whose limiter row is already over the cap.
    const db = {
      execute: async (q: { sql: string }) =>
        q.sql.includes("INSERT INTO saas_rate_limits")
          ? { rows: [{ count: PROMPT_DISPATCH_LIMIT.max + 1 }], rowsAffected: 1 }
          : { rows: [], rowsAffected: 0 },
    } as unknown as Client
    const site = {
      id: "s1", customer_id: "c1", status: "active", repo_full_name: "o/r",
      domain: "x.com", canonical_host: "apex", name: "X", niche: null,
      cms_site_id: null, cms_hostname: null, worker_name: "site-x", zone_id: null,
    } as CustomerSiteRow

    const result = await dispatchPrompt(db, {} as never, site, "do things", "preview")
    expect(result.ok).toBe(false)
    expect(result.code).toBe("quota_exceeded")
    expect(result.problem).toMatch(/hourly limit/i)
  })
})
