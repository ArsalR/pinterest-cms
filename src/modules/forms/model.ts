// src/modules/forms/model.ts
// Forms Engine (V1.4 F1) — PURE field model, validation, templates, ack
// rendering, and static HTML rendering. The design principle: one machinery,
// every business form is the same engine with different fields. ONE field
// definition drives BOTH surfaces — the static HTML the template emits and the
// server-side validation the submit endpoint runs. No I/O — unit-tested.

export type FieldType =
  | "text" | "email" | "phone" | "textarea" | "select" | "radio"
  | "checkbox" | "date" | "number" | "file" | "hidden"

export const FIELD_TYPES: readonly FieldType[] = [
  "text", "email", "phone", "textarea", "select", "radio", "checkbox", "date", "number", "file", "hidden",
]

export interface FieldDef {
  key: string          // machine key ([a-z0-9_], unique per form)
  label: string
  type: FieldType
  required: boolean
  options?: string[]   // select / radio
  help?: string
  max?: number         // max length (text-ish) — server-enforced
}

/** The honeypot input name — rendered invisibly; ANY value = bot, drop it. */
export const HONEYPOT_FIELD = "website_url_confirm"

/** Allowed upload types (magic-byte-checked at the endpoint) + size cap.
 *  Executables can never smuggle through: this list IS the policy. */
export const UPLOAD_ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024

const KEY_RE = /^[a-z0-9_]{1,40}$/

/** Parse stored fields JSON; invalid defs dropped; junk → []. Pure. */
export function parseFields(raw: unknown): FieldDef[] {
  if (typeof raw !== "string" || !raw.trim()) return []
  try {
    const a = JSON.parse(raw) as unknown
    if (!Array.isArray(a)) return []
    const out: FieldDef[] = []
    const seen = new Set<string>()
    for (const v of a as Array<Record<string, unknown>>) {
      const key = String(v?.key ?? "")
      const type = String(v?.type ?? "") as FieldType
      if (!KEY_RE.test(key) || seen.has(key) || !FIELD_TYPES.includes(type)) continue
      seen.add(key)
      const def: FieldDef = {
        key,
        label: String(v?.label ?? key).slice(0, 120),
        type,
        required: v?.required === true,
      }
      if ((type === "select" || type === "radio") && Array.isArray(v?.options)) {
        def.options = (v.options as unknown[]).map((o) => String(o).slice(0, 120)).filter(Boolean).slice(0, 30)
      }
      if (typeof v?.help === "string" && v.help.trim()) def.help = v.help.slice(0, 200)
      if (typeof v?.max === "number" && v.max > 0) def.max = Math.min(v.max, 10000)
      out.push(def)
    }
    return out
  } catch {
    return []
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_RE = /^[+\d][\d\s().-]{5,24}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export interface ValidationResult {
  ok: boolean
  /** Cleaned values by key (file fields carry the R2 URL, set by the caller). */
  values: Record<string, string>
  errors: Array<{ key: string; message: string }>
}

/** Validate submitted values against the SAME defs the HTML was rendered from. Pure. */
export function validateSubmission(defs: FieldDef[], raw: Record<string, string>): ValidationResult {
  const values: Record<string, string> = {}
  const errors: Array<{ key: string; message: string }> = []
  for (const d of defs) {
    let v = String(raw[d.key] ?? "").trim()
    const cap = d.max ?? (d.type === "textarea" ? 5000 : 500)
    if (v.length > cap) v = v.slice(0, cap)
    if (!v) {
      if (d.required && d.type !== "file") errors.push({ key: d.key, message: `${d.label} is required.` })
      continue
    }
    switch (d.type) {
      case "email":
        if (!EMAIL_RE.test(v)) errors.push({ key: d.key, message: `${d.label} doesn't look like an email address.` })
        break
      case "phone":
        if (!PHONE_RE.test(v)) errors.push({ key: d.key, message: `${d.label} doesn't look like a phone number.` })
        break
      case "date":
        if (!DATE_RE.test(v)) errors.push({ key: d.key, message: `${d.label} must be a date (YYYY-MM-DD).` })
        break
      case "number":
        if (!/^-?\d+(\.\d+)?$/.test(v)) errors.push({ key: d.key, message: `${d.label} must be a number.` })
        break
      case "select":
      case "radio":
        if (d.options && !d.options.includes(v)) errors.push({ key: d.key, message: `${d.label}: pick one of the listed options.` })
        break
      case "checkbox":
        v = v === "on" || v === "1" || v === "yes" ? "yes" : "no"
        break
    }
    values[d.key] = v
  }
  return { ok: errors.length === 0, values, errors }
}

/** The submitter's email from a validated submission (first email field). Pure.
 *  Acknowledgments go ONLY here — never to arbitrary recipients. */
export function submitterEmail(defs: FieldDef[], values: Record<string, string>): string | null {
  const f = defs.find((d) => d.type === "email" && values[d.key])
  return f ? values[f.key] : null
}

// ─────────────────────── acknowledgment templating ───────────────────────

function escHtml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c)
}

/** Render {{placeholder}} template. Values are HTML-ESCAPED (no injection via
 *  submitted content); unknown placeholders render empty. Pure. */
export function renderAckTemplate(template: string, values: Record<string, string>, extra: Record<string, string> = {}): string {
  const all: Record<string, string> = { ...values, ...extra }
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, key: string) => escHtml(all[key.toLowerCase()] ?? ""))
}

// ─────────────────────── static HTML rendering ───────────────────────

function escAttr(s: string): string {
  return escHtml(s)
}

/**
 * Render a form as PURE static HTML (zero-JS covenant — native inputs, no
 * client script; Turnstile is the one allowed widget and its script tag is
 * added by the page, not here). Mirrored by the site template. Pure.
 */
export function renderFormHtml(opts: {
  title: string
  fields: FieldDef[]
  action: string
  turnstileSitekey?: string
  page?: string
  submitLabel?: string
}): string {
  const rows = opts.fields.map((d) => {
    const req = d.required ? " required" : ""
    const name = escAttr(d.key)
    const label = `<label for="f-${name}"><strong>${escHtml(d.label)}</strong>${d.required ? " *" : ""}</label>`
    const help = d.help ? `<p class="form-help">${escHtml(d.help)}</p>` : ""
    let control: string
    switch (d.type) {
      case "textarea":
        control = `<textarea id="f-${name}" name="${name}" rows="5"${req}></textarea>`
        break
      case "select":
        control = `<select id="f-${name}" name="${name}"${req}><option value="">Choose…</option>${(d.options ?? [])
          .map((o) => `<option value="${escAttr(o)}">${escHtml(o)}</option>`)
          .join("")}</select>`
        break
      case "radio":
        control = (d.options ?? [])
          .map((o, i) => `<label class="form-radio"><input type="radio" name="${name}" value="${escAttr(o)}"${i === 0 && d.required ? " required" : ""}> ${escHtml(o)}</label>`)
          .join("")
        break
      case "checkbox":
        control = `<label class="form-check"><input type="checkbox" id="f-${name}" name="${name}"${req}> ${escHtml(d.help ?? "Yes")}</label>`
        break
      case "file":
        control = `<input type="file" id="f-${name}" name="${name}" accept="image/*,.pdf"${req}>`
        break
      case "hidden":
        return `<input type="hidden" name="${name}" value="">`
      default: {
        const typeMap: Record<string, string> = { email: "email", phone: "tel", date: "date", number: "number", text: "text" }
        control = `<input type="${typeMap[d.type] ?? "text"}" id="f-${name}" name="${name}"${req}>`
      }
    }
    if (d.type === "checkbox") return `<div class="form-row">${label}${control}</div>`
    return `<div class="form-row">${label}${help}${control}</div>`
  })

  const hasFile = opts.fields.some((d) => d.type === "file")
  return `<form method="POST" action="${escAttr(opts.action)}"${hasFile ? ` enctype="multipart/form-data"` : ""} class="site-form">
${rows.map((r) => "  " + r).join("\n")}
  <input type="text" name="${HONEYPOT_FIELD}" value="" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0">
  ${opts.page ? `<input type="hidden" name="_page" value="${escAttr(opts.page)}">` : ""}
  ${opts.turnstileSitekey ? `<div class="cf-turnstile" data-sitekey="${escAttr(opts.turnstileSitekey)}"></div>` : ""}
  <button type="submit">${escHtml(opts.submitLabel ?? "Send")}</button>
</form>`
}

// ─────────────────────── form templates (the 12 variants) ───────────────────────

export interface FormTemplate {
  id: string
  name: string
  fields: FieldDef[]
  ackSubject: string
  ackBody: string
}

const F = (key: string, label: string, type: FieldType, required = false, rest: Partial<FieldDef> = {}): FieldDef => ({
  key, label, type, required, ...rest,
})
const baseAck = (what: string) =>
  `<p>Hi {{name}},</p><p>Thanks — we received your ${what} and will get back to you soon.</p><p>— {{site_name}}</p>`

export const FORM_TEMPLATES: readonly FormTemplate[] = [
  { id: "contact", name: "Contact", fields: [F("name", "Your name", "text", true), F("email", "Email", "email", true), F("message", "Message", "textarea", true)], ackSubject: "We got your message — {{site_name}}", ackBody: baseAck("message") },
  { id: "quote", name: "Quote Request", fields: [F("name", "Your name", "text", true), F("email", "Email", "email", true), F("phone", "Phone", "phone"), F("service", "What do you need?", "textarea", true), F("budget", "Budget range", "select", false, { options: ["Under $500", "$500–$2,000", "$2,000–$10,000", "$10,000+"] }), F("timeline", "When do you need it?", "date")], ackSubject: "Your quote request — {{site_name}}", ackBody: baseAck("quote request") },
  { id: "estimate", name: "Free Estimate", fields: [F("name", "Your name", "text", true), F("email", "Email", "email", true), F("phone", "Phone", "phone", true), F("address", "Property address", "text", true), F("details", "Describe the job", "textarea", true), F("photo", "Photo (optional)", "file")], ackSubject: "Your free estimate request — {{site_name}}", ackBody: baseAck("estimate request") },
  { id: "callback", name: "Callback Request", fields: [F("name", "Your name", "text", true), F("phone", "Phone number", "phone", true), F("email", "Email", "email"), F("best_time", "Best time to call", "select", false, { options: ["Morning", "Afternoon", "Evening"] })], ackSubject: "We'll call you back — {{site_name}}", ackBody: baseAck("callback request") },
  { id: "support", name: "Support Ticket", fields: [F("name", "Your name", "text", true), F("email", "Email", "email", true), F("subject", "Subject", "text", true), F("priority", "Priority", "select", false, { options: ["Low", "Normal", "Urgent"] }), F("details", "Describe the issue", "textarea", true), F("attachment", "Screenshot (optional)", "file")], ackSubject: "Ticket received — {{site_name}}", ackBody: baseAck("support request") },
  { id: "complaint", name: "Complaint", fields: [F("name", "Your name", "text", true), F("email", "Email", "email", true), F("order_ref", "Order / reference number", "text"), F("details", "What went wrong?", "textarea", true)], ackSubject: "We're on it — {{site_name}}", ackBody: baseAck("complaint") },
  { id: "feedback", name: "Feedback", fields: [F("name", "Your name", "text"), F("email", "Email", "email"), F("rating", "How was your experience?", "radio", true, { options: ["Excellent", "Good", "Okay", "Poor"] }), F("comments", "Tell us more", "textarea")], ackSubject: "Thanks for the feedback — {{site_name}}", ackBody: baseAck("feedback") },
  { id: "review", name: "Review / Testimonial", fields: [F("name", "Your name", "text", true), F("email", "Email", "email", true), F("rating", "Rating", "radio", true, { options: ["5", "4", "3", "2", "1"] }), F("review", "Your review", "textarea", true), F("permission", "You may publish this review", "checkbox", true, { help: "Yes, you may publish my review with my first name" })], ackSubject: "Thanks for your review — {{site_name}}", ackBody: baseAck("review") },
  { id: "job", name: "Job Application", fields: [F("name", "Full name", "text", true), F("email", "Email", "email", true), F("phone", "Phone", "phone", true), F("position", "Position", "text", true), F("cover", "Why you?", "textarea", true), F("cv", "CV / Resume (PDF)", "file", true)], ackSubject: "Application received — {{site_name}}", ackBody: baseAck("application") },
  { id: "event", name: "Event Registration", fields: [F("name", "Full name", "text", true), F("email", "Email", "email", true), F("guests", "Number of guests", "number", true), F("dietary", "Dietary requirements", "text")], ackSubject: "You're registered — {{site_name}}", ackBody: baseAck("registration") },
  { id: "partner", name: "Partner / Vendor Inquiry", fields: [F("company", "Company name", "text", true), F("name", "Contact name", "text", true), F("email", "Email", "email", true), F("website", "Website", "text"), F("proposal", "What are you proposing?", "textarea", true)], ackSubject: "Inquiry received — {{site_name}}", ackBody: baseAck("inquiry") },
  { id: "newsletter", name: "Newsletter", fields: [F("email", "Email address", "email", true)], ackSubject: "Confirm your subscription — {{site_name}}", ackBody: `<p>One more step: click the link below to confirm your subscription to {{site_name}}.</p><p><a href="{{confirm_link}}">Confirm subscription</a></p>` },
] as const

export function formTemplate(id: string): FormTemplate | null {
  return FORM_TEMPLATES.find((t) => t.id === id) ?? null
}

/** Slug for a new form. Pure. */
export function formSlug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "form"
}
