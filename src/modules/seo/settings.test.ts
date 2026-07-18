// src/modules/seo/settings.test.ts — Site SEO Control Center (S3) + hard-rails guardrail.
import { describe, it, expect } from "vitest"
import {
  DEFAULT_SEO_SETTINGS, buildRobotsTxt, robotsIsDefault,
  robotsWouldBlockMajorEngines, globalSchema, AI_BOTS,
} from "./settings"

const S = (over: Partial<typeof DEFAULT_SEO_SETTINGS> = {}) => ({ ...DEFAULT_SEO_SETTINGS, ...over })

describe("buildRobotsTxt (byte-identical rail)", () => {
  // Rail #3: an untouched site emits NO robots.txt (null) → build unchanged.
  it("reproduces today's exact robots.txt for default settings", () => {
    expect(robotsIsDefault(DEFAULT_SEO_SETTINGS)).toBe(true)
    // Byte-for-byte identical to the template's current gen-redirects.mjs output.
    expect(buildRobotsTxt(DEFAULT_SEO_SETTINGS, "https://x.com/sitemap-index.xml"))
      .toBe("User-agent: *\nAllow: /\n\nSitemap: https://x.com/sitemap-index.xml\n")
  })

  it("blocks every AI bot with one toggle, leaving search allowed", () => {
    const txt = buildRobotsTxt(S({ blockAiBots: true }), "https://x.com/sitemap-index.xml")
    expect(txt).toContain("User-agent: GPTBot")
    expect(txt).toContain("User-agent: ClaudeBot")
    for (const b of AI_BOTS) expect(txt).toContain(`User-agent: ${b}`)
    // search engines still get an allow-all catch-all group + the sitemap ref
    expect(txt).toMatch(/User-agent: \*\nAllow: \//)
    expect(txt).toContain("Sitemap: https://x.com/sitemap-index.xml")
  })

  it("disallows configured paths (dropping the catch-all Allow)", () => {
    const txt = buildRobotsTxt(S({ disallowPaths: ["/tag/", "search"] }), "https://x.com/sitemap-index.xml")
    expect(txt).toContain("Disallow: /tag/")
    expect(txt).toContain("Disallow: /search")
    expect(txt).toContain("Sitemap: https://x.com/sitemap-index.xml")
  })
})

describe("robotsWouldBlockMajorEngines (HARD RAIL)", () => {
  it("passes for the AI-bot toggle — AI blocking never bars search", () => {
    expect(robotsWouldBlockMajorEngines(S({ blockAiBots: true }))).toBe(false)
  })

  // GUARDRAIL FIRES (rail #5): a config that would deindex the site from a
  // major engine is detected so the Control Center can force a typed override.
  it("fires when a major engine is named in blockedBots", () => {
    expect(robotsWouldBlockMajorEngines(S({ blockedBots: ["Googlebot"] }))).toBe(true)
    expect(robotsWouldBlockMajorEngines(S({ blockedBots: ["bingbot"] }))).toBe(true)
  })

  it("fires on a blanket Disallow: / for all bots", () => {
    expect(robotsWouldBlockMajorEngines(S({ disallowPaths: ["/"] }))).toBe(true)
  })

  it("fires on a catch-all block written into robotsExtra", () => {
    expect(robotsWouldBlockMajorEngines(S({ robotsExtra: "User-agent: *\nDisallow: /" }))).toBe(true)
  })

  it("does not fire for ordinary path disallows", () => {
    expect(robotsWouldBlockMajorEngines(S({ disallowPaths: ["/admin", "/tag/"] }))).toBe(false)
  })
})

describe("globalSchema", () => {
  it("returns null when disabled (byte-identical default)", () => {
    expect(globalSchema(DEFAULT_SEO_SETTINGS, "Site", "https://x.com")).toBeNull()
  })
  it("emits Organization + WebSite with logo and sameAs when configured", () => {
    const g = globalSchema(S({ globalSchemaEnabled: true, orgName: "Acme", orgLogo: "https://x.com/l.png", socialProfiles: ["https://twitter.com/acme"] }), "Site", "https://x.com") as { "@graph": Array<Record<string, unknown>> }
    expect(g["@graph"][0].name).toBe("Acme")
    expect(g["@graph"][0].logo).toBe("https://x.com/l.png")
    expect(g["@graph"][0].sameAs).toEqual(["https://twitter.com/acme"])
    expect(g["@graph"][1]["@type"]).toBe("WebSite")
  })
})
