// src/modules/vault/sealedBox.ts
// libsodium crypto_box_seal, assembled from @noble primitives — required by
// the GitHub Actions secrets API (repo secrets must be sealed to the repo's
// X25519 public key). WebCrypto has no sealed-box equivalent, hence the only
// runtime dependency addition of the SaaS layer (@noble/*: pure JS, audited,
// no WASM — justified in PLAN.md).
//
// Format (libsodium spec): ephemeral_pk(32) || xsalsa20poly1305(
//   key   = x25519(ephemeral_sk, recipient_pk),  via crypto_box seed (HSalsa20)
//   nonce = BLAKE2b-24(ephemeral_pk || recipient_pk),
//   msg )

import { x25519 } from "@noble/curves/ed25519.js"
import { xsalsa20poly1305, hsalsa } from "@noble/ciphers/salsa.js"
import { blake2b } from "@noble/hashes/blake2.js"

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64encode(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// hsalsa operates on little-endian u32 words.
function toU32(bytes: Uint8Array): Uint32Array {
  const out = new Uint32Array(bytes.length / 4)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true)
  return out
}

function fromU32(words: Uint32Array): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < words.length; i++) dv.setUint32(i * 4, words[i], true)
  return out
}

const SIGMA32 = toU32(new TextEncoder().encode("expand 32-byte k"))

/** crypto_box key: HSalsa20(x25519 shared secret) — libsodium's beforenm. */
function boxSharedKey(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(sk, pk)
  const out = new Uint32Array(8)
  hsalsa(SIGMA32, toU32(shared), new Uint32Array(4), out)
  return fromU32(out)
}

/** Seal `plaintext` to a recipient X25519 public key. Pure function (exported
 *  for tests via injectable ephemeral key). */
export function sealToPublicKey(
  recipientPkB64: string,
  plaintext: string,
  ephemeralSk?: Uint8Array
): string {
  const recipientPk = b64decode(recipientPkB64)
  if (recipientPk.length !== 32) throw new Error("sealedBox: recipient public key must be 32 bytes")
  const esk = ephemeralSk ?? crypto.getRandomValues(new Uint8Array(32))
  const epk = x25519.getPublicKey(esk)

  const nonce = blake2b
    .create({ dkLen: 24 })
    .update(epk)
    .update(recipientPk)
    .digest()

  const key = boxSharedKey(esk, recipientPk)
  const ct = xsalsa20poly1305(key, nonce).encrypt(new TextEncoder().encode(plaintext))

  const out = new Uint8Array(32 + ct.length)
  out.set(epk, 0)
  out.set(ct, 32)
  return b64encode(out)
}

/** Test-only inverse (recipient side) — proves interop with the seal format. */
export function openSealedBox(recipientSk: Uint8Array, sealedB64: string): string {
  const sealed = b64decode(sealedB64)
  const epk = sealed.slice(0, 32)
  const recipientPk = x25519.getPublicKey(recipientSk)
  const nonce = blake2b.create({ dkLen: 24 }).update(epk).update(recipientPk).digest()
  const key = boxSharedKey(recipientSk, epk)
  const pt = xsalsa20poly1305(key, nonce).decrypt(sealed.slice(32))
  return new TextDecoder().decode(pt)
}
