/**
 * Fixed Dust and WorkOS endpoints, and the one constant that decides how Dust
 * bills every turn this plugin sends.
 *
 * These are external protocol constants, not deployment tunables: changing any
 * of them changes which service is talked to, not how this plugin is configured.
 */

/**
 * Origin stamped on every user message this plugin sends.
 *
 * Dust classifies a turn as programmatic usage when either the authenticated
 * principal is an API key or the message origin maps to `"programmatic"` in
 * `front/lib/api/programmatic_usage/common.ts`. In that table `cli` maps to
 * `"user"` while `api` and `cli_programmatic` map to `"programmatic"`. This
 * plugin authenticates as a WorkOS user grant and stamps `cli`, so its turns
 * are billed as interactive user usage — the same as the Dust web app.
 *
 * There is deliberately no way to override this per request.
 */
export const USER_MESSAGE_ORIGIN = 'cli'

/** WorkOS tenant that issues Dust user grants. */
export const WORKOS_DOMAIN = 'api.workos.com'

/**
 * Production WorkOS client the Dust CLI is registered as. The device grant is
 * bound to this client, so a different id yields tokens Dust will not accept.
 */
export const WORKOS_CLIENT_ID = 'client_01JGCT55T7FVDG9XF74925R1KT'

/** Device-authorization endpoint that issues a user code and device code. */
export const WORKOS_DEVICE_AUTHORIZE_URL = `https://${WORKOS_DOMAIN}/user_management/authorize/device`

/** Token endpoint for both the device-code exchange and refresh. */
export const WORKOS_TOKEN_URL = `https://${WORKOS_DOMAIN}/user_management/authenticate`

/** OAuth scopes the device grant requests. */
export const WORKOS_SCOPE = 'openid profile email'

/** Claim on the WorkOS access token naming the Dust region that holds the user's data. */
export const WORKOS_REGION_CLAIM = 'https://dust.tt/region'

/** Dust deployment host per region claim value. */
export const DUST_REGION_HOSTS = {
  'us-central1': 'https://dust.tt',
  'europe-west1': 'https://eu.dust.tt',
} as const

/** Region assumed when the access token carries no region claim. */
export const DUST_DEFAULT_REGION = 'us-central1'

/** Region claim values this plugin knows a host for. */
export type DustRegion = keyof typeof DUST_REGION_HOSTS

/**
 * Resolve the Dust host for a region claim.
 *
 * An unrecognized region is not an error: WorkOS may report a region this
 * build predates, and the default deployment can still answer for it.
 * @param region - the raw `https://dust.tt/region` claim value.
 * @returns the origin to send Dust requests to.
 */
export function dustHost(region: string): string {
  return (
    DUST_REGION_HOSTS[region as DustRegion] ?? DUST_REGION_HOSTS[DUST_DEFAULT_REGION]
  )
}

/**
 * Base URL for Dust's public, documented workspace API.
 * @param region - the region claim value.
 * @param workspaceId - the workspace sId.
 * @returns the `/api/v1/w/<wId>` prefix every public call is relative to.
 */
export function dustApiBase(region: string, workspaceId: string): string {
  return `${dustHost(region)}/api/v1/w/${workspaceId}`
}

/**
 * Base URL for Dust's private workspace API.
 *
 * Reachable by a WorkOS user grant and not by a workspace API key. The model
 * catalog lives here and has no public equivalent.
 * @param region - the region claim value.
 * @param workspaceId - the workspace sId.
 * @returns the `/api/w/<wId>` prefix.
 */
export function dustPrivateApiBase(region: string, workspaceId: string): string {
  return `${dustHost(region)}/api/w/${workspaceId}`
}
