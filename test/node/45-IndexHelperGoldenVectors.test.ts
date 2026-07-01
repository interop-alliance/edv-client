/*!
 * Copyright (c) 2026 Digital Bazaar, Inc. All rights reserved.
 */
import { IndexHelper } from '../../src/IndexHelper.js'
import { IndexHelperBase } from '../../src/IndexHelperBase.js'
import { LegacyIndexHelperVersion1 } from '../../src/LegacyIndexHelperVersion1.js'
import { MockHmac } from './MockHmac.js'

/**
 * Golden vectors for the blinded attribute wire format.
 *
 * `MockHmac` is keyed with a fixed secret, so the blinded output for a given
 * `(attribute, value)` is fully deterministic. These vectors pin that output so
 * that any accidental change to the blinding internals -- in particular a change
 * that would make `LegacyIndexHelperVersion1` unable to read or migrate data
 * written by older clients, which the test suite otherwise never exercises --
 * fails loudly instead of silently breaking queries and migration.
 *
 * If a vector legitimately needs to change, that is a wire-format change: it
 * must be coordinated with the reference EDV server and a new attribute version,
 * not edited to make the test pass.
 */

// a document whose attributes are indexed below
const DOC = {
  sequence: 0,
  content: { name: 'Alice', a: '1', b: '2' }
}

// version 1 (legacy) blinded output -- MUST stay byte-compatible with data
// written by older clients so `_migrate` can read it
const V1_SIMPLE = [
  {
    name: 'G0HUHGpelLgBY5XLRHk0XH52sd0FzofZW6tVadik6Yc',
    value: 'ZlvMZfz7lrKkzfhwbbV0ccCedNXd0PnbWQXdIrXSwTI',
    unique: false
  }
]
const V1_COMPOUND = [
  {
    name: 'aR5rsLcD9NJPPRinXpyagUJbYrNzX7P1m2bf1oU-nXQ',
    value: '6MHbzr6ddaigwrp2zupyV15dc7-mYnWwLuBqJty_mVM',
    unique: false
  },
  {
    name: 'kDUPnV7Wix_9vag-ujdtR0I3YK6P794b_CGzJOVnE4k',
    value: 'VtBm3FX8G2xCU3zei3qVIhZI-1KQKtJ7I3fFetteIfI',
    unique: true
  }
]

// version 2 blinded output -- the current default wire format
const V2_SIMPLE = [
  {
    name: 'G0HUHGpelLgBY5XLRHk0XH52sd0FzofZW6tVadik6Yc',
    value: 'iG19914_8syaw3HloKuXTgprIZ-P1I3zAxLjIliey38'
  }
]
const V2_COMPOUND = [
  {
    name: '0nwLynUyJ8R9TGPnX55Y_7uM0Bj5hrHxataIl06LLa8',
    value: 'it51aWonJ53b2yIYFrQ-WMLDjUlBrHPWZokYQNjl0tI'
  },
  {
    name: 'ez81uNy_LJOQYV6cM1gw_Lcy3ewJxFltO_vURTWiAMI',
    value: 'I9raFbFsLTQ0zPlKEnbHyfckJ6ARpiaxI2nYkqmedE8',
    unique: true
  }
]

async function blindSimple(helper: any, hmac: any) {
  helper.ensureIndex({ attribute: 'content.name' })
  const entry = await helper.createEntry({ hmac, doc: DOC })
  return entry.attributes
}

async function blindCompound(helper: any, hmac: any) {
  helper.ensureIndex({ attribute: ['content.a', 'content.b'], unique: true })
  const entry = await helper.createEntry({ hmac, doc: DOC })
  return entry.attributes
}

describe('IndexHelper golden vectors', () => {
  let hmac: any
  beforeAll(async () => {
    hmac = await MockHmac.create()
  })

  describe('LegacyIndexHelperVersion1 (version 1)', () => {
    it('blinds a simple attribute to the pinned vector', async () => {
      const attributes = await blindSimple(new LegacyIndexHelperVersion1(), hmac)
      attributes.should.deep.equal(V1_SIMPLE)
    })

    it('blinds a compound attribute to the pinned vector', async () => {
      const attributes = await blindCompound(
        new LegacyIndexHelperVersion1(), hmac
      )
      attributes.should.deep.equal(V1_COMPOUND)
    })

    it('builds a query with the pinned blinded name and value', async () => {
      const helper = new LegacyIndexHelperVersion1()
      helper.ensureIndex({ attribute: 'content.name' })
      const query = await helper.buildQuery({
        hmac,
        equals: { 'content.name': 'Alice' }
      })
      query.should.deep.equal({
        index: 'urn:mockhmac:1',
        equals: [{ [V1_SIMPLE[0].name]: V1_SIMPLE[0].value }]
      })
    })
  })

  describe('IndexHelper (version 2)', () => {
    it('blinds a simple attribute to the pinned vector', async () => {
      const attributes = await blindSimple(new IndexHelper(), hmac)
      attributes.should.deep.equal(V2_SIMPLE)
    })

    it('blinds a compound attribute to the pinned vector', async () => {
      const attributes = await blindCompound(new IndexHelper(), hmac)
      attributes.should.deep.equal(V2_COMPOUND)
    })

    it('builds a query with the pinned blinded name and value', async () => {
      const helper = new IndexHelper()
      helper.ensureIndex({ attribute: 'content.name' })
      const query = await helper.buildQuery({
        hmac,
        equals: { 'content.name': 'Alice' }
      })
      query.should.deep.equal({
        index: 'urn:mockhmac:1',
        equals: [{ [V2_SIMPLE[0].name]: V2_SIMPLE[0].value }]
      })
    })
  })

  describe('version 1 vs version 2 divergence', () => {
    it('shares the blinded name but diverges on the blinded value', () => {
      // the name is HMAC(sha256(attributeName)) in both versions...
      V1_SIMPLE[0].name.should.equal(V2_SIMPLE[0].name)
      // ...but the value salting differs, so the two MUST NOT collapse into a
      // single implementation
      V1_SIMPLE[0].value.should.not.equal(V2_SIMPLE[0].value)
    })
  })

  describe('shared base', () => {
    it('both helpers extend IndexHelperBase', () => {
      new LegacyIndexHelperVersion1().should.be.an.instanceof(IndexHelperBase)
      new IndexHelper().should.be.an.instanceof(IndexHelperBase)
    })
  })
})
