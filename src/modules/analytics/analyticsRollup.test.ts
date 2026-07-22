import { describe, it, expect } from "vitest"
import {
  buildBeaconQuery, aggregateBeaconRows, parseAeResponse, previousUtcDay,
  type BeaconRow,
} from "./analyticsRollup"

describe("buildBeaconQuery", () => {
  it("scopes to the site index and a single UTC day, and escapes quotes", () => {
    const sql = buildBeaconQuery("site_beacon", "s'1", "2026-07-21")
    expect(sql).toContain("FROM site_beacon")
    expect(sql).toContain("index1 = 's''1'")
    expect(sql).toContain("toDateTime('2026-07-21 00:00:00')")
    expect(sql).toContain("INTERVAL '1' DAY")
    expect(sql).toContain("GROUP BY t, p, r, a")
  })
})

describe("previousUtcDay", () => {
  it("returns the day before, in UTC", () => {
    const ms = Date.UTC(2026, 6, 22, 4, 0, 0) // 2026-07-22 04:00 UTC
    expect(previousUtcDay(ms)).toBe("2026-07-21")
  })
})

describe("parseAeResponse", () => {
  it("maps AE rows into typed BeaconRows and tolerates junk", () => {
    const rows = parseAeResponse({ data: [{ t: "pv", p: "/", r: "", a: "", n: 5, secs: 0 }, null] })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ t: "pv", p: "/", r: "", a: "", n: 5, secs: 0 })
    expect(rows[1].t).toBe("")
    expect(parseAeResponse({})).toEqual([])
    expect(parseAeResponse("nope")).toEqual([])
  })
})

describe("aggregateBeaconRows", () => {
  const rows: BeaconRow[] = [
    { t: "pv", p: "/", r: "https://google.com", a: "", n: 10, secs: 0 },
    { t: "pv", p: "/blog/", r: "https://google.com", a: "", n: 4, secs: 0 },
    { t: "pv", p: "/blog/", r: "", a: "", n: 6, secs: 0 },
    { t: "sd", p: "/", r: "", a: "50", n: 8, secs: 0 },
    { t: "sd", p: "/", r: "", a: "100", n: 3, secs: 0 },
    { t: "cl", p: "/", r: "", a: "cta:whatsapp", n: 2, secs: 0 },
    { t: "ob", p: "/", r: "", a: "partner.com", n: 5, secs: 0 },
    { t: "te", p: "/", r: "", a: "", n: 7, secs: 210 },
  ]

  it("sums views and ranks paths + referrers", () => {
    const day = aggregateBeaconRows(rows)
    expect(day.views).toBe(20)
    // tie at 10 views each; stable sort preserves first-seen order (/ before /blog/)
    expect(day.paths).toEqual([
      { path: "/", views: 10 },
      { path: "/blog/", views: 10 },
    ])
    // referrers only count page views that carried an origin
    expect(day.referrers).toEqual([{ origin: "https://google.com", views: 14 }])
  })

  it("buckets scroll depth, clicks, outbound, and engagement", () => {
    const day = aggregateBeaconRows(rows)
    expect(day.scroll).toEqual({ "25": 0, "50": 8, "75": 0, "100": 3 })
    expect(day.clicks).toEqual([{ label: "cta:whatsapp", count: 2 }])
    expect(day.outbound).toEqual([{ host: "partner.com", count: 5 }])
    expect(day.engagedSamples).toBe(7)
    expect(day.engagedSecondsTotal).toBe(210)
  })

  it("ignores non-positive counts", () => {
    const day = aggregateBeaconRows([{ t: "pv", p: "/", r: "", a: "", n: 0, secs: 0 }])
    expect(day.views).toBe(0)
    expect(day.paths).toEqual([])
  })
})
