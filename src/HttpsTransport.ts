/*!
 * Copyright (c) 2022-2023 Digital Bazaar, Inc. All rights reserved.
 */
import { assert, assertInvocationSigner } from './assert.js'
import { DEFAULT_HEADERS, httpClient } from '@interop/http-client'
import { signCapabilityInvocation } from '@interop/http-signature-zcap-invoke'
import type {
  IEDVConfig,
  IEDVQuery,
  IEncryptedDocument,
  ISigner,
  IZcap
} from '@interop/data-integrity-core'
import { Transport } from './Transport.js'
import {
  getInvocationTarget,
  parseEdvId,
  ZCAP_ROOT_PREFIX
} from './zcapUrls.js'
import type {
  ITransportCreateEdvOptions,
  ITransportFindConfigsOptions,
  ITransportGetChunkOptions,
  ITransportStoreChunkOptions,
  ITransportUpdateIndexOptions
} from './Transport.js'

/**
 * A node.js `https.Agent` instance used to handle HTTPS requests. Typed
 * loosely because it is an environment-specific (Node-only) object.
 */
export type HttpsAgent = any

/**
 * Options for the internal `_signedHttpGet` helper.
 */
interface ISignedHttpGetOptions {
  url: string
  capability?: IZcap | string
  notFoundMessage?: string
}

/**
 * Options for the internal `_signedHttpPost` helper.
 */
interface ISignedHttpPostOptions {
  url: string
  json?: object
  capability?: IZcap | string
  capabilityAction?: string
  insert?: boolean
}

/**
 * The shape of a `find` response body, narrowed from the raw HTTP response.
 */
interface IFindResult {
  documents?: unknown[]
  documentIds?: string[]
  hasMore?: boolean
}

export class HttpsTransport extends Transport {
  capability?: IZcap | string
  defaultHeaders: Record<string, string>
  // `edvId` and `url` are URL-building plumbing passed through to the HTTP
  // client and URL helpers; kept loose to avoid threading nullability casts
  // through every request path.
  edvId: any
  httpsAgent?: HttpsAgent
  invocationSigner?: ISigner
  url: any
  _rootZcapId?: string

  /**
   * Creates a transport layer for an EDV client to use to perform an
   * operation with an EDV server over HTTPS.
   *
   * @param {object} options - The options to use.
   * @param {object|string} [options.capability] - The authorization capability
   *   (zcap) to use to authorize the operation.
   * @param {object} [options.defaultHeaders] - Default headers to use with
   *   HTTP requests.
   * @param {string} [options.edvId] - The ID of the target EDV.
   * @param {HttpsAgent} [options.httpsAgent] - A node.js `https.Agent`
   *   instance to use when making requests.
   * @param {object} [options.invocationSigner] - An object with an
   *   `id` property and a `sign` function for signing a capability invocation.
   * @param {string} [options.url] - The url to use.
   *
   * @returns {HttpsTransport} An HttpsTransport instance.
   */
  constructor({
    capability,
    defaultHeaders,
    edvId,
    httpsAgent,
    invocationSigner,
    url
  }: {
    capability?: IZcap | string
    defaultHeaders?: Record<string, string>
    edvId?: string
    httpsAgent?: HttpsAgent
    invocationSigner?: ISigner
    url?: string
  } = {}) {
    super()
    if (url !== undefined) {
      assert(url, 'url', 'string')
    }
    if (invocationSigner !== undefined) {
      assertInvocationSigner(invocationSigner)
    }
    this.capability = capability
    this.defaultHeaders = { ...DEFAULT_HEADERS, ...defaultHeaders }
    this.edvId = edvId
    this.httpsAgent = httpsAgent
    this.invocationSigner = invocationSigner
    this.url = url
    if (edvId) {
      this._rootZcapId = `${ZCAP_ROOT_PREFIX}${encodeURIComponent(edvId)}`
    }
  }

  /**
   * @inheritdoc
   */
  override async createEdv({ config }: ITransportCreateEdvOptions = {}) {
    let { capability, url } = this
    if (!url) {
      url = getInvocationTarget({ capability }) || _createAbsoluteUrl('/edvs')
    }

    // no invocationSigner was provided, submit the request without a zCap
    const { defaultHeaders, httpsAgent: agent, invocationSigner } = this
    if (!invocationSigner) {
      const response = await httpClient.post(url, {
        headers: defaultHeaders,
        json: config,
        agent
      })
      return response.data
    }

    if (!capability) {
      capability = `${ZCAP_ROOT_PREFIX}${encodeURIComponent(url)}`
    }

    // submit request w/signed zcap invocation
    const response = await this._signedHttpPost({
      url,
      json: config,
      capability,
      insert: true
    })
    return response.data
  }

  /**
   * @inheritdoc
   */
  override async getConfig({ id = this.edvId }: { id?: string } = {}) {
    const { capability } = this
    if (!(id || capability)) {
      throw new TypeError('"capability" is required if "id" was not provided.')
    }
    const url = getInvocationTarget({ capability }) || id

    const { defaultHeaders, httpsAgent: agent, invocationSigner } = this
    if (!invocationSigner) {
      // send request w/o zcap invocation
      const response = await httpClient.get(url, {
        headers: defaultHeaders,
        agent
      })
      return response.data
    }

    // send request w/ zcap invocation
    const response = await this._signedHttpGet({
      url,
      capability,
      notFoundMessage: 'Config not found.'
    })
    return response.data
  }

  /**
   * @inheritdoc
   */
  override async updateConfig({ config }: { config?: IEDVConfig } = {}) {
    const { capability, edvId } = this
    if (!(edvId || capability)) {
      throw new TypeError(
        '"capability" is required if "edvId" was not provided ' +
          'to the HttpsTransport constructor.'
      )
    }
    const url = getInvocationTarget({ capability }) || edvId

    const { defaultHeaders, httpsAgent: agent, invocationSigner } = this
    if (!invocationSigner) {
      // send request w/o zcap invocation
      await httpClient.post(url, {
        headers: defaultHeaders,
        json: config,
        agent
      })
      return
    }

    // send request w/ zcap invocation
    await this._signedHttpPost({ url, json: config, capability, insert: false })
  }

  /**
   * @inheritdoc
   */
  override async findConfigs({
    controller,
    referenceId,
    after,
    limit
  }: ITransportFindConfigsOptions = {}) {
    let { capability, url } = this
    if (!url) {
      url = getInvocationTarget({ capability }) || _createAbsoluteUrl('/edvs')
    }

    // eliminate undefined properties, to prevent expression of them using
    // the string literal `undefined`
    const searchParams: Record<string, string> = Object.fromEntries(
      Object.entries({ controller, referenceId, after, limit })
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)])
    )

    // no invocationSigner was provided, submit the request without a zCap
    const { defaultHeaders, httpsAgent: agent, invocationSigner } = this
    if (!invocationSigner) {
      // send request w/o signed zcap invocation
      const response = await httpClient.get(url, {
        searchParams,
        headers: defaultHeaders,
        agent
      })
      return response.data
    }

    if (!capability) {
      capability = `${ZCAP_ROOT_PREFIX}${encodeURIComponent(url)}`
    }

    // add params to URL so they will be signed
    url += `?${new URLSearchParams(searchParams)}`
    const response = await this._signedHttpGet({ url, capability })
    return response.data
  }

  /**
   * @inheritdoc
   */
  override async insert({ encrypted }: { encrypted?: IEncryptedDocument } = {}) {
    assert(encrypted, 'encrypted', 'object')
    // trim document ID and trailing slash to post to `/documents`
    let url = this._getDocUrl(encrypted.id, this.capability)
    if (url.endsWith(encrypted.id)) {
      url = url.slice(0, -(encrypted.id.length + 1))
    }
    await this._signedHttpPost({ url, json: encrypted, insert: true })
  }

  /**
   * @inheritdoc
   */
  override async update({ encrypted }: { encrypted?: IEncryptedDocument } = {}) {
    assert(encrypted, 'encrypted', 'object')
    const url = this._getDocUrl(encrypted.id, this.capability)
    await this._signedHttpPost({ url, json: encrypted, insert: false })
  }

  /**
   * @inheritdoc
   */
  override async updateIndex({
    docId,
    entry
  }: ITransportUpdateIndexOptions = {}) {
    const url = this._getDocUrl(docId, this.capability) + '/index'
    await this._signedHttpPost({ url, json: entry, insert: false })
  }

  /**
   * @inheritdoc
   */
  override async get({ id }: { id?: string } = {}) {
    const url = this._getDocUrl(id, this.capability)
    const response = await this._signedHttpGet({
      url,
      notFoundMessage: 'Document not found.'
    })
    return response.data
  }

  /**
   * @inheritdoc
   */
  override async find({ query }: { query?: IEDVQuery } = {}) {
    assert(query, 'query', 'object')
    const { capability, edvId } = this
    let url = getInvocationTarget({ capability })
    if (!url) {
      if (!edvId) {
        throw new Error('Either "capability" or "edvId" must be given.')
      }
      url = `${edvId}/query`
    } else if (!url.includes('/query')) {
      // note: capability with a target of `/documents` or the EDV ID,
      // can be used to query by augmenting with `/query`
      url += '/query'
    }

    // for backwards compatibility, convert `returnDocuments` to a query
    // parameter
    if (query.returnDocuments !== undefined) {
      const { returnDocuments, ...rest } = query
      query = rest
      url += `?${new URLSearchParams({ returnDocuments: String(returnDocuments) })}`
    }

    // do signed HTTP post w/'read' action
    const response = await this._signedHttpPost({
      url,
      json: query,
      capability,
      capabilityAction: 'read'
    })
    if (query.count === true) {
      return response.data
    }
    const { documents, documentIds, hasMore } = response.data as IFindResult
    const result: IFindResult = {}
    if (documents) {
      result.documents = documents
    }
    if (documentIds) {
      result.documentIds = documentIds
    }
    if (hasMore !== undefined) {
      result.hasMore = hasMore
    }
    return result
  }

  /**
   * @inheritdoc
   */
  override async revokeCapability({
    capabilityToRevoke
  }: { capabilityToRevoke?: IZcap } = {}) {
    assert(capabilityToRevoke, 'capabilityToRevoke', 'object')

    let { edvId, capability } = this
    if (!edvId && !(capability && typeof capability === 'object')) {
      // since no `edvId` was set and no `capability` with an invocation
      // target that can be parsed was given, get the EDV ID from the
      // capability that is to be revoked -- presuming it is a document (if
      // revoking any other capability, the `edvId` must be set or a
      // `capability` passed to invoke)
      edvId = parseEdvId({ capability: capabilityToRevoke })
    }

    const revokePath = `${edvId}/zcaps/revocations`
    const url =
      getInvocationTarget({ capability }) ||
      `${revokePath}/${encodeURIComponent(capabilityToRevoke.id)}`
    if (!capability) {
      capability = `${ZCAP_ROOT_PREFIX}${encodeURIComponent(url)}`
    }
    await this._signedHttpPost({
      url,
      json: capabilityToRevoke,
      capability,
      insert: true
    })
  }

  /**
   * @inheritdoc
   */
  override async storeChunk({ docId, chunk }: ITransportStoreChunkOptions) {
    assert(chunk, 'chunk', 'object')
    // append `/chunks/<chunkIndex>`
    const { index } = chunk
    const url = this._getDocUrl(docId, this.capability) + `/chunks/${index}`
    await this._signedHttpPost({ url, json: chunk, insert: false })
  }

  /**
   * @inheritdoc
   */
  override async getChunk({
    docId,
    chunkIndex
  }: ITransportGetChunkOptions = {}) {
    // append `/chunks/<chunkIndex>`
    const url =
      this._getDocUrl(docId, this.capability) + `/chunks/${chunkIndex}`
    const response = await this._signedHttpGet({
      url,
      notFoundMessage: 'Document chunk not found.'
    })

    // TODO: validate response.data

    // return chunk
    return response.data
  }

  async _signedHttpGet({
    url,
    capability = this.capability,
    notFoundMessage
  }: ISignedHttpGetOptions) {
    if (!capability) {
      capability = this._rootZcapId
    }
    try {
      // sign HTTP header
      const { defaultHeaders, httpsAgent: agent, invocationSigner } = this
      const headers = await signCapabilityInvocation({
        url,
        method: 'get',
        headers: defaultHeaders,
        capability,
        invocationSigner: invocationSigner as ISigner,
        capabilityAction: 'read'
      })
      // send request
      return await httpClient.get(url, { headers, agent })
    } catch (e: any) {
      // normalize not found errors
      if (notFoundMessage && e.status === 404) {
        const err: any = new Error(notFoundMessage)
        err.name = 'NotFoundError'
        err.cause = e
        throw err
      }
      throw e
    }
  }

  async _signedHttpPost({
    url,
    json,
    capability = this.capability,
    capabilityAction = 'write',
    insert
  }: ISignedHttpPostOptions) {
    if (!capability) {
      capability = this._rootZcapId
    }
    try {
      // sign HTTP header
      const { defaultHeaders, httpsAgent: agent, invocationSigner } = this
      const headers = await signCapabilityInvocation({
        url,
        method: 'post',
        headers: defaultHeaders,
        json,
        capability,
        invocationSigner: invocationSigner as ISigner,
        capabilityAction
      })

      // send request
      return await httpClient.post(url, { agent, json, headers })
    } catch (e: any) {
      // normalize 409 errors to duplicate / conflict errors
      if (insert !== undefined && e.status === 409) {
        const cause = e
        if (insert) {
          // eslint-disable-next-line no-ex-assign
          e = new Error('Duplicate error.')
          e.name = 'DuplicateError'
        } else {
          // eslint-disable-next-line no-ex-assign
          e = new Error('Conflict error.')
          e.name = 'InvalidStateError'
        }
        e.cause = cause
      }
      throw e
    }
  }

  // helper that gets a document URL from a document ID
  _getDocUrl(id: any, capability: any) {
    if (!this.edvId) {
      if (!capability) {
        throw new Error('Either "capability" or "edvId" must be given.')
      }
      const target: any = getInvocationTarget({ capability })
      // target is the entire documents collection
      if (target.endsWith('/documents')) {
        return `${target}/${id}`
      }
      return target
    }
    return `${this.edvId}/documents/${id}`
  }

  // retained for backwards compatibility; delegates to the shared helper
  static _getInvocationTarget({ capability }: { capability?: IZcap | string }) {
    return getInvocationTarget({ capability })
  }
}

function _createAbsoluteUrl(url: any) {
  if (url.includes(':')) {
    return url
  }
  if (typeof self !== 'undefined') {
    return `${self.location.origin}${url}`
  }
  throw new Error('"url" must be an absolute URL.')
}

/**
 * A node.js HTTPS agent.
 *
 * @typedef {object} HttpsAgent
 * @see https://nodejs.org/api/https.html#https_class_https_agent
 */
