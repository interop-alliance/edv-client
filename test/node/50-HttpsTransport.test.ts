/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * Characterization tests for `HttpsTransport`.
 *
 * These pin the current behavior of `HttpsTransport` -- especially the
 * branches that the `EdvClient` happy-path suites never reach -- so that an
 * upcoming refactor of the `Transport` / `HttpsTransport` relationship has a
 * safety net. Where current behavior is a known bug, the test says so in a
 * comment rather than silently encoding it as correct.
 */
import { BASE_URL, default as mock } from './mock.js'
import { HttpsTransport } from '../../src/index.js'

describe('HttpsTransport (characterization)', () => {
  let invocationSigner: any = null
  const edvId = `${BASE_URL}/edvs/characterization-edv`
  // capture the most recent request bodies for the extra routes below
  let lastConfigPost: any = null
  let lastIndexPost: any = null

  beforeAll(async () => {
    await mock.init()
    invocationSigner = mock.invocationSigner

    // The shared MockStorage registers no routes for `updateConfig`
    // (POST /edvs/:edvId) or `updateIndex` (POST .../documents/:docId/index),
    // because the existing EdvClient suites never reach those transport
    // methods. Register minimal handlers so we can pin their request behavior.
    mock.server.post(`${BASE_URL}/edvs/:edvId`, (request: any) => {
      lastConfigPost = request
      return [200, undefined, JSON.parse(request.requestBody).json]
    })
    mock.server.post(
      `${BASE_URL}/edvs/:edvId/documents/:docId/index`,
      (request: any) => {
        lastIndexPost = request
        return [204, undefined]
      }
    )
    // A document route that always reports a write conflict, used to drive the
    // `_signedHttpPost` non-insert (InvalidStateError) branch.
    mock.server.post(`${BASE_URL}/edvs/conflict/documents/:docId`, () => {
      return [409, undefined]
    })
  })
  afterAll(async () => {
    await mock.server.shutdown()
  })

  describe('updateConfig', () => {
    it('posts the new config to the EDV id url', async () => {
      const transport = new HttpsTransport({ edvId, invocationSigner })
      const config = { id: edvId, sequence: 1, controller: invocationSigner.id }
      lastConfigPost = null
      await transport.updateConfig({ config })
      should.exist(lastConfigPost)
      lastConfigPost.route.should.equal(edvId)
      JSON.parse(lastConfigPost.requestBody).json.sequence.should.equal(1)
    })

    it('throws when neither edvId nor capability is given', async () => {
      const transport = new HttpsTransport({ invocationSigner })
      let err
      try {
        await transport.updateConfig({ config: { sequence: 1 } })
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.should.be.instanceOf(TypeError)
    })
  })

  describe('updateIndex', () => {
    it('posts the index entry to the document index url', async () => {
      const transport = new HttpsTransport({ edvId, invocationSigner })
      const docId = 'doc-123'
      const entry = { sequence: 0, hmac: { id: 'hmac-1' }, attributes: [] }
      lastIndexPost = null
      await transport.updateIndex({ docId, entry })
      should.exist(lastIndexPost)
      lastIndexPost.route.should.equal(`${edvId}/documents/${docId}/index`)
      JSON.parse(lastIndexPost.requestBody).json.should.eql(entry)
    })
  })

  describe('_signedHttpPost conflict handling', () => {
    it('update throws InvalidStateError on a 409 conflict', async () => {
      const transport = new HttpsTransport({
        edvId: `${BASE_URL}/edvs/conflict`,
        invocationSigner
      })
      let err: any
      try {
        await transport.update({ encrypted: { id: 'doc-x', sequence: 1 } })
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.name.should.equal('InvalidStateError')
      err.message.should.equal('Conflict error.')
    })
  })

  describe('argument guards', () => {
    it('getConfig throws when neither id nor capability is given', async () => {
      const transport = new HttpsTransport({ invocationSigner })
      let err
      try {
        await transport.getConfig({})
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.should.be.instanceOf(TypeError)
    })

    it('find throws when neither capability nor edvId is given', async () => {
      const transport = new HttpsTransport({ invocationSigner })
      let err: any
      try {
        await transport.find({ query: {} })
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.message.should.equal('Either "capability" or "edvId" must be given.')
    })

    it('createEdv throws when the url cannot be resolved in node', async () => {
      // no `url`, no `capability`, and no browser `self` -- so
      // `_createAbsoluteUrl('/edvs')` has nothing to resolve against.
      const transport = new HttpsTransport({ invocationSigner })
      let err
      try {
        await transport.createEdv({ config: { sequence: 0 } })
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.message.should.equal('"url" must be an absolute URL.')
    })
  })

  describe('_getInvocationTarget', () => {
    it('returns null when capability is null or undefined', () => {
      should.equal(
        HttpsTransport._getInvocationTarget({ capability: null }),
        null
      )
      should.equal(HttpsTransport._getInvocationTarget({}), null)
    })

    it('extracts invocationTarget from an object capability', () => {
      const target = `${BASE_URL}/edvs/abc/documents`
      HttpsTransport._getInvocationTarget({
        capability: { invocationTarget: target }
      }).should.equal(target)
    })

    it('throws if a string capability is not a root zcap', () => {
      let err: any
      try {
        HttpsTransport._getInvocationTarget({ capability: 'not-a-root-zcap' })
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.message.should.contain('root capability')
    })

    it('throws TypeError if invocationTarget is not a URL', () => {
      let err
      try {
        HttpsTransport._getInvocationTarget({
          capability: { invocationTarget: 'no-colon-here' }
        })
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.should.be.instanceOf(TypeError)
    })

    // Decodes a string root zcap to its bare invocation target URL, stripping
    // the `urn:zcap:root:` prefix. This previously returned the un-stripped
    // urn because the code called `substring(ZCAP_ROOT_PREFIX)` (a string,
    // coerced to NaN -> 0) instead of `substring(ZCAP_ROOT_PREFIX.length)`.
    it('decodes a string root zcap to its bare invocation target', () => {
      const target = `${BASE_URL}/edvs/abc/documents`
      const stringZcap = `urn:zcap:root:${encodeURIComponent(target)}`
      const result = HttpsTransport._getInvocationTarget({
        capability: stringZcap
      })
      result.should.equal(target)
    })
  })

  describe('_getDocUrl', () => {
    it('throws when neither capability nor edvId is available', () => {
      const transport = new HttpsTransport({ invocationSigner })
      let err
      try {
        transport._getDocUrl('doc-1', undefined)
      } catch (caught) {
        err = caught
      }
      should.exist(err)
      err.message.should.equal('Either "capability" or "edvId" must be given.')
    })

    it('appends the doc id when capability targets the documents collection', () => {
      const transport = new HttpsTransport({ invocationSigner })
      const target = `${BASE_URL}/edvs/abc/documents`
      transport
        ._getDocUrl('doc-1', { invocationTarget: target })
        .should.equal(`${target}/doc-1`)
    })

    it('returns the target as-is when it is not the documents collection', () => {
      const transport = new HttpsTransport({ invocationSigner })
      const target = `${BASE_URL}/edvs/abc/documents/doc-1`
      transport
        ._getDocUrl('doc-1', { invocationTarget: target })
        .should.equal(target)
    })

    it('builds the url from edvId when set', () => {
      const transport = new HttpsTransport({ edvId, invocationSigner })
      transport
        ._getDocUrl('doc-1', undefined)
        .should.equal(`${edvId}/documents/doc-1`)
    })
  })
})
