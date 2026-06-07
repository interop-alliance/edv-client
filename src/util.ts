import { sha256 as _sha256 } from '@noble/hashes/sha2.js'

// Isomorphic crypto helpers. `getRandomValues` is provided natively by Node
// (>=24), browsers, and Deno; React Native consumers must install the
// `react-native-get-random-values` polyfill (see the README). SHA-256 uses the
// pure-JS `@noble/hashes` implementation so it works everywhere without a
// WebCrypto `subtle` shim.

export async function getRandomBytes(buf: Uint8Array) {
  return globalThis.crypto.getRandomValues(buf)
}

export async function sha256(buf: Uint8Array) {
  return _sha256(buf)
}
