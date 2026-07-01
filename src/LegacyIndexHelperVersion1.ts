/*!
 * Copyright (c) 2019-2026 Digital Bazaar, Inc. All rights reserved.
 */
import { base64url } from './baseX.js'
import canonicalize from 'canonicalize'
import { sha256 } from './util.js'
import { IndexHelperBase } from './IndexHelperBase.js'

/**
 * Legacy version 1 index helper. It blinds attributes in a single keyed pass
 * (HMAC over the SHA-256 of each value, namespaced as `{key: value}`), and
 * combines compound-index components by colon-joining the already-blinded
 * base64url strings. This matches the original EDV spec blinding procedure.
 *
 * This version exists only to read and migrate blinded attributes written by
 * older clients; its blinding internals MUST stay byte-compatible with legacy
 * on-disk data and must not be "fixed". The shared, blinding-agnostic machinery
 * lives in `IndexHelperBase`.
 */
export class LegacyIndexHelperVersion1 extends IndexHelperBase {
  /**
   * Blinds a single attribute using the given HMAC API.
   *
   * @param {object} options - The options to use.
   * @param {object} options.hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {string} options.key - A key associated with a value.
   * @param {any} options.value - The value associated with the key for the
   *   attribute.
   *
   * @returns {Promise<object>} - Resolves to an object `{name, value}`.
   */
  async _blindAttribute({ hmac, key, value }: any) {
    // salt values with key to prevent cross-key leakage
    value = canonicalize({ key: value })
    const [blindedName, blindedValue] = await Promise.all([
      this._blindString(hmac, key),
      this._blindString(hmac, value)
    ])
    return { name: blindedName, value: blindedValue }
  }

  /**
   * Builds a blind compound attribute from an array of blind attributes
   * via the given HMAC API.
   *
   * @param {object} options - The options to use.
   * @param {object} options.hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {Array} options.blindAttributes - The blind attributes that
   *   comprise the compound index.
   * @param {number} [options.length=options.blindAttributes.length] - The
   *   number of blind attributes to go into the compound attribute
   *   (<= `blindAttributes.length`).
   *
   * @returns {Promise<string>} - Resolves to the blinded compound attribute.
   */
  async _blindCompoundAttribute({
    hmac,
    blindAttributes,
    length = blindAttributes.length
  }: any) {
    const selection =
      length === blindAttributes.length
        ? blindAttributes
        : blindAttributes.slice(0, length)
    const nameInput = selection.map((x: any) => x.name).join(':')
    const valueInput = selection.map((x: any) => x.value).join(':')
    const [name, value] = await Promise.all([
      this._blindString(hmac, nameInput),
      this._blindString(hmac, valueInput)
    ])
    return { name, value }
  }

  /**
   * Blinds a string using the given HMAC API.
   *
   * @param {object} hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {string} value - The value to blind.
   *
   * @returns {Promise<string>} - Resolves to the blinded value.
   */
  async _blindString(hmac: any, value: any) {
    // convert value to Uint8Array and hash it
    const data = await sha256(new TextEncoder().encode(value))
    const signature = await hmac.sign({ data })
    if (typeof signature === 'string') {
      // presume base64url-encoded
      return signature
    }
    // base64url-encode Uint8Array signature
    return base64url.encode(signature)
  }

  override async _buildBlindAttributes({ hmac, doc, equal, has }: any) {
    const result = []

    // get all matching indexes and corresponding attribute values
    const { simpleMatches, compoundMatches, attributeValues } =
      this._getMatchingIndexes({ doc, equal, has })

    // compute and store all blinded attributes in parallel
    const blindedAttributes = new Map()
    const blindPromises = []
    for (const [attribute, valueSet] of attributeValues.entries()) {
      // create a blinded set for each attribute name; it will hold the
      // blinded attribute associated with each attribute+value pair
      const blindedSet = new Set()
      blindedAttributes.set(attribute, blindedSet)
      for (const v of valueSet) {
        // use an IIFE to push a promise onto `blindPromises` to await all
        // promises in parallel and within IIFE add the resolved blinded
        // attribute to the current attribute's `blindedSet`
        blindPromises.push(
          (async () => {
            blindedSet.add(
              await this._blindAttribute({ hmac, key: attribute, value: v })
            )
          })()
        )
      }
    }
    await Promise.all(blindPromises)

    // add all matching simple index blinded attributes and track simple
    // attributes to avoid duplicating entries when processing compound
    // indexes
    const simpleAttributes = new Set()
    for (const { attribute, unique } of simpleMatches) {
      const blindedSet = blindedAttributes.get(attribute)
      for (const blinded of blindedSet) {
        result.push({ ...blinded, unique })
      }
      simpleAttributes.add(attribute)
    }

    // compute and add all matching compound index blinded attributes
    const compoundPromises = []
    for (const { attributes, unique } of compoundMatches) {
      /* Note: For each matching index, there are some number of matching
      attributes that need to be combinatorially spread. For example, for this
      index: `['content.a', 'content.b', 'content.c']`, there may be multiple
      values for each attribute such as `A` values for `content.a`, `B` values
      for `content.b`, and `C` values for `content.c`. Each combination these
      values will produce a new blinded attribute to add to `entry`.
      Combinations must also include partial ones, e.g., combinations of
      values for `content.a` alone as well as values for `content.a` and
      `content.b` without `content.c`. */
      const combinations = []
      let previous: any[] = [[]]
      for (const attribute of attributes) {
        const blindedSet = blindedAttributes.get(attribute)
        if (!blindedSet) {
          // no values for current attribute, so no more entries to produce
          break
        }
        // produce a new combination for every `blinded` value and every
        // combination from the previous attribute
        const next = []
        for (const blinded of blindedSet) {
          for (const combination of previous) {
            next.push([...combination, blinded])
          }
        }
        combinations.push(...next)
        previous = next
      }

      // now generate entries from every combination
      for (const combination of combinations) {
        // skip generating an entry for this combination if it has just the
        // first attribute and an entry for it was already added
        if (combination.length === 1 && simpleAttributes.has(attributes[0])) {
          continue
        }

        // use an IIFE to push a promise onto `compoundPromises` to await all
        // promises in parallel and within IIFE return blinded attribute to
        // add to `entry` below
        compoundPromises.push(
          (async () => {
            const attribute: any = await this._blindCompoundAttribute({
              hmac,
              blindAttributes: combination
            })
            // an encrypted attribute is only unique for a compound index when
            // it contains a value for every attribute in the index
            attribute.unique =
              unique && combination.length === attributes.length
            return attribute
          })()
        )
      }
    }
    result.push(...(await Promise.all(compoundPromises)))

    return result
  }
}
