import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deletePodFile,
  downloadPodFile,
  listPodFiles,
  podRelativePath,
  replacePodFile,
  uploadPodFile,
} from '../../src/dust/pod-files.ts'

const CONTEXT = { base: 'https://eu.dust.tt/api/w/w1', accessToken: 'tok' }
const POD = 'vlt_pod1'

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

describe('the path a pod file is addressed by', () => {
  it('strips the listing prefix, which is not what the routes accept', () => {
    // The listing answers `pod-<spaceId>/a.ts`, but every read and write wants
    // the legacy `pod/` scope. Sending back what was listed earns a 400
    // "Path must start with the correct scope prefix".
    expect(podRelativePath('pod-vlt_pod1/src/a.ts')).toBe('src/a.ts')
  })

  it('leaves a path that carries no prefix alone', () => {
    expect(podRelativePath('src/a.ts')).toBe('src/a.ts')
  })
})

describe('listing a pod', () => {
  it('reports each file by its pod-relative path', async () => {
    mockFetch(() => jsonResponse(200, {
      files: [
        { path: 'pod-vlt_pod1/a.ts', sizeBytes: 10, lastModifiedMs: 5, isDirectory: false },
        { path: 'pod-vlt_pod1/src/b.ts', sizeBytes: 20, lastModifiedMs: 6, isDirectory: false },
      ],
    }))

    const files = await listPodFiles(CONTEXT, POD)

    expect(files.map(f => f.path)).toEqual(['a.ts', 'src/b.ts'])
    expect(files[0]).toMatchObject({ bytes: 10, modifiedMs: 5 })
  })

  it('leaves directories out, which are not files to sync', async () => {
    mockFetch(() => jsonResponse(200, {
      files: [
        { path: 'pod-vlt_pod1/src', isDirectory: true },
        { path: 'pod-vlt_pod1/a.ts', sizeBytes: 1, isDirectory: false },
      ],
    }))

    expect((await listPodFiles(CONTEXT, POD)).map(f => f.path)).toEqual(['a.ts'])
  })

  it('reports an empty pod as empty rather than failing', async () => {
    mockFetch(() => jsonResponse(200, {}))

    await expect(listPodFiles(CONTEXT, POD)).resolves.toEqual([])
  })
})

describe('reading one pod file', () => {
  it('asks on the canonical route, the one Dust\'s own tools use', async () => {
    // Not `spaces/<id>/files/pod/<rel>`. That legacy scope answers 200 with a
    // different copy of the same file: after the agent edits `sum.js`, it
    // still returns what this client uploaded, while `files__cat` returns
    // what the agent wrote. Each side read back its own writes and concluded
    // the other had done nothing.
    const calls = mockFetch(() => new Response('contents', { status: 200 }))
    await downloadPodFile(CONTEXT, POD, 'src/a.ts')

    expect(calls[0]?.url).toMatch(
      /^https:\/\/eu\.dust\.tt\/api\/w\/w1\/files\/path\/pod-vlt_pod1\/src\/a\.ts\?/,
    )
  })

  it('asks for a URL the CDN has never seen', async () => {
    // Dust serves these through Cloudflare with `max-age=14400`, so a plain
    // GET answers from a cache up to four hours old — writes land and reads
    // keep returning the old file, which is indistinguishable from a write
    // that silently failed. A unique query parameter forces a MISS.
    const calls = mockFetch(() => new Response('x', { status: 200 }))
    await downloadPodFile(CONTEXT, POD, 'a.ts')
    await downloadPodFile(CONTEXT, POD, 'a.ts')

    expect(calls[0]?.url).not.toBe(calls[1]?.url)
  })

  it('returns the file as text', async () => {
    mockFetch(() => new Response('contents', { status: 200 }))

    await expect(downloadPodFile(CONTEXT, POD, 'a.ts')).resolves.toBe('contents')
  })

  it('escapes a path with a space, rather than sending a broken url', async () => {
    const calls = mockFetch(() => new Response('x', { status: 200 }))
    await downloadPodFile(CONTEXT, POD, 'my notes.md')

    expect(calls[0]?.url).toContain('my%20notes.md')
  })

  it('fails loudly when Dust refuses the read', async () => {
    mockFetch(() => new Response('nope', { status: 404 }))

    await expect(downloadPodFile(CONTEXT, POD, 'a.ts')).rejects.toThrow('404')
  })
})

describe('writing one pod file', () => {
  it('PUTs the bytes to the canonical path, in one request', async () => {
    // The legacy flow was three: declare the file, POST the bytes to the url
    // that came back, then move it because `fileName` had its slashes
    // stripped. All three succeeded and none of them wrote where the agent
    // reads.
    const calls = mockFetch(() => new Response('', { status: 201 }))
    await uploadPodFile(CONTEXT, POD, 'src/a.ts', 'body')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://eu.dust.tt/api/w/w1/files/path/pod-vlt_pod1/src/a.ts')
    expect(calls[0]?.init?.method).toBe('PUT')
    expect(calls[0]?.init?.body).toBe('body')
  })

  it('creates the intervening folders without a second request', async () => {
    const calls = mockFetch(() => new Response('', { status: 201 }))
    await uploadPodFile(CONTEXT, POD, 'deep/nested/a.ts', 'body')

    expect(calls).toHaveLength(1)
  })

  it('reports what Dust said when it refuses the write', async () => {
    mockFetch(() => new Response('too large', { status: 413 }))

    await expect(uploadPodFile(CONTEXT, POD, 'a.ts', 'body')).rejects.toThrow(/413.*too large/)
  })
})

describe('replacing a pod file', () => {
  it('overwrites in place, with no delete first', async () => {
    // The delete was for the legacy upload, which kept both copies and
    // suffixed the newcomer with its file id. The canonical route answers 200
    // for a file that was already there and overwrites it.
    const calls = mockFetch(() => new Response('', { status: 200 }))
    await replacePodFile(CONTEXT, POD, 'a.ts', 'new')

    expect(calls.map(c => c.init?.method ?? 'GET')).toEqual(['PUT'])
    expect(calls[0]?.init?.body).toBe('new')
  })
})

describe('removing one pod file', () => {
  it('deletes on the canonical route', async () => {
    const calls = mockFetch(() => new Response(null, { status: 204 }))
    await deletePodFile(CONTEXT, POD, 'src/a.ts')

    expect(calls[0]?.url).toBe('https://eu.dust.tt/api/w/w1/files/path/pod-vlt_pod1/src/a.ts')
    expect(calls[0]?.init?.method).toBe('DELETE')
  })
})
