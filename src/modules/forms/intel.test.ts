// Pure-logic tests for the F4 submission-intelligence pieces (no Workers
// runtime, no network — CI-safe per gotcha #12).
import { describe, it, expect } from "vitest"
import { buildIntelPrompt, buildDraftPrompt, parseIntelResponse, digestEmailHtml, LEAD_SCORES } from "./intel"

const INPUT = {
  formTitle: "Request a quote",
  siteName: "Acme Plumbing",
  fields: { name: "Sam Lee", email: "sam@example.com", message: "Burst pipe, need someone today" },
}

describe("buildIntelPrompt / buildDraftPrompt", () => {
  it("carries the submission fields and site context into the user prompt", () => {
    const p = buildIntelPrompt(INPUT)
    expect(p.user).toContain("Acme Plumbing")
    expect(p.user).toContain("Request a quote")
    expect(p.user).toContain("Burst pipe")
    expect(p.system).toContain('"score"')
    const d = buildDraftPrompt(INPUT)
    expect(d.user).toContain("Burst pipe")
    expect(d.system).toContain("Never invent")
  })

  it("caps enormous field payloads", () => {
    const big = buildIntelPrompt({ ...INPUT, fields: { message: "x".repeat(50000) } })
    expect(big.user.length).toBeLessThan(6000)
  })
})

describe("parseIntelResponse", () => {
  it("parses a clean JSON object", () => {
    const r = parseIntelResponse('{"summary":"Sam has a burst pipe and wants same-day service.","score":"hot","reason":"urgent, concrete job"}')
    expect(r).not.toBeNull()
    expect(r?.score).toBe("hot")
    expect(r?.summary).toContain("burst pipe")
  })

  it("tolerates code fences and surrounding prose", () => {
    const r = parseIntelResponse('Here you go:\n```json\n{"summary":"A vague inquiry.","score":"cold","reason":"no specifics"}\n```')
    expect(r?.score).toBe("cold")
  })

  it("rejects junk, missing summary, and invalid scores", () => {
    expect(parseIntelResponse(null)).toBeNull()
    expect(parseIntelResponse("not json at all")).toBeNull()
    expect(parseIntelResponse('{"summary":"","score":"hot"}')).toBeNull()
    expect(parseIntelResponse('{"summary":"ok","score":"volcanic"}')).toBeNull()
  })

  it("caps summary/reason lengths and normalizes score case", () => {
    const r = parseIntelResponse(`{"summary":"${"s".repeat(500)}","score":"HOT","reason":"${"r".repeat(500)}"}`)
    expect(r?.summary.length).toBeLessThanOrEqual(200)
    expect(r?.reason.length).toBeLessThanOrEqual(80)
    expect(r?.score).toBe("hot")
    expect(LEAD_SCORES).toContain(r?.score)
  })
})

describe("digestEmailHtml", () => {
  it("lists items with escaped content and links to the inbox", () => {
    const html = digestEmailHtml("acme.com", "arsal.app", "site1", [
      { formTitle: "Contact", first: "<script>alert(1)</script>", aiSummary: "A & B want a quote", aiScore: "warm: genuine", createdAt: "2026-07-19 08:00:00" },
      { formTitle: "Quote", first: "Plain lead", aiSummary: null, aiScore: null, createdAt: "2026-07-19 09:00:00" },
    ])
    expect(html).toContain("https://arsal.app/app/sites/site1/inbox")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("A &amp; B want a quote")
    expect(html).toContain("(warm)")
    expect(html).toContain("2 new submissions")
  })
})
