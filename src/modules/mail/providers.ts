// src/modules/mail/providers.ts
// Sending adapters (V1.5 M1): Cloudflare RECEIVES, a connected provider SENDS.
// Picking a provider is a dropdown, not a project — one adapter interface,
// three implementations. The customer's API key is vault-encrypted per site
// and decrypted only at send time. Request builders are pure + unit-tested;
// the dispatch/verify wrappers are best-effort fetch with friendly errors.

export const MAIL_PROVIDERS = ["resend", "brevo", "sendgrid"] as const
export type MailProviderId = (typeof MAIL_PROVIDERS)[number]

export function isMailProvider(v: string): v is MailProviderId {
  return (MAIL_PROVIDERS as readonly string[]).includes(v)
}

export const MAIL_PROVIDER_LABELS: Record<MailProviderId, string> = {
  resend: "Resend", brevo: "Brevo", sendgrid: "SendGrid",
}

export interface SendInput {
  fromEmail: string
  fromName: string
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
  attachments?: Array<{ filename: string; base64: string; contentType: string }>
}

export interface ProviderRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/** Build the HTTP request for a provider's send API. Pure — unit-tested. */
export function buildSendRequest(provider: MailProviderId, apiKey: string, m: SendInput): ProviderRequest {
  const from = m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail
  switch (provider) {
    case "resend":
      return {
        url: "https://api.resend.com/emails",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to: [m.to], subject: m.subject, html: m.html || undefined, text: m.text || undefined,
          reply_to: m.replyTo || undefined,
          attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.base64 })),
        }),
      }
    case "brevo":
      return {
        url: "https://api.brevo.com/v3/smtp/email",
        headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sender: { email: m.fromEmail, name: m.fromName || undefined },
          to: [{ email: m.to }],
          replyTo: m.replyTo ? { email: m.replyTo } : undefined,
          subject: m.subject, htmlContent: m.html || undefined, textContent: m.text || undefined,
          attachment: m.attachments?.map((a) => ({ name: a.filename, content: a.base64 })),
        }),
      }
    case "sendgrid":
      return {
        url: "https://api.sendgrid.com/v3/mail/send",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: m.to }] }],
          from: { email: m.fromEmail, name: m.fromName || undefined },
          reply_to: m.replyTo ? { email: m.replyTo } : undefined,
          subject: m.subject,
          content: [
            ...(m.text ? [{ type: "text/plain", value: m.text }] : []),
            ...(m.html ? [{ type: "text/html", value: m.html }] : []),
          ],
          attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.base64, type: a.contentType })),
        }),
      }
  }
}

export interface SendResult { ok: boolean; error?: string }

/** Send via the chosen provider. Best-effort; returns a plain-language error. */
export async function providerSend(provider: MailProviderId, apiKey: string, m: SendInput): Promise<SendResult> {
  const req = buildSendRequest(provider, apiKey, m)
  try {
    const resp = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body })
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: `Your ${MAIL_PROVIDER_LABELS[provider]} API key was rejected — reconnect it.` }
    if (resp.status === 429) return { ok: false, error: `${MAIL_PROVIDER_LABELS[provider]} is rate-limiting your account — try again shortly.` }
    if (!resp.ok) return { ok: false, error: `${MAIL_PROVIDER_LABELS[provider]} returned ${resp.status} — check the from-address is on a verified domain.` }
    return { ok: true }
  } catch {
    return { ok: false, error: `Couldn't reach ${MAIL_PROVIDER_LABELS[provider]} — try again.` }
  }
}

/** Verify the provider API key works (cheap authenticated GET). Best-effort. */
export async function providerStatus(provider: MailProviderId, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const probe: Record<MailProviderId, { url: string; headers: Record<string, string> }> = {
    resend: { url: "https://api.resend.com/domains", headers: { Authorization: `Bearer ${apiKey}` } },
    brevo: { url: "https://api.brevo.com/v3/account", headers: { "api-key": apiKey, Accept: "application/json" } },
    sendgrid: { url: "https://api.sendgrid.com/v3/scopes", headers: { Authorization: `Bearer ${apiKey}` } },
  }
  const p = probe[provider]
  try {
    const resp = await fetch(p.url, { headers: p.headers })
    if (resp.ok) return { ok: true }
    if (resp.status === 401 || resp.status === 403) return { ok: false, error: "Key rejected — check you pasted a full API key with send permission." }
    return { ok: false, error: `${MAIL_PROVIDER_LABELS[provider]} returned ${resp.status}.` }
  } catch {
    return { ok: false, error: `Couldn't reach ${MAIL_PROVIDER_LABELS[provider]}.` }
  }
}
