// src/lib/imageMeta.test.ts — EXIF/GPS stripping (V1.3 Image SEO profile).
import { describe, it, expect } from "vitest"
import { stripJpegExif, isJpeg } from "./imageMeta"

/** Hand-build a minimal JPEG: SOI + segments + SOS + fake scan data. */
function seg(marker: number, payload: number[]): number[] {
  const len = payload.length + 2
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload]
}
function jpeg(...segments: number[][]): ArrayBuffer {
  const scan = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xff, 0xd9]
  return new Uint8Array([0xff, 0xd8, ...segments.flat(), ...scan]).buffer
}

const APP0 = seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00]) // JFIF
const EXIF = seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02, 0x03]) // "Exif" + GPS-ish bytes
const IPTC = seg(0xed, [0x50, 0x68, 0x6f, 0x74, 0x6f]) // Photoshop IRB
const ICC = seg(0xe2, [0x49, 0x43, 0x43, 0x5f]) // ICC color profile (kept)

describe("stripJpegExif", () => {
  // GUARDRAIL (privacy): the EXIF/GPS segment must be gone from the output.
  it("removes EXIF and IPTC, keeps JFIF + ICC + scan data", () => {
    const input = jpeg(APP0, EXIF, ICC, IPTC)
    const out = new Uint8Array(stripJpegExif(input))
    const hex = Array.from(out, (b) => b.toString(16).padStart(2, "0")).join("")
    expect(hex).not.toContain("457869660000") // "Exif\0\0" gone
    expect(hex).toContain("4a46494600") // JFIF kept
    expect(hex).toContain("4943435f") // ICC kept
    expect(out[0]).toBe(0xff) // still a valid JPEG stream
    expect(out[1]).toBe(0xd8)
    expect(hex).toContain("aabb") // scan data intact
    expect(out.length).toBeLessThan(new Uint8Array(input).length)
  })

  it("returns the buffer untouched when there's nothing to strip", () => {
    const input = jpeg(APP0, ICC)
    expect(stripJpegExif(input)).toBe(input)
  })

  // GUARDRAIL (never corrupt): non-JPEG and malformed streams pass through.
  it("passes through non-JPEGs and malformed data unchanged", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer
    expect(stripJpegExif(png)).toBe(png)
    const truncated = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]).buffer // length beyond EOF
    expect(stripJpegExif(truncated)).toBe(truncated)
    expect(isJpeg(new Uint8Array(png))).toBe(false)
  })
})
