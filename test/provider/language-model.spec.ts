import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { isBridgedCall, nativeSink, registerBridge } from '../../src/bridge/registry.ts'
import { DustThreadStore } from '../../src/provider/history.ts'
import { DustLanguageModel, type DustSettings } from '../../src/provider/language-model.ts'

const SETTINGS: DustSettings = {
  accessToken: 'tok',
  region: 'europe-west1',
  workspaceId: 'w1',
  agentSId: 'dust',
}

const BASE = 'https://eu.dust.tt/api/v1/w/w1'

interface Recorded {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sse(events: readonly Record<string, unknown>[]): Response {
  const text = events
    .map((data, index) => `data: ${JSON.stringify({ eventId: String(index), data })}\n\n`)
    .join('')
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } })
}

const CONVERSATION = {
  conversation: {
    sId: 'c1',
    content: [
      [{ type: 'user_message', sId: 'u1' }],
      [{ type: 'agent_message', sId: 'm1', parentMessageId: 'u1', status: 'created' }],
    ],
  },
}

/**
 * A fake Dust that answers every route a turn touches, and records what it
 * was sent so the billing-relevant fields can be asserted.
 */
function fakeDust(events: readonly Record<string, unknown>[]) {
  const requests: Recorded[] = []
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    requests.push({
      method,
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })

    if (url.endsWith('/events')) return sse(events)
    if (method === 'POST' && url === `${BASE}/assistant/conversations`) return json(CONVERSATION)
    if (method === 'POST' && url === `${BASE}/assistant/conversations/c1/messages`) {
      return json({ message: { sId: 'u2' } })
    }
    if (url === `${BASE}/assistant/conversations/c1`) {
      return json({
        conversation: {
          sId: 'c1',
          content: [
            ...CONVERSATION.conversation.content,
            [{ type: 'user_message', sId: 'u2' }],
            [{ type: 'agent_message', sId: 'm2', parentMessageId: 'u2', status: 'created' }],
          ],
        },
      })
    }
    if (url.endsWith('/cancel') || url.endsWith('/validate-action')) return json({ success: true })
    if (method === 'POST' && url === `${BASE}/files`) {
      const name = (JSON.parse(String(init?.body)) as { fileName: string }).fileName
      return json({ file: { sId: `fil_${name}`, uploadUrl: `https://eu.dust.tt/upload/${name}` } })
    }
    if (method === 'POST' && url.startsWith('https://eu.dust.tt/upload/')) return json({ file: {} })
    if (method === 'POST' && url.endsWith('/content_fragments')) return json({ contentFragment: {} })
    throw new Error(`unexpected ${method} ${url}`)
  })
  vi.stubGlobal('fetch', fetch)
  return { requests, fetch }
}

const ANSWER = [
  { type: 'generation_tokens', classification: 'chain_of_thought', text: 'Thinking.' },
  { type: 'generation_tokens', classification: 'tokens', text: 'Hello ' },
  { type: 'generation_tokens', classification: 'tokens', text: 'world' },
  { type: 'agent_message_success' },
]

function call(prompt: LanguageModelV3CallOptions['prompt'], signal?: AbortSignal): LanguageModelV3CallOptions {
  return { prompt, ...(signal === undefined ? {} : { abortSignal: signal }) }
}

const hello = call([
  { role: 'system', content: 'Be terse.' },
  { role: 'user', content: [{ type: 'text', text: 'hi' }] },
])

async function collect(stream: ReadableStream<LanguageModelV3StreamPart>) {
  const parts: LanguageModelV3StreamPart[] = []
  for await (const part of stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) {
    parts.push(part)
  }
  return parts
}

function model(modelId = 'anthropic:claude-sonnet-5', settings: DustSettings = SETTINGS) {
  return new DustLanguageModel(modelId, settings, { threads: new DustThreadStore() })
}

describe('DustLanguageModel', () => {
  it('identifies itself as an AI SDK v3 model of the dust provider', () => {
    const subject = model('openai:gpt-5')

    expect(subject.specificationVersion).toBe('v3')
    expect(subject.provider).toBe('dust')
    expect(subject.modelId).toBe('openai:gpt-5')
  })

  describe('billing contract', () => {
    it('sends every request with the Dust CLI user agent', async () => {
      const { requests } = fakeDust(ANSWER)

      await collect((await model().doStream(hello)).stream)

      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) {
        expect(request.headers['User-Agent']).toBe('Dust CLI')
        expect(request.headers['Authorization']).toBe('Bearer tok')
      }
    })

    it('stamps the user message with the cli origin', async () => {
      const { requests } = fakeDust(ANSWER)

      await collect((await model().doStream(hello)).stream)

      const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
      expect(create?.body).toMatchObject({
        message: {
          content: 'Be terse.\n\n---\n\nhi',
          mentions: [{ configurationId: 'dust' }],
          context: { origin: 'cli', username: 'opencode' },
        },
      })
    })

    it('stamps a follow-up message with the cli origin too', async () => {
      const { requests } = fakeDust(ANSWER)
      const subject = model()
      await collect((await subject.doStream(hello)).stream)

      await collect(
        (
          await subject.doStream(
            call([
              { role: 'system', content: 'Be terse.' },
              { role: 'user', content: [{ type: 'text', text: 'hi' }] },
              { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
              { role: 'user', content: [{ type: 'text', text: 'again' }] },
            ]),
          )
        ).stream,
      )

      const append = requests.find(
        request => request.url === `${BASE}/assistant/conversations/c1/messages`,
      )
      expect(append?.body).toMatchObject({ content: 'again', context: { origin: 'cli' } })
    })
  })

  it('streams reasoning then text, and finishes with stop', async () => {
    fakeDust(ANSWER)

    const parts = await collect((await model().doStream(hello)).stream)

    expect(parts.map(part => part.type)).toEqual([
      'stream-start',
      'response-metadata',
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(parts.filter(part => part.type === 'text-delta').map(part => part.delta).join('')).toBe(
      'Hello world',
    )
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } })
  })

  it('reports the Dust conversation as the response id', async () => {
    fakeDust(ANSWER)

    const parts = await collect((await model().doStream(hello)).stream)

    expect(parts.find(part => part.type === 'response-metadata')).toMatchObject({ id: 'c1' })
  })

  it('strips the thinking and response delimiters left in raw tokens', async () => {
    fakeDust([
      { type: 'generation_tokens', classification: 'tokens', text: '<respo' },
      { type: 'generation_tokens', classification: 'tokens', text: 'nse>ok</response>' },
      { type: 'agent_message_success' },
    ])

    const parts = await collect((await model().doStream(hello)).stream)

    expect(parts.filter(part => part.type === 'text-delta').map(part => part.delta).join('')).toBe('ok')
  })

  it('runs the real model through Dust’s default agent', async () => {
    const { requests } = fakeDust(ANSWER)

    await collect((await model().doStream(hello)).stream)

    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    expect(create?.body).toMatchObject({
      message: {
        mentions: [{ configurationId: 'dust' }],
        modelSelection: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
      },
    })
    expect((create?.body as { message: { modelSelection: object } }).message.modelSelection)
      .not.toHaveProperty('reasoningEffort')
  })

  it('refuses a model id that names no real model, rather than running the agent’s own', async () => {
    const { requests } = fakeDust(ANSWER)

    await expect(model('agent-default').doStream(hello)).rejects.toThrow(/not a Dust model/)
    expect(requests).toEqual([])
  })

  it('sends the catalog model and reasoning effort as a model override', async () => {
    const { requests } = fakeDust(ANSWER)

    await collect(
      (await model('openai:gpt-5', { ...SETTINGS, reasoningEffort: 'high' }).doStream(hello)).stream,
    )

    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    expect(create?.body).toMatchObject({
      message: {
        modelSelection: { providerId: 'openai', modelId: 'gpt-5', reasoningEffort: 'high' },
      },
    })
  })

  it('approves the agent’s own tool calls so the turn does not stall', async () => {
    const { requests } = fakeDust([
      { type: 'tool_approve_execution', actionId: 'act1' },
      ...ANSWER,
    ])

    await collect((await model().doStream(hello)).stream)

    const approval = requests.find(request => request.url.endsWith('/validate-action'))
    expect(approval?.url).toBe(`${BASE}/assistant/conversations/c1/messages/m1/validate-action`)
    expect(approval?.body).toEqual({ actionId: 'act1', approved: 'approved' })
  })

  it('turns an agent error into a stream error and an error finish', async () => {
    fakeDust([{ type: 'agent_error', error: { message: 'quota exceeded' } }])

    const parts = await collect((await model().doStream(hello)).stream)

    const error = parts.find(part => part.type === 'error')
    expect(String((error as { error: unknown }).error)).toContain('quota exceeded')
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'error' } })
  })

  it('refuses to run without a workspace, rather than guessing one', async () => {
    fakeDust(ANSWER)

    await expect(model('anthropic:claude-sonnet-5', { ...SETTINGS, workspaceId: '' }).doStream(hello)).rejects.toThrow(
      /workspace/i,
    )
  })

  it('collects the streamed answer for doGenerate', async () => {
    fakeDust(ANSWER)

    const result = await model().doGenerate(hello)

    expect(result.content).toEqual([
      { type: 'reasoning', text: 'Thinking.' },
      { type: 'text', text: 'Hello world' },
    ])
    expect(result.finishReason.unified).toBe('stop')
  })

  it('cancels the Dust generation when the caller aborts', async () => {
    const { requests } = fakeDust([
      { type: 'generation_tokens', classification: 'tokens', text: 'partial' },
    ])
    const controller = new AbortController()
    const { stream } = await model().doStream(call(hello.prompt, controller.signal))
    const reader = stream.getReader()

    for (;;) {
      const { value } = await reader.read()
      if (value?.type === 'text-delta') break
    }
    controller.abort()
    await reader.cancel().catch(() => undefined)
    await vi.waitFor(() => {
      expect(requests.some(request => request.url.endsWith('/cancel'))).toBe(true)
    })
  })
})

describe('DustLanguageModel with the opencode bridge', () => {
  const NOTE = 'Use the helper.'

  /** A call carrying the bridge context the plugin's context hook adds. */
  function bridged(prompt: LanguageModelV3CallOptions['prompt']): LanguageModelV3CallOptions {
    return {
      prompt,
      providerOptions: { dust: { dustBridge: { sessionID: 'ses_1', spaceId: 'vlt_pod', note: NOTE } } },
    }
  }

  afterEach(() => {
    registerBridge('vlt_pod', undefined)
  })

  it('files a new conversation in the exchange pod, so the sandbox mounts it', async () => {
    const { requests } = fakeDust(ANSWER)

    await collect((await model().doStream(bridged(hello.prompt))).stream)

    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    expect(create?.body).toMatchObject({ spaceId: 'vlt_pod' })
  })

  it('puts the bridge note in front of every turn, appends included', async () => {
    const { requests } = fakeDust(ANSWER)
    const subject = model()
    await collect((await subject.doStream(bridged(hello.prompt))).stream)
    await collect(
      (
        await subject.doStream(
          bridged([
            ...hello.prompt,
            { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
            { role: 'user', content: [{ type: 'text', text: 'again' }] },
          ]),
        )
      ).stream,
    )

    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    const append = requests.find(request => request.url === `${BASE}/assistant/conversations/c1/messages`)
    expect((create?.body as { message: { content: string } }).message.content).toMatch(
      /^Use the helper\.\n\n---\n\nBe terse\./,
    )
    expect((append?.body as { content: string }).content).toBe('Use the helper.\n\n---\n\nagain')
  })

  it('tells the bridge when the session’s Dust turn starts and ends', async () => {
    fakeDust(ANSWER)
    const listener = { streamStarted: vi.fn(), streamEnded: vi.fn() }
    registerBridge('vlt_pod', listener)

    await collect((await model().doStream(bridged(hello.prompt))).stream)

    expect(listener.streamStarted).toHaveBeenCalledWith('ses_1', 'c1')
    expect(listener.streamEnded).toHaveBeenCalledWith('ses_1')
  })

  it('shows the agent’s sandbox commands in its reasoning', async () => {
    fakeDust([
      {
        type: 'agent_action_success',
        action: {
          internalMCPServerName: 'sandbox',
          toolName: 'bash',
          params: { command: 'bash /files/pod/oc-tools/oc.sh step1 <<EOF' },
          status: 'succeeded',
        },
      },
      ...ANSWER,
    ])

    const parts = await collect((await model().doStream(bridged(hello.prompt))).stream)

    const reasoning = parts
      .filter(part => part.type === 'reasoning-delta')
      .map(part => part.delta)
      .join('')
    expect(reasoning).toContain('$ bash /files/pod/oc-tools/oc.sh step1 <<EOF')
  })

  it('works unbridged when the plugin passed nothing', async () => {
    const { requests } = fakeDust(ANSWER)

    await collect((await model().doStream(hello)).stream)

    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    expect(create?.body).not.toHaveProperty('spaceId')
  })
})

describe('DustLanguageModel with pasted images', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const look = (text: string) => ({
    role: 'user' as const,
    content: [
      { type: 'text' as const, text },
      { type: 'file' as const, data: PNG, mediaType: 'image/png' },
    ],
  })

  it('uploads the image under its own type and attaches it to the new conversation', async () => {
    const { requests } = fakeDust(ANSWER)

    await collect((await model().doStream(call([look('what is this?')]))).stream)

    const declare = requests.find(request => request.url === `${BASE}/files`)
    expect(declare?.body).toMatchObject({ contentType: 'image/png', fileName: 'pasted-1.png', useCase: 'conversation' })
    expect(requests.some(request => request.url === 'https://eu.dust.tt/upload/pasted-1.png')).toBe(true)
    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    expect(create?.body).toMatchObject({ contentFragments: [{ title: 'pasted-1.png', fileId: 'fil_pasted-1.png' }] })
  })

  it('attaches an image to an existing conversation before the message it illustrates', async () => {
    const { requests } = fakeDust(ANSWER)
    const subject = model()
    await collect((await subject.doStream(hello)).stream)

    await collect(
      (
        await subject.doStream(
          call([...hello.prompt, { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] }, look('and this?')]),
        )
      ).stream,
    )

    const fragment = requests.findIndex(request => request.url === `${BASE}/assistant/conversations/c1/content_fragments`)
    const message = requests.findIndex(request => request.url === `${BASE}/assistant/conversations/c1/messages`)
    expect(fragment).toBeGreaterThan(-1)
    expect(fragment).toBeLessThan(message)
    expect(requests[fragment]?.body).toEqual({ fileId: 'fil_pasted-1.png', title: 'pasted-1.png' })
    expect(requests.find(request => request.url === `${BASE}/files`)?.body).toMatchObject({
      useCaseMetadata: { conversationId: 'c1' },
    })
  })

  it('still answers the words when Dust refuses the image', async () => {
    const { requests, fetch } = fakeDust(ANSWER)
    const answer = fetch.getMockImplementation()
    fetch.mockImplementation(async (input: string, init?: RequestInit) =>
      String(input) === `${BASE}/files` ? json({ error: { message: 'too big' } }, 400) : answer!(input, init))

    const parts = await collect((await model().doStream(call([look('what is this?')]))).stream)

    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } })
    const create = requests.find(request => request.url === `${BASE}/assistant/conversations`)
    expect(create?.body).not.toHaveProperty('contentFragments')
  })
})

describe('DustLanguageModel carrying bridged calls into opencode’s loop', () => {
  function bridged(prompt: LanguageModelV3CallOptions['prompt']): LanguageModelV3CallOptions {
    return {
      prompt,
      providerOptions: { dust: { dustBridge: { sessionID: 'ses_1', spaceId: 'vlt_pod', note: 'note' } } },
    }
  }

  afterEach(() => {
    registerBridge('vlt_pod', undefined)
  })

  it('emits a bridged call as an opencode tool call, inside the turn that asked for it', async () => {
    fakeDust(ANSWER)
    registerBridge('vlt_pod', {
      streamStarted: sessionID => {
        nativeSink(sessionID)?.emit({ tool: 'edit', arguments: { path: 'a.ts', oldString: 'a', newString: 'b' } })
      },
      streamEnded: () => undefined,
    })

    const parts = await collect((await model().doStream(bridged(hello.prompt))).stream)

    const call = parts.find(part => part.type === 'tool-call')
    expect(call).toMatchObject({
      type: 'tool-call',
      toolName: 'edit',
      input: JSON.stringify({ path: 'a.ts', oldString: 'a', newString: 'b' }),
    })
    expect(isBridgedCall((call as { toolCallId: string }).toolCallId)).toBe(true)
    expect(parts.at(-1)).toMatchObject({ type: 'finish', finishReason: { unified: 'tool-calls' } })
  })

  it('names a bash call by opencode’s shell tool', async () => {
    fakeDust(ANSWER)
    registerBridge('vlt_pod', {
      streamStarted: sessionID => {
        nativeSink(sessionID)?.emit({ tool: 'bash', arguments: { command: 'ls' } })
      },
      streamEnded: () => undefined,
    })

    const parts = await collect((await model().doStream(bridged(hello.prompt))).stream)

    expect(parts.find(part => part.type === 'tool-call')).toMatchObject({ toolName: 'shell' })
  })

  it('closes the open text before a tool call, so the card lands between the sentences', async () => {
    fakeDust(ANSWER)
    registerBridge('vlt_pod', {
      streamStarted: sessionID => {
        nativeSink(sessionID)?.emit({ tool: 'read', arguments: {} })
      },
      streamEnded: () => undefined,
    })

    const parts = await collect((await model().doStream(bridged(hello.prompt))).stream)

    const index = parts.findIndex(part => part.type === 'tool-call')
    const before = parts.slice(0, index).map(part => part.type)
    const open = before.filter(type => type === 'text-start' || type === 'reasoning-start').length
    const closed = before.filter(type => type === 'text-end' || type === 'reasoning-end').length
    expect(open).toBe(closed)
  })

  it('takes no more calls once the turn is over', async () => {
    fakeDust(ANSWER)

    await collect((await model().doStream(bridged(hello.prompt))).stream)

    expect(nativeSink('ses_1')).toBeUndefined()
  })

  it('answers opencode’s follow-up step with nothing, because Dust already has the results', async () => {
    const { requests } = fakeDust(ANSWER)
    let id = ''
    registerBridge('vlt_pod', {
      streamStarted: sessionID => {
        id = nativeSink(sessionID)?.emit({ tool: 'read', arguments: {} }) ?? ''
      },
      streamEnded: () => undefined,
    })
    const subject = model()
    await collect((await subject.doStream(bridged(hello.prompt))).stream)
    const sent = requests.length

    const parts = await collect(
      (
        await subject.doStream(
          bridged([
            ...hello.prompt,
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hello world' },
                { type: 'tool-call', toolCallId: id, toolName: 'read', input: {} },
              ],
            },
            {
              role: 'tool',
              content: [{ type: 'tool-result', toolCallId: id, toolName: 'read', output: { type: 'text', value: 'x' } }],
            },
          ]),
        )
      ).stream,
    )

    expect(requests.length).toBe(sent)
    expect(parts.map(part => part.type)).toEqual(['stream-start', 'finish'])
    expect(parts.at(-1)).toMatchObject({ finishReason: { unified: 'stop' } })
  })
})
