process.env['OPENCODE_DUST_LOG'] = 'off'

import { afterEach, beforeEach, vi } from 'vitest'

/**
 * Network guard for the whole suite.
 *
 * Every Dust and WorkOS call in these tests is meant to be stubbed. A test
 * that forgets loses money and leaks credentials: a real turn against
 * dust.tt is billed to the workspace, and a real WorkOS call would need a
 * genuine grant. So the default `fetch` is one that fails loudly and names the
 * URL it refused, rather than one that works.
 *
 * `vi.stubGlobal('fetch', ...)` inside a test replaces this for that test;
 * `unstubAllGlobals` restores it.
 */
const forbiddenFetch = vi.fn((input: unknown) => {
  const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input)
  throw new Error(
    `Refusing a real network request to ${url}. ` +
      'Stub fetch with vi.stubGlobal in this test — a real Dust turn is billed.',
  )
})

beforeEach(() => {
  vi.stubGlobal('fetch', forbiddenFetch)
})

afterEach(() => {
  vi.unstubAllGlobals()
})
