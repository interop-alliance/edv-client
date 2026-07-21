/*!
 * Copyright (c) 2018-2023 Digital Bazaar, Inc. All rights reserved.
 */
import { EdvClient, EdvDocument } from '../../src/index.js'
import { isNewEDV, isRecipient } from './test-utils.js'
import { base64url } from '../../src/baseX.js'
import mock from './mock.js'

function getRandomUint8({ size = 50 } = {}) {
  return new Uint8Array(size).map(() => Math.floor(Math.random() * 255))
}

// reads a decrypt `ReadableStream` fully into a single Uint8Array
async function readAll(readable) {
  const reader = readable.getReader()
  let data = new Uint8Array(0)
  let done = false
  while (!done) {
    const { value, done: _done } = await reader.read()
    if (value) {
      const next = new Uint8Array(data.length + value.length)
      next.set(data)
      next.set(value, data.length)
      data = next
    }
    done = _done
  }
  return data
}

// parses the (base64url) JWE protected header into an object
function parseProtectedHeader(jwe) {
  const decoded = new TextDecoder().decode(base64url.decode(jwe.protected))
  return JSON.parse(decoded)
}

// returns the stored chunk entries for a doc id, ordered by chunk index; each
// value is the mock's stored request body whose `json` holds the chunk
function storedChunksFor(docId) {
  const entries = []
  for (const [route, value] of mock.edvStorage.chunks) {
    if (route.includes(`/documents/${docId}/chunks/`)) {
      entries.push({ route, value })
    }
  }
  entries.sort((left, right) => left.value.json.index - right.value.json.index)
  return entries
}

const cipherVersions = ['recommended', 'fips']

describe('EDV Stream Tests', function () {
  let invocationSigner = null
  let keyResolver = null
  beforeAll(async () => {
    await mock.init()
    invocationSigner = mock.invocationSigner
    keyResolver = mock.keyResolver
  })
  afterAll(async () => {
    await mock.server.shutdown()
  })

  cipherVersions.forEach(cipherVersion => {
    describe(`"${cipherVersion}" cipher version`, () => {
      it('should insert a document with a stream', async () => {
        const client = await mock.createEdv({ cipherVersion })
        const testId = await EdvClient.generateId()
        const doc = { id: testId, content: { someKey: 'someValue' } }
        const data = getRandomUint8()
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(data)
            controller.close()
          }
        })
        const inserted = await client.insert({
          keyResolver,
          invocationSigner,
          doc,
          stream
        })
        const hmac = {
          id: client.hmac.id,
          type: client.hmac.type
        }

        // Streams are added in an update
        // after the initial document has been written
        // hence the sequence is 1 and not 0.
        isNewEDV({ hmac, inserted, testId, sequence: 1 })
        isRecipient({ recipient: inserted.jwe.recipients[0], cipherVersion })
        inserted.content.should.deep.equal({ someKey: 'someValue' })
        should.exist(inserted.stream)
        inserted.stream.should.have.keys('sequence', 'chunks')
      })

      it('should be able to decrypt a stream from an EdvDocument', async () => {
        const { invocationSigner, keyResolver } = mock
        const client = await mock.createEdv({ cipherVersion })
        client.ensureIndex({ attribute: 'content.indexedKey' })
        const testId = await EdvClient.generateId()
        const doc = { id: testId, content: { indexedKey: 'value1' } }
        const data = getRandomUint8()
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(data)
            controller.close()
          }
        })
        await client.insert({ doc, stream, invocationSigner, keyResolver })
        const edvDoc = new EdvDocument({
          invocationSigner,
          id: doc.id,
          keyAgreementKey: client.keyAgreementKey,
          capability: {
            id: `${client.id}`,
            invocationTarget: `${client.id}/documents/${doc.id}`
          },
          cipherVersion
        })
        const result = await edvDoc.read()
        result.should.be.an('object')
        result.content.should.eql({ indexedKey: 'value1' })
        should.exist(result.stream)
        result.stream.should.be.an('object')
        const expectedStream = await edvDoc.getStream({ doc: result })
        const reader = expectedStream.getReader()
        let streamData = new Uint8Array(0)
        let done = false
        while (!done) {
          // value is either undefined or a Uint8Array
          const { value, done: _done } = await reader.read()
          // if there is a chunk then we need to update the streamData
          if (value) {
            // create a new array with the new length
            const next = new Uint8Array(streamData.length + value.length)
            // set the first values to the existing chunk
            next.set(streamData)
            // set the chunk's values to the rest of the array
            next.set(value, streamData.length)
            // update the streamData
            streamData = next
          }
          done = _done
        }
      })
      it('should be able to write a stream to an EdvDocument', async () => {
        const { invocationSigner, keyResolver } = mock
        const client = await mock.createEdv({ cipherVersion })
        client.ensureIndex({ attribute: 'content.indexedKey' })
        const docId = await EdvClient.generateId()
        const doc = { id: docId, content: { indexedKey: 'value2' } }
        await client.insert({ doc, invocationSigner, keyResolver })
        const edvDoc = new EdvDocument({
          invocationSigner,
          id: doc.id,
          keyAgreementKey: client.keyAgreementKey,
          capability: {
            id: `${client.id}`,
            invocationTarget: `${client.id}/documents/${doc.id}`
          },
          cipherVersion
        })
        const data = getRandomUint8()
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(data)
            controller.close()
          }
        })
        const result = await edvDoc.write({
          doc,
          stream,
          invocationSigner,
          keyResolver
        })
        result.should.be.an('object')
        result.content.should.deep.equal({ indexedKey: 'value2' })
        should.exist(result.stream)
        const expectedStream = await edvDoc.getStream({ doc: result })
        const reader = expectedStream.getReader()
        let streamData = new Uint8Array(0)
        let done = false
        while (!done) {
          // value is either undefined or a Uint8Array
          const { value, done: _done } = await reader.read()
          // if there is a chunk then we need to update the streamData
          if (value) {
            // create a new array with the new length
            const next = new Uint8Array(streamData.length + value.length)
            // set the first values to the existing chunk
            next.set(streamData)
            // set the chunk's values to the rest of the array
            next.set(value, streamData.length)
            // update the streamData
            streamData = next
          }
          done = _done
        }
      })
      it('should throw error if document chunk does not exist', async () => {
        const { invocationSigner, keyResolver } = mock
        const client = await mock.createEdv({ cipherVersion })
        client.ensureIndex({ attribute: 'content.indexedKey' })
        const docId = await EdvClient.generateId()
        const doc = { id: docId, content: { indexedKey: 'value3' } }
        const data = getRandomUint8()
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(data)
            controller.close()
          }
        })
        await client.insert({ doc, invocationSigner, keyResolver, stream })
        const edvDoc = new EdvDocument({
          invocationSigner,
          id: doc.id,
          keyAgreementKey: client.keyAgreementKey,
          capability: {
            id: `${client.id}`,
            invocationTarget: `${client.id}/documents/${doc.id}`
          },
          cipherVersion
        })
        const result = await edvDoc.read()

        result.should.be.an('object')
        result.content.should.eql({ indexedKey: 'value3' })
        should.exist(result.stream)
        result.stream.should.be.an('object')

        // intentionally clear the database for chunks
        mock.edvStorage.chunks.clear()

        const expectedStream = await edvDoc.getStream({ doc: result })
        const reader = expectedStream.getReader()
        let streamData = new Uint8Array(0)
        let done = false
        let err
        try {
          while (!done) {
            // value is either undefined or a Uint8Array
            const { value, done: _done } = await reader.read()
            // if there is a chunk then we need to update the streamData
            if (value) {
              // create a new array with the new length
              const next = new Uint8Array(streamData.length + value.length)
              // set the first values to the existing chunk
              next.set(streamData)
              // set the chunk's values to the rest of the array
              next.set(value, streamData.length)
              // update the streamData
              streamData = next
            }
            done = _done
          }
        } catch (e) {
          err = e
        }
        should.exist(err)
        err.name.should.equal('NotFoundError')
        err.message.should.equal('Document chunk not found.')
      })
    })
  })

  describe('chunked-stream AAD binding', () => {
    it('binds chunks by default (multi-chunk round-trip, in order)', async () => {
      const { invocationSigner, keyResolver } = mock
      const client = await mock.createEdv()
      const testId = await EdvClient.generateId()
      const doc = { id: testId, content: { someKey: 'someValue' } }
      // 60 bytes at a 20-byte chunk size yields three chunks
      const data = getRandomUint8({ size: 60 })
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(data)
          controller.close()
        }
      })
      const inserted = await client.insert({
        doc,
        stream,
        chunkSize: 20,
        invocationSigner,
        keyResolver
      })
      inserted.stream.chunks.should.equal(3)

      // every chunk's shared protected header advertises `caad: 1`
      const chunks = storedChunksFor(testId)
      chunks.length.should.equal(3)
      for (const { value } of chunks) {
        const header = parseProtectedHeader(value.json.jwe)
        header.caad.should.equal(1)
      }

      // the chunks decrypt, in order, back to the original bytes
      const edvDoc = new EdvDocument({
        invocationSigner,
        id: doc.id,
        keyAgreementKey: client.keyAgreementKey,
        capability: {
          id: `${client.id}`,
          invocationTarget: `${client.id}/documents/${doc.id}`
        }
      })
      const result = await edvDoc.read()
      const roundTripped = await readAll(
        await edvDoc.getStream({ doc: result })
      )
      roundTripped.should.deep.equal(data)
    })

    it('fails the read when two bound chunks are swapped', async () => {
      const { invocationSigner, keyResolver } = mock
      const client = await mock.createEdv()
      const testId = await EdvClient.generateId()
      const doc = { id: testId, content: { someKey: 'someValue' } }
      const data = getRandomUint8({ size: 60 })
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(data)
          controller.close()
        }
      })
      const result = await client.insert({
        doc,
        stream,
        chunkSize: 20,
        invocationSigner,
        keyResolver
      })

      // a malicious server swaps the ciphertext of chunk 0 and chunk 1; with
      // per-chunk AAD binding each now decrypts under the wrong index
      const chunks = storedChunksFor(testId)
      const firstJwe = chunks[0].value.json.jwe
      chunks[0].value.json.jwe = chunks[1].value.json.jwe
      chunks[1].value.json.jwe = firstJwe

      const edvDoc = new EdvDocument({
        invocationSigner,
        id: doc.id,
        keyAgreementKey: client.keyAgreementKey,
        capability: {
          id: `${client.id}`,
          invocationTarget: `${client.id}/documents/${doc.id}`
        }
      })
      let err
      try {
        await readAll(await edvDoc.getStream({ doc: result }))
      } catch (caught) {
        err = caught
      }
      should.exist(err)
    })

    it('writes legacy-format chunks when chunkedAad is false', async () => {
      const { invocationSigner, keyResolver } = mock
      const client = await mock.createEdv()
      const testId = await EdvClient.generateId()
      const doc = { id: testId, content: { someKey: 'someValue' } }
      const data = getRandomUint8({ size: 60 })
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(data)
          controller.close()
        }
      })
      const inserted = await client.insert({
        doc,
        stream,
        chunkSize: 20,
        chunkedAad: false,
        invocationSigner,
        keyResolver
      })
      inserted.stream.chunks.should.equal(3)

      // legacy chunks carry no `caad` marker in their protected header
      const chunks = storedChunksFor(testId)
      for (const { value } of chunks) {
        const header = parseProtectedHeader(value.json.jwe)
        should.not.exist(header.caad)
      }

      // and still round-trip to the original bytes
      const edvDoc = new EdvDocument({
        invocationSigner,
        id: doc.id,
        keyAgreementKey: client.keyAgreementKey,
        capability: {
          id: `${client.id}`,
          invocationTarget: `${client.id}/documents/${doc.id}`
        }
      })
      const result = await edvDoc.read()
      const roundTripped = await readAll(
        await edvDoc.getStream({ doc: result })
      )
      roundTripped.should.deep.equal(data)
    })
  })
})
