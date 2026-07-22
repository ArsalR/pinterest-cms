import { describe, it, expect } from "vitest"
import { buildOptimizationReport, type OptimizeInput } from "./optimize"

const TOOLS = { seo: "/seo", aeo: "/aeo", images: "/img", speed: "/scripts", local: "/local", indexing: "/idx" }

function baseInput(over: Partial<OptimizeInput> = {}): OptimizeInput {
  return {
    title: "How to pull a great espresso shot at home",
    metaDescription: "A practical, well-tested guide to dialing in espresso at home with any machine.",
    excerpt: "A practical, well-tested guide to dialing in espresso at home with any machine.",
    content:
      `<div class="aeo-tldr"><ul><li>Grind fine</li><li>18g in, 36g out</li></ul></div>` +
      `<h2>What grind size should I use?</h2><p>${"Detailed body copy about grind size and technique. ".repeat(40)}</p>` +
      `<div class="aeo-stat"><p>Adoption grew 42%. <a href="https://example.org">Source</a></p></div>` +
      `<img src="/a.jpg" alt="espresso pour">`,
    focusKeyword: "espresso",
    hasAuthor: true,
    updatedAt: "2026-07-01",
    nowMs: Date.UTC(2026, 6, 22),
    profiles: ["ai", "image"],
    site: { speedOk: true, speedDetail: "Scripts weigh ~1KB of the 100KB budget." },
    tools: TOOLS,
    ...over,
  }
}

describe("buildOptimizationReport", () => {
  it("always includes Search, Images, Speed and Indexing sections", () => {
    const r = buildOptimizationReport(baseInput())
    const keys = r.sections.map((s) => s.key)
    expect(keys).toContain("seo")
    expect(keys).toContain("images")
    expect(keys).toContain("speed")
    expect(keys).toContain("indexing")
  })

  it("includes the AEO section only when the ai profile is active", () => {
    expect(buildOptimizationReport(baseInput({ profiles: ["ai"] })).sections.map((s) => s.key)).toContain("aeo")
    expect(buildOptimizationReport(baseInput({ profiles: [] })).sections.map((s) => s.key)).not.toContain("aeo")
  })

  it("includes the Local section only when the local profile is active", () => {
    const withLocal = buildOptimizationReport(baseInput({ profiles: ["ai", "local"], site: { speedOk: true, speedDetail: "ok", localConfigured: false } }))
    const local = withLocal.sections.find((s) => s.key === "local")
    expect(local).toBeTruthy()
    expect(local!.checks[0].status).toBe("warn")
    expect(local!.checks[0].fix?.href).toBe("/local")
  })

  it("flags a failing speed budget as red with a fix link", () => {
    const r = buildOptimizationReport(baseInput({ site: { speedOk: false, speedDetail: "BLOCKED: 170KB over budget" } }))
    const speed = r.sections.find((s) => s.key === "speed")!
    expect(speed.checks[0].status).toBe("bad")
    expect(speed.checks[0].fix?.href).toBe("/scripts")
    expect(r.allClear).toBe(false)
  })

  it("counts missing alt text and links the image tool", () => {
    const r = buildOptimizationReport(baseInput({ content: '<p>x</p><img src="/a.jpg"><img src="/b.jpg"><img src="/c.jpg">' }))
    const img = r.sections.find((s) => s.key === "images")!.checks[0]
    expect(img.status).toBe("bad") // 3 missing → bad
    expect(img.fix?.href).toBe("/img")
  })

  it("good checks carry no fix link; score + counts are consistent", () => {
    const r = buildOptimizationReport(baseInput())
    const all = r.sections.flatMap((s) => s.checks)
    for (const c of all) if (c.status === "good") expect(c.fix).toBeUndefined()
    expect(r.counts.good + r.counts.warn + r.counts.bad).toBe(all.length)
    expect(r.score).toBeGreaterThanOrEqual(0)
    expect(r.score).toBeLessThanOrEqual(100)
  })

  it("index status maps to the right state", () => {
    expect(buildOptimizationReport(baseInput({ site: { speedOk: true, speedDetail: "ok", indexStatus: "indexed" } }))
      .sections.find((s) => s.key === "indexing")!.checks[0].status).toBe("good")
    expect(buildOptimizationReport(baseInput({ site: { speedOk: true, speedDetail: "ok", indexStatus: "not-indexed" } }))
      .sections.find((s) => s.key === "indexing")!.checks[0].fix?.href).toBe("/idx")
  })
})
