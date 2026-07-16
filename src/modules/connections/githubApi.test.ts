// src/modules/connections/githubApi.test.ts
// Phase 10 audit — the GitHub REST client (installation-token calls) exercised
// against a MOCKED GitHub API: every provisioning/prompt network op plus its
// failure path. No real network; global fetch is stubbed per-test.

import { describe, it, expect, afterEach, vi } from "vitest"
import {
  repoExists, createRepoFromTemplate, setRepoSecret, putRepoFile,
  dispatchWorkflow, repositoryDispatch, rollbackToCommit, listCommits,
} from "./github"

interface Call { url: string; method: string; body: unknown }
let calls: Call[] = []

/** Route mocked responses by (method, url-substring). */
function mockGitHub(routes: Array<{ m?: string; u: string; status?: number; json?: unknown }>) {
  calls = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? "GET").toUpperCase()
      calls.push({ url, method, body: init.body ? JSON.parse(String(init.body)) : null })
      const hit = routes.find((r) => url.includes(r.u) && (!r.m || r.m === method))
      const status = hit?.status ?? 200
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => hit?.json ?? {},
      } as unknown as Response
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

const TOKEN = "ghs_installationtoken"
// A valid 32-byte base64 key so sealToPublicKey (libsodium sealed box) works.
const PUBKEY_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64")

describe("repoExists (idempotent provisioning probe)", () => {
  it("true when the repo resolves, false on 404", async () => {
    mockGitHub([{ u: "/repos/acme/site-a", status: 200 }])
    expect(await repoExists(TOKEN, "acme/site-a")).toBe(true)
    mockGitHub([{ u: "/repos/acme/missing", status: 404 }])
    expect(await repoExists(TOKEN, "acme/missing")).toBe(false)
  })
})

describe("createRepoFromTemplate", () => {
  it("POSTs to the template generate endpoint with owner+name", async () => {
    mockGitHub([{ m: "POST", u: "/generate", status: 201 }])
    await createRepoFromTemplate(TOKEN, "ArsalR/site-template", "acme", "site-a", "desc")
    const call = calls.find((c) => c.url.includes("/generate"))!
    expect(call.method).toBe("POST")
    expect(call.url).toContain("/repos/ArsalR/site-template/generate")
    expect(call.body).toMatchObject({ owner: "acme", name: "site-a", private: false })
  })
  it("throws on a GitHub error status", async () => {
    mockGitHub([{ m: "POST", u: "/generate", status: 422 }])
    await expect(createRepoFromTemplate(TOKEN, "t/t", "acme", "x", "d")).rejects.toThrow(/failed \(422\)/)
  })
})

describe("setRepoSecret (sealed to the repo public key)", () => {
  it("fetches the public key then PUTs a sealed value (never plaintext)", async () => {
    mockGitHub([
      { m: "GET", u: "/actions/secrets/public-key", json: { key: PUBKEY_B64, key_id: "kid-1" } },
      { m: "PUT", u: "/actions/secrets/CMS_KEY", status: 201 },
    ])
    await setRepoSecret(TOKEN, "acme/site-a", "CMS_KEY", "cms_live_supersecret")
    const put = calls.find((c) => c.method === "PUT")!
    const body = put.body as { encrypted_value: string; key_id: string }
    expect(body.key_id).toBe("kid-1")
    expect(typeof body.encrypted_value).toBe("string")
    // The raw secret must never appear in the request body.
    expect(JSON.stringify(put.body)).not.toContain("cms_live_supersecret")
  })
})

describe("putRepoFile (create vs update by sha)", () => {
  it("creates without a sha when the file is absent (404)", async () => {
    mockGitHub([
      { m: "GET", u: "/contents/site.config.json", status: 404 },
      { m: "PUT", u: "/contents/site.config.json", status: 201 },
    ])
    await putRepoFile(TOKEN, "acme/site-a", "site.config.json", "{}", "chore: config")
    const put = calls.find((c) => c.method === "PUT")!
    expect(put.body).not.toHaveProperty("sha")
  })
  it("updates with the existing sha when the file is present", async () => {
    mockGitHub([
      { m: "GET", u: "/contents/wrangler.toml", status: 200, json: { sha: "abc123" } },
      { m: "PUT", u: "/contents/wrangler.toml", status: 200 },
    ])
    await putRepoFile(TOKEN, "acme/site-a", "wrangler.toml", "x", "chore")
    const put = calls.find((c) => c.method === "PUT")!
    expect((put.body as { sha?: string }).sha).toBe("abc123")
  })
})

describe("dispatches", () => {
  it("dispatchWorkflow posts ref + inputs to the workflow file", async () => {
    mockGitHub([{ m: "POST", u: "/workflows/deploy.yml/dispatches", status: 204 }])
    await dispatchWorkflow(TOKEN, "acme/site-a", "deploy.yml", "main", { reason: "x" })
    const call = calls[0]
    expect(call.url).toContain("/workflows/deploy.yml/dispatches")
    expect(call.body).toEqual({ ref: "main", inputs: { reason: "x" } })
  })
  it("repositoryDispatch posts the event type + client payload", async () => {
    mockGitHub([{ m: "POST", u: "/dispatches", status: 204 }])
    await repositoryDispatch(TOKEN, "acme/site-a", "content-updated", { reason: "gated-publish" })
    expect(calls[0].body).toEqual({ event_type: "content-updated", client_payload: { reason: "gated-publish" } })
  })
})

describe("rollbackToCommit (forward revert — never a force-push)", () => {
  it("reads target tree + head, creates a commit, and fast-forwards the ref", async () => {
    mockGitHub([
      { m: "GET", u: "/commits/deadbeef", json: { commit: { tree: { sha: "tree-1" } } } },
      { m: "GET", u: "/git/ref/heads/main", json: { object: { sha: "head-1" } } },
      { m: "POST", u: "/git/commits", json: { sha: "new-commit" } },
      { m: "PATCH", u: "/git/refs/heads/main", status: 200 },
    ])
    const sha = await rollbackToCommit(TOKEN, "acme/site-a", "deadbeef", "main")
    expect(sha).toBe("new-commit")
    const patch = calls.find((c) => c.method === "PATCH")!
    expect((patch.body as { force: boolean }).force).toBe(false) // history preserved
    expect((patch.body as { sha: string }).sha).toBe("new-commit")
  })
  it("refuses to roll back (throws) when GitHub can't return the target commit", async () => {
    mockGitHub([
      { m: "GET", u: "/commits/deadbeef", status: 404 }, // target unreadable
      { m: "GET", u: "/git/ref/heads/main", json: { object: { sha: "head-1" } } },
    ])
    // Must never fall through to a force-push on a bad read — it throws instead.
    await expect(rollbackToCommit(TOKEN, "acme/site-a", "deadbeef")).rejects.toThrow()
    expect(calls.some((c) => c.method === "PATCH")).toBe(false)
  })
})

describe("listCommits", () => {
  it("maps commits to first-line messages", async () => {
    mockGitHub([{ u: "/commits?per_page=15", json: [{ sha: "s1", commit: { message: "feat: x\n\nbody", committer: { date: "2026-01-01" } } }] }])
    const out = await listCommits(TOKEN, "acme/site-a")
    expect(out[0]).toMatchObject({ sha: "s1", message: "feat: x", date: "2026-01-01" })
  })
})
