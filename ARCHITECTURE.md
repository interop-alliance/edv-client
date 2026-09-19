# Architecture

How `@interop/edv-client` is laid out and the EDV server protocol contract it
must honor. For contribution conventions see [CONTRIBUTING.md](CONTRIBUTING.md);
for agent-facing rules (toolchain, tests, reference paths) see
[AGENTS.md](AGENTS.md).

## Module Map

```
src/
  index.ts          Public API: EdvClient, EdvDocument, HttpsTransport, plus
                    everything core.ts exports
  core.ts           The `./core` entry: EdvClientCore, EdvDocumentCipher,
                    assertDocId, Transport -- no HTTP packages in its graph
  EdvClientCore.ts  Transport-agnostic core: index updates, sequence handling,
                    tombstone delete; owns an EdvDocumentCipher (documentCipher)
  EdvDocumentCipher.ts  Transport-free JWE codec: encrypt/decrypt, default
                    recipients, sequence + index-attribute blinding
  EdvClient.ts      Core + HTTPS transport + zcap invocation convenience
  EdvDocument.ts    Handle for reading/writing one document (incl. streams)
  IndexHelper.ts    HMAC-blinds attribute names/values; builds `indexed` entries
                    and `equals`/`has` queries
  HttpsTransport.ts Maps operations onto the EDV HTTP API (zcap-signed)
  Transport.ts      Abstract transport interface
```

## Server Protocol Contract

What the server enforces and the client must respect (full detail in the
`bedrock-edv-storage` AGENTS.md). When changing request shapes, sequence logic,
or `IndexHelper`, check against this list.

### IDs

- Document IDs are **client-chosen**; vault (EDV) IDs are **server-assigned**
  (the create endpoint discards any client-sent `id`).
- Both are 128-bit multibase IDs:
  `'z' + base58btc([0x00, 0x10, ...16 random bytes])`. The server rejects
  anything else with a 400.
- Full IDs are URLs (`<baseUri>/edvs/<localId>`); documents and chunks live
  under the vault URL.

### Sequences and concurrency

- A document update succeeds only if the stored doc has
  `sequence === incoming.sequence - 1` (enforced atomically server-side);
  mismatch is a 409 `InvalidStateError`. Insert with a nonzero starting sequence
  is allowed (eases copying docs between vaults).
- Sequences must be non-negative safe integers `< Number.MAX_SAFE_INTEGER`.
- A chunk write is rejected (409) unless `chunk.sequence` equals the document's
  **current** sequence -- so when updating a doc with a stream, bump the doc
  sequence first, then (re)write chunks with the new sequence.
- Config updates follow the same previous+1 rule; config sequence must be 0 at
  create.

### Deletion is a client-side concept

There is **no HTTP DELETE for documents**. `delete()` updates the doc to an
encrypted tombstone (`{content: {}, meta: {deleted: true}}`) with an incremented
sequence. Chunks do have a real DELETE endpoint.

### Errors the client should expect

| Status | Name                     | When                                                   |
| ------ | ------------------------ | ------------------------------------------------------ |
| 409    | `DuplicateError`         | insert with existing doc ID; unique-attribute conflict |
| 409    | `InvalidStateError`      | sequence mismatch (doc, config, or chunk/doc)          |
| 404    | `NotFoundError`          | missing vault/doc/chunk                                |
| 403    | `NotAllowedError`        | zcap authorization failure                             |
| 400    | validation / `DataError` | schema or ID-format violations                         |

Uniqueness of `unique: true` blinded attributes is enforced by the server per
(vault, hmac key, name, value) across all docs -- a conflicting write surfaces
as 409 `DuplicateError`, not a validation error.

### Queries

- Query body is `{index, equals | has, count?, limit?}` where `index` is the
  HMAC key ID and names/values are already blinded (by `IndexHelper`).
- The server caps results at 1000 and computes `hasMore` by fetching
  `limit + 1`; there is **no cursor/pagination token yet**, so `hasMore` with no
  way to resume is a known protocol gap.
- `count: true` returns `{count}` only; `returnDocuments: false` returns
  `{documentIds}` instead of `{documents}`.
- Query endpoints are POSTs but require zcap action `read`, not `write`
  (otherwise expected action follows the HTTP method: GET to `read`, POST to
  `write`).

### zcaps and caching

- The root zcap for a vault is synthesized, never stored: id
  `urn:zcap:root:<urlencoded vault URL>`, controller = the vault config's
  `controller`. Capabilities for documents/chunks/query verify against the vault
  as the root invocation target.
- Delegated zcaps are revoked via
  `POST <edvId>/zcaps/revocations/<revocationId>`.
- Document and chunk GETs return an ETag with `cache-control: private, no-cache`
  -- responses are revalidatable via conditional requests.
