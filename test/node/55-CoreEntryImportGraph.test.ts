/*!
 * Copyright (c) 2026 Interop Alliance. All rights reserved.
 */
/**
 * The `./core` entry stays off the HTTP graph. `core.ts` exists so that a
 * caller which brings its own `Transport`, or which only encrypts and
 * decrypts locally, does not evaluate `@interop/http-client` or
 * `@interop/http-signature-zcap-invoke`. This test walks the entry's
 * transitive static-import graph over `src/` and refuses any reach into the
 * two HTTP packages or into the modules that pull them
 * (`EdvClient.ts`, `EdvDocument.ts`, `HttpsTransport.ts`).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src'
)

const HTTP_PACKAGES = [
  '@interop/http-client',
  '@interop/http-signature-zcap-invoke'
]

const HTTP_MODULES = ['EdvClient.ts', 'EdvDocument.ts', 'HttpsTransport.ts']

/**
 * Matches the module specifier of every static `import ... from '...'`,
 * `export ... from '...'`, and bare `import '...'` in a source file. Type-only
 * imports are included on purpose: a type reach into the HTTP side is the
 * first step of a runtime one.
 */
const SPECIFIER =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g

/**
 * Walks the static-import graph from one `src/`-relative entry module and
 * returns every reachable `src/` module (relative paths) and every external
 * package specifier encountered.
 *
 * @param entry {string}   a `src/`-relative module path
 * @returns {{ modules: Set<string>; packages: Set<string> }}
 */
function reachableFrom(entry: string): {
  modules: Set<string>
  packages: Set<string>
} {
  const modules = new Set<string>()
  const packages = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const relative = queue.pop() as string
    if (modules.has(relative)) {
      continue
    }
    modules.add(relative)
    const source = fs.readFileSync(path.join(SRC, relative), 'utf8')
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2]
      if (specifier === undefined) {
        continue
      }
      if (specifier.startsWith('.')) {
        queue.push(
          path.join(path.dirname(relative), specifier).replace(/\.js$/, '.ts')
        )
      } else {
        packages.add(specifier)
      }
    }
  }
  return { modules, packages }
}

describe('core entry import graph', () => {
  const { modules, packages } = reachableFrom('core.ts')

  it('imports neither HTTP package', () => {
    const leaked = [...packages].filter(specifier =>
      HTTP_PACKAGES.some(
        pkg => specifier === pkg || specifier.startsWith(`${pkg}/`)
      )
    )
    leaked.should.deep.equal([])
  })

  it('reaches none of the modules that pull them', () => {
    const leaked = [...modules].filter(module => HTTP_MODULES.includes(module))
    leaked.should.deep.equal([])
  })

  it('does reach the crypto kernel', () => {
    // Guards the test itself: an emptied barrel would pass the two
    // assertions above vacuously.
    modules.has('EdvClientCore.ts').should.equal(true)
    modules.has('EdvDocumentCipher.ts').should.equal(true)
    ;[...packages]
      .some(specifier => specifier.startsWith('@interop/minimal-cipher'))
      .should.equal(true)
  })

  it('the root entry does reach them, so the split is real', () => {
    const root = reachableFrom('index.ts')
    root.modules.has('HttpsTransport.ts').should.equal(true)
    for (const pkg of HTTP_PACKAGES) {
      ;[...root.packages]
        .some(specifier => specifier.startsWith(pkg))
        .should.equal(true)
    }
  })
})
