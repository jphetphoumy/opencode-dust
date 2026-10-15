import { afterEach, describe, expect, it, vi } from 'vitest'

import { ensurePod, listPods } from '../../src/dust/pods.ts'

const CONTEXT = { base: 'https://eu.dust.tt/api/w/w1', accessToken: 'tok' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const SPACES = {
  spaces: [
    { sId: 'vlt_global', name: 'Company Data', kind: 'global' },
    { sId: 'vlt_p1', name: 'test1', kind: 'project' },
    { sId: 'vlt_reg', name: 'Ops', kind: 'regular' },
  ],
}

describe('listing pods', () => {
  it('reports only project spaces, which is what a Pod is', () => {
    // `space_resource.ts` calls them "Project (pod) spaces". A global or
    // regular space has no pod filesystem, so offering one would produce a
    // 400 "Files are only available for Pod spaces" on the first write.
    mockFetch(() => jsonResponse(200, SPACES))

    return expect(listPods(CONTEXT)).resolves.toEqual([
      { sId: 'vlt_p1', name: 'test1' },
    ])
  })

  it('reports an empty workspace as empty', async () => {
    mockFetch(() => jsonResponse(200, {}))

    await expect(listPods(CONTEXT)).resolves.toEqual([])
  })
})

describe('finding or creating a pod by name', () => {
  it('returns the existing pod rather than making a second one', async () => {
    // Two pods of the same name would split a project's files between them,
    // and which one an ingest reached would depend on ordering.
    const calls = mockFetch(() => jsonResponse(200, SPACES))

    await expect(ensurePod(CONTEXT, 'test1')).resolves.toEqual({
      sId: 'vlt_p1',
      name: 'test1',
      created: false,
    })
    expect(calls.every(c => c.init?.method !== 'POST')).toBe(true)
  })

  it('matches a name regardless of case, as a human would', async () => {
    mockFetch(() => jsonResponse(200, SPACES))

    await expect(ensurePod(CONTEXT, 'TEST1')).resolves.toMatchObject({ sId: 'vlt_p1' })
  })

  it('creates the pod when the workspace has none by that name', async () => {
    const calls = mockFetch((url, init) =>
      init?.method === 'POST'
        ? jsonResponse(200, { space: { sId: 'vlt_new', name: 'test-pi-dust', kind: 'project' } })
        : jsonResponse(200, SPACES),
    )

    await expect(ensurePod(CONTEXT, 'test-pi-dust')).resolves.toEqual({
      sId: 'vlt_new',
      name: 'test-pi-dust',
      created: true,
    })

    const post = calls.find(c => c.init?.method === 'POST')
    expect(JSON.parse(String(post?.init?.body))).toMatchObject({
      name: 'test-pi-dust',
      spaceKind: 'project',
      isRestricted: true,
    })
  })

  it('fails loudly when Dust creates nothing', async () => {
    // Returning a pod id that does not exist would have every later call fail
    // somewhere less obvious than here.
    mockFetch((url, init) =>
      init?.method === 'POST' ? jsonResponse(200, {}) : jsonResponse(200, SPACES),
    )

    await expect(ensurePod(CONTEXT, 'nope')).rejects.toThrowError(/could not create/i)
  })
})
