// src/modules/customers/email.ts
// Transactional email via Resend (decision A), sending from arsal.app.
// One provider platform-wide: verification, password reset, alerts, forms.
//
// When RESEND_API_KEY is unset (local dev / flag rehearsal), sends are logged
// to the console instead — flows still complete so development never blocks
// on email infrastructure. Never log message bodies in production paths.

import type { CloudflareEnv } from "../../lib/types"

const FROM_AUTH = "SiteNetwork <login@arsal.app>"

export interface SendEmailInput {
  to: string
  subject: string
  html: string
  from?: string
}

/** Send one email. Returns true when accepted (or dev-logged). */
export async function sendEmail(env: CloudflareEnv, input: SendEmailInput): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.log(`[email:dev] to=${input.to} subject="${input.subject}" (RESEND_API_KEY unset — not sent)`)
    return true
  }
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.from ?? FROM_AUTH,
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
    })
    if (!resp.ok) {
      // Log status only — never response bodies that could echo addresses/content.
      console.error(`sendEmail: Resend returned ${resp.status}`)
      return false
    }
    return true
  } catch (err) {
    console.error("sendEmail: request failed:", err instanceof Error ? err.message : err)
    return false
  }
}

function authEmailShell(heading: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:ui-sans-serif,system-ui,sans-serif;background:#f5f5f5;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e5e5">
    <h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>
    ${bodyHtml}
    <p style="color:#737373;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
  </div>
</body></html>`
}

export function verificationEmailHtml(link: string): string {
  return authEmailShell(
    "Verify your email",
    `<p style="font-size:14px;color:#404040">Confirm your email address to finish creating your account.</p>
     <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px">Verify email</a></p>
     <p style="font-size:12px;color:#737373">This link expires in 24 hours.</p>`
  )
}

export function resetEmailHtml(link: string): string {
  return authEmailShell(
    "Reset your password",
    `<p style="font-size:14px;color:#404040">Click below to choose a new password.</p>
     <p><a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px">Reset password</a></p>
     <p style="font-size:12px;color:#737373">This link expires in 1 hour.</p>`
  )
}
