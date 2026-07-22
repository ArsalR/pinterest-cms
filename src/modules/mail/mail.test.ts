// Pure-logic tests for the Site Mailbox (V1.5 M1): threading, subject
// normalization, attachment safety (incl. the guardrail-fires executable
// rejection), and the provider request builders.
import { describe, it, expect } from "vitest"
import {
  normalizeSubject, parseIds, threadKey, sniffAttachmentMime, vetAttachment, isSpam, preview,
} from "./model"
import { buildSendRequest } from "./providers"

const b64 = (bytes: number[]) => {
  let s = ""
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s)
}

describe("subject + id parsing", () => {
  it("strips Re/Fwd prefixes and collapses space", () => {
    expect(normalizeSubject("Re: Fwd:  Re: Hello  world")).toBe("Hello world")
    expect(normalizeSubject("Order #12")).toBe("Order #12")
  })
  it("parses angle-bracketed id lists", () => {
    expect(parseIds("<a@x> <b@y>")).toEqual(["a@x", "b@y"])
    expect(parseIds("bare@id")).toEqual(["bare@id"])
    expect(parseIds(undefined)).toEqual([])
  })
})

describe("threadKey (conversation grouping)", () => {
  const base = { messageId: "<m3@x>", inReplyTo: "", references: [], subject: "Hi", from: "a@x", to: "b@y" }
  it("uses the References root when present", () => {
    expect(threadKey({ ...base, references: ["root@x", "m2@x"] })).toBe("id:root@x")
  })
  it("falls back to In-Reply-To, then own id", () => {
    expect(threadKey({ ...base, inReplyTo: "<m2@x>" })).toBe("id:m2@x")
    expect(threadKey(base)).toBe("id:m3@x")
  })
  it("buckets by normalized subject + participants when no ids", () => {
    const k1 = threadKey({ messageId: "", inReplyTo: "", references: [], subject: "Re: Quote", from: "A@x", to: "B@y" })
    const k2 = threadKey({ messageId: "", inReplyTo: "", references: [], subject: "quote", from: "b@y", to: "a@x" })
    expect(k1).toBe(k2) // same conversation regardless of Re: and direction
    expect(k1.startsWith("subj:quote::")).toBe(true)
  })
})

describe("attachment safety (guardrail fires on executables)", () => {
  it("sniffs allowed types by magic bytes", () => {
    expect(sniffAttachmentMime(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg")
    expect(sniffAttachmentMime(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe("application/pdf")
    expect(sniffAttachmentMime(new Uint8Array([...[0x50, 0x4b, 0x03, 0x04], 0, 0, 0, 0]))).toBe("application/zip")
  })
  it("REJECTS executables regardless of extension (MZ / ELF / shebang)", () => {
    expect(sniffAttachmentMime(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull() // Windows PE
    expect(sniffAttachmentMime(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBeNull() // ELF
    expect(sniffAttachmentMime(new Uint8Array([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e]))).toBeNull() // #!/bin
  })
  it("vetAttachment blocks an .exe renamed to invoice.pdf", () => {
    const evil = vetAttachment({ filename: "invoice.pdf", contentType: "application/pdf", base64: b64([0x4d, 0x5a, 0x90, 0x00, 0x03]) })
    expect(evil.ok).toBe(false)
    if (!evil.ok) expect(evil.reason).toMatch(/not allowed/i)
  })
  it("vetAttachment accepts a real PDF and resolves the extension", () => {
    const ok = vetAttachment({ filename: "doc.pdf", contentType: "application/pdf", base64: b64([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]) })
    expect(ok.ok).toBe(true)
    if (ok.ok) { expect(ok.mime).toBe("application/pdf"); expect(ok.ext).toBe("pdf") }
  })
})

describe("spam + preview helpers", () => {
  it("reads the Cloudflare spam verdict", () => {
    expect(isSpam("FAIL")).toBe(true)
    expect(isSpam("PASS")).toBe(false)
    expect(isSpam("")).toBe(false)
  })
  it("previews text, falling back to stripped html", () => {
    expect(preview("", "<p>Hello <b>there</b></p>", 100)).toBe("Hello there")
    expect(preview("x".repeat(200), "", 20)).toHaveLength(20)
  })
})

describe("provider request builders", () => {
  const m = { fromEmail: "sales@acme.com", fromName: "Acme", to: "x@y.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", replyTo: "owner@acme.com" }
  it("Resend: bearer + from string + reply_to", () => {
    const r = buildSendRequest("resend", "re_123", m)
    expect(r.url).toContain("resend.com")
    expect(r.headers.Authorization).toBe("Bearer re_123")
    const body = JSON.parse(r.body)
    expect(body.from).toBe("Acme <sales@acme.com>")
    expect(body.reply_to).toBe("owner@acme.com")
    expect(body.to).toEqual(["x@y.com"])
  })
  it("Brevo: api-key header + sender/to objects", () => {
    const r = buildSendRequest("brevo", "xkeysib-1", m)
    expect(r.headers["api-key"]).toBe("xkeysib-1")
    const body = JSON.parse(r.body)
    expect(body.sender).toEqual({ email: "sales@acme.com", name: "Acme" })
    expect(body.to).toEqual([{ email: "x@y.com" }])
    expect(body.htmlContent).toBe("<p>Hi</p>")
  })
  it("SendGrid: personalizations + content array", () => {
    const r = buildSendRequest("sendgrid", "SG.abc", m)
    expect(r.headers.Authorization).toBe("Bearer SG.abc")
    const body = JSON.parse(r.body)
    expect(body.personalizations[0].to).toEqual([{ email: "x@y.com" }])
    expect(body.content).toContainEqual({ type: "text/html", value: "<p>Hi</p>" })
  })
})
