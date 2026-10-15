import { describe, expect, it, vi } from 'vitest'

import type { DeviceCode, TokenGrant } from '../../src/dust/workos.ts'
import { DUST_OAUTH_METHOD_ID, createDustOAuth, type LoginApi } from '../../src/provider/login.ts'

const DEVICE: DeviceCode = {
  deviceCode: 'dev',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://auth.dust.tt/device',
  verificationUriComplete: 'https://auth.dust.tt/device?code=ABCD-EFGH',
  expiresIn: 300,
  intervalSeconds: 5,
}

const GRANT: TokenGrant = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 1_900_000_000_000,
  region: 'europe-west1',
}

function api(overrides: Partial<LoginApi> = {}): LoginApi {
  return {
    requestDeviceCode: vi.fn(async () => DEVICE),
    pollForGrant: vi.fn(async () => GRANT),
    refreshGrant: vi.fn(async () => ({ ...GRANT, accessToken: 'access2', refreshToken: 'refresh2' })),
    fetchWorkspaces: vi.fn(async () => [{ sId: 'w1', name: 'Acme', role: 'user' }]),
    ...overrides,
  }
}

describe('createDustOAuth', () => {
  it('registers a device-code OAuth method on the dust integration', () => {
    const registration = createDustOAuth(api())

    expect(registration.integrationID).toBe('dust')
    expect(registration.method).toMatchObject({ id: DUST_OAUTH_METHOD_ID, type: 'oauth' })
    expect(registration.method.form?.[0]).toMatchObject({ key: 'workspace', type: 'string' })
  })

  it('sends the human to the pre-filled verification page with the code to check', async () => {
    const authorization = await createDustOAuth(api()).authorize({})

    expect(authorization.mode).toBe('auto')
    expect(authorization.url).toBe(DEVICE.verificationUriComplete)
    expect(authorization.instructions).toContain('ABCD-EFGH')
    expect(authorization.expiresAt).toBeGreaterThan(Date.now())
  })

  it('spells out where to go, for when no browser can be opened (e.g. in a container)', async () => {
    const authorization = await createDustOAuth(api()).authorize({})

    expect(authorization.instructions).toContain(DEVICE.verificationUriComplete)
    expect(authorization.instructions).toContain(DEVICE.verificationUri)
  })

  it('stores the grant with its region and the only workspace the user has', async () => {
    const authorization = await createDustOAuth(api()).authorize({})
    if (authorization.mode !== 'auto') throw new Error('expected auto mode')

    await expect(authorization.callback).resolves.toEqual({
      type: 'oauth',
      methodID: DUST_OAUTH_METHOD_ID,
      access: 'access',
      refresh: 'refresh',
      expires: GRANT.expiresAt,
      metadata: { region: 'europe-west1', workspaceId: 'w1' },
    })
  })

  it('picks the workspace the human named, by id or by name', async () => {
    const many = api({
      fetchWorkspaces: vi.fn(async () => [
        { sId: 'w1', name: 'Acme', role: 'user' },
        { sId: 'w2', name: 'Globex', role: 'admin' },
      ]),
    })

    for (const workspace of ['w2', 'globex']) {
      const authorization = await createDustOAuth(many).authorize({ workspace })
      if (authorization.mode !== 'auto') throw new Error('expected auto mode')
      await expect(authorization.callback).resolves.toMatchObject({
        metadata: { workspaceId: 'w2' },
      })
    }
  })

  it('refuses to guess between several workspaces, and lists them', async () => {
    const authorization = await createDustOAuth(
      api({
        fetchWorkspaces: vi.fn(async () => [
          { sId: 'w1', name: 'Acme', role: 'user' },
          { sId: 'w2', name: 'Globex', role: 'admin' },
        ]),
      }),
    ).authorize({})
    if (authorization.mode !== 'auto') throw new Error('expected auto mode')

    await expect(authorization.callback).rejects.toThrow(/Acme \(w1\).*Globex \(w2\)/s)
  })

  it('refreshes the grant and carries the workspace forward', async () => {
    const registration = createDustOAuth(api())

    const refreshed = await registration.refresh?.({
      type: 'oauth',
      methodID: DUST_OAUTH_METHOD_ID,
      access: 'access',
      refresh: 'refresh',
      expires: 0,
      metadata: { region: 'us-central1', workspaceId: 'w1' },
    } as never)

    expect(refreshed).toMatchObject({
      access: 'access2',
      refresh: 'refresh2',
      metadata: { region: 'europe-west1', workspaceId: 'w1' },
    })
  })

  it('labels the connection with its workspace', () => {
    const label = createDustOAuth(api()).label?.({
      type: 'oauth',
      methodID: DUST_OAUTH_METHOD_ID,
      access: 'a',
      refresh: 'r',
      expires: 0,
      metadata: { region: 'us-central1', workspaceId: 'w1' },
    } as never)

    expect(label).toBe('Dust workspace w1')
  })
})
