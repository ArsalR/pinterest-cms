// src/modules/importer/backup.ts
// Minimal ZIP reader for WordPress "backup" uploads (K9 extension). Many people
// have a .zip rather than a bare .xml — either a zipped WXR export
// (WordPress.com / some plugins) or a full-site backup that happens to contain
// the export. We locate the WXR .xml entry and inflate just that one, so a
// huge media-laden zip never has to fit in memory at once.
//
// Uses DecompressionStream('deflate-raw') (available in Workers AND Node 18+),
// so this stays unit-testable in plain Node. Only the two real-world ZIP
// compression methods are handled: 0 (stored) and 8 (deflate).

const LOCAL_SIG = 0x04034b50 // "PK\x03\x04"

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const src = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.enqueue(bytes); ctrl.close() } })
  // Cast bridges the DOM vs Workers stream lib typings; runtime is unaffected.
  const ds = new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>
  const buf = await new Response(src.pipeThrough(ds)).arrayBuffer()
  return new Uint8Array(buf)
}

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  offset: number // offset of the local file header
}

/**
 * List the entries of a ZIP by walking local file headers from the front.
 * (We avoid the central directory so a truncated/streamed backup still yields
 * its early entries.) Data-descriptor entries — size 0 in the local header,
 * bit 3 of the flags set — are reported with size 0 and skipped by the reader
 * below; WXR exports are stored/deflated with real sizes, so this is safe.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = []
  let o = 0
  while (o + 30 <= bytes.length && u32(bytes, o) === LOCAL_SIG) {
    const flags = u16(bytes, o + 6)
    const method = u16(bytes, o + 8)
    const compressedSize = u32(bytes, o + 18)
    const uncompressedSize = u32(bytes, o + 22)
    const nameLen = u16(bytes, o + 26)
    const extraLen = u16(bytes, o + 28)
    const nameStart = o + 30
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLen))
    const dataStart = nameStart + nameLen + extraLen
    entries.push({ name, method, compressedSize, uncompressedSize, offset: o })
    // Streaming (data-descriptor) entries hide the size in the local header; we
    // can't reliably skip them without the central directory, so stop there.
    if ((flags & 0x08) !== 0 && compressedSize === 0) break
    o = dataStart + compressedSize
  }
  return entries
}

async function readEntry(bytes: Uint8Array, e: ZipEntry): Promise<Uint8Array | null> {
  const o = e.offset
  if (u32(bytes, o) !== LOCAL_SIG) return null
  const nameLen = u16(bytes, o + 26)
  const extraLen = u16(bytes, o + 28)
  const dataStart = o + 30 + nameLen + extraLen
  const data = bytes.subarray(dataStart, dataStart + e.compressedSize)
  if (e.method === 0) return data // stored
  if (e.method === 8) return inflateRaw(data) // deflate
  return null // unsupported method
}

/** True if a byte buffer starts with the ZIP local-file signature. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && u32(bytes, 0) === LOCAL_SIG
}

/**
 * Find and inflate the WordPress export (WXR) inside a ZIP. Picks the largest
 * `.xml` entry whose inflated content looks like a WXR (contains `<item` and a
 * WordPress namespace). Returns null when the zip carries no parseable export
 * (e.g. a SQL-only database backup) — the caller surfaces a clear message.
 */
export async function extractWxrFromZip(bytes: Uint8Array): Promise<string | null> {
  const xmls = listZipEntries(bytes)
    .filter((e) => /\.xml$/i.test(e.name) && (e.method === 0 || e.method === 8))
    .sort((a, b) => b.uncompressedSize - a.uncompressedSize)
  for (const e of xmls) {
    try {
      const raw = await readEntry(bytes, e)
      if (!raw) continue
      const text = new TextDecoder().decode(raw)
      if (text.includes("<item") && /xmlns:wp=|wp:post_type|<wp:/.test(text)) return text
    } catch {
      // try the next candidate
    }
  }
  return null
}
