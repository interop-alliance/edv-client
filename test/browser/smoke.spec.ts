import { test, expect } from '@playwright/test'

// Isomorphic smoke test: prove the browser bundle loads and the browser
// crypto path (`util-browser`, backed by WebCrypto) works in a real browser.
test('edv-client browser crypto smoke', async ({ page }) => {
  await page.goto('/test/index.html')

  const result = await page.evaluate(async () => {
    const { getRandomBytes, sha256 } = await import('/src/util-browser.ts')
    const random = new Uint8Array(16)
    await getRandomBytes(random)
    const digest = await sha256(new TextEncoder().encode('edv-client'))
    return {
      randomLength: random.length,
      randomAllZero: random.every(b => b === 0),
      digestLength: digest.length
    }
  })

  expect(result.randomLength).toBe(16)
  // a 16-byte random buffer being all zero is effectively impossible
  expect(result.randomAllZero).toBe(false)
  // SHA-256 digest is 32 bytes
  expect(result.digestLength).toBe(32)
})
