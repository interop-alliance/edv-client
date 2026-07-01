/*!
 * Copyright (c) 2019-2026 Digital Bazaar, Inc. All rights reserved.
 */
import { base64url } from './baseX.js'
import canonicalize from 'canonicalize'
import { LruCache } from '@interop/lru-memoize'
import { sha256 } from './util.js'
import { assertHmac, IndexHelperBase } from './IndexHelperBase.js'

/**
 * Version 2 index helper. Blinds attributes in two stages: an unkeyed SHA-256
 * pre-hash of each canonicalized value (cacheable and byte-concatenated for
 * compound indexes), followed by a keyed HMAC pass over the resulting digests.
 * The shared, blinding-agnostic machinery lives in `IndexHelperBase`.
 */
export class IndexHelper extends IndexHelperBase {
  _cache: any

  /**
   * Creates a new IndexHelper instance that can be used to blind EDV
   * document attributes to enable indexing.
   *
   * @returns {IndexHelper} An IndexHelper instance.
   */
  constructor() {
    super()
    this._cache = new LruCache({
      // each entry size ~64 bytes, 1000 entries ~= 64KiB
      max: 1000
    })
  }

  /**
   * Ensures that future documents inserted or updated using this client
   * instance will be indexed according to the given attribute, additionally
   * prewarming the HMAC cache when an `hmac` is supplied. See
   * `IndexHelperBase.ensureIndex` for the indexing semantics.
   *
   * @param {object} options - The options to use.
   * @param {string|string[]} options.attribute - The attribute name or an
   *   array of attribute names to create a unique compound index.
   * @param {boolean} [options.unique=false] - Set to `true` if the index
   *   should be considered unique, `false` if not.
   * @param {object} [options.hmac] - An optional HMAC API with `id`, `sign`,
   *   and `verify` properties for prewarming caches.
   */
  override ensureIndex({ attribute, unique = false, hmac }: any = {}) {
    super.ensureIndex({ attribute, unique })

    if (hmac) {
      assertHmac(hmac)
      const attributes = Array.isArray(attribute) ? attribute : [attribute]
      // ignore errors during prewarm; they are not fatal
      this._prewarmCache({ attributes, hmac }).catch(() => {})
    }
  }

  /**
   * Blinds a Uint8Array of bytes using the given HMAC API.
   *
   * @param {object} hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {Uint8Array} data - The value to blind.
   *
   * @returns {Promise<string>} - Resolves to the blinded value.
   */
  async _blindData(hmac: any, data: any) {
    // convert value to Uint8Array and hash it
    const signature = await this._cachedHmac({ hmac, data })
    if (typeof signature === 'string') {
      // presume base64url-encoded
      return signature
    }
    // base64url-encode Uint8Array signature
    return base64url.encode(signature)
  }

  /**
   * Blinds a hashed attribute (compound or simple) using the given HMAC API.
   *
   * @param {object} options - The options to use.
   * @param {object} options.hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {object} options.hashedAttribute - The attribute with `name`,
   *   `value`, and optional `unique` property; `name` and `value` MUST be
   *   Uint8Arrays.
   *
   * @returns {Promise<object>} - Resolves to an object
   *   `{name, value, unique?}`.
   */
  async _blindHashedAttribute({ hmac, hashedAttribute }: any) {
    // salt values with key to prevent cross-key leakage
    const saltedValue = await sha256(
      _joinHashes([hashedAttribute.name, hashedAttribute.value])
    )
    const [name, value] = await Promise.all([
      this._blindData(hmac, hashedAttribute.name),
      this._blindData(hmac, saltedValue)
    ])
    const blindAttribute: any = { name, value }
    if (hashedAttribute.unique) {
      blindAttribute.unique = true
    }
    return blindAttribute
  }

  override async _buildBlindAttributes({ hmac, doc, equal, has }: any) {
    const hashedAttributes = []

    // get all matching indexes and corresponding attribute values
    const { simpleMatches, compoundMatches, attributeValues } =
      this._getMatchingIndexes({ doc, equal, has })

    // compute and store all hashed attributes in parallel
    const hashedAttributeMap = new Map()
    const hashPromises = []
    for (const [name, valueSet] of attributeValues.entries()) {
      // create a hashed set for each attribute name; it will hold the
      // hashed attribute associated with each name+value pair
      const hashedSet = new Set()
      hashedAttributeMap.set(name, hashedSet)
      for (const value of valueSet) {
        // use an IIFE to push a promise onto `hashPromises` to await all
        // promises in parallel and within IIFE add the resolved hashed
        // attribute to the current attribute's `hashedSet`
        hashPromises.push(
          (async () => {
            hashedSet.add(await this._hashAttribute({ hmac, name, value }))
          })()
        )
      }
    }
    await Promise.all(hashPromises)

    // add all matching simple index hashed attributes and track simple
    // attributes to avoid duplicating entries when processing compound
    // indexes
    const simpleAttributes = new Set()
    for (const { attribute: name, unique } of simpleMatches) {
      const hashedSet = hashedAttributeMap.get(name)
      for (const hashed of hashedSet) {
        hashedAttributes.push({ ...hashed, unique })
      }
      simpleAttributes.add(name)
    }

    // compute and add all matching compound index hashed attributes
    const compoundPromises = []
    for (const { attributes: names, unique } of compoundMatches) {
      /* Note: For each matching index, there are some number of matching
      attributes that need to be combinatorially spread. For example, for this
      index: `['content.a', 'content.b', 'content.c']`, there may be multiple
      values for each attribute such as `A` values for `content.a`, `B` values
      for `content.b`, and `C` values for `content.c`. Each combination these
      values will ultimately produce a new blinded attribute to add to `entry`.
      Combinations must also include partial ones, e.g., combinations of
      values for `content.a` alone as well as values for `content.a` and
      `content.b` without `content.c`. */
      const combinations = []
      let previous: any[] = [[]]
      for (const name of names) {
        const hashedSet = hashedAttributeMap.get(name)
        if (!hashedSet) {
          // no values for current attribute name; no more entries to produce
          break
        }
        // produce a new combination for every `hashed` value and every
        // combination from the previous attribute
        const next = []
        for (const hashed of hashedSet) {
          for (const combination of previous) {
            next.push([...combination, hashed])
          }
        }
        combinations.push(...next)
        previous = next
      }

      // now generate entries from every combination
      for (const combination of combinations) {
        // skip generating an entry for this combination if it has just the
        // first attribute and an entry for it was already added
        if (combination.length === 1 && simpleAttributes.has(names[0])) {
          continue
        }

        // use an IIFE to push a promise onto `compoundPromises` to await all
        // promises in parallel and within IIFE return hashed attribute to
        // blind and add to `entry` below
        compoundPromises.push(
          (async () => {
            const attribute: any = await this._hashCompoundAttribute({
              hashedAttributes: combination
            })
            // an encrypted attribute is only unique for a compound index when
            // it contains a value for every attribute in the index
            attribute.unique = unique && combination.length === names.length
            return attribute
          })()
        )
      }
    }
    hashedAttributes.push(...(await Promise.all(compoundPromises)))

    // blind all hashed attributes and return them
    return Promise.all(
      hashedAttributes.map(async hashedAttribute =>
        this._blindHashedAttribute({ hmac, hashedAttribute })
      )
    )
  }

  /**
   * Hashes a single attribute, converting its name and value into a hashed
   * name and hashed value.
   *
   * @param {object} options - The options to use.
   * @param {string} options.name - A name associated with a value.
   * @param {any} options.value - The value associated with the name for the
   *   attribute.
   *
   * @returns {Promise<object>} - Resolves to an object `{name, value}`.
   */
  async _hashAttribute({ name, value }: any) {
    // canonicalize value to get consistent representation and hash
    value = canonicalize(value)
    const [hashedName, hashedValue] = await Promise.all([
      _hashString(name),
      _hashString(value)
    ])
    return { name: hashedName, value: hashedValue }
  }

  /**
   * Builds a hashed compound attribute from an array of hashed attributes
   * via the given HMAC API.
   *
   * @param {object} options - The options to use.
   * @param {Array} options.hashedAttributes - The hashed attributes that
   *   comprise the compound index.
   * @param {number} [options.length=options.hashedAttributes.length] - The
   *   number of hashed attributes to go into the compound attribute
   *   (<= `hashedAttributes.length`).
   *
   * @returns {Promise<string>} - Resolves to the hashed compound attribute.
   */
  async _hashCompoundAttribute({
    hashedAttributes,
    length = hashedAttributes.length
  }: any) {
    const selection =
      length === hashedAttributes.length
        ? hashedAttributes
        : hashedAttributes.slice(0, length)
    const nameInput = _joinHashes(selection.map((x: any) => x.name))
    const valueInput = _joinHashes(selection.map((x: any) => x.value))
    const [name, value] = await Promise.all([
      sha256(nameInput),
      sha256(valueInput)
    ])
    return { name, value }
  }

  async _prewarmCache({ attributes, hmac }: any) {
    const promises = []
    const compound = []
    for (const [i, name] of attributes.entries()) {
      const hashed = await _hashString(name)
      compound.push(hashed)
      const data = i === 0 ? hashed : await sha256(_joinHashes(compound))
      promises.push(this._cachedHmac({ hmac, data }))
    }
    return Promise.all(promises)
  }

  async _cachedHmac({ hmac, data }: any) {
    return this._cache.memoize({
      key: `${encodeURIComponent(hmac.id)}:${base64url.encode(data)}`,
      fn: () => hmac.sign({ data })
    })
  }
}

async function _hashString(str: any) {
  return sha256(new TextEncoder().encode(str))
}

// `hashes` is an array of Uint8Arrays, each MUST have the same length
function _joinHashes(hashes: any) {
  if (hashes.length === 0) {
    return new Uint8Array(0)
  }

  const joined = new Uint8Array(hashes.length * hashes[0].length)
  let offset = 0
  for (const hash of hashes) {
    joined.set(hash, offset)
    offset += hash.length
  }

  return joined
}
