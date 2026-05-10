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
import { uploadToR2 } from "../../../lib/r2"
import { cuid } from "../../../lib/utils"

const MAX_FILES_PER_REQUEST = 20
const MAX_BYTES_PER_FILE = 10 * 1024 * 1024 // 10 MB

export const uploadRoutes = new Hono<AppEnv>()

uploadRoutes.post("/", async (c) => {
  const siteDb = c.get("siteDb")
  const hostname = c.get("hostname")

  const auth = await validateApiKey(siteDb, c.req.raw, "write")
  if (auth.error) {
    return c.json({ error: auth.error }, auth.status as 401 | 403)
  }

  let formData: FormData
  try {
    formData = await c.req.formData()
  } catch {
    await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
    return c.json({ error: "Invalid multipart body" }, 400)
  }

  const files = formData.getAll("files").filter((f): f is File => f instanceof File)
  if (!files.length) {
    await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
    return c.json({ error: "No files provided. Send one or more `files` fields." }, 400)
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
    return c.json({ error: `Maximum ${MAX_FILES_PER_REQUEST} files per request` }, 400)
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
    if (!file.type.startsWith("image/")) {
      await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
      return c.json({ error: `File '${file.name}' is not an image (got ${file.type})` }, 400)
    }
    if (file.size > MAX_BYTES_PER_FILE) {
      await logApiRequest(siteDb, auth.keyId, "/v1/upload", "POST", 400)
      return c.json(
        { error: `File '${file.name}' exceeds ${MAX_BYTES_PER_FILE / 1024 / 1024}MB limit` },
        400
      )
    }

    const alt = String(formData.get(`alt[${i}]`) ?? "")
    const caption = String(formData.get(`caption[${i}]`) ?? "")

    const buffer = await file.arrayBuffer()
    const { url, key } = await uploadToR2(c.env, hostname, file.name, buffer, file.type)

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
