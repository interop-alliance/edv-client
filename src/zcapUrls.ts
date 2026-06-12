/*!
 * Copyright (c) 2022-2026 Digital Bazaar, Inc. All rights reserved.
 */
import type { IZcap } from '@interop/data-integrity-core'

/**
 * Helpers for deriving EDV URLs from authorization capabilities (zcaps). A
 * root zcap encodes its invocation target (an `https` EDV/document URL) in its
 * URN; a delegated zcap carries it as an `invocationTarget` property. These
 * functions extract that target and parse the EDV ID out of it.
 */

/**
 * The URN prefix used by a synthesized root zcap; the URL-encoded invocation
 * target follows it.
 */
export const ZCAP_ROOT_PREFIX = 'urn:zcap:root:'

/**
 * Gets the invocation target (an `https` URL) for a capability.
 *
 * @param {object} options - The options to use.
 * @param {object|string} [options.capability] - The authorization capability
 *   (zcap), either a delegated/root zcap object or a root zcap URN string.
 *
 * @returns {string|null} The invocation target URL, or `null` if no capability
 *   was given.
 */
export function getInvocationTarget({
  capability
}: {
  capability?: IZcap | string
} = {}): string | null {
  // no capability, so no invocation target
  if (capability === undefined || capability === null) {
    return null
  }

  let invocationTarget
  if (typeof capability === 'string') {
    if (!capability.startsWith(ZCAP_ROOT_PREFIX)) {
      throw new Error(
        'If "capability" is a string, it must be a root capability.'
      )
    }
    invocationTarget = decodeURIComponent(
      capability.substring(ZCAP_ROOT_PREFIX.length)
    )
  } else if (typeof capability === 'object') {
    ;({ invocationTarget } = capability)
  }

  if (
    !(typeof invocationTarget === 'string' && invocationTarget.includes(':'))
  ) {
    throw new TypeError(
      '"invocationTarget" from capability must be an "https" URL.'
    )
  }

  return invocationTarget
}

/**
 * Parses an EDV ID from a capability's invocation target.
 *
 * @param {object} options - The options to use.
 * @param {object|string} options.capability - The authorization capability
 *   (zcap) to parse the EDV ID from.
 *
 * @returns {string} The ID of the EDV.
 */
export function parseEdvId({
  capability
}: {
  capability?: IZcap | string
} = {}): string {
  const invocationTarget = getInvocationTarget({ capability }) as string
  const start = invocationTarget.lastIndexOf('/edvs/')
  if (start === -1) {
    throw new Error(`Invalid EDV invocation target (${invocationTarget}).`)
  }
  const end = invocationTarget.indexOf('/', start + '/edvs/'.length + 1)
  if (end === -1) {
    // form: https://example.com/edvs/z1238121237
    return invocationTarget
  }
  // form: https://example.com/edvs/z1238121237/...
  return invocationTarget.slice(0, end)
}
