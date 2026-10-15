import { afterEach, describe, expect, it, vi } from 'vitest'

import { uploadConversationBytes, uploadConversationFile } from '../../src/dust/ingest.ts'

const CONTEXT = { base: 'https://eu.dust.tt/api/v1/w/w1', accessToken: 'tok' }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Answer the create call, then the upload to the URL it handed back. */
function mockUpload(
  created: unknown = { file: { sId: 'fil_1', uploadUrl: 'https://upload.example/fil_1' } },
) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return calls.length === 1
      ? jsonResponse(200, created)
      : jsonResponse(200, { file: { sId: 'fil_1' } })
  })
  vi.stubGlobal('fetch', spy)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('putting one file into a conversation', () => {
  it('declares the file before sending its bytes', async () => {
    // Dust hands back an upload URL in exchange for the metadata; there is no
    // one-shot upload to use instead.
    const calls = mockUpload()
    await uploadConversationFile(CONTEXT, 'c1', 'src/a.ts', 'hello')

    expect(calls[0]?.url).toBe('https://eu.dust.tt/api/v1/w/w1/files')
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      fileName: 'src/a.ts',
      useCase: 'conversation',
      useCaseMetadata: { conversationId: 'c1' },
    })
  })

  it('declares the byte length, not the character count', async () => {
    // Dust checks the declared size against what arrives, and a multi-byte
    // character makes the two disagree.
    const calls = mockUpload()
    await uploadConversationFile(CONTEXT, 'c1', 'a.ts', 'héllo')

    const body = JSON.parse(String(calls[0]?.init?.body)) as { fileSize: number }
    expect(body.fileSize).toBe(Buffer.byteLength('héllo', 'utf8'))
  })

  it('sends the content to the url Dust handed back', async () => {
    const calls = mockUpload()
    await uploadConversationFile(CONTEXT, 'c1', 'a.ts', 'hello')

    expect(calls[1]?.url).toBe('https://upload.example/fil_1')
    expect(calls[1]?.init?.method).toBe('POST')
    expect(calls[1]?.init?.body).toBeInstanceOf(FormData)
  })

  it('returns the file id, which is what attaches it to the conversation', async () => {
    mockUpload()

    await expect(uploadConversationFile(CONTEXT, 'c1', 'a.ts', 'hello')).resolves.toBe('fil_1')
  })

  it('sends source as plain text, whatever the extension suggests', async () => {
    // `text/plain` is what makes Dust treat it as readable source rather than
    // guessing a type from the name and processing it as something else.
    const calls = mockUpload()
    await uploadConversationFile(CONTEXT, 'c1', 'a.ts', 'hello')

    const body = JSON.parse(String(calls[0]?.init?.body)) as { contentType: string }
    expect(body.contentType).toBe('text/plain')
  })

  it('fails loudly when Dust returns no upload url', async () => {
    // Silently skipping would leave the agent reading a file that is not there
    // and reporting the gap as its own inability.
    mockUpload({ file: { sId: 'fil_1' } })

    await expect(
      uploadConversationFile(CONTEXT, 'c1', 'a.ts', 'hello'),
    ).rejects.toThrowError(/upload url/i)
  })

  it('fails loudly when the bytes are refused', async () => {
    const spy = vi.fn(async (url: string) =>
      url.includes('upload.example')
        ? jsonResponse(413, { error: { message: 'too large' } })
        : jsonResponse(200, { file: { sId: 'fil_1', uploadUrl: 'https://upload.example/fil_1' } }),
    )
    vi.stubGlobal('fetch', spy)

    await expect(
      uploadConversationFile(CONTEXT, 'c1', 'a.ts', 'hello'),
    ).rejects.toThrowError(/413|too large/i)
  })
})

describe('putting one image into a conversation', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

  it('declares the image type rather than plain text', async () => {
    // The whole point of the byte route: `text/plain` would have Dust process
    // a PNG as source and hand the model a wall of mojibake.
    const calls = mockUpload()
    await uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png', 'c1')

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      contentType: 'image/png',
      fileName: 'shot.png',
      fileSize: bytes.byteLength,
      useCase: 'conversation',
      useCaseMetadata: { conversationId: 'c1' },
    })
  })

  it('omits the conversation metadata when the conversation does not exist yet', async () => {
    // A first turn uploads before there is any conversation to belong to, and
    // Dust's own uploader sends no metadata in exactly that case — the file is
    // claimed by the `contentFragments` of the create call instead.
    const calls = mockUpload()
    await uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png')

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('useCaseMetadata')
  })

  it('sends the bytes to the url Dust handed back', async () => {
    const calls = mockUpload()
    await uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png')

    expect(calls[1]?.url).toBe('https://upload.example/fil_1')
    expect(calls[1]?.init?.body).toBeInstanceOf(FormData)
  })

  it('sends the bytes under the declared type, not as text', async () => {
    const calls = mockUpload()
    await uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png')

    const form = calls[1]?.init?.body as FormData
    const sent = form.get('file') as File
    expect(sent.type).toBe('image/png')
    expect(await sent.bytes()).toEqual(bytes)
  })

  it('returns the file id, which is what a content fragment refers to', async () => {
    mockUpload()

    await expect(
      uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png'),
    ).resolves.toBe('fil_1')
  })

  it('fails loudly when Dust returns no upload url', async () => {
    mockUpload({ file: { sId: 'fil_1' } })

    await expect(
      uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png'),
    ).rejects.toThrowError(/upload url/i)
  })

  it('names the file in the refusal, since a turn may carry several', async () => {
    const spy = vi.fn(async (url: string) =>
      url.includes('upload.example')
        ? jsonResponse(413, { error: { message: 'too large' } })
        : jsonResponse(200, { file: { sId: 'fil_1', uploadUrl: 'https://upload.example/fil_1' } }),
    )
    vi.stubGlobal('fetch', spy)

    await expect(
      uploadConversationBytes(CONTEXT, 'shot.png', bytes, 'image/png'),
    ).rejects.toThrowError(/shot\.png/)
  })
})
