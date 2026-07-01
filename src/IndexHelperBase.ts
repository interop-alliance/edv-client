/*!
 * Copyright (c) 2019-2026 Digital Bazaar, Inc. All rights reserved.
 */
import split from 'split-string'

/**
 * Shared base for the EDV index helpers. It owns the transport-agnostic,
 * blinding-agnostic machinery -- index registration, entry creation, query
 * building, index matching, and attribute dereferencing -- that is byte-for-byte
 * identical across attribute versions.
 *
 * Subclasses supply the version-specific blinding pipeline by implementing
 * `_buildBlindAttributes`; nothing in this base touches the HMAC/hash internals,
 * so a subclass's on-the-wire blinded output is fully determined by its own
 * overrides. See `IndexHelper` (version 2) and `LegacyIndexHelperVersion1`.
 */

const ATTRIBUTE_PREFIXES = ['content', 'meta']

export class IndexHelperBase {
  indexes: any
  compoundIndexes: any

  constructor() {
    this.indexes = new Map()
    this.compoundIndexes = new Map()
  }

  /**
   * Ensures that future documents inserted or updated using this client
   * instance will be indexed according to the given attribute, provided that
   * they contain that attribute. Compound indexes can be specified by
   * providing an array for `attribute`.
   *
   * Queries may be performed using compound indexes without specifying all
   * attributes in the compound index so long as there is at least one value
   * (or the attribute name for "has" queries) specified for consecutive
   * attributes starting with the first. This allows for querying using only
   * a prefix of a compound index. However, uniqueness will not be enforced
   * unless all attributes in the compound index are present in a document.
   *
   * @param {object} options - The options to use.
   * @param {string|string[]} options.attribute - The attribute name or an
   *   array of attribute names to create a unique compound index.
   * @param {boolean} [options.unique=false] - Set to `true` if the index
   *   should be considered unique, `false` if not.
   */
  ensureIndex({ attribute, unique = false }: any = {}) {
    let attributes = attribute
    if (!Array.isArray(attribute)) {
      attributes = [attribute]
    }
    if (!(
      attributes.length > 0 &&
      attributes.every((x: any) => typeof x === 'string')
    )) {
      throw new TypeError(
        '"attribute" must be a string or an array of strings.'
      )
    }

    if (attributes.length === 1) {
      // add simple index
      this.indexes.set(attributes[0], unique)
    } else {
      // add compound index
      const key = attributes.map((x: any) => encodeURIComponent(x)).join('|')
      this.compoundIndexes.set(key, { attributes, unique })
    }
  }

  /**
   * Creates an indexable entry of blinded attributes for the given document
   * using the HMAC associated with this instance.
   *
   * @param {object} options - The options to use.
   * @param {object} options.hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {object} options.doc - The document to create the indexable entry
   *   for.
   *
   * @returns {Promise<object>} - Resolves to the new indexable entry.
   */
  async createEntry({ hmac, doc }: any) {
    assertHmac(hmac)
    const entry = {
      hmac: {
        id: hmac.id,
        type: hmac.type
      },
      sequence: doc.sequence,
      attributes: await this._buildBlindAttributes({ hmac, doc })
    }
    return entry
  }

  /**
   * Returns a shallow copy of the array of indexed entries for the given
   * document where any existing entry matching the HMAC associated with this
   * instance is updated to include the current document attributes. If no
   * existing entry is found, a new entry is appended to the shallow copy
   * prior to its return.
   *
   * @param {object} options - The options to use.
   * @param {object} options.hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {object} options.doc - The document to create or update an indexable
   *   entry for.
   *
   * @returns {Promise<Array>} - Resolves to the updated array of indexable
   *   entries.
   */
  async updateEntry({ hmac, doc }: any) {
    assertHmac(hmac)

    // get previously indexed entries to update
    let { indexed = [] } = doc
    if (!Array.isArray(indexed)) {
      throw new TypeError('"indexed" must be an array.')
    }

    // create new entry
    const entry = await this.createEntry({ hmac, doc })

    // find existing entry in `indexed` by hmac ID and type
    const i = indexed.findIndex(
      (e: any) => e.hmac.id === hmac.id && e.hmac.type === hmac.type
    )

    // replace or append new entry
    indexed = indexed.slice()
    if (i === -1) {
      indexed.push(entry)
    } else {
      indexed[i] = entry
    }

    return indexed
  }

  /**
   * Builds a query that can be submitted to an EDV index service.
   *
   * @param {object} options - The options to use.
   * @param {object} options.hmac - An HMAC API with `id`, `sign`, and `verify`
   *   properties.
   * @param {object|Array} [options.equals] - An object with key-value
   *   attribute pairs to match or an array of such objects.
   * @param {string|Array} [options.has] - A string with an attribute name to
   *   match or an array of such strings.
   *
   * @returns {Promise<object>} - Resolves to the built query.
   */
  async buildQuery({ hmac, equals, has }: any) {
    assertHmac(hmac)

    // validate params
    if (equals === undefined && has === undefined) {
      throw new Error('Either "equals" or "has" must be defined.')
    }
    if (equals !== undefined && has !== undefined) {
      throw new Error('Only one of "equals" or "has" may be defined at once.')
    }
    if (equals !== undefined) {
      if (Array.isArray(equals)) {
        if (!equals.every((x: any) => x && typeof x === 'object')) {
          throw new TypeError('"equals" must be an array of objects.')
        }
      } else if (!(equals && typeof equals === 'object')) {
        throw new TypeError(
          '"equals" must be an object or an array of objects.'
        )
      }
    }
    if (has !== undefined) {
      if (Array.isArray(has)) {
        if (!has.every((x: any) => x && typeof x === 'string')) {
          throw new TypeError('"has" must be an array of strings.')
        }
      } else if (typeof has !== 'string') {
        throw new TypeError('"has" must be a string or an array of strings.')
      }
    }

    const query: any = {
      index: hmac.id
    }

    if (equals) {
      // normalize to array
      if (!Array.isArray(equals)) {
        equals = [equals]
      }
      // blind all values in each `equal`
      query.equals = await Promise.all(
        equals.map(async (equal: any) => {
          const result: any = {}
          const blinded = await this._buildBlindAttributes({ hmac, equal })
          for (const { name, value } of blinded) {
            result[name] = value
          }
          return result
        })
      )
    } else if (has !== undefined) {
      // normalize to array
      if (!Array.isArray(has)) {
        has = [has]
      }
      // blind every attribute name in `has`
      query.has = (await this._buildBlindAttributes({ hmac, has })).map(
        ({ name }: any) => name
      )
    }
    return query
  }

  /**
   * Builds the blinded attributes for a document or query. Implemented by each
   * attribute-version subclass; the base intentionally has no blinding logic.
   *
   * @param {object} options - The options to use (`hmac` plus one of `doc`,
   *   `equal`, or `has`).
   *
   * @returns {Promise<Array>} - Resolves to the blinded attributes.
   */
  async _buildBlindAttributes(_options: any): Promise<any[]> {
    throw new Error(
      '"_buildBlindAttributes" must be implemented by a subclass.'
    )
  }

  _getMatchingIndexes({ doc, equal, has }: any = {}) {
    // build a map of `attribute name => set of values` whilst matching
    const attributeValues = new Map()
    let matchFn
    if (doc) {
      // build a map of `attribute name => set of values` whilst matching
      // against the document
      matchFn = ({ attribute }: any) => {
        return this._matchDocument({ attribute, attributeValues, doc })
      }
    } else {
      // any attribute in `equal` or `has` entry is a match
      let attributes
      if (equal) {
        attributes = Object.keys(equal)
        for (const [name, value] of Object.entries(equal)) {
          attributeValues.set(name, new Set([value]))
        }
      } else {
        attributes = has
        for (const name of has) {
          // use dummy value of `true`; values will not be used in a `has`
          // query; note that this could be optimized to avoid the unnecessary
          // blinding of values in the future with more complex code
          attributeValues.set(name, new Set([true]))
        }
      }
      matchFn = ({ attribute }: any) => attributes.includes(attribute)
    }
    const result = this._matchIndexes({ matchFn })
    return { ...result, attributeValues }
  }

  _matchIndexes({ matchFn }: any = {}) {
    // any simple index that has a value defined for its attribute is a match
    const simpleMatches = []
    for (const [attribute, unique] of this.indexes.entries()) {
      if (matchFn({ attribute })) {
        simpleMatches.push({ attribute, unique })
      }
    }

    // any compound index that has a value defined for its first attribute is a
    // match; continue to process consecutive attributes whilst at least one
    // value per consecutive attribute is defined
    const compoundMatches = []
    for (const index of this.compoundIndexes.values()) {
      let first = true
      const { attributes } = index
      for (const attribute of attributes) {
        if (!matchFn({ attribute })) {
          // consecutive value not defined
          break
        }
        if (first) {
          first = false
          compoundMatches.push(index)
        }
      }
    }

    return { simpleMatches, compoundMatches }
  }

  _matchDocument({ attribute, attributeValues, doc }: any) {
    // get attribute value from document
    const value = this._dereferenceAttribute({ attribute, doc })
    if (value === undefined) {
      return false
    }

    // get set of values
    let valueSet = attributeValues.get(attribute)
    if (!valueSet) {
      attributeValues.set(attribute, (valueSet = new Set()))
    }

    // add each value in an array as a separate attribute value
    if (Array.isArray(value)) {
      value.forEach(valueSet.add, valueSet)
    } else {
      valueSet.add(value)
    }

    return true
  }

  _parseAttribute(attribute: any) {
    const keys = split(attribute)
    if (keys.length === 0) {
      throw new Error(
        `Invalid attribute "${attribute}"; it must be of the form ` +
          '"content.foo.bar".'
      )
    }
    // ensure prefix is valid
    if (!ATTRIBUTE_PREFIXES.includes(keys[0])) {
      throw new Error(
        `Attribute "${attribute}" must be prefixed with one of the ` +
          `following: ${ATTRIBUTE_PREFIXES.join(', ')}`
      )
    }
    return keys
  }

  _dereferenceAttribute({ attribute, keys, doc }: any): any {
    keys = keys || this._parseAttribute(attribute)
    let value = doc
    while (keys.length > 0) {
      if (!(value && typeof value === 'object')) {
        return undefined
      }
      const key = keys.shift()
      value = value[key]
      if (Array.isArray(value)) {
        // there are more keys, so recurse into array
        return value
          .map((v: any) =>
            this._dereferenceAttribute({ keys: keys.slice(), doc: v })
          )
          .filter((v: any) => v !== undefined)
      }
    }
    return value
  }
}

export function assertHmac(hmac: any) {
  if (!(
    hmac &&
    typeof hmac === 'object' &&
    typeof hmac.id === 'string' &&
    typeof hmac.sign === 'function' &&
    typeof hmac.verify === 'function'
  )) {
    throw new TypeError(
      '"hmac" must be an object with "id", "sign", and "verify" properties.'
    )
  }
}
