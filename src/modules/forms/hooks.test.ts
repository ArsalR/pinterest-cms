// src/modules/forms/hooks.test.ts — automation hooks (V1.4 F3) pure parts.
import { describe, it, expect } from "vitest"
import { ctaBlockHtml, injectCtaBlocks, subscribersToCsv, CTA_KINDS } from "./hooks"

describe("ctaBlockHtml (zero-JS CTA builders)", () => {
  it("builds all six kinds without any script", () => {
    for (const k of CTA_KINDS) {
      const html = ctaBlockHtml(k, k === "whatsapp" ? "+44 113 000" : k === "call" ? "+44113000" : k === "email" ? "a@b.co" : k === "book" ? "https://cal.com/x" : "newsletter")
      expect(html).not.toContain("<script")
      expect(html).toContain("<a ")
    }
  })
  it("whatsapp: digits-only wa.me + encoded prefill; escapes labels", () => {
    const html = ctaBlockHtml("whatsapp", "+44 (113) 000-999", '<b>Chat</b>', "Hi & hello")
    expect(html).toContain("https://wa.me/44113000999?text=Hi%20%26%20hello")
    expect(html).toContain("&lt;b&gt;Chat&lt;/b&gt;")
  })
})

describe("injectCtaBlocks", () => {
  it("replaces markers, drops unknown kinds, leaves plain content untouched", () => {
    const html = '<p>x</p><div class="cta-block" data-cta="call" data-value="+441" data-label="Ring us"></div><div class="cta-block" data-cta="evil" data-value="x"></div>'
    const out = injectCtaBlocks(html)
    expect(out).toContain('tel:+441')
    expect(out).toContain("Ring us")
    expect(out).not.toContain("evil")
    const plain = "<p>no markers</p>"
    expect(injectCtaBlocks(plain)).toBe(plain)
  })
})

describe("subscribersToCsv", () => {
  it("exports confirmed+pending, skips unsubscribed", () => {
    const csv = subscribersToCsv([
      { email: "a@x.co", confirmed: true, unsubscribed: false, createdAt: "2026" },
      { email: "b@x.co", confirmed: false, unsubscribed: false, createdAt: "2026" },
      { email: "c@x.co", confirmed: true, unsubscribed: true, createdAt: "2026" },
    ])
    expect(csv).toContain("a@x.co,yes")
    expect(csv).toContain("b@x.co,pending")
    expect(csv).not.toContain("c@x.co")
  })
})
