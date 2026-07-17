// src/modules/analytics/uptime.test.ts
// Pure logic for uptime monitoring (Workers-Paid feature): HTTP classification,
// rolling fold, and uptime %. The probe + cron walk are best-effort I/O.

import { describe, it, expect } from "vitest"
import { classifyHttp, foldSample, uptimePct } from "./uptime"

describe("classifyHttp", () => {
  it("treats a served response (2xx/3xx/4xx) as up, 5xx + network error as down", () => {
    expect(classifyHttp(200)).toBe("up")
    expect(classifyHttp(301)).toBe("up")
    expect(classifyHttp(404)).toBe("up")   // reachable, just a missing path
    expect(classifyHttp(500)).toBe("down")
    expect(classifyHttp(503)).toBe("down")
    expect(classifyHttp(0)).toBe("down")    // timeout / connection refused
  })
})

describe("foldSample + uptimePct", () => {
  it("accumulates checks and up-count across the day", () => {
    let r = foldSample(null, { up: true, status: 200, latencyMs: 120, at: "t1" })
    r = foldSample(r, { up: true, status: 200, latencyMs: 90, at: "t2" })
    r = foldSample(r, { up: false, status: 503, latencyMs: 0, at: "t3" })
    expect(r.checks).toBe(3)
    expect(r.up).toBe(2)
    expect(r.lastStatus).toBe(503)      // last sample wins for "last…" fields
    expect(uptimePct(r)).toBe(66.7)     // 2/3
  })

  it("reports 100% when there are no checks yet (no false alarm)", () => {
    expect(uptimePct({ checks: 0, up: 0 })).toBe(100)
  })

  it("perfect uptime is 100%", () => {
    let r = foldSample(null, { up: true, status: 200, latencyMs: 50, at: "t" })
    r = foldSample(r, { up: true, status: 200, latencyMs: 50, at: "t" })
    expect(uptimePct(r)).toBe(100)
  })
})
