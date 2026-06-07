/*!
 * Copyright (c) 2025 Digital Bazaar, Inc. All rights reserved.
 */
// Ambient module shims for runtime dependencies that do not ship their own
// TypeScript type declarations. They are intentionally untyped (`any`); the
// public API of `edv-client` is typed in its own source.
declare module 'canonicalize'
declare module 'split-string'
declare module '@digitalbazaar/http-client'
declare module '@digitalbazaar/minimal-cipher'
declare module '@digitalbazaar/lru-memoize'
declare module '@digitalbazaar/http-signature-zcap-invoke'
