// src/modules/pinterest/schedule.ts
// Pure drip-schedule maths for Pinterest (K7 — "auto-pin on a drip schedule").
// Pinterest penalizes bursts, so new pins are spaced out: at most `perDay`, no
// closer than `minSpacingMins`. All functions are pure and unit-tested; the
// caller injects `nowMs` and the existing queue so there's no hidden clock.

export interface PinCadence {
  perDay: number         // max pins scheduled per rolling 24h
  minSpacingMins: number // minimum gap between consecutive pins
}

export const DEFAULT_CADENCE: PinCadence = { perDay: 5, minSpacingMins: 90 }

const MIN_MS = 60_000
const DAY_MS = 86_400_000

/**
 * Given the timestamps (ms) of pins already queued and `count` new pins to add,
 * return the timestamps for the new pins — each at least `minSpacingMins` after
 * the previous, and never exceeding `perDay` within any rolling 24h window.
 * Scheduling starts no earlier than `nowMs`. Pure.
 */
export function nextSlots(existingMs: number[], count: number, nowMs: number, cadence: PinCadence = DEFAULT_CADENCE): number[] {
  const spacing = Math.max(1, cadence.minSpacingMins) * MIN_MS
  const perDay = Math.max(1, cadence.perDay)
  const all = [...existingMs].sort((a, b) => a - b)
  const out: number[] = []

  for (let i = 0; i < count; i++) {
    // Earliest by spacing: one gap after the last scheduled pin (or now).
    const last = all.length ? all[all.length - 1] : nowMs - spacing
    let candidate = Math.max(nowMs, last + spacing)
    // Enforce the rolling-24h cap: if the trailing 24h already holds `perDay`
    // pins, push the candidate just past the oldest of that window.
    // Loop because pushing forward can bring a different window into view.
    for (;;) {
      const windowStart = candidate - DAY_MS
      const inWindow = all.filter((t) => t > windowStart && t <= candidate)
      if (inWindow.length < perDay) break
      // Move to just after the (perDay-th-from-top) pin leaves the window.
      const sorted = inWindow.sort((a, b) => a - b)
      candidate = sorted[sorted.length - perDay] + DAY_MS + spacing
    }
    out.push(candidate)
    all.push(candidate)
    all.sort((a, b) => a - b)
  }
  return out
}

export interface Scheduled<T> {
  item: T
  scheduledAtMs: number
}

/** Partition scheduled items into those due now and those still pending. Pure. */
export function partitionDue<T>(items: Array<Scheduled<T>>, nowMs: number): { due: Array<Scheduled<T>>; pending: Array<Scheduled<T>> } {
  const due: Array<Scheduled<T>> = []
  const pending: Array<Scheduled<T>> = []
  for (const it of items) {
    if (it.scheduledAtMs <= nowMs) due.push(it)
    else pending.push(it)
  }
  due.sort((a, b) => a.scheduledAtMs - b.scheduledAtMs)
  return { due, pending }
}
