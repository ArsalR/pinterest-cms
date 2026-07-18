// src/modules/connections/waf.test.ts — edge bot protection (V1.3) pure parts.
import { describe, it, expect } from "vitest"
import { aiBotWafExpression, WAF_RULE_DESCRIPTION, WAF_PERMISSION_HELP, CF_TOKEN_TEMPLATE } from "./cloudflare"
import { AI_BOTS, MAJOR_ENGINE_BOTS } from "../seo"

describe("aiBotWafExpression", () => {
  it("builds a lowercase contains-clause per bot, or-joined", () => {
    const expr = aiBotWafExpression(["GPTBot", "ClaudeBot"])
    expect(expr).toBe('(lower(http.user_agent) contains "gptbot") or (lower(http.user_agent) contains "claudebot")')
  })

  it("covers the full AI_BOTS list used by the robots layer (both levels agree)", () => {
    const expr = aiBotWafExpression(AI_BOTS)
    for (const bot of AI_BOTS) expect(expr).toContain(bot.toLowerCase())
  })

  // GUARDRAIL: the edge rule must NEVER block a major search engine — the
  // expression is built only from the AI list, which shares no entries with
  // the major-engine list.
  it("never matches a major search engine crawler", () => {
    const expr = aiBotWafExpression(AI_BOTS)
    for (const engine of MAJOR_ENGINE_BOTS) {
      expect(expr).not.toContain(engine)
    }
  })
})

describe("plain-language failure surfacing", () => {
  it("names the exact missing permission and where to fix it", () => {
    expect(WAF_PERMISSION_HELP).toContain("Firewall Services")
    expect(WAF_PERMISSION_HELP).toContain("dash.cloudflare.com")
  })
  it("the token template now asks for Firewall Services: Edit up front", () => {
    expect(CF_TOKEN_TEMPLATE.some((t) => t.permission === "Firewall Services" && t.access === "Edit")).toBe(true)
  })
  it("the managed rule is identifiable (non-clobbering updates key on it)", () => {
    expect(WAF_RULE_DESCRIPTION).toContain("sitenetwork")
  })
})
