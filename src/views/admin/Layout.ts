// src/views/admin/Layout.ts
// Admin chrome: sidebar nav + top bar + content area.
// All admin pages call renderAdminLayout({ ... }).

import { escapeHtml, escapeAttr } from "../../lib/utils"

export interface AdminLayoutInput {
  title: string
  hostname: string
  user: { id?: string; email: string; role: string } | null | undefined
  active: string                  // "dashboard" | "posts" | "pages" | "categories" | "media" | "menus" | "appearance" | "seo" | "settings" | "permalinks" | "api-keys"
  bodyHtml: string
  /** Extra <head> content (e.g. CSS for Tiptap, scripts). */
  extraHead?: string
  /** Optional inline scripts at end of body. */
  inlineScript?: string
  /** Override the page H1 inside the content area. Defaults to `title`. */
  pageHeading?: string
  /** Optional buttons / actions next to the page heading. */
  pageActions?: string
  /** Show a banner above content (e.g. one-time API key reveal). */
  banner?: string
  /** Wider content area (used by theme customizer). */
  fullWidth?: boolean
}

const NAV_ITEMS: Array<{ id: string; label: string; href: string; icon: string }> = [
  { id: "dashboard", label: "Dashboard", href: "/admin/", icon: iconHome() },
  { id: "posts", label: "Posts", href: "/admin/posts", icon: iconDoc() },
  { id: "pages", label: "Pages", href: "/admin/pages", icon: iconPage() },
  { id: "categories", label: "Categories", href: "/admin/categories", icon: iconTag() },
  { id: "media", label: "Media", href: "/admin/media", icon: iconImage() },
  { id: "menus", label: "Menus", href: "/admin/menus", icon: iconMenu() },
  { id: "appearance", label: "Appearance", href: "/admin/appearance", icon: iconBrush() },
  { id: "seo", label: "SEO", href: "/admin/seo", icon: iconChart() },
  { id: "permalinks", label: "Permalinks", href: "/admin/permalinks", icon: iconLink() },
  { id: "redirects", label: "Redirects", href: "/admin/redirects", icon: iconRedirect() },
  { id: "api-keys", label: "API Keys", href: "/admin/api-keys", icon: iconKey() },
  { id: "settings", label: "Settings", href: "/admin/settings", icon: iconCog() },
]

export function renderAdminLayout(input: AdminLayoutInput): string {
  const sidebar = NAV_ITEMS.map(
    (n) =>
      `<a class="nav-item ${n.id === input.active ? "active" : ""}" href="${escapeAttr(n.href)}">
        <span class="nav-icon">${n.icon}</span>
        <span>${escapeHtml(n.label)}</span>
      </a>`
  ).join("")

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(input.title)}</title>
${baseStyles()}
${input.extraHead ?? ""}
</head>
<body>
<div class="admin-shell">
  <aside class="admin-sidebar">
    <div class="brand">
      <strong>${escapeHtml(input.hostname)}</strong>
      <span class="brand-sub">Admin</span>
    </div>
    <nav>${sidebar}</nav>
    <form method="POST" action="/admin/login/logout" class="logout-form">
      <button type="submit" class="logout-btn">
        ${iconLogout()} <span>Sign out</span>
      </button>
    </form>
  </aside>
  <main class="admin-main ${input.fullWidth ? "full-width" : ""}">
    <header class="page-head">
      <div>
        <h1>${escapeHtml(input.pageHeading ?? input.title)}</h1>
      </div>
      <div class="page-actions">${input.pageActions ?? ""}</div>
    </header>
    ${input.banner ?? ""}
    <div class="page-body">${input.bodyHtml}</div>
  </main>
</div>
${input.inlineScript ?? ""}
</body></html>`
}

function baseStyles(): string {
  return `<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--surface:#171717;--surface-2:#1f1f1f;
  --border:#262626;--border-2:#404040;
  --text:#fafafa;--muted:#a3a3a3;--muted-2:#737373;
  --primary:#e60023;--primary-hover:#cb001f;
  --success:#22c55e;--warn:#f59e0b;--danger:#ef4444;
  --radius:10px;--radius-sm:6px;
  --font:ui-sans-serif,-apple-system,system-ui,Segoe UI,Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
html,body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button{font-family:inherit;font-size:inherit}
input,select,textarea{font-family:inherit;font-size:inherit}

.admin-shell{display:grid;grid-template-columns:240px 1fr;min-height:100vh}
@media(max-width:900px){.admin-shell{grid-template-columns:64px 1fr}.admin-sidebar .nav-item span:not(.nav-icon),.admin-sidebar .brand-sub,.admin-sidebar .brand strong,.logout-btn span{display:none}}

.admin-sidebar{background:var(--surface);border-right:1px solid var(--border);padding:20px 12px;display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.brand{padding:8px 8px 16px;border-bottom:1px solid var(--border);margin-bottom:12px}
.brand strong{display:block;font-size:14px;letter-spacing:-0.01em}
.brand-sub{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.06em}
.admin-sidebar nav{display:flex;flex-direction:column;gap:2px;flex:1}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:var(--radius-sm);color:var(--muted);font-weight:500;font-size:13px}
.nav-item:hover{background:var(--surface-2);color:var(--text)}
.nav-item.active{background:var(--primary);color:#fff}
.nav-icon{display:inline-flex;width:18px;height:18px;flex-shrink:0}
.nav-icon svg{width:18px;height:18px}
.logout-form{margin-top:auto;padding-top:12px;border-top:1px solid var(--border)}
.logout-btn{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;background:transparent;border:none;color:var(--muted);border-radius:var(--radius-sm);cursor:pointer;font-size:13px;font-weight:500;text-align:left}
.logout-btn:hover{background:var(--surface-2);color:var(--text)}

.admin-main{padding:24px 32px 64px;max-width:1200px;width:100%}
.admin-main.full-width{max-width:none}
.page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)}
.page-head h1{font-size:24px;font-weight:700;letter-spacing:-0.02em}
.page-actions{display:flex;gap:8px;flex-wrap:wrap}

.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:var(--radius-sm);background:var(--surface-2);border:1px solid var(--border);color:var(--text);font-weight:500;cursor:pointer;font-size:13px}
.btn:hover{background:var(--border)}
.btn.primary{background:var(--primary);color:#fff;border-color:var(--primary)}
.btn.primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.btn.danger{background:transparent;color:var(--danger);border-color:rgba(239,68,68,0.4)}
.btn.danger:hover{background:rgba(239,68,68,0.12)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--muted)}
.btn.ghost:hover{background:var(--surface-2);color:var(--text)}
.btn.sm{padding:5px 10px;font-size:12px}

.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.card h2{font-size:16px;margin-bottom:12px}

.form-row{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.form-row label{font-size:13px;font-weight:500;color:var(--muted)}
.form-row .hint{font-size:12px;color:var(--muted-2);margin-top:-2px}
.form-row input[type=text],.form-row input[type=email],.form-row input[type=password],
.form-row input[type=url],.form-row input[type=number],.form-row select,.form-row textarea{
  background:var(--bg);border:1px solid var(--border-2);border-radius:var(--radius-sm);
  padding:9px 11px;color:var(--text);width:100%;
}
.form-row textarea{resize:vertical;min-height:80px;font-family:var(--mono)}
.form-row input:focus,.form-row select:focus,.form-row textarea:focus{outline:none;border-color:var(--primary)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:720px){.form-grid{grid-template-columns:1fr}}

.banner{padding:14px 16px;border-radius:var(--radius);margin-bottom:16px;font-size:13px;border:1px solid}
.banner.success{background:rgba(34,197,94,0.1);border-color:rgba(34,197,94,0.3);color:#86efac}
.banner.warn{background:rgba(245,158,11,0.1);border-color:rgba(245,158,11,0.3);color:#fcd34d}
.banner.error{background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.3);color:#fca5a5}
.banner.info{background:rgba(59,130,246,0.1);border-color:rgba(59,130,246,0.3);color:#93c5fd}

table{width:100%;border-collapse:collapse;font-size:13px}
table th,table td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)}
table th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:0.04em;background:var(--surface)}
table tr:hover td{background:var(--surface-2)}
table .row-actions{display:flex;gap:4px;justify-content:flex-end}

.pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
.pill.published{background:rgba(34,197,94,0.15);color:#86efac}
.pill.draft{background:rgba(115,115,115,0.2);color:#a3a3a3}
.pill.api{background:rgba(99,102,241,0.15);color:#a5b4fc}
.pill.manual{background:rgba(245,158,11,0.15);color:#fcd34d}

.empty-state{text-align:center;padding:60px 20px;color:var(--muted)}
.empty-state svg{margin-bottom:14px;opacity:0.3}
.kbd{font-family:var(--mono);font-size:11px;padding:2px 6px;background:var(--surface-2);border:1px solid var(--border);border-radius:4px}

input[type=checkbox]{accent-color:var(--primary)}
</style>`
}

// SVG icons (currentColor fill, 18×18). Stripped down for brevity.
function iconHome(){return svg('<path d="M3 11l9-8 9 8M5 9.5V21h5v-6h4v6h5V9.5"/>')}
function iconDoc(){return svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/>')}
function iconPage(){return svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h6"/>')}
function iconTag(){return svg('<path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3H4a1 1 0 0 0-1 1v5.59a2 2 0 0 0 .59 1.41l9.58 9.58a2 2 0 0 0 2.83 0l4.59-4.59a2 2 0 0 0 0-2.82z"/><circle cx="7" cy="7" r="1.2"/>')}
function iconImage(){return svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>')}
function iconMenu(){return svg('<path d="M3 6h18M3 12h18M3 18h18"/>')}
function iconBrush(){return svg('<path d="M19 7 8 18l-3 1 1-3L17 5z"/><path d="m13 9 4 4"/>')}
function iconChart(){return svg('<path d="M3 3v18h18"/><path d="m7 14 4-4 4 4 5-5"/>')}
function iconLink(){return svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.71 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>')}
function iconRedirect(){return svg('<path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 4 4v0a4 4 0 0 1-4 4H8"/>')}
function iconKey(){return svg('<circle cx="7.5" cy="14.5" r="3.5"/><path d="m10 12 11-11M16 7l3 3M19 4l3 3"/>')}
function iconCog(){return svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')}
function iconLogout(){return svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>')}

function svg(inner: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`
}
