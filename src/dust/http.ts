/**
 * HTTP transport for Dust's workspace API: request construction, and the one
 * place an HTTP status becomes a classified failure callers can switch on.
 */

/**
 * User agent Dust requires before it will accept a `cli` message origin.
 *
 * `isUserMessageContextValid` in `front/lib/api/assistant/conversation.ts`
 * gates that origin on `authMethod === "oauth" && userAgent === "Dust CLI"`.
 * A different string does not downgrade the origin — Dust rejects the whole
 * message with HTTP 400 — so this exact value is part of the origin contract,
 * not decoration.
 */
const USER_AGENT = 'Dust CLI'

/** What this client actually is, kept alongside the required user agent. */
const CLIENT_ID = 'opencode-dust'

/** This plugin's version, reported alongside the client id. */
const CLIENT_VERSION = '0.1.0'

/**
 * How a failed Dust response should be reacted to.
 *
 * Callers branch on this rather than on raw status codes, because the reaction
 * differs sharply: `gone` means abandon the conversation and open a new one,
 * `unauthorized` means refresh the grant and retry once, and `forbidden`
 * usually means the workspace lacks a feature flag and retrying cannot help.
 */
export type DustFailureKind =
  | 'unauthorized'
  | 'forbidden'
  | 'gone'
  | 'rate-limited'
  | 'client'
  | 'server'

/** A Dust response that was not a success, classified and attributed to its route. */
export class DustApiError extends Error {
  override readonly name = 'DustApiError'

  constructor(
    /** The HTTP status Dust answered with. */
    readonly status: number,
    /** How callers should react. */
    readonly kind: DustFailureKind,
    /** Dust's own `error.type` discriminator, absent when the body was not a Dust error. */
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Classify an HTTP status.
 *
 * 403 is deliberately not `gone`: Dust answers 403 when a workspace lacks a
 * feature flag the request needs, which is a permanent configuration fact
 * about a resource that still exists.
 * @param status - the response status.
 * @returns the reaction category.
 */
function classify(status: number): DustFailureKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404 || status === 410) return 'gone'
  if (status === 429) return 'rate-limited'
  return status >= 500 ? 'server' : 'client'
}

/** A Dust error body, when the response carried one. */
interface DustErrorBody {
  error?: { type?: string; message?: string }
}

/**
 * Where one caller's bearer token comes from.
 *
 * A string is a single token, fixed for the life of the context. Dust's WorkOS
 * access tokens are valid for fifteen minutes, and a turn's context outlives
 * one request by design — it follows a generation for as long as the agent
 * works — so a turn must carry the function form: it is asked for a token per
 * request, and asked again with `refresh` after a 401. A context holding a
 * snapshot token instead loses every stream reconnect and every liveness probe
 * the moment that token expires, and the turn reports itself truncated while
 * Dust is still generating it.
 */
export type DustTokenSource = string | ((refresh: boolean) => Promise<string>)

/** Authenticated identity of one Dust API caller. */
export interface DustRequestContext {
  /** Workspace-scoped API base, from `dustApiBase` or `dustPrivateApiBase`. */
  readonly base: string
  /** The bearer token, or the source that mints one per request. */
  readonly accessToken: DustTokenSource
  /** Cancels the request when the turn is abandoned. */
  readonly signal?: AbortSignal
}

/**
 * Resolve the bearer token for one request.
 * @param source - the context's token or token source.
 * @param refresh - true to demand a newly minted token instead of the stored one.
 * @returns the token to send.
 */
export async function dustBearerToken(
  source: DustTokenSource,
  refresh = false,
): Promise<string> {
  return typeof source === 'string' ? source : source(refresh)
}

/** Options for one Dust call. `body` is serialized as JSON when present. */
export interface DustRequestInit {
  readonly method?: string
  readonly body?: unknown
  /**
   * Send `body` as it is, rather than as JSON.
   *
   * Dust's canonical file route takes the file's own bytes with the file's own
   * content type. JSON-encoding those wraps every pushed file in quotes and
   * escapes its newlines — which Dust accepts, stores, and hands back to the
   * agent as one long line beginning with a quote.
   */
  readonly rawBody?: boolean
  readonly headers?: Record<string, string>
  /**
   * Abort the request when Dust has not answered within this many milliseconds.
   *
   * `fetch` alone waits five minutes on a gateway that accepts a connection and
   * then never answers. Any call a loop depends on needs this: an unbounded
   * wait inside a loop is not a slow request, it is a loop that stopped.
   */
  readonly timeoutMs?: number
}

/**
 * The signal one request runs under.
 *
 * A request timeout must not cancel the caller's own signal, and the caller
 * walking away must not wait out the timeout, so the two are combined rather
 * than one replacing the other.
 * @param signal - the caller's cancellation, when there is one.
 * @param timeoutMs - the request budget, when there is one.
 * @returns the signal to pass to `fetch`, or nothing when neither applies.
 */
function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
  if (timeout === undefined) return signal
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Build the headers every Dust request carries.
 * @param accessToken - the WorkOS access token.
 * @returns bearer authorization plus this client's identity.
 */
export function dustAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': USER_AGENT,
    // Dust's CLI sends its version under this name; keeping it means the
    // required user agent above does not hide which client is really calling.
    'X-Dust-CLI-Version': CLIENT_VERSION,
    'X-Dust-Client': CLIENT_ID,
  }
}

/**
 * Perform one Dust API call without inspecting the response.
 *
 * Used directly for streaming routes, whose body must stay unread.
 *
 * A 401 is retried once against a freshly minted token when the context can
 * mint one. Dust's tokens expire on a fifteen-minute clock that no caller can
 * align a turn to, so the alternative is a turn that dies at an arbitrary
 * point in its own generation.
 * @param context - base URL, token and cancellation.
 * @param path - route relative to the base, with no leading slash.
 * @param init - method, JSON body and extra headers.
 * @returns the raw response, successful or not.
 */
export async function dustFetch(
  context: DustRequestContext,
  path: string,
  init: DustRequestInit = {},
): Promise<Response> {
  const send = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      ...dustAuthHeaders(token),
      ...init.headers,
    }
    if (init.body !== undefined && init.rawBody !== true) {
      headers['Content-Type'] = 'application/json'
    }

    // Armed per attempt: a retry that inherited the first attempt's expired
    // budget would be aborted before it was sent.
    const signal = requestSignal(context.signal, init.timeoutMs)

    return fetch(`${context.base}/${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined
        ? {}
        : { body: init.rawBody === true ? String(init.body) : JSON.stringify(init.body) }),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  const response = await send(await dustBearerToken(context.accessToken))
  if (response.status !== 401 || typeof context.accessToken === 'string') return response

  // The refused body is never read, and leaving it unread holds the connection
  // until the runtime collects it; a body already errored has nothing to free.
  await response.body?.cancel().catch(() => undefined)
  return send(await dustBearerToken(context.accessToken, true))
}

/**
 * Read a Dust error response into a classified failure.
 *
 * A non-JSON body is not itself an error to report: proxies and gateways
 * answer HTML, and the status is what callers act on.
 * @param response - the failed response.
 * @param path - the route, for attribution.
 * @returns the failure to throw.
 */
async function toApiError(response: Response, path: string): Promise<DustApiError> {
  let body: DustErrorBody | undefined
  try {
    body = (await response.json()) as DustErrorBody
  } catch {
    // Non-JSON error bodies carry no more information than the status.
  }

  const detail = body?.error?.message ?? response.statusText
  return new DustApiError(
    response.status,
    classify(response.status),
    body?.error?.type,
    `Dust ${path} failed with ${response.status}: ${detail}`,
  )
}

/**
 * Perform one Dust API call and decode its JSON body.
 * @param context - base URL, token and cancellation.
 * @param path - route relative to the base, with no leading slash.
 * @param init - method, JSON body and extra headers.
 * @returns the decoded response body.
 * @throws DustApiError when Dust answers a non-2xx status.
 */
export async function dustJson<T>(
  context: DustRequestContext,
  path: string,
  init: DustRequestInit = {},
): Promise<T> {
  const response = await dustFetch(context, path, init)
  if (!response.ok) throw await toApiError(response, path)
  return (await response.json()) as T
}
