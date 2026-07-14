// src/modules/provisioning/provisionSite.test.ts
// Pure-logic invariants of the provisioning plan (the orchestrator's DB/API
// paths are exercised in Phase 10 against mocked GitHub/CF clients).

import { describe, it, expect } from "vitest"
import { PROVISION_STEPS, STEP_LABELS, siteSlug } from "./provisionSite"

describe("PROVISION_STEPS", () => {
  it("has the locked ordering: repo before secrets before deploy before domains before workers.dev-disable", () => {
    const idx = (s: string) => PROVISION_STEPS.indexOf(s as (typeof PROVISION_STEPS)[number])
    expect(idx("cms_site")).toBeLessThan(idx("repo_secrets")) // API key must exist first
    expect(idx("create_repo")).toBeLessThan(idx("repo_secrets"))
    expect(idx("repo_secrets")).toBeLessThan(idx("first_deploy"))
    expect(idx("first_deploy")).toBeLessThan(idx("verify_deploy"))
    expect(idx("verify_deploy")).toBeLessThan(idx("attach_domains"))
    expect(idx("attach_domains")).toBeLessThan(idx("disable_workers_dev")) // never disable before the domain works
    expect(idx("turnstile")).toBeLessThan(idx("site_config")) // config embeds the sitekey
  })

  it("every step has a plain-language label (spec UX rule)", () => {
    for (const step of PROVISION_STEPS) {
      expect(STEP_LABELS[step], step).toBeTruthy()
      expect(STEP_LABELS[step]).not.toMatch(/[_]/) // labels are prose, not identifiers
    }
  })

  it("step names are unique", () => {
    expect(new Set(PROVISION_STEPS).size).toBe(PROVISION_STEPS.length)
  })
})

describe("siteSlug", () => {
  it("derives DNS/repo-safe slugs from domains", () => {
    expect(siteSlug("BrewCraft.com")).toBe("brewcraft-com")
    expect(siteSlug("my.multi.part.co.uk")).toBe("my-multi-part-co-uk")
  })
  it("strips leading/trailing separators and caps length", () => {
    expect(siteSlug("---weird--.com--")).toBe("weird-com")
    expect(siteSlug("a".repeat(80) + ".com").length).toBeLessThanOrEqual(50)
  })
})
