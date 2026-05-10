// src/lib/theme.ts
// Theme CSS variables driven entirely from the per-site settings table.
// No hardcoded colors / fonts / sizes anywhere in the frontend — all
// values flow through these helpers.

import type { Settings } from "./types"

/** Generate the inline CSS variable block for a site's theme. */
export function getThemeCssVars(s: Settings): string {
  const cardShadow =
    s.theme_card_style === "floating"
      ? "0 8px 30px rgba(0,0,0,0.12)"
      : s.theme_card_style === "outlined"
      ? "0 0 0 1px var(--color-border)"
      : s.theme_card_style === "sharp"
      ? "0 1px 3px rgba(0,0,0,0.06)"
      : "0 2px 8px rgba(0,0,0,0.08)"

  const radius =
    s.theme_card_style === "sharp" ? "0px" : s.theme_border_radius || "16px"

  return `
    --color-primary: ${s.theme_primary_color ?? "#e60023"};
    --color-secondary: ${s.theme_secondary_color ?? "#111111"};
    --color-accent: ${s.theme_accent_color ?? "#e60023"};
    --color-bg: ${s.theme_background_color ?? "#f0f0f0"};
    --color-surface: ${s.theme_surface_color ?? "#ffffff"};
    --color-text: ${s.theme_text_color ?? "#111111"};
    --color-muted: ${s.theme_text_muted_color ?? "#767676"};
    --color-border: ${s.theme_border_color ?? "#e0e0e0"};
    --font-heading: '${(s.theme_heading_font ?? "Playfair Display").replace(/'/g, "")}', serif;
    --font-body: '${(s.theme_body_font ?? "DM Sans").replace(/'/g, "")}', sans-serif;
    --font-size-base: ${s.theme_font_size_base ?? "16px"};
    --line-height: ${s.theme_line_height ?? "1.7"};
    --radius: ${radius};
    --container-width: ${s.theme_container_width ?? "1200px"};
    --grid-columns: ${s.theme_grid_columns ?? "auto"};
    --card-shadow: ${cardShadow};
  `.trim()
}

/** Map of theme settings, used by the customizer's postMessage updater. */
export function themeSettingsToVars(s: Settings): Record<string, string> {
  const block = getThemeCssVars(s)
  const out: Record<string, string> = {}
  for (const line of block.split(";")) {
    const m = line.match(/--([a-z0-9-]+):\s*(.+)$/i)
    if (m) out[`--${m[1]}`] = m[2].trim()
  }
  return out
}

/** Build the Google Fonts <link> URL for the site's selected fonts. */
export function buildGoogleFontsUrl(s: Settings): string {
  const heading = (s.theme_heading_font || "Playfair Display").trim()
  const body = (s.theme_body_font || "DM Sans").trim()
  const families = new Set<string>()
  families.add(`${heading.replace(/ /g, "+")}:wght@400;500;600;700;800`)
  if (body !== heading) {
    families.add(`${body.replace(/ /g, "+")}:wght@400;500;600;700`)
  }
  return `https://fonts.googleapis.com/css2?${[...families]
    .map((f) => `family=${f}`)
    .join("&")}&display=swap`
}

/** Curated Google Fonts list for the typography picker. */
export const GOOGLE_FONTS: string[] = [
  "Playfair Display",
  "DM Sans",
  "Inter",
  "Lora",
  "Merriweather",
  "Source Serif 4",
  "Crimson Pro",
  "Cormorant Garamond",
  "EB Garamond",
  "Libre Baskerville",
  "Libre Caslon Text",
  "Bricolage Grotesque",
  "Space Grotesk",
  "Manrope",
  "Plus Jakarta Sans",
  "Outfit",
  "Be Vietnam Pro",
  "Public Sans",
  "Karla",
  "Work Sans",
  "Roboto Slab",
  "Bitter",
  "Vollkorn",
  "Spectral",
  "Fraunces",
  "Newsreader",
  "Bodoni Moda",
  "DM Serif Display",
  "DM Serif Text",
  "Cardo",
  "Yrsa",
  "Marcellus",
  "Italiana",
  "Forum",
  "Cinzel",
  "Cormorant",
  "Tenor Sans",
  "Quattrocento",
  "Domine",
  "Rozha One",
  "Big Shoulders Display",
  "Archivo",
  "Archivo Narrow",
  "Barlow",
  "Mulish",
  "Nunito",
  "Nunito Sans",
  "Montserrat",
  "Raleway",
  "Poppins",
  "Lato",
  "Open Sans",
  "Roboto",
  "Source Sans 3",
  "Geist",
  "Geist Mono",
  "JetBrains Mono",
  "IBM Plex Sans",
  "IBM Plex Serif",
  "IBM Plex Mono",
  "Syne",
  "Unbounded",
  "Anton",
  "Oswald",
  "Bebas Neue",
  "Abril Fatface",
  "Lobster",
  "Pacifico",
  "Caveat",
  "Dancing Script",
]

/** Curated palette presets for the colors customizer. */
export interface PalettePreset {
  id: string
  name: string
  vars: Record<string, string>
}
export const PALETTE_PRESETS: PalettePreset[] = [
  {
    id: "pinterest-red",
    name: "Pinterest Red",
    vars: {
      theme_primary_color: "#e60023",
      theme_secondary_color: "#111111",
      theme_accent_color: "#e60023",
      theme_background_color: "#f0f0f0",
      theme_surface_color: "#ffffff",
      theme_text_color: "#111111",
      theme_text_muted_color: "#767676",
      theme_border_color: "#e0e0e0",
    },
  },
  {
    id: "nordic",
    name: "Nordic",
    vars: {
      theme_primary_color: "#1f3a5f",
      theme_secondary_color: "#0e1a2b",
      theme_accent_color: "#4a6fa5",
      theme_background_color: "#f5f7fa",
      theme_surface_color: "#ffffff",
      theme_text_color: "#0e1a2b",
      theme_text_muted_color: "#5b6b80",
      theme_border_color: "#dde3eb",
    },
  },
  {
    id: "terracotta",
    name: "Terracotta",
    vars: {
      theme_primary_color: "#c8553d",
      theme_secondary_color: "#3d2c2e",
      theme_accent_color: "#dba159",
      theme_background_color: "#faf3eb",
      theme_surface_color: "#ffffff",
      theme_text_color: "#3d2c2e",
      theme_text_muted_color: "#7a6b67",
      theme_border_color: "#ead8c5",
    },
  },
  {
    id: "midnight",
    name: "Midnight",
    vars: {
      theme_primary_color: "#fbbf24",
      theme_secondary_color: "#fafafa",
      theme_accent_color: "#f59e0b",
      theme_background_color: "#0a0a0a",
      theme_surface_color: "#171717",
      theme_text_color: "#fafafa",
      theme_text_muted_color: "#a3a3a3",
      theme_border_color: "#262626",
    },
  },
  {
    id: "sage",
    name: "Sage",
    vars: {
      theme_primary_color: "#5d7a5b",
      theme_secondary_color: "#2e3a2c",
      theme_accent_color: "#a8b89e",
      theme_background_color: "#f3f6f1",
      theme_surface_color: "#ffffff",
      theme_text_color: "#2e3a2c",
      theme_text_muted_color: "#6b7868",
      theme_border_color: "#dde3d8",
    },
  },
  {
    id: "warm-cream",
    name: "Warm Cream",
    vars: {
      theme_primary_color: "#a05c2c",
      theme_secondary_color: "#3a2814",
      theme_accent_color: "#d4a574",
      theme_background_color: "#fdf6ec",
      theme_surface_color: "#ffffff",
      theme_text_color: "#3a2814",
      theme_text_muted_color: "#8a7560",
      theme_border_color: "#ebe0cf",
    },
  },
]

/** Render the live <style> tag for a site's theme + custom CSS. */
export function renderThemeStyleTag(s: Settings): string {
  // Strip any `</style` sequences so a malicious admin-stored value can't break out.
  const customCss = (s.theme_custom_css || "")
    .replace(/<\/\s*style/gi, "<\\/style")
    .trim()
  return `<style id="cms-theme">
:root {
${getThemeCssVars(s)}
}
${customCss}
</style>`
}
