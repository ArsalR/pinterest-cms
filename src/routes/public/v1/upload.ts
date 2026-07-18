// src/routes/public/v1/upload.ts
// Upload 1–20 images. Returns R2 URLs + media IDs.
//
// POST /api/public/v1/upload
// Authorization: Bearer cms_live_xxx
// Content-Type: multipart/form-data
// Fields:
//   files     — File[] (one or more)
//   alt[i]    — string (optional alt text matched by index)
//   caption[i]— string (optional)

import { Hono } from "hono"
import type { AppEnv } from "../../../lib/types"
import { validateApiKey, logApiRequest } from "../../../lib/apiAuth"
import { apiError } from "../../../lib/errors"
import { uploadToR2 } from "../../../lib/r2"
import { stripJpegExif, imageProfileOn } from "../../../lib/imageMeta"
import { cuid } from "../../../lib/utils"

const MAX_FILES_PER_REQUEST = 20
const MAX_BYTES_PER_FILE = 10 * 1024 * 1024 // 10 MB

// Validate by magic bytes — client-supplied MIME in multipart can be spoofed.
function detectImageMime(bytes: Uint8Array): string | null {
  const b = bytes
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp"
  return null
}

export const uploadRoutes = new Hono<AppEnv>()

uploadRoutes.post("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) return apiError(c, auth.status, auth.code, auth.error)

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
    return apiError(c, 400, "validation_invalid_value", "Invalid multipart body")
  }

  const files = formData.getAll("files").filter((f): f is File => f instanceof File)
  if (!files.length) {
    await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
    return apiError(c, 400, "validation_required_field", "No files provided. Send one or more `files` fields.", { field: "files" })
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
    return apiError(c, 400, "upload_too_many_files", `Maximum ${MAX_FILES_PER_REQUEST} files per request`, { max: MAX_FILES_PER_REQUEST, sent: files.length })
  }

  const uploaded: Array<{
    url: string
    filename: string
    size: number
    alt: string
    caption: string
    mediaId: string
    r2Key: string
  }> = []

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (file.size > MAX_BYTES_PER_FILE) {
      await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
      return apiError(c, 400, "upload_file_too_large", `File '${file.name}' exceeds ${MAX_BYTES_PER_FILE / 1024 / 1024}MB limit`, { filename: file.name, maxBytes: MAX_BYTES_PER_FILE, size: file.size })
    }

    const alt = String(formData.get(`alt[${i}]`) ?? "")
    const caption = String(formData.get(`caption[${i}]`) ?? "")

    let buffer = await file.arrayBuffer()

    // Validate by magic bytes, not the client-supplied MIME type (trivially spoofed).
    const detectedMime = detectImageMime(new Uint8Array(buffer))
    if (!detectedMime) {
      await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
      return apiError(c, 400, "upload_invalid_mime", `File '${file.name}' is not a supported image (JPEG, PNG, GIF, WebP)`, { filename: file.name })
    }

    // V1.3 Image SEO profile: strip EXIF/GPS from JPEGs at the door (privacy
    // + weight). Profile off = bytes stored exactly as uploaded (today).
    if (detectedMime === "image/jpeg" && (await imageProfileOn(siteDb))) {
      buffer = stripJpegExif(buffer)
    }

    const { url, key } = await uploadToR2(c.env, hostname, file.name, buffer, detectedMime)

    const mediaId = cuid()
    await siteDb.execute({
      sql: `INSERT INTO media (id, url, filename, size, alt, caption, source, r2_key)
            VALUES (?, ?, ?, ?, ?, ?, 'api', ?)`,
      args: [mediaId, url, file.name, file.size, alt, caption, key],
    })

    uploaded.push({ url, filename: file.name, size: file.size, alt, caption, mediaId, r2Key: key })
  }

  await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 200)
  return c.json({ success: true, uploaded })
})
