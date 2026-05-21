// src/routes/admin/login.ts
// Admin login/logout handlers. Exported as plain functions (not a Hono sub-app)
// to avoid the sub-app root-path edge case where app.route("/login", sub) only
// matches /login/ (trailing slash), not /login.

import type { Context } from "hono"
import type { AppEnv } from "../../lib/types"
import { verifyPassword, signJwt } from "../../lib/auth"
import { buildSetCookie } from "../../lib/cookies"
import { escapeHtml, escapeAttr } from "../../lib/utils"
import { loadSettings } from "../../lib/defaults"

export async function loginGetHandler(c: Context<AppEnv>): Promise<Response> {
  const url = new URL(c.req.url)
  const next = url.searchParams.get("next") || "/admin/"
  const error = url.searchParams.get("error")
  const settings: Record<string, string> = await loadSettings(c.get("siteDb")).catch(() => ({}))
  const siteName = settings.site_name || c.get("hostname")
  return c.html(loginHtml(siteName, next, error), 200, {
    "Cache-Control": "no-store, private",
  })
}

export async function loginPostHandler(c: Context<AppEnv>): Promise<Response> {
  const siteDb = c.get("siteDb")

  if (!c.env.JWT_SECRET) {
    console.error("login: JWT_SECRET env var is not set — cannot issue sessions")
    return redirectWithError("/admin/login", "Server configuration error — contact admin")
  }

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return redirectWithError("/admin/", "Invalid form submission")
  }

  const email = String(form.get("email") || "").toLowerCase().trim()
  const password = String(form.get("password") || "")
  const next = String(form.get("next") || "/admin/")

  if (!email || !password) {
    return redirectWithError(next, "Email and password required")
  }

  let r
  try {
    r = await siteDb.execute({
      sql: "SELECT id, email, password, role FROM users WHERE email = ? LIMIT 1",
      args: [email],
    })
  } catch (err) {
    console.error("login: DB query failed:", err)
    return redirectWithError(next, "Login temporarily unavailable — please try again")
  }

  if (!r.rows.length) {
    return redirectWithError(next, "Invalid email or password")
  }
  const user = r.rows[0]

  let ok: boolean
  try {
    ok = await verifyPassword(password, user.password as string)
  } catch (err) {
    console.error("login: verifyPassword threw:", err)
    return redirectWithError(next, "Login temporarily unavailable — please try again")
  }

  if (!ok) {
    return redirectWithError(next, "Invalid email or password")
  }

  let token: string
  try {
    token = await signJwt(
      {
        sub: user.id as string,
        email: user.email as string,
        role: (user.role as string) ?? "admin",
      },
      c.env.JWT_SECRET
    )
  } catch (err) {
    console.error("login: signJwt threw:", err)
    return redirectWithError(next, "Session creation failed — contact admin")
  }

  const cookieName = c.env.SESSION_COOKIE_NAME || "cms_session"
  const setCookie = buildSetCookie(cookieName, token, {
    maxAge: 60 * 60 * 24 * 7,
    sameSite: "Lax",
    httpOnly: true,
    secure: true,
  })
  // Sanitize next: only allow same-origin paths.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/admin/"

  return new Response(null, {
    status: 302,
    headers: { Location: safeNext, "Set-Cookie": setCookie },
  })
}

export async function logoutHandler(c: Context<AppEnv>): Promise<Response> {
  const cookieName = c.env.SESSION_COOKIE_NAME || "cms_session"
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/admin/login",
      "Set-Cookie": buildSetCookie(cookieName, "", { maxAge: 0, httpOnly: true, secure: true }),
    },
  })
}

function redirectWithError(next: string, msg: string): Response {
  const params = new URLSearchParams({ next, error: msg })
  return new Response(null, {
    status: 302,
    headers: { Location: `/admin/login?${params}` },
  })
}

function loginHtml(siteName: string, next: string, error: string | null): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Sign in — ${escapeHtml(siteName)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;
       min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;}
  .card{width:100%;max-width:380px;background:#171717;border:1px solid #262626;
        border-radius:16px;padding:32px;}
  h1{margin:0 0 4px;font-size:24px;letter-spacing:-0.02em}
  .sub{color:#a3a3a3;font-size:14px;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:500;color:#d4d4d4;margin:14px 0 6px}
  input{width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;
        padding:10px 12px;color:#fafafa;font-size:14px;font-family:inherit}
  input:focus{outline:none;border-color:#e60023;}
  button{width:100%;margin-top:20px;background:#e60023;color:#fff;border:none;border-radius:8px;
         padding:11px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  button:hover{background:#cb001f}
  .err{margin-top:14px;padding:10px 12px;border-radius:8px;background:#3b1116;color:#fca5a5;font-size:13px;border:1px solid #7f1d1d}
  .foot{margin-top:24px;font-size:12px;color:#737373;text-align:center}
</style></head>
<body>
  <form class="card" method="POST" action="/admin/login">
    <h1>Sign in</h1>
    <p class="sub">${escapeHtml(siteName)} admin</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <input type="hidden" name="next" value="${escapeAttr(next)}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="email" autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autocomplete="current-password">
    <button type="submit">Sign in</button>
    <div class="foot">Pinterest CMS</div>
  </form>
</body></html>`
}
