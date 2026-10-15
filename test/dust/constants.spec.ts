import { describe, expect, it } from 'vitest'

import {
  DUST_REGION_HOSTS,
  DUST_DEFAULT_REGION,
  USER_MESSAGE_ORIGIN,
  WORKOS_CLIENT_ID,
  WORKOS_DEVICE_AUTHORIZE_URL,
  WORKOS_REGION_CLAIM,
  WORKOS_TOKEN_URL,
  dustApiBase,
  dustPrivateApiBase,
  dustHost,
} from '../../src/dust/constants.ts'

describe('user message origin', () => {
  // Dust bills a turn as programmatic when the origin maps to "programmatic" in
  // front/lib/api/programmatic_usage/common.ts. 'cli' maps to "user"; 'api' and
  // 'cli_programmatic' do not. This constant is the whole reason the plugin is
  // not billed as API usage, so it is asserted rather than assumed.
  it('is cli, the only origin Dust classifies as interactive user usage', () => {
    expect(USER_MESSAGE_ORIGIN).toBe('cli')
  })

  it('is never an origin Dust classifies as programmatic', () => {
    expect(['api', 'cli_programmatic']).not.toContain(USER_MESSAGE_ORIGIN)
  })
})

describe('region hosts', () => {
  it('resolves the two regions WorkOS reports', () => {
    expect(dustHost('us-central1')).toBe('https://dust.tt')
    expect(dustHost('europe-west1')).toBe('https://eu.dust.tt')
  })

  it('falls back to the default region for an unknown region claim', () => {
    expect(dustHost('moon-base1')).toBe(DUST_REGION_HOSTS[DUST_DEFAULT_REGION])
  })

  it('builds the public and private API bases for a workspace', () => {
    expect(dustApiBase('us-central1', 'w123')).toBe('https://dust.tt/api/v1/w/w123')
    expect(dustPrivateApiBase('europe-west1', 'w123')).toBe('https://eu.dust.tt/api/w/w123')
  })
})

describe('WorkOS endpoints', () => {
  it('targets the production client the Dust CLI is registered as', () => {
    expect(WORKOS_CLIENT_ID).toMatch(/^client_[A-Z0-9]+$/)
    expect(WORKOS_DEVICE_AUTHORIZE_URL).toBe(
      'https://api.workos.com/user_management/authorize/device',
    )
    expect(WORKOS_TOKEN_URL).toBe('https://api.workos.com/user_management/authenticate')
  })

  it('reads the region from the Dust-namespaced claim', () => {
    expect(WORKOS_REGION_CLAIM).toBe('https://dust.tt/region')
  })
})
