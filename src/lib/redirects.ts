// src/lib/redirects.ts
// Lookup an admin-managed redirect/410/404 rule for a given request path.
// Called from the frontend slug router BEFORE attempting post/category resolution
// so admin overrides always win.
//
// Order of precedence:
//   1. Exact match on from_path
//   2. Longest prefix match (match_type='prefix') — useful for /old-section/* → /new-section/*
//   3. Returns null → caller falls through to normal resolution

import type { Client } from "@libsql/client/web"
import { escapeHtml } from "./utils"

export interface RedirectRule {
  id: string
  from_path: string
  target: string | null
  kind: "301" | "302" | "410" | "404"
  match_type: "exact" | "prefix"
  message: string | null
}

export async function lookupRedirect(
  siteDb: Client,
  path: string
): Promise<RedirectRule | null> {
  // Strip query/hash if present for lookup; we match path only.
  const cleanPath = path.split("?")[0].split("#")[0]

  // 1. Exact match (uses unique index, fast).
  const exact = await siteDb.execute({
    sql: `SELECT id, from_path, target, kind, match_type, message
          FROM redirects
          WHERE from_path = ? AND active = 1 AND match_type = 'exact'
          LIMIT 1`,
    args: [cleanPath],
  })
  if (exact.rows.length) return rowToRule(exact.rows[0])

  // 2. Longest-prefix match. Limited to redirects whose from_path is a prefix of cleanPath.
  // We pull candidates and pick the longest in JS to avoid a SQL LENGTH() ORDER BY scan.
  const prefixes = await siteDb.execute({
    sql: `SELECT id, from_path, target, kind, match_type, message
          FROM redirects
          WHERE active = 1 AND match_type = 'prefix' AND ? LIKE from_path || '%'`,
    args: [cleanPath],
  })
  if (prefixes.rows.length) {
    let best: RedirectRule | null = null
    for (const row of prefixes.rows) {
      const r = rowToRule(row)
      if (!best || r.from_path.length > best.from_path.length) best = r
    }
    return best
  }

  return null
}

/** Apply a redirect rule, returning the appropriate Response. */
export function applyRedirect(rule: RedirectRule, requestPath: string): Response {
  if (rule.kind === "301" || rule.kind === "302") {
    let location = rule.target || "/"
    if (rule.match_type === "prefix" && rule.target) {
      // Replace the matched prefix with the target prefix.
      const remainder = requestPath.slice(rule.from_path.length)
      location = rule.target.replace(/\/$/, "") + (remainder.startsWith("/") ? remainder : "/" + remainder)
    }
    return new Response(null, {
      status: rule.kind === "301" ? 301 : 302,
      headers: {
        Location: location,
        "Cache-Control": rule.kind === "301" ? "public, max-age=3600" : "no-store",
      },
    })
  }
  if (rule.kind === "410") {
    const body = rule.message
      ? wrapMessageHtml(escapeHtml(rule.message), 410, "Gone")
      : goneHtml(requestPath)
    return new Response(body, {
      status: 410,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    })
  }
  // 404
  const body = rule.message
    ? wrapMessageHtml(escapeHtml(rule.message), 404, "Not found")
    : notFoundHtml(requestPath)
  return new Response(body, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  })
}

/** Fire-and-forget hit counter increment. Never blocks the response. */
export function trackRedirectHit(siteDb: Client, ruleId: string): void {
  siteDb
    .execute({
      sql: `UPDATE redirects SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE id = ?`,
      args: [ruleId],
    })
    .catch(() => {
      /* silent — we don't fail the request over a counter update */
    })
}

function rowToRule(row: Record<string, unknown>): RedirectRule {
  return {
    id: row.id as string,
    from_path: row.from_path as string,
    target: (row.target as string | null) ?? null,
    kind: (row.kind as "301" | "302" | "410" | "404") || "301",
    match_type: (row.match_type as "exact" | "prefix") || "exact",
    message: (row.message as string | null) ?? null,
  }
}

// ─────────────── Default response bodies ───────────────

function wrapMessageHtml(safeMessage: string, status: number, title: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#111;
  min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;}
  .card{max-width:480px;text-align:center}p{color:#525252;margin:8px 0}
  a{color:#e60023;font-weight:600;text-decoration:none}</style></head>
<body><div class="card">
  <h1>${status}</h1>
  <p>${safeMessage}</p>
  <p><a href="/">← Back home</a></p>
</div></body></html>`
}

function goneHtml(path: string): string {
  const safe = path.replace(/[<>&]/g, "")
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Gone</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#111;
       min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;}
  .card{max-width:480px;text-align:center}
  h1{font-size:64px;margin:0 0 8px;letter-spacing:-2px}
  p{color:#525252;margin:8px 0}
  a{color:#e60023;font-weight:600;text-decoration:none}
  code{background:#e5e5e5;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head>
<body><div class="card">
  <h1>410</h1>
  <p>The page <code>${safe}</code> has been permanently removed.</p>
  <p><a href="/">← Back home</a></p>
</div></body></html>`
}

function notFoundHtml(path: string): string {
  const safe = path.replace(/[<>&]/g, "")
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not found</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#111;
       min-height:100vh;display:grid;place-items:center;margin:0;padding:24px;}
  .card{max-width:480px;text-align:center}
  h1{font-size:72px;margin:0 0 8px;letter-spacing:-2px}
  p{color:#525252;margin:8px 0}
  a{color:#e60023;font-weight:600;text-decoration:none}
  code{background:#e5e5e5;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head>
<body><div class="card">
  <h1>404</h1>
  <p>We couldn't find <code>${safe}</code>.</p>
  <p><a href="/">← Back home</a></p>
</div></body></html>`
}
