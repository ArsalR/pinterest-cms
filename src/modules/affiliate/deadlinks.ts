// src/modules/affiliate/deadlinks.ts
// Dead-link checking (K10 "weekly dead-link cron"). The classification is pure
// (unit-tested); the actual HTTP probe is best-effort I/O with a short timeout.

export type LinkHealth = "ok" | "dead" | "unknown"

/** Classify an HTTP status (0 = fetch threw / timed out). Pure. */
export function classifyStatus(status: number): LinkHealth {
  if (status === 0) return "unknown"     // network error / blocked — don't cry wolf
  if (status >= 400 && status !== 429) return "dead" // 4xx/5xx = broken (429 is rate-limit, not dead)
  return "ok"
}

export interface LinkCheck {
  url: string
  status: number
  health: LinkHealth
}

/**
 * Probe one link. Tries HEAD, falls back to GET (many affiliate hosts reject
 * HEAD). Best-effort — a thrown/timed-out request classifies as "unknown", not
 * "dead", so transient blips don't spam false reports.
 */
export async function checkLink(url: string, timeoutMs = 8000): Promise<LinkCheck> {
  const probe = async (method: "HEAD" | "GET"): Promise<number> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const resp = await fetch(url, { method, redirect: "follow", signal: ctrl.signal })
      return resp.status
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    let status = await probe("HEAD")
    if (status === 405 || status === 501) status = await probe("GET") // HEAD not allowed
    return { url, status, health: classifyStatus(status) }
  } catch {
    return { url, status: 0, health: "unknown" }
  }
}
