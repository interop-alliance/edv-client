export async function getRandomBytes(buf: Uint8Array) {
  return globalThis.crypto.getRandomValues(buf)
}

export async function sha256(buf: Uint8Array) {
  return new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', buf as BufferSource)
  )
}
