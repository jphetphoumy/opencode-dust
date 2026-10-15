import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  WorkosAuthError,
  decodeRegion,
  grantExpiresAt,
  isGrantExpired,
  pollForGrant,
  refreshGrant,
  requestDeviceCode,
} from '../../src/dust/workos.ts'

/** Build an unsigned JWT whose payload carries the given claims. */
function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Queue responses so a polling test can script the server turn by turn. */
function mockFetchSequence(...responses: readonly Response[]) {
  const queue = [...responses]
  const spy = vi.fn(async () => {
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected extra fetch')
    return next
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

/** Body of the nth fetch call, decoded from form encoding. */
function formBody(spy: ReturnType<typeof vi.fn>, index: number): Record<string, string> {
  const [, init] = spy.mock.calls[index] as unknown as [string, RequestInit]
  return Object.fromEntries(new URLSearchParams(init.body as string))
}

const EXP = 1_800_000_000
const ACCESS = jwt({ exp: EXP, 'https://dust.tt/region': 'europe-west1' })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestDeviceCode', () => {
  it('posts the client id and scope form-encoded, and normalizes the response', async () => {
    const spy = mockFetchSequence(
      jsonResponse(200, {
        device_code: 'dev-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://workos.com/device',
        verification_uri_complete: 'https://workos.com/device?code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      }),
    )

    const device = await requestDeviceCode()

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.workos.com/user_management/authorize/device')
    expect(new Headers(init.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded',
    )
    const body = formBody(spy, 0)
    expect(body.client_id).toMatch(/^client_/)
    expect(body.scope).toBe('openid profile email')

    expect(device).toEqual({
      deviceCode: 'dev-1',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://workos.com/device',
      verificationUriComplete: 'https://workos.com/device?code=ABCD-EFGH',
      expiresIn: 600,
      intervalSeconds: 5,
    })
  })

  it('reports a rejected device-code request', async () => {
    mockFetchSequence(jsonResponse(400, { error: 'invalid_client' }))
    await expect(requestDeviceCode()).rejects.toBeInstanceOf(WorkosAuthError)
  })
})

const DEVICE = {
  deviceCode: 'dev-1',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://workos.com/device',
  verificationUriComplete: 'https://workos.com/device?code=ABCD-EFGH',
  expiresIn: 600,
  intervalSeconds: 5,
}

describe('pollForGrant', () => {
  it('sends the device-code grant type until the user approves', async () => {
    const spy = mockFetchSequence(
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, { access_token: ACCESS, refresh_token: 'ref-1' }),
    )
    const sleep = vi.fn(async () => {})

    const grant = await pollForGrant(DEVICE, { sleep })

    expect(formBody(spy, 0)).toMatchObject({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dev-1',
    })
    expect(grant.accessToken).toBe(ACCESS)
    expect(grant.refreshToken).toBe('ref-1')
    expect(grant.region).toBe('europe-west1')
  })

  it('waits the advertised interval between attempts', async () => {
    mockFetchSequence(
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, { access_token: ACCESS, refresh_token: 'ref-1' }),
    )
    const sleep = vi.fn(async () => {})

    await pollForGrant(DEVICE, { sleep })

    expect(sleep).toHaveBeenCalledWith(5000)
  })

  it('backs off by five seconds when told to slow down, and keeps the slower pace', async () => {
    mockFetchSequence(
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(200, { access_token: ACCESS, refresh_token: 'ref-1' }),
    )
    const sleep = vi.fn(async (_ms: number) => {})

    await pollForGrant(DEVICE, { sleep })

    expect(sleep.mock.calls.map(call => call[0])).toEqual([10000, 10000])
  })

  it('gives up when the user declines', async () => {
    mockFetchSequence(jsonResponse(400, { error: 'access_denied' }))
    const error = await pollForGrant(DEVICE, { sleep: async () => {} }).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(WorkosAuthError)
    expect((error as WorkosAuthError).code).toBe('access_denied')
  })

  it('gives up when the device code expires', async () => {
    mockFetchSequence(jsonResponse(400, { error: 'expired_token' }))
    await expect(pollForGrant(DEVICE, { sleep: async () => {} })).rejects.toThrowError(
      /expired/i,
    )
  })

  it('stops polling when the caller withdraws', async () => {
    const controller = new AbortController()
    const spy = mockFetchSequence(jsonResponse(400, { error: 'authorization_pending' }))
    const sleep = vi.fn(async () => {
      controller.abort()
    })

    await expect(
      pollForGrant(DEVICE, { sleep, signal: controller.signal }),
    ).rejects.toThrowError(/abort|cancel/i)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('refreshGrant', () => {
  it('exchanges the refresh token and returns the new grant', async () => {
    const spy = mockFetchSequence(
      jsonResponse(200, { access_token: ACCESS, refresh_token: 'ref-2' }),
    )

    const grant = await refreshGrant('ref-1')

    expect(formBody(spy, 0)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'ref-1',
    })
    expect(grant.refreshToken).toBe('ref-2')
  })

  it('marks a rejected refresh so the caller knows to re-login', async () => {
    mockFetchSequence(jsonResponse(400, { error: 'invalid_grant' }))
    const error = (await refreshGrant('stale').catch((e: unknown) => e)) as WorkosAuthError

    expect(error).toBeInstanceOf(WorkosAuthError)
    expect(error.requiresReauthentication).toBe(true)
  })

  it('does not demand re-login when WorkOS is merely unavailable', async () => {
    mockFetchSequence(jsonResponse(503, {}))
    const error = (await refreshGrant('ref-1').catch((e: unknown) => e)) as WorkosAuthError

    expect(error.requiresReauthentication).toBe(false)
  })
})

describe('token claims', () => {
  it('reads the Dust region claim', () => {
    expect(decodeRegion(ACCESS)).toBe('europe-west1')
  })

  it('falls back to the default region when the claim is absent', () => {
    expect(decodeRegion(jwt({ exp: EXP }))).toBe('us-central1')
  })

  it('falls back to the default region for a token it cannot decode', () => {
    expect(decodeRegion('not-a-jwt')).toBe('us-central1')
  })

  it('takes the expiry from the token’s exp claim', () => {
    expect(grantExpiresAt(ACCESS)).toBe(EXP * 1000)
  })

  it('treats a token with no exp claim as already expired, forcing a refresh', () => {
    const now = 1_000_000
    expect(isGrantExpired({ expiresAt: grantExpiresAt(jwt({})) }, now)).toBe(true)
  })

  it('refreshes ahead of the true expiry so a long stream does not start on a dying token', () => {
    const expiresAt = 1_000_000
    expect(isGrantExpired({ expiresAt }, expiresAt - 5_000)).toBe(true)
    expect(isGrantExpired({ expiresAt }, expiresAt - 120_000)).toBe(false)
  })
})
