// src/modules/pseo/generate.test.ts
import { describe, it, expect } from "vitest"
import { parseCsv, renderTemplate, generateBatch, type PseoTemplate } from "./generate"

describe("parseCsv", () => {
  it("parses headers + rows", () => {
    const rows = parseCsv("city,pop\nAustin,961000\nDallas,1300000")
    expect(rows).toEqual([{ city: "Austin", pop: "961000" }, { city: "Dallas", pop: "1300000" }])
  })
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('name,note\n"Smith, John","He said ""hi"""')
    expect(rows[0].name).toBe("Smith, John")
    expect(rows[0].note).toBe('He said "hi"')
  })
  it("returns [] when there are no data rows", () => {
    expect(parseCsv("just,headers")).toEqual([])
    expect(parseCsv("")).toEqual([])
  })
})

describe("renderTemplate", () => {
  it("substitutes {{col}} placeholders, blanks missing columns", () => {
    expect(renderTemplate("Best cafes in {{city}} ({{pop}})", { city: "Austin", pop: "961k" })).toBe("Best cafes in Austin (961k)")
    expect(renderTemplate("{{missing}}!", {})).toBe("!")
  })
})

describe("generateBatch (K2 — gated)", () => {
  const body = (city: string) =>
    `Everything about coffee in ${city}. ` + Array.from({ length: 400 }, (_, i) => `${city}word${i % 30}`).join(" ")
  const template: PseoTemplate = {
    titleTemplate: "Coffee guide for {{city}}",
    metaTemplate: "The complete coffee guide for {{city}}, {{state}}.",
    contentTemplate: "{{body}}",
    slugTemplate: "coffee-{{city}}",
    uniqueDataColumns: ["city", "state", "pop"],
  }

  it("generates one gated page per row; distinct rows pass", () => {
    const csv =
      "city,state,pop,body\n" +
      `Austin,TX,961000,"${body("Austin")}"\n` +
      `Dallas,TX,1300000,"${body("Dallas")}"`
    const r = generateBatch(csv, template, [])
    expect(r.total).toBe(2)
    expect(r.passed).toBe(2)
    expect(r.pages[0].slug).toBe("coffee-austin")
  })

  it("blocks near-duplicate rows (the leash) — 2nd identical body fails unique-content", () => {
    const same = body("Town")
    const csv =
      "city,state,pop,body\n" +
      `Alpha,TX,1,"${same}"\n` +
      `Beta,TX,2,"${same}"`
    const r = generateBatch(csv, template, [])
    expect(r.passed).toBe(1) // first joins corpus, second is a near-duplicate
    expect(r.failed).toBe(1)
    expect(r.pages[1].result.checks.find((c) => c.id === "unique_content")?.passed).toBe(false)
  })

  it("blocks thin rows", () => {
    const csv = "city,state,pop,body\nAustin,TX,961000,short"
    const r = generateBatch(csv, template, [])
    expect(r.failed).toBe(1)
    expect(r.pages[0].result.checks.find((c) => c.id === "word_count")?.passed).toBe(false)
  })

  it("enforces per-page unique data (min 1 forced on)", () => {
    const t2: PseoTemplate = { ...template, uniqueDataColumns: ["nope"] } // column not in CSV
    const csv = "city,state,pop,body\nAustin,TX,961000," + `"${body("Austin")}"`
    const r = generateBatch(csv, t2, [])
    expect(r.pages[0].result.checks.find((c) => c.id === "unique_data")?.passed).toBe(false)
  })
})
