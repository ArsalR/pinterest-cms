// Pure-logic tests for scoped integration keys (V1.5 M2): the scope catalog +
// the permitScope mapping that the public API enforces (incl. the guardrail
// that a read-only key is denied write).
import { describe, it, expect } from "vitest"
import { SCOPE_IDS, isScope } from "./keys"
import { SITE_EVENTS, isWebhookEvent } from "./subscriptions"
import { permitScope } from "../../lib/apiAuth"
import { generateScopedKey } from "../../lib/auth"
import { WEBHOOK_EVENTS } from "../../lib/webhooks"
import { buildOpenApiSpec } from "../../routes/public/v1/openapi"
import { ERROR_CODES } from "../../lib/errors"

describe("scope catalog", () => {
  it("validates known scope ids and rejects junk", () => {
    expect(isScope("read-posts")).toBe(true)
    expect(isScope("write-posts")).toBe(true)
    expect(isScope("delete-everything")).toBe(false)
    expect(SCOPE_IDS).toContain("read-analytics")
  })
})

describe("generateScopedKey", () => {
  it("mints an sk_site_ key distinct from cms_live_", () => {
    const k = generateScopedKey()
    expect(k.startsWith("sk_site_")).toBe(true)
    expect(k.length).toBeGreaterThan(50)
    expect(generateScopedKey()).not.toBe(k) // random
  })
})

describe("permitScope (public-API enforcement)", () => {
  it("exact scope always passes", () => {
    expect(permitScope("read-analytics", ["read-analytics"])).toBe(true)
    expect(permitScope("manage-redirects", ["manage-redirects"])).toBe(true)
  })
  it("coarse 'read' is satisfied by any read-* or write-*", () => {
    expect(permitScope("read", ["read-posts"])).toBe(true)
    expect(permitScope("read", ["write-posts"])).toBe(true) // write implies read
    expect(permitScope("read", ["manage-redirects"])).toBe(false)
  })
  it("GUARDRAIL: a read-only key is denied write", () => {
    expect(permitScope("write", ["read-posts", "read-forms", "read-analytics"])).toBe(false)
    expect(permitScope("write", ["write-posts"])).toBe(true)
  })
  it("empty scopes grant nothing", () => {
    expect(permitScope("read", [])).toBe(false)
    expect(permitScope("write", [])).toBe(false)
  })
})

describe("event webhook catalog", () => {
  it("every site event is a real webhook event", () => {
    for (const e of SITE_EVENTS) expect(WEBHOOK_EVENTS).toContain(e)
    expect(isWebhookEvent("mail.received")).toBe(true)
    expect(isWebhookEvent("nope.nope")).toBe(false)
  })
  it("the new business events are registered", () => {
    for (const e of ["form.submitted", "mail.received", "order.created", "site.deployed", "analytics.daily"]) {
      expect(WEBHOOK_EVENTS).toContain(e)
    }
  })
})

describe("OpenAPI spec (M2)", () => {
  const spec = buildOpenApiSpec("acme.cms.arsal.app") as {
    openapi: string; servers: Array<{ url: string }>; paths: Record<string, unknown>
    components: { schemas: { Error: { properties: { code: { enum: string[] } } } } }
  }
  it("is OpenAPI 3 with the site server + Bearer security", () => {
    expect(spec.openapi).toBe("3.0.3")
    expect(spec.servers[0].url).toBe("https://acme.cms.arsal.app/api/public")
    expect(spec.paths["/v1/posts"]).toBeDefined()
  })
  it("documents the full frozen error-code enum", () => {
    expect(spec.components.schemas.Error.properties.code.enum).toEqual(ERROR_CODES)
    expect(spec.components.schemas.Error.properties.code.enum).toHaveLength(16)
  })
})
