import { describe, expect, it, vi } from 'vitest'

import { fetchWorkspaces } from '../../src/dust/directory.ts'

describe('fetchWorkspaces', () => {
  it('reads the workspaces from the regional me route, as the Dust CLI', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ user: { workspaces: [{ sId: 'w1', name: 'Acme', role: 'admin' }] } }),
      ),
    )
    vi.stubGlobal('fetch', fetch)

    await expect(fetchWorkspaces('europe-west1', 'tok')).resolves.toEqual([
      { sId: 'w1', name: 'Acme', role: 'admin' },
    ])
    expect(fetch).toHaveBeenCalledWith(
      'https://eu.dust.tt/api/v1/me',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'Dust CLI' }),
      }),
    )
  })

  it('reads a user with no workspaces as an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: {} }))))

    await expect(fetchWorkspaces('us-central1', 'tok')).resolves.toEqual([])
  })
})
