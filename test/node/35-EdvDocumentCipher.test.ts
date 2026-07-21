/*!
 * Copyright (c) 2025 Digital Bazaar, Inc. All rights reserved.
 */
import { EdvClient, EdvClientCore, EdvDocumentCipher } from '../../src/index.js'
import { Cipher, KeyMissError } from '@interop/minimal-cipher'
import { assertDocId } from '../../src/assert.js'
import { base64url } from '../../src/baseX.js'
import { IndexHelper } from '../../src/IndexHelper.js'
import mock from './mock.js'

function parseProtectedHeader(jwe) {
  const decoded = new TextDecoder().decode(base64url.decode(jwe.protected))
  return JSON.parse(decoded)
}

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

  it('throws KeyMissError when the key does not open the envelope', async () => {
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

    // decrypting with a key that is not a recipient must fail with a typed
    // KeyMissError rather than a generic Error
    let err
    try {
      await documentCipher.decrypt({
        encryptedDoc: encrypted,
        keyAgreementKey: mock.keys.fips.keyAgreementKey
      })
    } catch (caught) {
      err = caught
    }
    should.exist(err)
    err.should.be.an.instanceof(KeyMissError)
    err.name.should.equal('KeyMissError')
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

  it('forwards additionalProtectedParams into the JWE protected header', async () => {
    const documentCipher = new EdvDocumentCipher({
      cipher: new Cipher(),
      indexHelper: new IndexHelper()
    })
    const id = await EdvClient.generateId()
    const recipients = documentCipher.createDefaultRecipients(keyAgreementKey)
    const was = { v: 1, res: id }

    const encrypted = await documentCipher.encrypt({
      doc: { id, content: { secret: 'value' } },
      recipients,
      keyResolver,
      update: false,
      additionalProtectedParams: { was }
    })

    // the extra members are visible (and AEAD-authenticated) in the header
    const header = parseProtectedHeader(encrypted.jwe)
    header.was.should.deep.equal(was)
    // reserved `enc` remains intact alongside the extra member
    header.enc.should.be.a('string')

    // the header is the AAD, so a successful decrypt proves it authentic
    const decrypted = await documentCipher.decrypt({
      encryptedDoc: encrypted,
      keyAgreementKey
    })
    decrypted.content.should.deep.equal({ secret: 'value' })
  })

  it('decrypt prefers the sealed stream state over the cleartext copy', async () => {
    const documentCipher = new EdvDocumentCipher({
      cipher: new Cipher(),
      indexHelper: new IndexHelper()
    })
    const id = await EdvClient.generateId()
    const recipients = documentCipher.createDefaultRecipients(keyAgreementKey)

    const encrypted = await documentCipher.encrypt({
      doc: {
        id,
        content: { secret: 'value' },
        stream: { sequence: 0, chunks: 3 }
      },
      recipients,
      keyResolver,
      update: false
    })
    // the encrypted envelope carries a cleartext `stream` copy
    encrypted.stream.should.deep.equal({ sequence: 0, chunks: 3 })

    // a malicious server lowers the cleartext chunk count to truncate reads
    encrypted.stream.chunks = 1

    // after decrypt the authenticated (sealed) count wins over the tampered
    // cleartext copy
    const decrypted = await documentCipher.decrypt({
      encryptedDoc: encrypted,
      keyAgreementKey
    })
    decrypted.stream.chunks.should.equal(3)
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
