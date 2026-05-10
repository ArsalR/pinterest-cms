// src/lib/types.ts
// Shared types used across the codebase.

import type { Client as LibSQLClient } from "@libsql/client/web"

export interface CloudflareEnv {
  // R2
  R2_BUCKET: R2Bucket
  R2_PUBLIC_URL: string

  // Turso master
  TURSO_MASTER_URL: string
  TURSO_MASTER_TOKEN: string

  // Turso provisioning
  TURSO_ORG: string
  TURSO_GROUP: string
  TURSO_API_TOKEN: string

  // Cloudflare API (for cache purge + DNS automation)
  CF_API_TOKEN: string
  CF_ZONE_ID: string
  CF_ACCOUNT_ID: string

  // Auth secrets
  JWT_SECRET: string
  NETWORK_ADMIN_KEY: string
  SESSION_COOKIE_NAME: string

  // Network admin
  NETWORK_ADMIN_HOSTNAME: string

  // Schema bootstrap
  SITE_SCHEMA_URL: string
}

export interface SiteConfig {
  id: string
  hostname: string
  name: string
  turso_url: string
  turso_token: string
  active: number
  created_at: string
}

export interface HonoVariables {
  site: SiteConfig
  siteDb: LibSQLClient
  hostname: string
  user?: { id: string; email: string; role: string }
  apiKeyId?: string
}

export type AppEnv = {
  Bindings: CloudflareEnv
  Variables: HonoVariables
}

export interface Post {
  id: string
  title: string
  slug: string
  content: string
  excerpt: string | null
  cover_image: string | null
  published: number
  published_at: string | null
  type: string
  category_id: string | null
  source: string
  seo_title: string | null
  seo_description: string | null
  seo_keywords: string | null
  og_title: string | null
  og_description: string | null
  og_image: string | null
  twitter_card: string | null
  canonical_url: string | null
  no_index: number
  structured_data: string | null
  created_at: string
  updated_at: string
}

export interface Category {
  id: string
  name: string
  slug: string
  description: string | null
  cover_image: string | null
  seo_title: string | null
  seo_desc: string | null
  created_at: string
}

export interface MenuItem {
  id: string
  label: string
  post_id: string | null
  url: string | null
  ord: number
  location: string
  parent_id: string | null
  created_at: string
}

export interface MediaFile {
  id: string
  url: string
  filename: string
  size: number
  width: number | null
  height: number | null
  alt: string | null
  caption: string | null
  source: string
  r2_key: string | null
  created_at: string
}

export interface ApiKey {
  id: string
  name: string
  key_hash: string
  key_preview: string
  permissions: string
  last_used_at: string | null
  usage_count: number
  active: number
  created_at: string
}

export type Settings = Record<string, string>
