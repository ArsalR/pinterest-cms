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

  // Feature flags — set to "1" to enable, unset/empty to disable.
  FEATURE_IDEMPOTENCY?: string
  FEATURE_WEBHOOKS?: string
  FEATURE_RATE_LIMIT?: string
  FEATURE_BATCH_POSTS?: string
  GC_ENABLED?: string
  // Optional tuning — defaults applied in code if absent.
  RATE_LIMIT_RPM?: string   // requests per minute per API key (default 60)

  // SaaS layer (saas_mode) — inert unless SAAS_MODE = "1".
  SAAS_MODE?: string           // "1" to enable the SaaS dashboard + API
  SAAS_APP_HOSTNAME?: string   // dashboard hostname (arsal.app); www.<host> 301s to apex
  SAAS_JWT_SECRET?: string     // secret — customer session JWTs (separate from tenant JWT_SECRET)
  RESEND_API_KEY?: string      // secret — transactional email; unset = dev logging mode
  SAAS_PBKDF2_ITERATIONS?: string // work factor for customer hashes (default 100000);
                                  // raising it strengthens hashes lazily on next login
  // Phase 2 — connections wizard.
  VAULT_MASTER_KEY?: string       // secret — hex(>=32 bytes); per-tenant HKDF root for the credential vault
  GITHUB_APP_ID?: string          // secret — platform GitHub App id (GITHUB_APP_SETUP.md)
  GITHUB_APP_PRIVATE_KEY?: string // secret — App private key, PKCS#8 PEM
  GITHUB_APP_SLUG?: string        // var — app slug for the install URL
  // Phase 3 — provisioning.
  SAAS_TEMPLATE_REPO?: string     // var — template repo (default ArsalR/site-template)
  SAAS_CMS_HOST_SUFFIX?: string   // var — per-site CMS hostname suffix (default cms.arsal.app)
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
  settings?: Record<string, string>
  user?: { id: string; email: string; role: string }
  apiKeyId?: string
  // SaaS layer — set by requireCustomer() on SAAS_APP_HOSTNAME requests only.
  customer?: import("./saas/customers").Customer
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
  scheduled_at: string | null
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
