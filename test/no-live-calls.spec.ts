import { describe, expect, it } from 'vitest'

import { fetchWorkspaces } from '../src/dust/directory.ts'
import { requestDeviceCode } from '../src/dust/workos.ts'

/**
 * The suite must never reach dust.tt or WorkOS. A real Dust turn is billed to
 * the workspace, and a real WorkOS device grant needs a human at a browser.
 */
describe('network guard', () => {
  it('refuses an unstubbed Dust call', async () => {
    await expect(fetchWorkspaces('us-central1', 'tok')).rejects.toThrowError(
      /Refusing a real network request.*https:\/\/dust\.tt/,
    )
  })

  it('refuses an unstubbed WorkOS call', async () => {
    await expect(requestDeviceCode()).rejects.toThrowError(/Refusing a real network request/)
  })
})
