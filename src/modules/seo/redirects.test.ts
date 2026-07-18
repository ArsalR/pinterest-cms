// src/modules/seo/redirects.test.ts — redirects manager (S4) + chain-loop guardrail.
import { describe, it, expect } from "vitest"
import {
  normalizeFrom, validateRedirect, isBrandedLink,
  toRedirectsCsv, parseRedirectsCsv, splitCsvLine, detectChains,
  type RedirectInput,
} from "./redirects"

const R = (over: Partial<RedirectInput> = {}): RedirectInput => ({ from: "/old/", to: "/new/", kind: "301", matchType: "exact", ...over })

describe("validation", () => {
  it("normalizes source paths", () => {
    expect(normalizeFrom("old//page")).toBe("/old/page")
    expect(normalizeFrom("  /a/b  ")).toBe("/a/b")
  })
  it("accepts internal + external targets, rejects junk", () => {
    expect(validateRedirect(R())).toBeNull()
    expect(validateRedirect(R({ to: "https://example.com/x" }))).toBeNull()
    expect(validateRedirect(R({ to: "not a url" }))).toMatch(/internal path/)
    expect(validateRedirect(R({ from: "/" }))).toMatch(/required/)
  })
  it("a 410 needs no target", () => {
    expect(validateRedirect(R({ kind: "410", to: "" }))).toBeNull()
    expect(validateRedirect(R({ kind: "301", to: "" }))).toMatch(/needs a target/)
  })
  it("classifies branded (external) links", () => {
    expect(isBrandedLink({ to: "https://amzn.to/x", kind: "301" })).toBe(true)
    expect(isBrandedLink({ to: "/internal/", kind: "301" })).toBe(false)
    expect(isBrandedLink({ to: "https://x/y", kind: "410" })).toBe(false)
  })
})

describe("CSV round-trip", () => {
  it("serializes and re-parses to the same rows", () => {
    const rows = [R(), R({ from: "/go/deal", to: "https://shop.com/p?a=1,2", kind: "302" })]
    const csv = toRedirectsCsv(rows)
    const back = parseRedirectsCsv(csv)
    expect(back.errors).toHaveLength(0)
    expect(back.rows).toHaveLength(2)
    expect(back.rows[1].to).toBe("https://shop.com/p?a=1,2")
  })
  it("handles quoted fields with commas", () => {
    expect(splitCsvLine('/a,"https://x/y?b=1,2",301,exact')).toEqual(["/a", "https://x/y?b=1,2", "301", "exact"])
  })
  it("skips the header and reports invalid rows without throwing", () => {
    const csv = "from,to,kind,match\n/good/,/dest/,301,exact\nbadrow,,301,exact\n"
    const res = parseRedirectsCsv(csv)
    expect(res.rows).toHaveLength(1)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].line).toBe(3)
  })
})

describe("detectChains (GUARDRAIL)", () => {
  it("returns nothing for a flat set of redirects", () => {
    expect(detectChains([R({ from: "/a", to: "/x" }), R({ from: "/b", to: "https://ext/" })])).toHaveLength(0)
  })

  // GUARDRAIL FIRES (rail #5): a chain a→b→c forces extra hops and must be
  // surfaced so the operator can flatten it.
  it("detects a multi-hop chain", () => {
    const chains = detectChains([R({ from: "/a", to: "/b" }), R({ from: "/b", to: "/c" })])
    const a = chains.find((c) => c.from === "/a")!
    expect(a.hops).toEqual(["/b", "/c"])
    expect(a.loop).toBe(false)
  })

  it("detects a redirect loop", () => {
    const chains = detectChains([R({ from: "/a", to: "/b" }), R({ from: "/b", to: "/a" })])
    expect(chains.some((c) => c.loop)).toBe(true)
  })

  it("detects a self-loop", () => {
    expect(detectChains([R({ from: "/a", to: "/a" })])[0].loop).toBe(true)
  })

  it("stops at external targets (no false chains)", () => {
    expect(detectChains([R({ from: "/go/x", to: "https://ext/" })])).toHaveLength(0)
  })
})
