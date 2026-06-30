/*!
 * Copyright (c) 2018-2025 Digital Bazaar, Inc. All rights reserved.
 */
/**
 * Transport-free JWE codec for EDV documents. Encapsulates the encrypt /
 * decrypt primitives -- and the index-attribute blinding that travels with
 * them -- so that a caller which owns its own transport (for example, Wallet
 * Attached Storage, whose `Collection` / `Resource` is the transport) can turn
 * cleartext documents into EDV envelopes, and back, without driving any I/O.
 *
 * `EdvClientCore` owns one of these (exposed as `documentCipher`); its public
 * `insert` / `update` / `get` / `find` simply bracket these primitives with
 * `Transport` calls.
 */
import { assert } from './assert.js'
import { Cipher } from '@interop/minimal-cipher'
import type {
  IEDVDocument,
  IEncryptedDocument,
  IHMAC,
  IKeyAgreementKey,
  IKeyResolver,
  IRecipientTemplate
} from '@interop/data-integrity-core'

export class EdvDocumentCipher {
  cipher: Cipher
  indexHelper: any

  /**
   * Creates a document cipher. Pairs a JWE `cipher` with an optional
   * `indexHelper`; the latter is only consulted by `encrypt` when an `hmac` is
   * supplied (to blind indexable attributes), so callers that do not index --
   * such as a WAS encrypted collection -- may omit it.
   *
   * @param options {object}
   * @param options.cipher {Cipher}        the JWE cipher (from `minimal-cipher`)
   * @param [options.indexHelper] {object} blinds indexable attributes when an
   *   `hmac` is given to `encrypt`
   */
  constructor({
    cipher,
    indexHelper
  }: {
    cipher: Cipher
    indexHelper?: any
  }) {
    this.cipher = cipher
    this.indexHelper = indexHelper
  }

  /**
   * Builds the default JWE recipient list for a key agreement key, using the
   * only supported algorithm (`ECDH-ES+A256KW`). Returns an empty array if no
   * key is given.
   *
   * @param keyAgreementKey {IKeyAgreementKey}   the recipient key
   * @returns {IRecipientTemplate[]}
   */
  createDefaultRecipients(
    keyAgreementKey: IKeyAgreementKey
  ): IRecipientTemplate[] {
    return keyAgreementKey
      ? [
          {
            header: {
              kid: keyAgreementKey.id,
              // only supported algorithm
              alg: 'ECDH-ES+A256KW'
            }
          }
        ]
      : []
  }

  /**
   * Decrypts an encrypted document, returning a working document that includes
   * its cleartext `content` (and `meta` / `stream`).
   *
   * @param options {object}
   * @param options.encryptedDoc {IEncryptedDocument}   the encrypted document
   * @param [options.keyAgreementKey] {IKeyAgreementKey}   the key for unwrapping
   *   the content encryption key
   * @returns {Promise<IEDVDocument>}
   */
  async decrypt({
    encryptedDoc,
    keyAgreementKey
  }: {
    encryptedDoc: IEncryptedDocument
    keyAgreementKey?: IKeyAgreementKey
  }): Promise<IEDVDocument> {
    // validate `encryptedDoc`
    assert(encryptedDoc, 'encryptedDoc', 'object')
    assert(encryptedDoc.id, 'encryptedDoc.id', 'string')
    assert(encryptedDoc.jwe, 'encryptedDoc.jwe', 'object')

    // decrypt doc content
    const { cipher } = this
    const { jwe } = encryptedDoc
    const data: any = await cipher.decryptObject({
      jwe,
      keyAgreementKey: keyAgreementKey as IKeyAgreementKey
    })
    if (data === null) {
      throw new Error('Decryption failed.')
    }
    const { content, meta, stream } = data
    // append decrypted content, meta, and stream
    const doc: IEDVDocument = { ...encryptedDoc, content, meta }
    if (stream !== undefined) {
      doc.stream = stream
    }
    return doc
  }

  /**
   * Encrypts a document's (clear) `content`, `meta`, and `stream` into a JWE
   * envelope, blinding any indexable attributes when an `hmac` is supplied, and
   * managing the document `sequence` (incremented on update, pinned to `0` on
   * insert).
   *
   * @param options {object}
   * @param options.doc {IEDVDocument}              the document to encrypt
   * @param [options.recipients] {IRecipientTemplate[]}   JWE recipients; merged
   *   with any recipients already on `doc.jwe`
   * @param [options.keyResolver] {IKeyResolver}    resolves a key ID to a DH
   *   public key
   * @param [options.hmac] {IHMAC}                  blinds indexable attributes;
   *   when absent, indexing is skipped
   * @param [options.update] {boolean}              `true` to advance `sequence`
   *   (an existing document), `false` for a fresh insert
   * @returns {Promise<IEncryptedDocument>}
   */
  async encrypt({
    doc,
    recipients,
    keyResolver,
    hmac,
    update
  }: {
    doc: IEDVDocument
    recipients?: IRecipientTemplate[]
    keyResolver?: IKeyResolver
    hmac?: IHMAC
    update?: boolean
  }): Promise<IEncryptedDocument> {
    const encrypted: any = { ...doc }
    if (!encrypted.meta) {
      encrypted.meta = {}
    }

    /* Note: There is an assumption that EDVs will be ported in their
    entirety. If the contents of a single EDV document is to be copied to
    another EDV, it should receive a new EDV document ID on the target EDV. No
    EDV document with the same ID should live on more than one EDV unless those
    EDVs are intended to be mirrors of one another. This reduces
    synchronization issues to a sequence number instead of something more
    complicated involving digests and other synchronization complexities. */

    if (update) {
      if ('sequence' in encrypted) {
        // Sequence is limited to MAX_SAFE_INTEGER - 1 to avoid unexpected
        // behavior when a client attempts to increment the sequence number.
        if (!Number.isSafeInteger(encrypted.sequence)) {
          throw new Error('"sequence" must be a non-negative safe integer.')
        }
        if (!(encrypted.sequence < Number.MAX_SAFE_INTEGER - 1)) {
          throw new Error('"sequence" is too large.')
        }
        encrypted.sequence++
      } else {
        encrypted.sequence = 0
      }
    } else {
      // sequence must be zero for new docs
      if ('sequence' in encrypted && encrypted.sequence !== 0) {
        throw new Error(
          `Invalid "sequence" for a new document: ${encrypted.sequence}.`
        )
      }
      encrypted.sequence = 0
    }

    const { cipher, indexHelper } = this

    // include existing recipients
    if (encrypted.jwe && encrypted.jwe.recipients) {
      const prev = encrypted.jwe.recipients.slice()
      if (recipients) {
        // add any new recipients
        for (const recipient of recipients) {
          if (!_findRecipient(prev, recipient)) {
            prev.push(recipient)
          }
        }
      }
      recipients = prev
    } else if (!(Array.isArray(recipients) && recipients.length > 0)) {
      throw new TypeError('"recipients" must be a non-empty array.')
    }

    // update indexed entries and jwe
    const { content, meta, stream } = doc
    const obj: any = { content, meta }
    if (stream !== undefined) {
      obj.stream = stream
    }
    const [indexed, jwe] = await Promise.all([
      hmac
        ? indexHelper.updateEntry({ hmac, doc: encrypted })
        : doc.indexed || [],
      cipher.encryptObject({
        obj,
        recipients: recipients as IRecipientTemplate[],
        keyResolver: keyResolver as IKeyResolver
      })
    ])
    delete encrypted.content
    delete encrypted.meta
    if (encrypted.stream) {
      encrypted.stream = {
        sequence: encrypted.stream.sequence,
        chunks: encrypted.stream.chunks
      }
    }
    encrypted.indexed = indexed
    encrypted.jwe = jwe
    return encrypted
  }
}

function _findRecipient(recipients: any, recipient: any) {
  const { kid, alg } = recipient.header
  return recipients.find(
    (entry: any) => entry.header.kid === kid && entry.header.alg === alg
  )
}
