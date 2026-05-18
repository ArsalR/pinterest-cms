// src/lib/cookies.ts
// Minimal cookie helpers — Hono ships its own, but we keep these dependency-free
// for places that handle raw Request/Response.

export function parseCookies(header: string | null | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

export interface SetCookieOptions {
  maxAge?: number
  path?: string
  domain?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Strict" | "Lax" | "None"
}

export function buildSetCookie(
  name: string,
  value: string,
  opts: SetCookieOptions = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  if (opts.path) parts.push(`Path=${opts.path}`)
  else parts.push("Path=/")
  if (opts.domain) parts.push(`Domain=${opts.domain}`)
  if (opts.httpOnly !== false) parts.push("HttpOnly")
  if (opts.secure !== false) parts.push("Secure")
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`)
  return parts.join("; ")
}
