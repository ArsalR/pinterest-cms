// src/modules/cloning/clone.ts
// Site cloning (K6) — PURE helpers, unit-tested. A clone is a brand-new,
// fully-independent site (its own repo, DB, domain) seeded from an existing
// one's kind + niche, then re-themed and re-seeded by Claude so it isn't a
// carbon copy (duplicate content is a ranking risk — the whole point is a
// *distinct* sibling). This file just builds the derived config + the genesis
// prompt; the service layer drives the actual provisioning.

export interface CloneInput {
  domain: string
  zoneId: string
  name: string
  niche: string
  angle: string // how this clone should differ (audience, region, sub-topic, tone)
}

/** Suggest a name for a clone from the source name. Pure. */
export function deriveCloneName(sourceName: string): string {
  return `${sourceName} (clone)`.slice(0, 80)
}

/**
 * Build the re-theme / re-seed genesis prompt for a clone. It tells Claude this
 * is a sibling of an existing site and MUST be visually and editorially
 * distinct — a different palette/layout and original articles for the new
 * angle — so the two never compete as duplicates. Pure — unit-tested.
 */
export function buildClonePrompt(sourceNiche: string, input: CloneInput, kind: string): string {
  return [
    `Create a ${kind} site called "${input.name}" about: ${input.niche}.`,
    `This is a CLONE spun off from an existing site in the "${sourceNiche}" space, so it must be clearly DISTINCT — not a copy.`,
    `Differentiating angle: ${input.angle}.`,
    `Re-theme it: choose a different color palette, typography feel, and homepage layout from a typical site in this niche.`,
    `Re-seed it: write 10 original seed articles for this specific angle — do NOT reuse the source site's article topics or wording. Create each item as a DRAFT (published: false) — it will pass through the quality gate in the dashboard before going live.`,
    `Keep all the standard trust pages, SEO files, and structured data.`,
  ].join("\n")
}
