/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The transport-free entry point. It carries the pieces that encrypt,
 * decrypt, blind and validate locally -- `EdvClientCore`,
 * `EdvDocumentCipher`, `assertDocId` and the abstract `Transport` a caller
 * subclasses -- and leaves out `EdvClient`, `EdvDocument` and
 * `HttpsTransport`. Nothing reachable from here imports
 * `@interop/http-client` or `@interop/http-signature-zcap-invoke`, so a
 * caller that brings its own transport, or that opens archived bytes with no
 * server at all, keeps those packages out of its import graph. The root entry
 * re-exports everything below and adds the HTTPS classes on top.
 */
export { EdvClientCore } from './EdvClientCore.js'
export { EdvDocumentCipher } from './EdvDocumentCipher.js'
export { assertDocId } from './assert.js'
export { Transport } from './Transport.js'
