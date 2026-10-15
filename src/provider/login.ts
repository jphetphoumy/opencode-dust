/**
 * Logging in to Dust from opencode: the WorkOS device flow, and the workspace
 * every later request is scoped to.
 *
 * Dust authenticates a human, not a machine, and that is deliberate here: it
 * bills a turn as interactive user usage only when the caller is a WorkOS user
 * grant stamping the `cli` origin. There is no API-key method, because an API
 * key would change what the workspace pays for every message.
 */

import type { Credential, Plugin } from '@opencode/plugin'

import { fetchWorkspaces, type DustWorkspace } from '../dust/directory.ts'
import {
  pollForGrant,
  refreshGrant,
  requestDeviceCode,
  type DeviceCode,
  type TokenGrant,
} from '../dust/workos.ts'
import { DUST_PROVIDER_ID } from './catalog.ts'

/** Id of the device-code method on the Dust integration. */
export const DUST_OAUTH_METHOD_ID = 'dust-device'

type IntegrationEditor = Parameters<Parameters<Plugin.Context['integration']['transform']>[0]>[0]
type MethodRegistration = Parameters<IntegrationEditor['method']['update']>[0]

/** The OAuth flavour of a method registration, which is what this returns. */
export type DustOAuthRegistration = Extract<MethodRegistration, { readonly authorize: unknown }>

/** The network calls the login makes, injected so tests never reach WorkOS. */
export interface LoginApi {
  requestDeviceCode(signal?: AbortSignal): Promise<DeviceCode>
  pollForGrant(device: DeviceCode): Promise<TokenGrant>
  refreshGrant(refreshToken: string): Promise<TokenGrant>
  fetchWorkspaces(region: string, accessToken: string): Promise<readonly DustWorkspace[]>
}

const DEFAULT_API: LoginApi = {
  requestDeviceCode,
  pollForGrant: device => pollForGrant(device),
  refreshGrant: refreshToken => refreshGrant(refreshToken),
  fetchWorkspaces: (region, accessToken) => fetchWorkspaces(region, accessToken),
}

/**
 * Settle the workspace a grant will address.
 *
 * Asked before the grant exists, so the answer is matched afterwards — by id
 * or by name. With several workspaces and no answer, this refuses rather than
 * guessing: a guess would send turns, and credits, to a workspace the human
 * did not pick.
 */
function chooseWorkspace(workspaces: readonly DustWorkspace[], wanted: string): string {
  const needle = wanted.trim().toLowerCase()
  if (needle !== '') {
    const match = workspaces.find(
      workspace => workspace.sId.toLowerCase() === needle || workspace.name.toLowerCase() === needle,
    )
    if (match !== undefined) return match.sId
  } else if (workspaces.length === 1 && workspaces[0] !== undefined) {
    return workspaces[0].sId
  }

  const available = workspaces.map(workspace => `${workspace.name} (${workspace.sId})`).join(', ')
  throw new Error(
    workspaces.length === 0
      ? 'This Dust account belongs to no workspace.'
      : `Choose a Dust workspace by name or id when logging in. Available: ${available}`,
  )
}

/** The credential opencode stores for a grant. */
function toCredential(grant: TokenGrant, workspaceId: string): Credential.OAuth {
  return {
    type: 'oauth',
    methodID: DUST_OAUTH_METHOD_ID as Credential.OAuth['methodID'],
    access: grant.accessToken,
    refresh: grant.refreshToken,
    expires: grant.expiresAt,
    // Spread into the SDK's options beside the token, which is how a model
    // learns where to send its turns.
    metadata: { region: grant.region, workspaceId },
  }
}

/** Read the workspace a stored credential addresses. */
function workspaceOf(credential: Credential.OAuth): string {
  const workspaceId = credential.metadata?.['workspaceId']
  return typeof workspaceId === 'string' ? workspaceId : ''
}

/**
 * Build the Dust integration's device-code login.
 * @param api - network calls; tests replace them all.
 * @returns the method registration to hand opencode.
 */
export function createDustOAuth(api: LoginApi = DEFAULT_API): DustOAuthRegistration {
  return {
    integrationID: DUST_PROVIDER_ID,
    method: {
      id: DUST_OAUTH_METHOD_ID,
      type: 'oauth',
      label: 'Log in with your browser',
      form: [
        {
          key: 'workspace',
          type: 'string',
          title: 'Dust workspace',
          description: 'Workspace name or id; leave empty if you belong to only one.',
          required: false,
        },
      ],
    },
    authorize: async answer => {
      const device = await api.requestDeviceCode()
      const wanted = typeof answer['workspace'] === 'string' ? answer['workspace'] : ''

      const callback = (async () => {
        const grant = await api.pollForGrant(device)
        const workspaces = await api.fetchWorkspaces(grant.region, grant.accessToken)
        return toCredential(grant, chooseWorkspace(workspaces, wanted))
      })()
      // opencode awaits this only once the human is told where to go; until
      // then a refusal must not surface as an unhandled rejection.
      callback.catch(() => undefined)

      return {
        mode: 'auto',
        url: device.verificationUriComplete,
        instructions: `Approve the code ${device.userCode} in your browser.`,
        expiresAt: Date.now() + device.expiresIn * 1000,
        callback,
      }
    },
    refresh: async credential => {
      const grant = await api.refreshGrant(credential.refresh)
      // WorkOS re-states the region on every grant; the workspace is this
      // plugin's own fact and must be carried forward, or every later turn
      // would have nothing to address.
      return toCredential(grant, workspaceOf(credential))
    },
    label: credential => `Dust workspace ${workspaceOf(credential)}`,
  }
}
