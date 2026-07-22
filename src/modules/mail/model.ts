// src/modules/mail/model.ts
// Site Mailbox (V1.5 M1) — pure logic. Cloudflare Email Routing receives; a
// connected provider (Resend/Brevo/SendGrid) sends. Everything here is
// deterministic and unit-tested: conversation threading from RFC-5322 headers,
// subject normalization, and the attachment safety allowlist (reused from the
// forms upload sniff — executables never land in R2).

/** The normalized inbound payload the customer's Email Worker POSTs to the
 *  platform (signed with the per-site inbound secret). Kept small + explicit
 *  so the worker's postal-mime output maps cleanly onto it. */
export interface InboundMail {
  from: string
  to: string
  subject: string
  text: string
  html: string
  messageId: string
  inReplyTo: string
  references: string[]
  /** Cloudflare Email Routing spam verdict header, when present ("PASS"/"FAIL"). */
  spamVerdict: string
  attachments: Array<{ filename: string; contentType: string; base64: string }>
}

/** Strip Re:/Fwd:/Fw: prefixes (any language-agnostic count) + collapse space. */
export function normalizeSubject(subject: string): string {
  return (subject || "")
    .replace(/^(\s*(re|fwd?|aw|sv|antw)\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** Angle-bracket a message-id list into clean ids. Pure. */
export function parseIds(raw: string | string[] | undefined): string[] {
  if (!raw) return []
  const s = Array.isArray(raw) ? raw.join(" ") : raw
  return (s.match(/<[^>]+>/g) || (s.trim() ? [s.trim()] : [])).map((x) => x.replace(/[<>]/g, "").trim()).filter(Boolean)
}

/**
 * The conversation key a message belongs to. Precedence mirrors mail clients:
 * the root of the References chain, else In-Reply-To, else this message's own
 * id (a new thread), and as a last resort a normalized-subject bucket between
 * the two participants. Pure — unit-tested.
 */
export function threadKey(m: { messageId: string; inReplyTo: string; references: string[]; subject: string; from: string; to: string }): string {
  const refs = m.references.filter(Boolean)
  if (refs.length) return `id:${refs[0]}`
  const irt = parseIds(m.inReplyTo)[0]
  if (irt) return `id:${irt}`
  const mid = parseIds(m.messageId)[0]
  if (mid) return `id:${mid}`
  // No usable ids — bucket by normalized subject + the two addresses.
  const subj = normalizeSubject(m.subject).toLowerCase() || "(no subject)"
  const pair = [m.from.toLowerCase(), m.to.toLowerCase()].sort().join("|")
  return `subj:${subj}::${pair}`
}

// ─────────────────────── attachment safety ───────────────────────

/** Mail attachments are broader than form uploads but still exclude anything
 *  executable/scriptable. Detected by MAGIC BYTES, not the claimed name. */
export const MAIL_ATTACH_ALLOWED = [
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "text/plain", "text/csv",
  "application/zip", // common + inert-at-rest; still magic-checked below
] as const
export const MAIL_ATTACH_MAX_BYTES = 10 * 1024 * 1024 // 10 MB per attachment

/** Sniff a file's real type from its leading bytes. Returns null for anything
 *  not on the allowlist — which is how executables (MZ/ELF/Mach-O/scripts) are
 *  rejected regardless of filename. Pure. */
export function sniffAttachmentMime(bytes: Uint8Array): string | null {
  const b = bytes
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (b.length > 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp"
  if (b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf"
  if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06)) return "application/zip"
  // Executable signatures — explicitly rejected (return null): MZ (0x4d5a),
  // ELF (0x7f454c46), Mach-O (0xfeedface/0xcafebabe), shebang (0x23 0x21).
  if (b.length > 1 && b[0] === 0x4d && b[1] === 0x5a) return null
  if (b.length > 3 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return null
  // Otherwise treat as plain text ONLY if it's clean ASCII/UTF-8-ish and small.
  if (isProbablyText(b)) return "text/plain"
  return null
}

function isProbablyText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 512)
  if (n === 0) return false
  if (b[0] === 0x23 && b[1] === 0x21) return false // shebang script
  for (let i = 0; i < n; i++) {
    const c = b[i]
    if (c === 9 || c === 10 || c === 13) continue
    if (c < 0x20 || c === 0x7f) return false // control byte ⇒ not text
  }
  return true
}

/** Decode a base64 attachment, size- and type-check it. Returns the safe bytes
 *  + resolved mime, or a reason string. Pure (no I/O). */
export function vetAttachment(a: { filename: string; contentType: string; base64: string }):
  | { ok: true; bytes: Uint8Array; mime: string; ext: string }
  | { ok: false; reason: string } {
  let bytes: Uint8Array
  try {
    const bin = atob(a.base64)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    return { ok: false, reason: "unreadable attachment" }
  }
  if (bytes.byteLength === 0) return { ok: false, reason: "empty attachment" }
  if (bytes.byteLength > MAIL_ATTACH_MAX_BYTES) return { ok: false, reason: "attachment too large (>10MB)" }
  const mime = sniffAttachmentMime(bytes)
  if (!mime || !(MAIL_ATTACH_ALLOWED as readonly string[]).includes(mime)) {
    return { ok: false, reason: "attachment type not allowed (executables and unknown types are blocked)" }
  }
  const ext = mime === "application/pdf" ? "pdf" : mime === "text/plain" ? "txt" : mime === "text/csv" ? "csv" : mime === "application/zip" ? "zip" : mime.split("/")[1]
  return { ok: true, bytes, mime, ext }
}

/** Is Cloudflare's spam verdict a FAIL? (header value is "PASS"/"FAIL".) Pure. */
export function isSpam(verdict: string): boolean {
  return /fail/i.test(verdict || "")
}

/** A short preview line for the thread list. Pure. */
export function preview(text: string, html: string, cap = 140): string {
  const src = (text || html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
  return src.length > cap ? src.slice(0, cap - 1) + "…" : src
}
