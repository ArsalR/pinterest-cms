// src/modules/seo/optimize.ts
// V1.5 M6 — the per-page Optimization Report. ONE panel that answers "is this
// page fully optimized?" by composing the existing pure analyzers (SEO content,
// AEO/AI-visibility, image alt) with the site-level facts (speed budget, local
// schema, index status) into a single graded list, each check linked to the
// tool that fixes it. This is the assurance surface; the quality gate remains
// the enforcement. Pure — no I/O, unit-tested.

import { analyzeContent } from "./content"
import { imagesMissingAlt } from "./content"
import { analyzeAiVisibility } from "./aeo"

export type OptStatus = "good" | "warn" | "bad"

export interface OptFix {
  label: string
  href: string
}
export interface OptCheck {
  id: string
  label: string
  status: OptStatus
  detail: string
  /** The tool that fixes this check (absent when already good / nothing to do). */
  fix?: OptFix
}
export interface OptSection {
  key: string
  title: string
  checks: OptCheck[]
}
export interface OptimizationReport {
  sections: OptSection[]
  counts: { good: number; warn: number; bad: number }
  /** 0..100 — share of checks that are green, lightly penalizing amber. */
  score: number
  /** True when nothing is red — the page clears every hard check. */
  allClear: boolean
}

/** Per-tool destination links, supplied by the caller (dashboard, site-scoped). */
export interface OptTools {
  seo: string // the SEO cockpit for this post
  aeo: string // AI-visibility hub / cockpit AEO section
  images: string // image SEO tool
  speed: string // site scripts / performance
  local: string // local business hub
  indexing: string // indexing ops
}

export interface OptimizeInput {
  title: string
  metaDescription: string
  excerpt: string
  content: string
  focusKeyword?: string
  hasAuthor: boolean
  updatedAt: string | null
  /** Current time (ms) — passed in to keep this pure/deterministic. */
  nowMs: number
  /** Active SEO profiles (drives which sections apply). */
  profiles: string[]
  /** Site-level facts the per-post analyzers can't see. */
  site: {
    /** Third-party script budget passes (Performance covenant). */
    speedOk: boolean
    speedDetail: string
    /** Local profile: is the business info (NAP) configured? undefined when n/a. */
    localConfigured?: boolean
    /** Index status from GSC/inspection: "indexed" | "not-indexed" | "unknown". */
    indexStatus?: "indexed" | "not-indexed" | "unknown"
  }
  tools: OptTools
}

function fix(label: string, href: string): OptFix {
  return { label, href }
}

/** Build the unified per-page optimization report. Pure. */
export function buildOptimizationReport(input: OptimizeInput): OptimizationReport {
  const sections: OptSection[] = []

  // 1. Search (SEO) — reuse the exact cockpit/gate analyzer.
  const content = analyzeContent({
    title: input.title,
    metaDescription: input.metaDescription || input.excerpt,
    content: input.content,
    focusKeyword: input.focusKeyword,
  })
  sections.push({
    key: "seo",
    title: "Search (Google)",
    checks: content.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      detail: c.detail,
      fix: c.status === "good" ? undefined : fix("Edit SEO", input.tools.seo),
    })),
  })

  // 2. AI answer engines (AEO/GEO) — always on from M6 (AEO baseline), but only
  //    show when the profile is active so we honour an explicit opt-out.
  if (input.profiles.includes("ai")) {
    const aiChecks = analyzeAiVisibility({
      title: input.title,
      excerpt: input.excerpt,
      content: input.content,
      hasAuthor: input.hasAuthor,
      updatedAt: input.updatedAt,
      nowMs: input.nowMs,
    })
    sections.push({
      key: "aeo",
      title: "AI answer engines",
      checks: aiChecks.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        detail: c.detail,
        fix: c.status === "good" ? undefined : fix("Improve quotability", input.tools.aeo),
      })),
    })
  }

  // 3. Images — alt text (image SEO + accessibility).
  const missingAlt = imagesMissingAlt(input.content)
  sections.push({
    key: "images",
    title: "Images",
    checks: [
      {
        id: "image_alt",
        label: "Descriptive alt text",
        status: missingAlt === 0 ? "good" : missingAlt <= 2 ? "warn" : "bad",
        detail: missingAlt === 0 ? "every image has alt text" : `${missingAlt} image${missingAlt === 1 ? "" : "s"} missing alt text`,
        fix: missingAlt === 0 ? undefined : fix("Fix image SEO", input.tools.images),
      },
    ],
  })

  // 4. Speed — the site's third-party script budget (covenant). Site-level.
  sections.push({
    key: "speed",
    title: "Speed",
    checks: [
      {
        id: "speed_budget",
        label: "Performance budget",
        status: input.site.speedOk ? "good" : "bad",
        detail: input.site.speedDetail,
        fix: input.site.speedOk ? undefined : fix("Review scripts", input.tools.speed),
      },
    ],
  })

  // 5. Local schema — only when the Local profile is active.
  if (input.profiles.includes("local")) {
    const ok = input.site.localConfigured === true
    sections.push({
      key: "local",
      title: "Local business",
      checks: [
        {
          id: "local_nap",
          label: "Business info & LocalBusiness schema",
          status: ok ? "good" : "warn",
          detail: ok ? "name, address, phone and hours are set" : "add your business name, address, phone and hours",
          fix: ok ? undefined : fix("Complete local info", input.tools.local),
        },
      ],
    })
  }

  // 6. Indexing status — from GSC/inspection when available.
  const idx = input.site.indexStatus ?? "unknown"
  sections.push({
    key: "indexing",
    title: "Indexing",
    checks: [
      {
        id: "index_status",
        label: "Indexed by Google",
        status: idx === "indexed" ? "good" : idx === "not-indexed" ? "warn" : "warn",
        detail:
          idx === "indexed"
            ? "this URL is in Google's index"
            : idx === "not-indexed"
              ? "not yet indexed — request indexing"
              : "index status not checked yet",
        fix: idx === "indexed" ? undefined : fix("Open indexing", input.tools.indexing),
      },
    ],
  })

  // Tally + score.
  let good = 0, warn = 0, bad = 0
  for (const s of sections) for (const c of s.checks) {
    if (c.status === "good") good++
    else if (c.status === "warn") warn++
    else bad++
  }
  const total = good + warn + bad
  const score = total === 0 ? 100 : Math.round(((good + warn * 0.5) / total) * 100)
  return { sections, counts: { good, warn, bad }, score, allClear: bad === 0 }
}
