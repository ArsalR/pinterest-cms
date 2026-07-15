// src/modules/pinterest/pinterest.test.ts
// Pure-logic: OAuth URL + pin payload, and the drip scheduler. The Pinterest
// API I/O (token exchange, createPin) is Phase-10 mocked-integration territory.

import { describe, it, expect } from "vitest"
import { PINTEREST_SCOPES, pinterestAuthUrl, pinPayload } from "./pins"
import { nextSlots, partitionDue, DEFAULT_CADENCE } from "./schedule"

describe("Pinterest OAuth + pin payload", () => {
  it("requests the standard-access scopes", () => {
    expect(PINTEREST_SCOPES).toEqual(expect.arrayContaining(["boards:write", "pins:write", "pins:read"]))
  })

  it("builds a consent URL with comma-joined scopes + state", () => {
    const u = new URL(pinterestAuthUrl("app-1", "https://arsal.app/app/connections/pinterest/callback", "st-9"))
    expect(u.origin + u.pathname).toBe("https://www.pinterest.com/oauth/")
    expect(u.searchParams.get("client_id")).toBe("app-1")
    expect(u.searchParams.get("scope")).toContain("pins:write")
    expect(u.searchParams.get("state")).toBe("st-9")
    expect(u.searchParams.get("response_type")).toBe("code")
  })

  it("caps title at 100 and description at 500 chars", () => {
    const p = pinPayload({
      boardId: "b1",
      title: "T".repeat(200),
      description: "D".repeat(900),
      link: "https://x.com/posts/a/",
      imageUrl: "https://x.com/img.jpg",
    })
    expect((p.title as string).length).toBe(100)
    expect((p.description as string).length).toBe(500)
    expect((p.media_source as { url: string }).url).toBe("https://x.com/img.jpg")
  })
})

describe("drip scheduler", () => {
  const now = Date.parse("2026-07-15T00:00:00Z")
  const MIN = 60_000

  it("spaces new pins by at least minSpacingMins", () => {
    const slots = nextSlots([], 3, now, { perDay: 100, minSpacingMins: 90 })
    expect(slots).toHaveLength(3)
    expect(slots[1] - slots[0]).toBeGreaterThanOrEqual(90 * MIN)
    expect(slots[2] - slots[1]).toBeGreaterThanOrEqual(90 * MIN)
    expect(slots[0]).toBeGreaterThanOrEqual(now)
  })

  it("respects already-queued pins when spacing new ones", () => {
    const existing = [now + 30 * MIN]
    const [first] = nextSlots(existing, 1, now, { perDay: 100, minSpacingMins: 90 })
    expect(first).toBeGreaterThanOrEqual(existing[0] + 90 * MIN)
  })

  it("enforces the rolling-24h perDay cap", () => {
    // perDay=2 → the 3rd pin must land in a new 24h window (> ~a day out).
    const slots = nextSlots([], 3, now, { perDay: 2, minSpacingMins: 60 })
    expect(slots[2] - now).toBeGreaterThan(24 * 60 * MIN)
  })

  it("partitions due vs pending by nowMs", () => {
    const items = [
      { item: "a", scheduledAtMs: now - 1000 },
      { item: "b", scheduledAtMs: now + 1000 },
      { item: "c", scheduledAtMs: now },
    ]
    const { due, pending } = partitionDue(items, now)
    expect(due.map((d) => d.item)).toEqual(["a", "c"]) // sorted, <= now
    expect(pending.map((p) => p.item)).toEqual(["b"])
  })

  it("has sane defaults", () => {
    expect(DEFAULT_CADENCE.perDay).toBeGreaterThan(0)
    expect(DEFAULT_CADENCE.minSpacingMins).toBeGreaterThan(0)
  })
})
