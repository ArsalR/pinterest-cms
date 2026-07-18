// src/lib/imageMeta.ts
// V1.3 Image SEO profile — EXIF/GPS stripping for JPEG uploads (privacy +
// weight). Pure byte-stream surgery, no dependencies: JPEG metadata lives in
// APP1 (EXIF, incl. GPS), APP2 (ICC is kept — it affects color rendering) and
// APP13 (IPTC) segments; removing APP1/APP13 removes location and camera data
// without touching image pixels. PNG/GIF/WebP rarely carry GPS and are passed
// through untouched. Unit-tested against hand-built JPEG streams.

import type { Client } from "@libsql/client/web"

/** Is the Image SEO profile on for this site? Drives upload-time stripping.
 *  Best-effort false (pre-migration sites keep today's exact behavior). */
export async function imageProfileOn(siteDb: Client): Promise<boolean> {
  try {
    const r = await siteDb.execute({ sql: "SELECT profiles FROM seo_settings WHERE id = 'default' LIMIT 1", args: [] })
    if (!r.rows.length) return false
    const a = JSON.parse(String(r.rows[0].profiles ?? "[]")) as unknown
    return Array.isArray(a) && a.includes("image")
  } catch {
    return false
  }
}

/** True when the buffer starts with the JPEG SOI marker. Pure. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8
}

/**
 * Strip EXIF (APP1) and IPTC (APP13) segments from a JPEG. Keeps APP0 (JFIF)
 * and APP2 (ICC color profile). Returns the original buffer untouched for
 * non-JPEGs or on any structural surprise — never corrupts an upload. Pure.
 */
export function stripJpegExif(input: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(input)
  if (!isJpeg(bytes)) return input

  try {
    const keep: Array<[number, number]> = [[0, 2]] // SOI
    let i = 2
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return input // lost sync — don't touch it
      const marker = bytes[i + 1]
      // SOS (start of scan): everything from here on is entropy-coded data.
      if (marker === 0xda) {
        keep.push([i, bytes.length])
        break
      }
      // Standalone markers (no length) shouldn't appear before SOS aside from
      // TEM/RSTn — treat defensively.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        keep.push([i, i + 2])
        i += 2
        continue
      }
      const len = (bytes[i + 2] << 8) | bytes[i + 3]
      if (len < 2 || i + 2 + len > bytes.length) return input
      const segEnd = i + 2 + len
      const isExif = marker === 0xe1 // APP1 (EXIF / XMP)
      const isIptc = marker === 0xed // APP13 (Photoshop IRB / IPTC)
      if (!isExif && !isIptc) keep.push([i, segEnd])
      i = segEnd
    }
    if (i + 4 > bytes.length && keep.length === 1) return input

    const total = keep.reduce((n, [a, b]) => n + (b - a), 0)
    if (total === bytes.length) return input // nothing stripped
    const out = new Uint8Array(total)
    let o = 0
    for (const [a, b] of keep) {
      out.set(bytes.subarray(a, b), o)
      o += b - a
    }
    return out.buffer
  } catch {
    return input
  }
}
