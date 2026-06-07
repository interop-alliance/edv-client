import { base58, base64urlnopad } from '@scure/base'

export const base58btc = base58

/**
 * base64url must be RFC 4648 compliant for interop, and the unpadded form is
 * used here, hence `base64urlnopad`.
 */
export const base64url = base64urlnopad
