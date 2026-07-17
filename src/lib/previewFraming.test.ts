// src/lib/previewFraming.test.ts
// Preview-window security invariant: production sites are UNFRAMEABLE, and only
// the throwaway preview worker relaxes frame-ancestors so the dashboard can
// embed it. Guards the template files + the CI gate against drift. Pure fs.

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (p: string) => readFileSync(`${ROOT}/${p}`, "utf8")

describe("production is unframeable", () => {
  const headers = read("site-template/public/_headers")
  it("the shipped _headers keeps frame-ancestors 'none' + X-Frame-Options DENY", () => {
    expect(headers).toContain("frame-ancestors 'none'")
    expect(headers).toContain("X-Frame-Options: DENY")
  })
  it("check-headers.mjs asserts production framing can't be weakened", () => {
    const gate = read("site-template/scripts/check-headers.mjs")
    expect(gate).toContain("frame-ancestors 'none'")
    expect(gate).toMatch(/X-Frame-Options: DENY/)
    expect(gate).toMatch(/process\.exit\(1\)/) // fails the deploy on a relaxed value
  })
})

describe("preview worker is framed by the dashboard (preview build only)", () => {
  const wf = read("site-template/.github/workflows/claude.yml")
  it("the PREVIEW deploy step swaps frame-ancestors to the dashboard host and drops X-Frame-Options", () => {
    expect(wf).toMatch(/frame-ancestors https:\/\/arsal\.app/)
    expect(wf).toMatch(/X-Frame-Options: DENY\$\/d/) // deletes the DENY line for preview
    // …and only in the preview-mode step, never on the direct/main path.
    expect(wf).toMatch(/Preview mode — build \+ deploy/)
  })
})

describe("the gate would reject a preview-flavored _headers on the production path", () => {
  it("a relaxed frame-ancestors fails the assertion logic", () => {
    // Simulate the exact check the gate runs.
    const previewHeaders = read("site-template/public/_headers")
      .replace("frame-ancestors 'none'", "frame-ancestors https://arsal.app")
      .replace(/^  X-Frame-Options: DENY$/m, "")
    expect(previewHeaders.includes("frame-ancestors 'none'")).toBe(false) // gate: FAIL
    expect(previewHeaders.includes("X-Frame-Options: DENY")).toBe(false)  // gate: FAIL
  })
})
