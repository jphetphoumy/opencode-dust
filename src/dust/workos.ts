/**
 * WorkOS device-authorization grant — the only way this plugin authenticates.
 *
 * Dust classifies any turn made with a workspace API key as programmatic usage
 * regardless of its origin, so an API-key path would defeat the point of the
 * plugin. There is deliberately none.
 */

import {
  DUST_DEFAULT_REGION,
  WORKOS_CLIENT_ID,
  WORKOS_DEVICE_AUTHORIZE_URL,
  WORKOS_REGION_CLAIM,
  WORKOS_SCOPE,
  WORKOS_TOKEN_URL,
} from './constants.ts'

/**
 * Refresh this far ahead of the true expiry.
 *
 * An agent turn can stream for minutes on a token that WorkOS issues with a
 * short lifetime, so a token that merely has not expired yet is not good
 * enough to start one with.
 */
const EXPIRY_SKEW_MS = 60_000

/** Extra delay WorkOS's `slow_down` response asks for, per RFC 8628. */
const SLOW_DOWN_STEP_MS = 5_000

/** A WorkOS grant attempt that failed. */
export class WorkosAuthError extends Error {
  override readonly name = 'WorkosAuthError'

  constructor(
    /** WorkOS's `error` discriminator, when it sent one. */
    readonly code: string | undefined,
    /**
     * Whether the stored grant is unusable and the human must log in again.
     * False for transport and availability failures, which retrying can fix.
     */
    readonly requiresReauthentication: boolean,
    message: string,
  ) {
    super(message)
  }
}

/** A pending device authorization, as WorkOS issued it. */
export interface DeviceCode {
  /** Secret this client polls with. */
  readonly deviceCode: string
  /** Short code the human types into the browser. */
  readonly userCode: string
  /** Page the human opens. */
  readonly verificationUri: string
  /** Same page with the user code pre-filled. */
  readonly verificationUriComplete: string
  /** Seconds until the device code stops being accepted. */
  readonly expiresIn: number
  /** Seconds WorkOS asks this client to wait between polls. */
  readonly intervalSeconds: number
}

/** A usable WorkOS grant, with the facts Dust needs derived from it. */
export interface TokenGrant {
  /** Bearer token for Dust requests. */
  readonly accessToken: string
  /** Token that buys the next access token. */
  readonly refreshToken: string
  /** Epoch milliseconds at which the access token stops being valid. */
  readonly expiresAt: number
  /** Dust region holding this user's workspaces. */
  readonly region: string
}

/** WorkOS token endpoint success body. */
interface TokenResponse {
  access_token?: string
  refresh_token?: string
}

/** WorkOS error body, shared by both endpoints. */
interface ErrorResponse {
  error?: string
  error_description?: string
}

/** POST a form-encoded body to WorkOS and decode the JSON answer. */
async function postForm(
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    ...(signal === undefined ? {} : { signal }),
  })

  let body: unknown
  try {
    body = await response.json()
  } catch {
    // WorkOS answers HTML from its edge on some failures; the status carries the meaning.
    body = {}
  }
  return { response, body }
}

/**
 * Decode a JWT payload without verifying it.
 *
 * The token is read only for claims this client uses to route its own
 * requests. Dust verifies the signature on every call, so a forged token buys
 * nothing but a rejected request.
 * @param token - the access token.
 * @returns the decoded claims, or nothing when the token is not a readable JWT.
 */
function decodeClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    // A token this client cannot read is still usable as an opaque bearer credential.
    return undefined
  }
}

/**
 * Read the Dust region an access token belongs to.
 * @param accessToken - the WorkOS access token.
 * @returns the region claim, or the default region when it carries none.
 */
export function decodeRegion(accessToken: string): string {
  const claim = decodeClaims(accessToken)?.[WORKOS_REGION_CLAIM]
  return typeof claim === 'string' ? claim : DUST_DEFAULT_REGION
}

/**
 * Read the moment an access token stops being valid.
 * @param accessToken - the WorkOS access token.
 * @returns epoch milliseconds, or 0 when the token declares no expiry — which
 * makes it always due for refresh rather than trusted indefinitely.
 */
export function grantExpiresAt(accessToken: string): number {
  const exp = decodeClaims(accessToken)?.['exp']
  return typeof exp === 'number' ? exp * 1000 : 0
}

/**
 * Whether a grant should be refreshed before being used.
 * @param grant - anything carrying the grant's expiry.
 * @param now - current epoch milliseconds.
 * @returns true when the token is expired or close enough that a long stream would outlive it.
 */
export function isGrantExpired(grant: { readonly expiresAt: number }, now: number): boolean {
  return grant.expiresAt - EXPIRY_SKEW_MS <= now
}

/** Turn a WorkOS token response into a grant, or explain why it is not one. */
function toGrant(body: unknown): TokenGrant {
  const token = body as TokenResponse
  if (typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string') {
    throw new WorkosAuthError(
      undefined,
      true,
      'WorkOS returned no token pair; the grant cannot be used.',
    )
  }
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: grantExpiresAt(token.access_token),
    region: decodeRegion(token.access_token),
  }
}

/**
 * Begin a device authorization.
 * @param signal - cancels the request.
 * @returns the codes and polling interval to drive {@link pollForGrant} with.
 * @throws WorkosAuthError when WorkOS refuses to start the flow.
 */
export async function requestDeviceCode(signal?: AbortSignal): Promise<DeviceCode> {
  const { response, body } = await postForm(
    WORKOS_DEVICE_AUTHORIZE_URL,
    { client_id: WORKOS_CLIENT_ID, scope: WORKOS_SCOPE },
    signal,
  )

  if (!response.ok) {
    const error = body as ErrorResponse
    throw new WorkosAuthError(
      error.error,
      true,
      `WorkOS refused the device authorization request: ${
        error.error_description ?? error.error ?? response.status
      }`,
    )
  }

  const device = body as Record<string, unknown>
  return {
    deviceCode: String(device['device_code']),
    userCode: String(device['user_code']),
    verificationUri: String(device['verification_uri']),
    verificationUriComplete: String(device['verification_uri_complete']),
    expiresIn: Number(device['expires_in']),
    intervalSeconds: Number(device['interval']),
  }
}

/** Injection points that let the polling loop be driven without real time passing. */
export interface PollOptions {
  /** Withdraws the flow; checked before every attempt. */
  readonly signal?: AbortSignal
  /** Waits between attempts. */
  readonly sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Poll WorkOS until the human approves the device code.
 *
 * `authorization_pending` and `slow_down` are the protocol's normal progress
 * responses, not failures; every other error ends the attempt.
 * @param device - the codes from {@link requestDeviceCode}.
 * @param options - cancellation and the sleep used between attempts.
 * @returns the approved grant.
 * @throws WorkosAuthError when the human declines or the code expires.
 * @throws when the caller withdraws.
 */
export async function pollForGrant(
  device: DeviceCode,
  options: PollOptions = {},
): Promise<TokenGrant> {
  const sleep = options.sleep ?? realSleep
  let intervalMs = device.intervalSeconds * 1000

  for (;;) {
    options.signal?.throwIfAborted()

    const { response, body } = await postForm(
      WORKOS_TOKEN_URL,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.deviceCode,
        client_id: WORKOS_CLIENT_ID,
      },
      options.signal,
    )

    if (response.ok) return toGrant(body)

    const code = (body as ErrorResponse).error
    if (code === 'slow_down') intervalMs += SLOW_DOWN_STEP_MS
    else if (code !== 'authorization_pending') {
      throw new WorkosAuthError(
        code,
        true,
        code === 'expired_token'
          ? 'The login code expired before it was approved.'
          : `WorkOS ended the login attempt: ${code ?? response.status}`,
      )
    }

    await sleep(intervalMs)
  }
}

/**
 * Exchange a refresh token for a fresh grant.
 * @param refreshToken - the stored refresh token.
 * @param signal - cancels the request.
 * @returns the new grant, including its replacement refresh token.
 * @throws WorkosAuthError; `requiresReauthentication` distinguishes a rejected
 * grant from WorkOS being unreachable.
 */
export async function refreshGrant(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenGrant> {
  const { response, body } = await postForm(
    WORKOS_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      client_id: WORKOS_CLIENT_ID,
      refresh_token: refreshToken,
    },
    signal,
  )

  if (response.ok) return toGrant(body)

  const error = body as ErrorResponse
  const rejected = response.status === 400 || response.status === 401
  throw new WorkosAuthError(
    error.error,
    rejected,
    rejected
      ? 'The stored Dust login is no longer valid; log in again.'
      : `WorkOS could not refresh the login: ${error.error ?? response.status}`,
  )
}
