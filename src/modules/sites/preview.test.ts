// src/modules/sites/preview.test.ts
// Pure: the preview-worker URL derivation. GitHub PR merge/close + CF subdomain
// lookup are best-effort I/O (mocked-client tests cover the API layer).

import { describe, it, expect } from "vitest"
import { previewWorkersUrl } from "./preview"

describe("previewWorkersUrl", () => {
  it("derives the throwaway preview worker's workers.dev URL", () => {
    expect(previewWorkersUrl("acme", "site-brewcraft")).toBe("https://site-brewcraft-preview.acme.workers.dev")
  })
})
