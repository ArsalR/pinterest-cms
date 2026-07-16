// src/modules/customers/authPages.ts
// Customer signup / login / logout / email verification / password reset.
// Plain handler functions (not a sub-app) — same root-path pattern as
// routes/admin/login.ts. All errors are plain-language (spec non-negotiable).

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { getMasterDb } from "../../lib/turso"
import { ensureMasterSchema } from "../../shared/masterMigrate"
import { buildSetCookie } from "../../lib/cookies"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { renderAuthPage } from "../../shared/ui"
import { sendEmail, verificationEmailHtml, resetEmailHtml } from "./email"
import {
  SAAS_SESSION_COOKIE,
  validateEmail,
  validatePassword,
  createCustomer,
  findCustomerByEmail,
  verifyCustomerPassword,
  signCustomerSession,
  issueToken,
  consumeToken,
  markEmailVerified,
  setCustomerPassword,
  customerIterations,
  trialDaysFromEnv,
  audit,
} from "./customers"
import { allowRate, AUTH_LIMITS, clientIp, RATE_LIMIT_MESSAGE } from "../../shared/rateLimit"

const NO_STORE = { "Cache-Control": "no-store, private" }

function appUrl(c: Context<AppEnv>, path: string): string {
  return `https://${c.get("hostname")}${path}`
}

async function masterDb(c: Context<AppEnv>) {
  const db = getMasterDb(c.env)
  await ensureMasterSchema(db)
  return db
}

function redirectTo(path: string, extraHeaders?: Record<string, string>): Response {
  return new Response(null, { status: 302, headers: { Location: path, ...extraHeaders } })
}

function safeNext(next: string): string {
  return next.startsWith("/app") && !next.startsWith("//") ? next : "/app"
}

// ─────────────────────── signup ───────────────────────

export async function signupGetHandler(c: Context<AppEnv>): Promise<Response> {
  const error = new URL(c.req.url).searchParams.get("error")
  return c.html(
    renderAuthPage(
      "Create account",
      `<h1>Create your account</h1>
       <p class="sub">14-day free trial. No card required.</p>
       ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
       <form method="POST" action="/app/signup">
         <label for="name">Name</label>
         <input id="name" name="name" type="text" autocomplete="name">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" required autocomplete="email">
         <label for="password">Password</label>
         <input id="password" name="password" type="password" required autocomplete="new-password" minlength="10">
         <button type="submit">Create account</button>
       </form>
       <div class="links">Already have an account? <a href="/app/login">Sign in</a></div>`
    ),
    200,
    NO_STORE
  )
}

export async function signupPostHandler(c: Context<AppEnv>): Promise<Response> {
  if (!c.env.SAAS_JWT_SECRET) {
    console.error("signup: SAAS_JWT_SECRET is not set")
    return redirectTo("/app/signup?error=" + encodeURIComponent("Sign-up isn't available right now — please try again later."))
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return redirectTo("/app/signup?error=" + encodeURIComponent("That form didn't come through — please try again."))
  }

  const email = validateEmail(String(form.get("email") || ""))
  const password = String(form.get("password") || "")
  const name = String(form.get("name") || "").trim() || null

  if (!email) {
    return redirectTo("/app/signup?error=" + encodeURIComponent("That email address doesn't look right — please check it."))
  }
  const pwErr = validatePassword(password)
  if (pwErr) {
    return redirectTo("/app/signup?error=" + encodeURIComponent(pwErr))
  }

  try {
    const db = await masterDb(c)
    if (!(await allowRate(db, `signup:ip:${clientIp(c.req.raw)}`, AUTH_LIMITS.signupIp))) {
      return redirectTo("/app/signup?error=" + encodeURIComponent(RATE_LIMIT_MESSAGE))
    }
    if (await findCustomerByEmail(db, email)) {
      return redirectTo("/app/login?error=" + encodeURIComponent("You already have an account with that email — sign in instead."))
    }
    const customer = await createCustomer(db, email, password, name, customerIterations(c.env.SAAS_PBKDF2_ITERATIONS), trialDaysFromEnv(c.env.SAAS_TRIAL_DAYS))
    await audit(db, customer.id, "customer.signup")

    const token = await issueToken(db, customer.id, "verify")
    c.executionCtx.waitUntil(
      sendEmail(c.env, {
        to: email,
        subject: "Verify your email",
        html: verificationEmailHtml(appUrl(c, `/app/verify?token=${token}`)),
      })
    )

    const session = await signCustomerSession(customer, c.env.SAAS_JWT_SECRET)
    return redirectTo("/app", {
      "Set-Cookie": buildSetCookie(SAAS_SESSION_COOKIE, session, {
        maxAge: 60 * 60 * 24 * 7,
        sameSite: "Lax",
        httpOnly: true,
        secure: true,
      }),
    })
  } catch (err) {
    console.error("signup failed:", err instanceof Error ? err.message : err)
    return redirectTo("/app/signup?error=" + encodeURIComponent("Something went wrong creating your account — please try again."))
  }
}

// ─────────────────────── login / logout ───────────────────────

export async function loginGetHandler(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const error = url.searchParams.get("error")
  const info = url.searchParams.get("info")
  const next = url.searchParams.get("next") || "/app"
  return c.html(
    renderAuthPage(
      "Sign in",
      `<h1>Sign in</h1>
       <p class="sub">SiteNetwork dashboard</p>
       ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
       ${info ? `<div class="ok">${escapeHtml(info)}</div>` : ""}
       <form method="POST" action="/app/login">
         <input type="hidden" name="next" value="${escapeAttr(next)}">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" required autocomplete="email" autofocus>
         <label for="password">Password</label>
         <input id="password" name="password" type="password" required autocomplete="current-password">
         <button type="submit">Sign in</button>
       </form>
       <div class="links"><a href="/app/forgot">Forgot password?</a> · <a href="/app/signup">Create account</a></div>`
    ),
    200,
    NO_STORE
  )
}

export async function loginPostHandler(c: Context<AppEnv>): Promise<Response> {
  if (!c.env.SAAS_JWT_SECRET) {
    console.error("saas login: SAAS_JWT_SECRET is not set")
    return redirectTo("/app/login?error=" + encodeURIComponent("Sign-in isn't available right now — please try again later."))
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return redirectTo("/app/login?error=" + encodeURIComponent("That form didn't come through — please try again."))
  }

  const email = validateEmail(String(form.get("email") || ""))
  const password = String(form.get("password") || "")
  const next = safeNext(String(form.get("next") || "/app"))

  if (!email || !password) {
    return redirectTo("/app/login?error=" + encodeURIComponent("Email and password are both required."))
  }

  try {
    const db = await masterDb(c)
    // Per-IP then per-account limits — credential-stuffing defense.
    if (
      !(await allowRate(db, `login:ip:${clientIp(c.req.raw)}`, AUTH_LIMITS.loginIp)) ||
      !(await allowRate(db, `login:email:${email}`, AUTH_LIMITS.loginEmail))
    ) {
      return redirectTo("/app/login?error=" + encodeURIComponent(RATE_LIMIT_MESSAGE))
    }
    const customer = await verifyCustomerPassword(db, email, password, customerIterations(c.env.SAAS_PBKDF2_ITERATIONS))
    if (!customer) {
      await audit(db, null, "customer.login_failed", email)
      return redirectTo("/app/login?error=" + encodeURIComponent("That email or password isn't right."))
    }
    await audit(db, customer.id, "customer.login")
    const session = await signCustomerSession(customer, c.env.SAAS_JWT_SECRET)
    return redirectTo(next, {
      "Set-Cookie": buildSetCookie(SAAS_SESSION_COOKIE, session, {
        maxAge: 60 * 60 * 24 * 7,
        sameSite: "Lax",
        httpOnly: true,
        secure: true,
      }),
    })
  } catch (err) {
    console.error("saas login failed:", err instanceof Error ? err.message : err)
    return redirectTo("/app/login?error=" + encodeURIComponent("Sign-in hit a snag — please try again."))
  }
}

export async function logoutPostHandler(_c: Context<AppEnv>): Promise<Response> {
  return redirectTo("/app/login", {
    "Set-Cookie": buildSetCookie(SAAS_SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: true }),
  })
}

// ─────────────────────── email verification ───────────────────────

export async function verifyGetHandler(c: Context<AppEnv>): Promise<Response> {
  const token = new URL(c.req.url).searchParams.get("token") || ""
  try {
    const db = await masterDb(c)
    const customerId = await consumeToken(db, token, "verify")
    if (!customerId) {
      return c.html(
        renderAuthPage(
          "Verification failed",
          `<h1>Link expired</h1>
           <p class="sub">This verification link is invalid or has expired.</p>
           <div class="links"><a href="/app">Go to dashboard</a> to request a new one.</div>`
        ),
        200,
        NO_STORE
      )
    }
    await markEmailVerified(db, customerId)
    await audit(db, customerId, "customer.email_verified")
    return redirectTo("/app")
  } catch (err) {
    console.error("verify failed:", err instanceof Error ? err.message : err)
    return c.html(
      renderAuthPage(
        "Verification failed",
        `<h1>Something went wrong</h1>
         <p class="sub">We couldn't verify your email just now — please try the link again in a minute.</p>`
      ),
      200,
      NO_STORE
    )
  }
}

// ─────────────────────── password reset ───────────────────────

export async function forgotGetHandler(c: Context<AppEnv>): Promise<Response> {
  const sent = new URL(c.req.url).searchParams.get("sent")
  return c.html(
    renderAuthPage(
      "Reset password",
      `<h1>Reset your password</h1>
       <p class="sub">We'll email you a reset link.</p>
       ${sent ? `<div class="ok">If that email has an account, a reset link is on its way.</div>` : ""}
       <form method="POST" action="/app/forgot">
         <label for="email">Email</label>
         <input id="email" name="email" type="email" required autocomplete="email" autofocus>
         <button type="submit">Send reset link</button>
       </form>
       <div class="links"><a href="/app/login">Back to sign in</a></div>`
    ),
    200,
    NO_STORE
  )
}

export async function forgotPostHandler(c: Context<AppEnv>): Promise<Response> {
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return redirectTo("/app/forgot")
  }
  const email = validateEmail(String(form.get("email") || ""))
  // Always the same response — never reveal whether the account exists.
  const done = redirectTo("/app/forgot?sent=1")
  if (!email) return done
  try {
    const db = await masterDb(c)
    // Per-IP and per-email limits — reset-email-bombing defense. The email
    // limit is counted whether or not the account exists (uniform timing).
    if (
      !(await allowRate(db, `forgot:ip:${clientIp(c.req.raw)}`, AUTH_LIMITS.forgotIp)) ||
      !(await allowRate(db, `forgot:email:${email}`, AUTH_LIMITS.forgotEmail))
    ) {
      return done // silently drop — same response, no enumeration via 429
    }
    const customer = await findCustomerByEmail(db, email)
    // ALL account-existence-dependent work is deferred to waitUntil so the
    // response returns after identical awaited work for both outcomes —
    // no timing oracle on account existence.
    if (customer) {
      const env = c.env
      const hostname = c.get("hostname")
      c.executionCtx.waitUntil(
        (async () => {
          const token = await issueToken(db, customer.id, "reset")
          await audit(db, customer.id, "customer.reset_requested")
          await sendEmail(env, {
            to: email,
            subject: "Reset your password",
            html: resetEmailHtml(`https://${hostname}/app/reset?token=${token}`),
          })
        })().catch((err) => console.error("forgot deferred work failed:", err))
      )
    }
  } catch (err) {
    console.error("forgot failed:", err instanceof Error ? err.message : err)
  }
  return done
}

export async function resetGetHandler(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const token = url.searchParams.get("token") || ""
  const error = url.searchParams.get("error")
  return c.html(
    renderAuthPage(
      "Choose a new password",
      `<h1>Choose a new password</h1>
       ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
       <form method="POST" action="/app/reset">
         <input type="hidden" name="token" value="${escapeAttr(token)}">
         <label for="password">New password</label>
         <input id="password" name="password" type="password" required autocomplete="new-password" minlength="10" autofocus>
         <button type="submit">Set password</button>
       </form>`
    ),
    200,
    NO_STORE
  )
}

export async function resetPostHandler(c: Context<AppEnv>): Promise<Response> {
  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return redirectTo("/app/forgot")
  }
  const token = String(form.get("token") || "")
  const password = String(form.get("password") || "")
  const pwErr = validatePassword(password)
  if (pwErr) {
    return redirectTo(`/app/reset?token=${encodeURIComponent(token)}&error=${encodeURIComponent(pwErr)}`)
  }
  try {
    const db = await masterDb(c)
    if (!(await allowRate(db, `reset:ip:${clientIp(c.req.raw)}`, AUTH_LIMITS.resetIp))) {
      return redirectTo("/app/forgot?error=" + encodeURIComponent(RATE_LIMIT_MESSAGE))
    }
    const customerId = await consumeToken(db, token, "reset")
    if (!customerId) {
      return redirectTo("/app/forgot?error=" + encodeURIComponent("That reset link is invalid or expired — request a new one."))
    }
    await setCustomerPassword(db, customerId, password, customerIterations(c.env.SAAS_PBKDF2_ITERATIONS))
    await audit(db, customerId, "customer.password_reset")
    return redirectTo("/app/login?info=" + encodeURIComponent("Password updated — sign in with your new password."))
  } catch (err) {
    console.error("reset failed:", err instanceof Error ? err.message : err)
    return redirectTo("/app/forgot?error=" + encodeURIComponent("Something went wrong — please request a new reset link."))
  }
}
