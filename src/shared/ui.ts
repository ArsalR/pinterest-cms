// src/shared/ui.ts
// SaaS dashboard shell (arsal.app). Server-rendered template strings, same
// conventions as views/admin/Layout.ts: no framework, inline CSS, escapeHtml
// on all interpolated text.
//
// Shared leaf: depends only on CMS-core utils, never on a SaaS module — the
// layout takes the minimal customer shape it renders, so `shared` stays at
// the bottom of the dependency graph (enforced by the module-boundary lint).

import { escapeHtml } from "../lib/utils"

export interface SaasLayoutInput {
  title: string
  active: string
  customer: { email: string }
  bodyHtml: string
  banner?: string
}

const NAV_ITEMS: Array<{ id: string; label: string; href: string }> = [
  { id: "home", label: "Overview", href: "/app" },
  { id: "sites", label: "Sites", href: "/app/sites" },
  { id: "network", label: "Network", href: "/app/network" },
  { id: "connections", label: "Connections", href: "/app/connections" },
  { id: "account", label: "Account", href: "/app/account" },
]

export function renderSaasLayout(input: SaasLayoutInput): string {
  const nav = NAV_ITEMS.map(
    (n) =>
      `<a href="${n.href}" class="nav-item${n.id === input.active ? " active" : ""}">${escapeHtml(n.label)}</a>`
  ).join("")

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(input.title)}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;min-height:100vh;display:flex}
  aside{width:220px;flex-shrink:0;border-right:1px solid #262626;padding:20px 12px;display:flex;flex-direction:column;gap:2px}
  .brand{font-weight:700;letter-spacing:-0.02em;padding:8px 12px 20px;font-size:15px}
  .nav-item{display:block;padding:8px 12px;border-radius:8px;color:#a3a3a3;text-decoration:none;font-size:14px}
  .nav-item:hover{background:#171717;color:#fafafa}
  .nav-item.active{background:#171717;color:#fafafa;font-weight:600}
  main{flex:1;padding:32px;max-width:1100px}
  h1{font-size:22px;letter-spacing:-0.02em;margin:0 0 20px}
  .card{background:#171717;border:1px solid #262626;border-radius:12px;padding:20px;margin-bottom:16px}
  .banner{background:#1c1917;border:1px solid #78350f;color:#fcd34d;border-radius:10px;padding:12px 16px;font-size:13px;margin-bottom:20px}
  .muted{color:#a3a3a3;font-size:13px}
  .btn{display:inline-block;background:#fafafa;color:#0a0a0a;border:none;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;font-family:inherit}
  .btn.ghost{background:transparent;color:#fafafa;border:1px solid #404040}
  .foot{margin-top:auto;padding:12px}
  .foot form{margin:0}
  .foot button{background:none;border:none;color:#737373;font-size:12px;cursor:pointer;padding:8px 12px;font-family:inherit}
  .foot button:hover{color:#fafafa}
</style></head>
<body>
  <aside>
    <div class="brand">SiteNetwork</div>
    ${nav}
    <div class="foot">
      <div class="muted" style="padding:0 12px 4px">${escapeHtml(input.customer.email)}</div>
      <form method="POST" action="/app/logout"><button type="submit">Sign out</button></form>
    </div>
  </aside>
  <main>
    ${input.banner ? `<div class="banner">${input.banner}</div>` : ""}
    <h1>${escapeHtml(input.title)}</h1>
    ${input.bodyHtml}
  </main>
</body></html>`
}

/** Minimal centered card page for the auth screens (login/signup/verify/reset). */
export function renderAuthPage(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#fafafa;min-height:100vh;display:grid;place-items:center;margin:0;padding:24px}
  .card{width:100%;max-width:400px;background:#171717;border:1px solid #262626;border-radius:16px;padding:32px}
  h1{margin:0 0 4px;font-size:22px;letter-spacing:-0.02em}
  .sub{color:#a3a3a3;font-size:14px;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:500;color:#d4d4d4;margin:14px 0 6px}
  input{width:100%;background:#0a0a0a;border:1px solid #404040;border-radius:8px;padding:10px 12px;color:#fafafa;font-size:14px;font-family:inherit}
  input:focus{outline:none;border-color:#fafafa}
  button{width:100%;margin-top:20px;background:#fafafa;color:#0a0a0a;border:none;border-radius:8px;padding:11px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .err{margin-top:14px;padding:10px 12px;border-radius:8px;background:#3b1116;color:#fca5a5;font-size:13px;border:1px solid #7f1d1d}
  .ok{margin-top:14px;padding:10px 12px;border-radius:8px;background:#0f2417;color:#86efac;font-size:13px;border:1px solid #14532d}
  .links{margin-top:20px;font-size:13px;color:#a3a3a3;text-align:center}
  .links a{color:#fafafa}
</style></head>
<body>
  <div class="card">
    ${bodyHtml}
  </div>
</body></html>`
}
