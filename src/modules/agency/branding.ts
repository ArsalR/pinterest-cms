// src/modules/agency/branding.ts
// White-label branding (K11) — PURE resolution + validation, unit-tested. The
// agency sets a brand name / color / logo; client-facing surfaces (the report
// portal, monthly emails) render with it instead of "SiteNetwork". Untrusted
// input is validated here so a bad color or oversized name can never break a
// rendered page.

export interface AgencyBrand {
  name: string
  color: string   // hex, used for accents
  logoUrl: string | null
}

export const DEFAULT_BRAND: AgencyBrand = { name: "SiteNetwork", color: "#fafafa", logoUrl: null }

const HEX = /^#[0-9a-fA-F]{6}$/

export interface BrandSettings {
  enabled?: boolean
  brand_name?: string | null
  brand_color?: string | null
  logo_url?: string | null
}

/**
 * Resolve stored settings into a safe brand. Falls back to defaults for any
 * missing/invalid field. When branding is disabled, always the default. Pure.
 */
export function resolveBrand(settings: BrandSettings | null): AgencyBrand {
  if (!settings?.enabled) return DEFAULT_BRAND
  const name = (settings.brand_name ?? "").trim().slice(0, 40) || DEFAULT_BRAND.name
  const color = settings.brand_color && HEX.test(settings.brand_color) ? settings.brand_color : DEFAULT_BRAND.color
  const logoUrl = validLogo(settings.logo_url)
  return { name, color, logoUrl }
}

/** Only allow an https image URL as a logo (blocks javascript:/data: injection). Pure. */
export function validLogo(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    return u.protocol === "https:" ? u.toString() : null
  } catch {
    return null
  }
}

/** Validate a proposed brand for the settings form. Pure. */
export function validateBrand(name: string, color: string, logoUrl: string): { ok: true } | { ok: false; problem: string } {
  if (name.trim().length === 0) return { ok: false, problem: "Give your brand a name." }
  if (name.trim().length > 40) return { ok: false, problem: "Brand name is too long (max 40 characters)." }
  if (color && !HEX.test(color)) return { ok: false, problem: "Brand color must be a hex value like #2563eb." }
  if (logoUrl && validLogo(logoUrl) === null) return { ok: false, problem: "Logo must be an https:// image URL." }
  return { ok: true }
}
