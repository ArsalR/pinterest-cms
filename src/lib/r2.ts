// src/lib/r2.ts
// Cloudflare R2 storage helpers. All sites share one bucket,
// keys namespaced by hostname: uploads/{hostname}/{timestamp}-{filename}

import type { CloudflareEnv } from "./types"
import { sanitizeFilename } from "./utils"

export interface UploadResult {
  url: string
  key: string
}

/** Upload bytes to R2 and return the public URL + storage key. */
export async function uploadToR2(
  env: CloudflareEnv,
  hostname: string,
  filename: string,
  body: ArrayBuffer | Uint8Array,
  mimeType: string
): Promise<UploadResult> {
  const safe = sanitizeFilename(filename)
  const key = `uploads/${hostname}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safe}`

  await env.R2_BUCKET.put(key, body, {
    httpMetadata: { contentType: mimeType },
    customMetadata: {
      hostname,
      originalFilename: filename.slice(0, 255),
      uploadedAt: new Date().toISOString(),
    },
  })

  return { url: `${env.R2_PUBLIC_URL}/${key}`, key }
}

/** Delete an object by R2 key. Idempotent. */
export async function deleteFromR2(env: CloudflareEnv, key: string): Promise<void> {
  await env.R2_BUCKET.delete(key).catch(() => {})
}

/** Convert a public URL back to its storage key (best-effort). */
export function r2KeyFromUrl(env: CloudflareEnv, url: string): string | null {
  if (!url) return null
  const prefix = env.R2_PUBLIC_URL.replace(/\/$/, "") + "/"
  if (url.startsWith(prefix)) return url.slice(prefix.length)
  return null
}

/** Build the public URL for a given key. */
export function r2PublicUrl(env: CloudflareEnv, key: string): string {
  return `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key.replace(/^\//, "")}`
}
