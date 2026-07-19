// src/modules/forms/model.test.ts — Forms Engine (V1.4 F1) pure guardrails.
import { describe, it, expect } from "vitest"
import {
  parseFields, validateSubmission, submitterEmail, renderAckTemplate,
  renderFormHtml, FORM_TEMPLATES, formTemplate, formSlug, HONEYPOT_FIELD,
  UPLOAD_ALLOWED, type FieldDef,
} from "./model"

const DEFS: FieldDef[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "email", label: "Email", type: "email", required: true },
  { key: "budget", label: "Budget", type: "select", required: false, options: ["A", "B"] },
  { key: "msg", label: "Message", type: "textarea", required: true, max: 50 },
]

describe("parseFields (one schema, two surfaces)", () => {
  it("drops invalid keys/types/dupes; junk → []", () => {
    const raw = JSON.stringify([
      { key: "ok_field", label: "OK", type: "text" },
      { key: "BAD KEY", label: "x", type: "text" },
      { key: "ok_field", label: "dupe", type: "text" },
      { key: "evil", label: "x", type: "script" },
    ])
    const out = parseFields(raw)
    expect(out).toHaveLength(1)
    expect(out[0].key).toBe("ok_field")
    expect(parseFields("junk")).toEqual([])
  })
})

describe("validateSubmission", () => {
  it("enforces required, formats, options, and caps", () => {
    const bad = validateSubmission(DEFS, { email: "not-an-email", budget: "C", msg: "hi" })
    const keys = bad.errors.map((e) => e.key)
    expect(keys).toContain("name")
    expect(keys).toContain("email")
    expect(keys).toContain("budget")
    const ok = validateSubmission(DEFS, { name: "Ada", email: "ada@x.com", budget: "A", msg: "x".repeat(100) })
    expect(ok.ok).toBe(true)
    expect(ok.values.msg).toHaveLength(50) // cap enforced
  })
  it("finds the submitter email (acks go ONLY there)", () => {
    const r = validateSubmission(DEFS, { name: "A", email: "a@b.co", msg: "m" })
    expect(submitterEmail(DEFS, r.values)).toBe("a@b.co")
    expect(submitterEmail([DEFS[0]], { name: "A" })).toBeNull()
  })
})

describe("renderAckTemplate (no spam relay / no injection)", () => {
  // GUARDRAIL: submitted values are HTML-escaped inside templates — a
  // malicious submission can't inject markup into acknowledgment emails.
  it("escapes submitted values and blanks unknown placeholders", () => {
    const out = renderAckTemplate("<p>Hi {{name}} {{nope}}</p>", { name: '<img src=x onerror=alert(1)>' })
    expect(out).toBe("<p>Hi &lt;img src=x onerror=alert(1)&gt; </p>")
  })
})

describe("renderFormHtml (zero-JS static rendering)", () => {
  it("emits native controls, honeypot, Turnstile div — and NO script tags", () => {
    const html = renderFormHtml({ title: "T", fields: DEFS, action: "https://x/api/saas/form/s/f", turnstileSitekey: "sk" })
    expect(html).toContain('method="POST"')
    expect(html).toContain('type="email"')
    expect(html).toContain(HONEYPOT_FIELD)
    expect(html).toContain("cf-turnstile")
    expect(html).not.toContain("<script") // the page adds the one allowed script
  })
  it("multipart only when a file field exists", () => {
    expect(renderFormHtml({ title: "T", fields: DEFS, action: "/a" })).not.toContain("multipart")
    expect(renderFormHtml({ title: "T", fields: [{ key: "cv", label: "CV", type: "file", required: true }], action: "/a" })).toContain("multipart/form-data")
  })
})

describe("templates (the 12 variants)", () => {
  it("all 12 exist with valid field sets and ack copy", () => {
    expect(FORM_TEMPLATES).toHaveLength(12)
    for (const t of FORM_TEMPLATES) {
      expect(parseFields(JSON.stringify(t.fields)).length).toBe(t.fields.length) // every template validates
      expect(t.ackSubject).toContain("{{site_name}}")
    }
    expect(formTemplate("quote")!.fields.some((f) => f.type === "select")).toBe(true)
    expect(formTemplate("nope")).toBeNull()
  })
  it("upload policy is a closed allowlist (no executables)", () => {
    expect(UPLOAD_ALLOWED).not.toContain("application/octet-stream")
    expect(UPLOAD_ALLOWED).toContain("application/pdf")
  })
  it("formSlug", () => {
    expect(formSlug("Free Estimate!")).toBe("free-estimate")
  })
})
