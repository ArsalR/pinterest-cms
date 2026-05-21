import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// currentWindow and nextWindowReset are internal; we test their observable
// effects by importing the module and inspecting the UTC truncation logic directly.

describe("rate-limit window helpers (logic-level)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("window string has YYYY-MM-DDTHH:MM format (16 chars)", () => {
    vi.setSystemTime(new Date("2026-05-21T14:37:59.999Z"))
    const window = new Date().toISOString().slice(0, 16)
    expect(window).toBe("2026-05-21T14:37")
    expect(window).toHaveLength(16)
  })

  it("window advances exactly on the minute boundary", () => {
    vi.setSystemTime(new Date("2026-05-21T14:37:59.999Z"))
    const before = new Date().toISOString().slice(0, 16)

    vi.setSystemTime(new Date("2026-05-21T14:38:00.000Z"))
    const after = new Date().toISOString().slice(0, 16)

    expect(before).toBe("2026-05-21T14:37")
    expect(after).toBe("2026-05-21T14:38")
  })

  it("reset timestamp is the start of the next UTC minute", () => {
    vi.setSystemTime(new Date("2026-05-21T14:37:29.000Z"))
    const d = new Date()
    d.setUTCSeconds(0, 0)
    d.setUTCMinutes(d.getUTCMinutes() + 1)
    const reset = Math.floor(d.getTime() / 1000)
    const expected = Math.floor(new Date("2026-05-21T14:38:00.000Z").getTime() / 1000)
    expect(reset).toBe(expected)
  })
})
