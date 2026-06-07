import crypto from 'node:crypto'
import { promisify } from 'node:util'
const randomFill = promisify(crypto.randomFill)

export async function getRandomBytes(buf: Uint8Array) {
  return randomFill(buf)
}

export async function sha256(buf: Uint8Array) {
  return new Uint8Array(crypto.createHash('sha256').update(buf).digest())
}
