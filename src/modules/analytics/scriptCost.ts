// src/modules/analytics/scriptCost.ts
// Third-party script cost warning (Performance Covenant P7): "This will slow
// your site by ~180ms — add anyway?". Pure estimate — unit-tested. The zero-JS
// gate already blocks arbitrary scripts; this powers the explicit-override UX
// so the wire cost is shown before a customer opts in.

export interface ScriptCostEstimate {
  transferMs: number // download time on a mid-tier mobile connection
  execMs: number     // parse + evaluate
  totalMs: number
  renderBlocking: boolean
  verdict: "cheap" | "noticeable" | "heavy"
}

/**
 * Estimate the wire cost of adding a third-party script.
 * Model (deliberately conservative, mobile-first):
 *  - transfer: bytes over ~1.6 Mbps (Slow 4G) = bytes*8 / 1_600_000 * 1000 ms
 *  - exec:     ~1ms per 1KB of script (parse+compile+run on a mid CPU)
 *  - render-blocking scripts (no defer/async) add their full cost to blocking.
 */
export function estimateScriptCost(bytes: number, opts: { defer?: boolean; async?: boolean } = {}): ScriptCostEstimate {
  const b = Math.max(0, bytes)
  const transferMs = Math.round((b * 8) / 1_600_000 * 1000)
  const execMs = Math.round(b / 1024)
  const renderBlocking = !opts.defer && !opts.async
  const totalMs = transferMs + execMs
  const verdict = totalMs < 50 ? "cheap" : totalMs < 200 ? "noticeable" : "heavy"
  return { transferMs, execMs, totalMs, renderBlocking, verdict }
}

/** Plain-language warning shown in the override UX. */
export function scriptCostWarning(url: string, est: ScriptCostEstimate): string {
  const blocking = est.renderBlocking ? " and it blocks rendering (add `defer` to cut this)" : ""
  return `Adding ${url} will slow your site by about ${est.totalMs}ms for every visitor${blocking}. This breaks the zero-JS speed guarantee — add anyway?`
}
