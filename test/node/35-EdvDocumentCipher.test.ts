/*!
 * Copyright (c) 2025 Digital Bazaar, Inc. All rights reserved.
 */
import { EdvClient, EdvClientCore, EdvDocumentCipher } from '../../src/index.js'
import { Cipher } from '@interop/minimal-cipher'
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
})
