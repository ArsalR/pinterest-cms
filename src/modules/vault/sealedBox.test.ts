// src/modules/vault/sealedBox.test.ts
// Round-trip proof of the libsodium sealed-box construction used for GitHub
// Actions secrets (pure JS — runs in plain Node).

import { describe, it, expect } from "vitest"
import { x25519 } from "@noble/curves/ed25519.js"
import { sealToPublicKey, openSealedBox } from "./sealedBox"

function b64(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

describe("sealedBox (crypto_box_seal)", () => {
  const recipientSk = new Uint8Array(32).fill(7)
  const recipientPkB64 = b64(x25519.getPublicKey(recipientSk))

  it("round-trips: recipient can open what we seal", () => {
    const sealed = sealToPublicKey(recipientPkB64, "cf-token-abc123")
    expect(openSealedBox(recipientSk, sealed)).toBe("cf-token-abc123")
  })

  it("output layout is ephemeral_pk(32) || ciphertext(msg+16 tag)", () => {
    const msg = "0123456789"
    const sealed = atob(sealToPublicKey(recipientPkB64, msg))
    expect(sealed.length).toBe(32 + msg.length + 16)
  })

  it("fresh ephemeral key every call — no deterministic output", () => {
    expect(sealToPublicKey(recipientPkB64, "same")).not.toBe(sealToPublicKey(recipientPkB64, "same"))
  })

  it("tampered ciphertext fails to open (poly1305 tag)", () => {
    const sealed = atob(sealToPublicKey(recipientPkB64, "secret"))
    const flipped = sealed.slice(0, 40) + String.fromCharCode(sealed.charCodeAt(40) ^ 1) + sealed.slice(41)
    expect(() => openSealedBox(recipientSk, btoa(flipped))).toThrow()
  })

  it("rejects malformed recipient keys", () => {
    expect(() => sealToPublicKey(btoa("short"), "x")).toThrow("32 bytes")
  })
})

describe("libsodium interop (cross-checked against tweetnacl)", () => {
  it("an independent NaCl implementation opens our sealed box — proves GitHub can too", async () => {
    const nacl = (await import("tweetnacl")).default
    const { blake2b } = await import("@noble/hashes/blake2.js")

    const kp = nacl.box.keyPair()
    const sealed = atob(sealToPublicKey(b64(kp.publicKey), "repo-secret-value"))
    const bytes = new Uint8Array(sealed.length)
    for (let i = 0; i < sealed.length; i++) bytes[i] = sealed.charCodeAt(i)

    const epk = bytes.slice(0, 32)
    const ct = bytes.slice(32)
    const nonce = blake2b.create({ dkLen: 24 }).update(epk).update(kp.publicKey).digest()
    const opened = nacl.box.open(ct, nonce, epk, kp.secretKey)
    expect(opened).not.toBeNull()
    expect(new TextDecoder().decode(opened!)).toBe("repo-secret-value")
  })
})
