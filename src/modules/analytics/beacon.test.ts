import { describe, it, expect } from "vitest"
import { parseBeaconEvent, beaconDataPoint, BEACON_EVENT_TYPES } from "./beacon"

describe("parseBeaconEvent", () => {
  it("accepts a page view and blanks its attribute", () => {
    const ev = parseBeaconEvent({ s: "tok", t: "pv", p: "/blog/post/", r: "https://google.com/search?q=x", a: "ignored" })
    expect(ev).toEqual({ s: "tok", t: "pv", p: "/blog/post/", r: "https://google.com", a: "" })
  })

  it("keeps only the referrer ORIGIN, never the full URL", () => {
    const ev = parseBeaconEvent({ s: "tok", t: "pv", p: "/", r: "https://news.example.com/a/b?utm=1#frag" })
    expect(ev?.r).toBe("https://news.example.com")
  })

  it("strips query + fragment from the path and enforces a leading slash", () => {
    const ev = parseBeaconEvent({ s: "tok", t: "pv", p: "blog/x?ref=1#top" })
    expect(ev?.p).toBe("/blog/x")
  })

  it("rejects unknown event types", () => {
    expect(parseBeaconEvent({ s: "tok", t: "xx", p: "/" })).toBeNull()
    for (const t of BEACON_EVENT_TYPES) {
      expect(parseBeaconEvent({ s: "tok", t, p: "/", a: t === "sd" ? "50" : t === "ob" ? "x.com" : t === "te" ? "10" : "" })).not.toBeNull()
    }
  })

  it("requires a token", () => {
    expect(parseBeaconEvent({ s: "", t: "pv", p: "/" })).toBeNull()
    expect(parseBeaconEvent({ t: "pv", p: "/" })).toBeNull()
  })

  it("only allows the four scroll buckets", () => {
    expect(parseBeaconEvent({ s: "t", t: "sd", p: "/", a: "50" })?.a).toBe("50")
    expect(parseBeaconEvent({ s: "t", t: "sd", p: "/", a: "63" })).toBeNull()
    expect(parseBeaconEvent({ s: "t", t: "sd", p: "/", a: "" })).toBeNull()
  })

  it("clamps time-engaged to a non-negative bounded integer", () => {
    expect(parseBeaconEvent({ s: "t", t: "te", p: "/", a: "42" })?.a).toBe("42")
    expect(parseBeaconEvent({ s: "t", t: "te", p: "/", a: "999999" })?.a).toBe("86400")
    expect(parseBeaconEvent({ s: "t", t: "te", p: "/", a: "-3" })).toBeNull()
    expect(parseBeaconEvent({ s: "t", t: "te", p: "/", a: "abc" })).toBeNull()
  })

  it("accepts only hostname-shaped outbound attributes, lowercased", () => {
    expect(parseBeaconEvent({ s: "t", t: "ob", p: "/", a: "External.COM" })?.a).toBe("external.com")
    expect(parseBeaconEvent({ s: "t", t: "ob", p: "/", a: "not a host!" })).toBeNull()
  })

  it("rejects non-http referrers and non-object payloads", () => {
    expect(parseBeaconEvent({ s: "t", t: "pv", p: "/", r: "javascript:alert(1)" })?.r).toBe("")
    expect(parseBeaconEvent(null)).toBeNull()
    expect(parseBeaconEvent("nope")).toBeNull()
  })
})

describe("beaconDataPoint", () => {
  it("indexes on the site and carries dimensions as blobs", () => {
    const dp = beaconDataPoint("site-1", { s: "tok", t: "pv", p: "/x", r: "https://a.com", a: "" })
    expect(dp.indexes).toEqual(["site-1"])
    expect(dp.blobs).toEqual(["pv", "/x", "https://a.com", ""])
    expect(dp.doubles).toEqual([1, 0])
  })

  it("records engaged seconds in double2 for te events", () => {
    const dp = beaconDataPoint("s", { s: "t", t: "te", p: "/", r: "", a: "30" })
    expect(dp.doubles).toEqual([1, 30])
  })
})
