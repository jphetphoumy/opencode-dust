import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DustApiError,
  dustAuthHeaders,
  dustFetch,
  dustJson,
} from '../../src/dust/http.ts'

const request = { base: 'https://dust.tt/api/v1/w/w1', accessToken: 'tok' }

/** Install a fetch double returning one canned response, and expose its calls. */
function mockFetch(response: Response | (() => Response | Promise<Response>)) {
  const impl = typeof response === 'function' ? response : () => response
  const spy = vi.fn(async () => impl())
  vi.stubGlobal('fetch', spy)
  return spy
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dustAuthHeaders', () => {
  it('sends the bearer token', () => {
    expect(dustAuthHeaders('tok').Authorization).toBe('Bearer tok')
  })

  it('identifies as the Dust CLI, which is what makes origin cli acceptable', () => {
    // front/lib/api/assistant/conversation.ts gates the `cli` origin on
    // `authMethod === "oauth" && userAgent === "Dust CLI"`. Any other
    // user agent makes Dust reject the message with HTTP 400 rather than
    // fall back to a different origin, so this string is load-bearing.
    expect(dustAuthHeaders('tok')['User-Agent']).toBe('Dust CLI')
  })

  it('still says which client this actually is, in its own header', () => {
    expect(dustAuthHeaders('tok')['X-Dust-Client']).toBe('opencode-dust')
  })
})

describe('dustFetch', () => {
  it('joins the path onto the workspace base and forwards the bearer token', async () => {
    const spy = mockFetch(jsonResponse(200, { ok: true }))
    await dustFetch(request, 'assistant/conversations', { method: 'POST', body: { a: 1 } })

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dust.tt/api/v1/w/w1/assistant/conversations')
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
  })

  it('omits a JSON content-type when there is no body', async () => {
    const spy = mockFetch(jsonResponse(200, {}))
    await dustFetch(request, 'me')

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('content-type')).toBeNull()
  })

  it('forwards the abort signal', async () => {
    const controller = new AbortController()
    const spy = mockFetch(jsonResponse(200, {}))
    await dustFetch({ ...request, signal: controller.signal }, 'me')

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('asks the context for a token per request', async () => {
    const tokens = ['tok-1', 'tok-2']
    const spy = mockFetch(jsonResponse(200, {}))
    const context = { ...request, accessToken: async () => tokens.shift() ?? 'exhausted' }

    await dustFetch(context, 'me')
    await dustFetch(context, 'me')

    const calls = spy.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([, init]) => new Headers(init.headers).get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ])
  })

  it('retries a refused request once against a freshly minted token', async () => {
    // A turn's token expires mid-generation; without this every stream
    // reconnect and every liveness probe fails and the turn, which Dust is
    // still generating, reports itself truncated.
    const spy: ReturnType<typeof mockFetch> = mockFetch(() =>
      spy.mock.calls.length === 1 ? jsonResponse(401, {}) : jsonResponse(200, { ok: true }),
    )
    const mint = vi.fn(async (refresh: boolean) => (refresh ? 'tok-new' : 'tok-old'))

    const response = await dustFetch({ ...request, accessToken: mint }, 'me')

    expect(response.status).toBe(200)
    expect(mint.mock.calls).toEqual([[false], [true]])
    const [, retry] = spy.mock.calls[1] as unknown as [string, RequestInit]
    expect(new Headers(retry.headers).get('authorization')).toBe('Bearer tok-new')
  })

  it('reports a refusal a fixed token cannot answer, rather than retrying it', async () => {
    const spy = mockFetch(jsonResponse(401, {}))
    const response = await dustFetch(request, 'me')

    expect(response.status).toBe(401)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('gives up when the freshly minted token is refused too', async () => {
    const spy = mockFetch(jsonResponse(401, {}))
    const response = await dustFetch({ ...request, accessToken: async () => 'tok' }, 'me')

    expect(response.status).toBe(401)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

describe('DustApiError classification', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'gone'],
    [410, 'gone'],
    [429, 'rate-limited'],
    [400, 'client'],
    [500, 'server'],
    [503, 'server'],
  ])('maps HTTP %i to kind %s', async (status, kind) => {
    mockFetch(jsonResponse(status, { error: { type: 'boom', message: 'nope' } }))
    const error = await dustJson(request, 'me').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(DustApiError)
    expect((error as DustApiError).kind).toBe(kind)
    expect((error as DustApiError).status).toBe(status)
  })

  it('carries Dust’s error type and message', async () => {
    mockFetch(jsonResponse(400, { error: { type: 'model_disabled', message: 'not enabled' } }))
    const error = (await dustJson(request, 'me').catch((e: unknown) => e)) as DustApiError

    expect(error.code).toBe('model_disabled')
    expect(error.message).toContain('not enabled')
  })

  it('still reports a failure when the error body is not JSON', async () => {
    mockFetch(new Response('<html>gateway</html>', { status: 502 }))
    const error = (await dustJson(request, 'me').catch((e: unknown) => e)) as DustApiError

    expect(error).toBeInstanceOf(DustApiError)
    expect(error.kind).toBe('server')
    expect(error.code).toBeUndefined()
  })

  it('names the route it failed on, so a failure is traceable', async () => {
    mockFetch(jsonResponse(500, {}))
    const error = (await dustJson(request, 'assistant/conversations').catch(
      (e: unknown) => e,
    )) as DustApiError

    expect(error.message).toContain('assistant/conversations')
  })
})

describe('dustJson', () => {
  it('returns the decoded body on success', async () => {
    mockFetch(jsonResponse(200, { conversation: { sId: 'c1' } }))
    await expect(dustJson(request, 'assistant/conversations')).resolves.toEqual({
      conversation: { sId: 'c1' },
    })
  })

  it('does not swallow an abort', async () => {
    mockFetch(() => {
      throw new DOMException('aborted', 'AbortError')
    })
    await expect(dustJson(request, 'me')).rejects.toThrowError(/abort/i)
  })
})
