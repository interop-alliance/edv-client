/*!
 * Copyright (c) 2025 Digital Bazaar, Inc. All rights reserved.
 */
import { EdvClient, EdvClientCore, EdvDocumentCipher } from '../../src/index.js'
import { Cipher } from '@interop/minimal-cipher'
import { assertDocId } from '../../src/assert.js'
import { IndexHelper } from '../../src/IndexHelper.js'
import mock from './mock.js'

describe('EdvDocumentCipher', () => {
  let keyAgreementKey = null
  let keyResolver = null

  beforeAll(async () => {
    await mock.init()
    keyAgreementKey = mock.keys.keyAgreementKey
    keyResolver = mock.keyResolver
  })

  afterAll(async () => {
    await mock.server.shutdown()
  })

  it('round-trips a document with no transport', async () => {
    const documentCipher = new EdvDocumentCipher({
      cipher: new Cipher(),
      indexHelper: new IndexHelper()
    })
    const id = await EdvClient.generateId()
    const recipients = documentCipher.createDefaultRecipients(keyAgreementKey)

    const encrypted = await documentCipher.encrypt({
      doc: { id, content: { secret: 'value' } },
      recipients,
      keyResolver,
      update: false
    })
    // the envelope must not leak cleartext
    encrypted.id.should.equal(id)
    encrypted.sequence.should.equal(0)
    encrypted.jwe.should.be.an('object')
    should.not.exist(encrypted.content)

    const decrypted = await documentCipher.decrypt({
      encryptedDoc: encrypted,
      keyAgreementKey
    })
    decrypted.content.should.deep.equal({ secret: 'value' })
  })

  it('createDefaultRecipients() returns [] without a key', async () => {
    const documentCipher = new EdvDocumentCipher({ cipher: new Cipher() })
    documentCipher.createDefaultRecipients(undefined).should.deep.equal([])
  })

  it('increments sequence on update', async () => {
    const documentCipher = new EdvDocumentCipher({
      cipher: new Cipher(),
      indexHelper: new IndexHelper()
    })
    const id = await EdvClient.generateId()
    const recipients = documentCipher.createDefaultRecipients(keyAgreementKey)
    const inserted = await documentCipher.encrypt({
      doc: { id, content: { count: 1 } },
      recipients,
      keyResolver,
      update: false
    })
    inserted.sequence.should.equal(0)

    const updated = await documentCipher.encrypt({
      doc: { ...inserted, content: { count: 2 } },
      recipients,
      keyResolver,
      update: true
    })
    updated.sequence.should.equal(1)
  })

  it('is exposed as EdvClientCore.documentCipher', async () => {
    const core = new EdvClientCore({ keyAgreementKey, keyResolver })
    core.documentCipher.should.be.an.instanceof(EdvDocumentCipher)
    core.documentCipher.cipher.should.equal(core.cipher)
    core.documentCipher.indexHelper.should.equal(core.indexHelper)
  })

  describe('deriveId()', () => {
    let documentCipher = null

    beforeAll(() => {
      documentCipher = new EdvDocumentCipher({ cipher: new Cipher() })
    })

    async function encryptWithoutId(content) {
      const recipients = documentCipher.createDefaultRecipients(keyAgreementKey)
      return documentCipher.encrypt({
        doc: { content },
        recipients,
        keyResolver,
        update: false
      })
    }

    it('derives a deterministic id in the standard EDV id format', async () => {
      const encrypted = await encryptWithoutId({ secret: 'value' })
      const id = await documentCipher.deriveId({ jwe: encrypted.jwe })

      // deterministic: same envelope, same id
      id.should.equal(await documentCipher.deriveId({ jwe: encrypted.jwe }))
      // instance method delegates to the static
      id.should.equal(await EdvDocumentCipher.deriveId({ jwe: encrypted.jwe }))
      // same multibase identity layout as generateId(): assertDocId accepts it
      assertDocId(id)
    })

    it('supports the encrypt-then-stamp flow', async () => {
      const encrypted = await encryptWithoutId({ secret: 'value' })
      encrypted.id = await documentCipher.deriveId({ jwe: encrypted.jwe })

      const decrypted = await documentCipher.decrypt({
        encryptedDoc: encrypted,
        keyAgreementKey
      })
      decrypted.id.should.equal(encrypted.id)
      decrypted.content.should.deep.equal({ secret: 'value' })
    })

    it('yields distinct ids for distinct ciphertexts', async () => {
      const first = await encryptWithoutId({ secret: 'one' })
      const second = await encryptWithoutId({ secret: 'two' })
      const firstId = await documentCipher.deriveId({ jwe: first.jwe })
      const secondId = await documentCipher.deriveId({ jwe: second.jwe })
      firstId.should.not.equal(secondId)
    })

    it('is stable when a recipient is added (ciphertext-only hash)', async () => {
      const encrypted = await encryptWithoutId({ secret: 'value' })
      const id = await documentCipher.deriveId({ jwe: encrypted.jwe })

      // simulate re-wrapping the CEK for an extra recipient: only
      // `jwe.recipients` changes, the ciphertext does not
      const withExtraRecipient = {
        ...encrypted.jwe,
        recipients: [
          ...encrypted.jwe.recipients,
          { header: { kid: 'did:key:extra', alg: 'ECDH-ES+A256KW' } }
        ]
      }
      const idAfter = await documentCipher.deriveId({
        jwe: withExtraRecipient
      })
      idAfter.should.equal(id)
    })

    it('rejects a jwe without a ciphertext', async () => {
      let error = null
      try {
        await documentCipher.deriveId({ jwe: {} })
      } catch (err) {
        error = err
      }
      should.exist(error)
      error.should.be.an.instanceof(TypeError)
      error.message.should.match(/ciphertext/)
    })
  })
})
