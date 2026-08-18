# Agent Guidelines

## Project Overview

`@interop/edv-client` is the client side of the **Encrypted Data Vault (EDV)
spec**: it encrypts documents locally, blinds index attributes with an HMAC key
the server never sees, and talks to an EDV server over zcap-authorized HTTP. It
is the Interop Alliance TypeScript fork of Digital Bazaar's `edv-client`. The
reference server implementation is `@bedrock/edv-storage` (see its AGENTS.md,
linked below, for the server-side architecture and the planned TypeScript +
fastify port for Wallet Attached Storage); that server's `test/mocha/25-28*`
suites drive this client end to end, so the two must stay wire-compatible.
Shared types (`IEDVConfig`, `IEncryptedDocument`, `IEDVChunk`, `IEDVQuery`) come
from `@interop/data-integrity-core`.

The `src/` module map lives in @ARCHITECTURE.md -- read it before making
changes.

### Reference materials

| Resource                                                            | Location                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------- |
| EDV spec                                                            | <https://identity.foundation/edv-spec/> (terminology: <https://identity.foundation/edv-spec/terms.html>) |
| WAS spec                                                            | <https://github.com/w3c-ccg/wallet-attached-storage-spec/blob/main/spec.md>  |
| WAS client                                                          | <https://github.com/interop-alliance/was-client>              |
| zCap Developer Guide                                                | <https://github.com/interop-alliance/zcap-developer-guide/blob/main/README.md> |
| ezcap fork (zcap client; its AGENTS.md also defines house TS style) | <https://github.com/interop-alliance/ezcap>                   |
| Current @interop zcap server-side verification pattern              | <https://github.com/interop-alliance/was-teaching-server/blob/main/src/zcap.ts> |
| EDV server (Digital Bazaar implementation) annotated with types     | <https://github.com/interop-alliance/bedrock-edv-storage> (see its AGENTS.md) |

## Server Protocol Contract

The EDV server protocol contract -- client-chosen vs server-assigned IDs,
sequence/concurrency rules, deletion-as-tombstone, the error codes the client
should expect, query shapes, and zcap caching -- lives in @ARCHITECTURE.md. When
changing request shapes, sequence logic, or `IndexHelper`, check against it.

## Toolchain & Project Layout

### Package Manager

Use `pnpm` (not `npm` or `yarn`). The lockfile is `pnpm-lock.yaml`. Install deps
with `pnpm install`; run scripts with `pnpm run <script>` or `pnpm <script>`.

### Build

The library is built with `tsc` (not `vite build`). `vite.config.ts` exists only
to configure Vitest and to run `vite dev` as a server for Playwright. Running
`pnpm run build` compiles `src/` to `dist/` via `tsconfig.json`.

### Two tsconfigs

- `tsconfig.json` — library build only; includes `src/**/*`
- `tsconfig.dev.json` — extends the above with `noEmit: true`; adds `test/**/*`,
  `vite.config.ts`, and `playwright.config.ts` so ESLint's type-aware rules
  cover all files

Do not add test files to `tsconfig.json` — they would be emitted into `dist/`.

### Tests

- `test/node/` — Vitest unit tests (`pnpm run test:node`); run in Node
- `test/browser/` — Playwright tests (`pnpm run test:browser`); run in real
  Chromium via a Vite dev server (`pnpm run dev`)

The `dev` script exists solely to give Playwright a server that can serve and
transform TypeScript source files on the fly. There is no browser app.

### ESM & import paths

The package is ESM-only (`"type": "module"`). Local imports must use the `.js`
extension even though source files are `.ts` — e.g.
`import { Example } from '../../src/index.js'`. TypeScript's
`moduleResolution: Bundler` resolves these to the `.ts` source at compile time.

## Conventions

Code style, refactoring, JSDoc, comment, and error-handling conventions live in
@CONTRIBUTING.md -- follow them.

## General

Ask before re-exporting types for consumer convenience. Consumers can import
their own types from packages like data-integrity-core.
