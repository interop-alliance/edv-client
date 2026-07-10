/*!
 * Copyright (c) 2018-2026 Digital Bazaar, Inc. All rights reserved.
 */
import { EdvClientCore, Transport } from '../../src/index.js'
import { MockHmac } from './MockHmac.js'

/**
 * A Transport stub that records the query passed to `find` and returns a
 * canned result, so cursor plumbing can be asserted without a live server.
 */
class StubTransport extends Transport {
  lastQuery: any
  result: any
  constructor({ result }: { result: any }) {
    super()
    this.result = result
  }
  async find({ query }: { query?: any } = {}): Promise<any> {
    this.lastQuery = query
    return this.result
  }
}

describe('EdvClientCore find cursor pagination', () => {
  let hmac: any = null
  beforeAll(async () => {
    hmac = await MockHmac.create()
  })

  it('copies the cursor option onto the query sent to the transport', async () => {
    const core = new EdvClientCore({ hmac })
    core.ensureIndex({ attribute: 'content.indexedKey' })
    const transport = new StubTransport({ result: { documentIds: [] } })
    await core.find({
      has: 'content.indexedKey',
      returnDocuments: false,
      cursor: 'opaque-cursor-token',
      transport
    })
    should.exist(transport.lastQuery.cursor)
    transport.lastQuery.cursor.should.equal('opaque-cursor-token')
  })

  it('surfaces the server cursor on the return value', async () => {
    const core = new EdvClientCore({ hmac })
    core.ensureIndex({ attribute: 'content.indexedKey' })
    const transport = new StubTransport({
      result: { documentIds: [], hasMore: true, cursor: 'next-page-cursor' }
    })
    const result = await core.find({
      has: 'content.indexedKey',
      returnDocuments: false,
      transport
    })
    should.exist(result.cursor)
    result.cursor.should.equal('next-page-cursor')
    result.hasMore.should.equal(true)
  })

  it('leaves cursor absent from query and result when not provided', async () => {
    const core = new EdvClientCore({ hmac })
    core.ensureIndex({ attribute: 'content.indexedKey' })
    const transport = new StubTransport({ result: { documentIds: [] } })
    const result = await core.find({
      has: 'content.indexedKey',
      returnDocuments: false,
      transport
    })
    should.not.exist(transport.lastQuery.cursor)
    should.not.exist(result.cursor)
  })
})
