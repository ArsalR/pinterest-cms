// src/lib/defaults.ts
// Default settings for a brand-new site. Written into the `settings` table
// on provisioning so every key is editable from /admin/* without code changes.

import type { Client } from "@libsql/client/web"

export interface DefaultSettingsInput {
  hostname: string
  siteName: string
  adminEmail?: string
}

export function buildDefaultSettings(input: DefaultSettingsInput): Record<string, string> {
  return {
    // SITE
    site_name: input.siteName,
    site_tagline: "A visual storytelling blog",
    site_url: `https://${input.hostname}`,
    admin_email: input.adminEmail ?? "",
    site_logo: "",
    site_favicon: "",
    site_og_image: "",

    // READING
    homepage_type: "latest",
    homepage_static_slug: "",
    custom_404_slug: "",
    posts_per_page: "24",

    // PERMALINK
    permalink_structure: "/%slug%/",
    category_base: "",

    // THEME — colors
    theme_primary_color: "#e60023",
    theme_secondary_color: "#111111",
    theme_accent_color: "#e60023",
    theme_background_color: "#f0f0f0",
    theme_surface_color: "#ffffff",
    theme_text_color: "#111111",
    theme_text_muted_color: "#767676",
    theme_border_color: "#e0e0e0",

    // THEME — typography
    theme_heading_font: "Playfair Display",
    theme_body_font: "DM Sans",
    theme_font_size_base: "16px",
    theme_line_height: "1.7",

    // THEME — layout
    theme_border_radius: "16px",
    theme_container_width: "1200px",
    theme_header_layout: "split",
    theme_footer_layout: "columns",

    // THEME — grid & cards
    theme_grid_columns: "auto",
    theme_card_style: "rounded",
    theme_pin_hover_effect: "slide-up",

    // THEME — display options
    theme_show_post_dates: "true",
    theme_show_author: "true",
    theme_show_reading_time: "true",
    theme_show_category_badge: "true",
    theme_show_excerpt: "true",
    theme_show_image_count: "true",
    theme_show_share_buttons: "true",
    theme_show_related_posts: "true",
    theme_enable_lightbox: "true",

    // THEME — custom
    theme_custom_css: "",

    // SEO
    seo_site_name: input.siteName,
    seo_default_title: input.siteName,
    seo_title_separator: "|",
    seo_default_description: "",
    seo_default_og_image: "",
    seo_twitter_handle: "",
    seo_google_verification: "",
    seo_bing_verification: "",
    seo_robots_default: "index,follow",
  }
}

/** Insert default settings, skipping any keys that already exist. */
export async function insertDefaultSettings(
  siteDb: Client,
  input: DefaultSettingsInput
): Promise<void> {
  const settings = buildDefaultSettings(input)
  for (const [key, value] of Object.entries(settings)) {
    await siteDb.execute({
      sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)",
      args: [key, value],
    })
  }
}

/** Fetch all settings as a plain object. */
export async function loadSettings(siteDb: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const rows = await siteDb.execute("SELECT key, value FROM settings")
  for (const r of rows.rows) {
    out[r.key as string] = (r.value as string) ?? ""
  }
  return out
}

/** Upsert a single settings key. */
export async function setSetting(
  siteDb: Client,
  key: string,
  value: string
): Promise<void> {
  await siteDb.execute({
    sql: `INSERT INTO settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  })
}
