// src/lib/audit.test.ts
// Phase 10 audit — cross-cutting static guards that don't need a runtime:
//   • secrets are never interpolated into a log line;
//   • the public-API discovery lists stay in sync (frozen-contract drift guard);
//   • the template's performance covenant budgets remain strict;
//   • the LHCI run stays a representative page set, not every page;
//   • wrangler.toml carries no [limits] block (free-plan CPU gotcha #4).
// Pure fs reads — imports nothing from other modules (boundary-safe).

import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

const SRC = fileURLToPath(new URL("..", import.meta.url)) // src/
const ROOT = fileURLToPath(new URL("../..", import.meta.url))

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...tsFiles(p))
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p)
  }
  return out
}

describe("no secret values are logged (Security Covenant)", () => {
  // A log line leaks if it interpolates an identifier that names a raw secret.
  const SECRET = /\$\{[^}]*(token|secret|password|passwd|api[_]?key|private_key|refresh)[^}]*\}/i
  // …unless the interpolated value is provably non-sensitive (encrypted blob,
  // last-4 preview, a count/length/id/name, or a "…unset" diagnostic).
  const SAFE = /(enc\b|encrypted|preview|\.length|count|\bid\b|Id\b|name|unset|configured|\?\s*"|===)/i

  it("no console.* line interpolates a raw credential", () => {
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const text = readFileSync(file, "utf8")
      for (const line of text.split("\n")) {
        if (!/console\.(log|error|warn|info|debug)/.test(line)) continue
        if (SECRET.test(line) && !SAFE.test(line)) offenders.push(`${file.replace(ROOT, ".")}: ${line.trim()}`)
      }
    }
    expect(offenders, `Potential secret logging:\n${offenders.join("\n")}`).toEqual([])
  })
})

describe("public API discovery lists stay in sync (frozen contract)", () => {
  it("every resource in the 404 'available' list is advertised in capabilities", () => {
    const caps = readFileSync(`${SRC}/routes/public/v1/capabilities.ts`, "utf8")
    const notFound = readFileSync(`${SRC}/routes/public/index.ts`, "utf8")
    const available = /available:\s*\[([^\]]+)\]/.exec(notFound)
    expect(available).toBeTruthy()
    const resources = [...available![1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
    expect(resources.length).toBeGreaterThan(0)
    for (const r of resources) {
      expect(caps, `capabilities.ts must advertise ${r}`).toContain(r)
    }
  })
})

describe("performance covenant budgets stay strict (template)", () => {
  const lhci = JSON.parse(readFileSync(`${ROOT}/site-template/lighthouserc.json`, "utf8"))
  const a = lhci.ci.assert.assertions

  it("keeps the deploy-blocking budgets", () => {
    expect(a["categories:performance"][1].minScore).toBeGreaterThanOrEqual(0.95)
    expect(a["largest-contentful-paint"][1].maxNumericValue).toBeLessThanOrEqual(1500)
    expect(a["cumulative-layout-shift"][1].maxNumericValue).toBeLessThanOrEqual(0.05)
    expect(a["total-blocking-time"][1].maxNumericValue).toBeLessThanOrEqual(100)
    expect(a["total-byte-weight"][1].maxNumericValue).toBeLessThanOrEqual(320 * 1024)
    // Every budget must be an 'error' (deploy-blocking), not a warning.
    for (const key of Object.keys(a)) expect(a[key][0]).toBe("error")
  })

  it("runs a REPRESENTATIVE page set (homepage + post + product + heaviest), not every page", () => {
    const runner = readFileSync(`${ROOT}/site-template/scripts/lhci-run.mjs`, "utf8")
    expect(runner).toMatch(/posts/)
    expect(runner).toMatch(/products/)
    expect(runner).toMatch(/about/)
    // First-of-each, not a full crawl.
    expect(runner).toMatch(/firstSubdir/)
  })
})

describe("free-plan guardrails (gotcha #4)", () => {
  it("wrangler.toml has no [limits] block (would fail deploy on the free plan)", () => {
    expect(readFileSync(`${ROOT}/wrangler.toml`, "utf8")).not.toMatch(/^\s*\[limits\]/m)
  })
})
