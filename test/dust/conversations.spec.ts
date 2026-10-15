import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DustConversationGoneError,
  cancelGeneration,
  createConversation,
  findAgentMessageId,
  findUnfinishedAgentMessageIds,
  readAgentMessage,
  postContentFragment,
  postMessage,
  streamAgentEvents,
  validateAction,
} from '../../src/dust/conversations.ts'

const CONTEXT = { base: 'https://dust.tt/api/v1/w/w1', accessToken: 'tok' }

const AUTHOR = {
  username: 'ada',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  timezone: 'Europe/Paris',
}

const TURN = { agentSId: 'a1', content: 'hello', author: AUTHOR }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function mockFetch(response: Response) {
  const spy = vi.fn(async () => response)
  vi.stubGlobal('fetch', spy)
  return spy
}

/** JSON body of the nth fetch call. */
function sentBody(spy: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const [, init] = spy.mock.calls[index] as unknown as [string, RequestInit]
  return JSON.parse(init.body as string) as Record<string, unknown>
}

const CREATED = {
  conversation: {
    sId: 'c1',
    content: [[{ type: 'user_message', sId: 'um1' }]],
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('message origin', () => {
  // This is the plugin's billing contract with Dust. `cli` is classified as
  // interactive user usage; `api` and `cli_programmatic` are metered as
  // programmatic. Both message-sending routes must stamp it, and neither
  // accepts an override.
  it('stamps cli when opening a conversation', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, TURN)

    const message = sentBody(spy).message as { context: { origin: string } }
    expect(message.context.origin).toBe('cli')
  })

  it('stamps cli when continuing a conversation', async () => {
    const spy = mockFetch(jsonResponse(200, { message: { sId: 'um2' } }))
    await postMessage(CONTEXT, 'c1', TURN)

    const context = (sentBody(spy) as { context: { origin: string } }).context
    expect(context.origin).toBe('cli')
  })

  it('cannot be overridden by a caller', async () => {
    const spy = mockFetch(jsonResponse(200, { message: { sId: 'um2' } }))
    await postMessage(CONTEXT, 'c1', {
      ...TURN,
      // A caller passing an origin must not change what is sent.
      ...({ origin: 'api' } as object),
    })

    const context = (sentBody(spy) as { context: { origin: string } }).context
    expect(context.origin).toBe('cli')
  })
})

describe('createConversation', () => {
  it('posts to the workspace conversations route', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, TURN)

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dust.tt/api/v1/w/w1/assistant/conversations')
    expect(init.method).toBe('POST')
  })

  it('mentions the agent and carries the author context', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, TURN)

    const message = sentBody(spy).message as Record<string, unknown>
    expect(message.content).toBe('hello')
    expect(message.mentions).toEqual([{ configurationId: 'a1' }])
    expect(message.context).toMatchObject({
      username: 'ada',
      fullName: 'Ada Lovelace',
      email: 'ada@example.com',
      timezone: 'Europe/Paris',
    })
  })

  it('creates unlisted conversations, matching the CLI', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, TURN)

    expect(sentBody(spy).visibility).toBe('unlisted')
  })

  it('returns the conversation and the user message it just created', async () => {
    mockFetch(jsonResponse(200, CREATED))
    const turn = await createConversation(CONTEXT, TURN)

    expect(turn).toEqual({ conversationId: 'c1', userMessageId: 'um1' })
  })

  it('sends no model override by default, so the agent runs its configured model', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, TURN)

    expect(sentBody(spy).message).not.toHaveProperty('modelSelection')
  })

  it('sends a model override when one is chosen', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, {
      ...TURN,
      modelSelection: { providerId: 'anthropic', modelId: 'claude-3', reasoningEffort: 'high' },
    })

    const message = sentBody(spy).message as Record<string, unknown>
    expect(message.modelSelection).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-3',
      reasoningEffort: 'high',
    })
  })

  it('advertises the client-side MCP servers the agent may call back into', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, { ...TURN, clientSideMCPServerIds: ['srv-1'] })

    const message = sentBody(spy).message as { context: Record<string, unknown> }
    expect(message.context.clientSideMCPServerIds).toEqual(['srv-1'])
  })

  it('places the conversation in a space when a project is selected', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, { ...TURN, spaceId: 'spc-1' })

    expect(sentBody(spy).spaceId).toBe('spc-1')
  })

  it('attaches content fragments when files are uploaded with the turn', async () => {
    const spy = mockFetch(jsonResponse(200, CREATED))
    await createConversation(CONTEXT, {
      ...TURN,
      contentFragments: [{ title: 'notes.md', fileId: 'fil-1' }],
    })

    expect(sentBody(spy).contentFragments).toEqual([{ title: 'notes.md', fileId: 'fil-1' }])
  })
})

describe('postMessage', () => {
  it('posts to the conversation messages route and returns the new user message id', async () => {
    const spy = mockFetch(jsonResponse(200, { message: { sId: 'um2' } }))
    const result = await postMessage(CONTEXT, 'c1', TURN)

    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://dust.tt/api/v1/w/w1/assistant/conversations/c1/messages')
    expect(result).toEqual({ conversationId: 'c1', userMessageId: 'um2' })
  })

  it.each([404, 410])(
    'reports HTTP %i as a conversation that can no longer be continued',
    async status => {
      mockFetch(jsonResponse(status, { error: { type: 'conversation_not_found' } }))
      await expect(postMessage(CONTEXT, 'c1', TURN)).rejects.toBeInstanceOf(
        DustConversationGoneError,
      )
    },
  )

  it('does not treat a missing feature flag as a dead conversation', async () => {
    // 403 means the workspace lacks a capability; opening a new conversation
    // would fail the same way, so the caller must not silently start over.
    mockFetch(jsonResponse(403, { error: { type: 'feature_flag_missing' } }))
    const error = await postMessage(CONTEXT, 'c1', TURN).catch((e: unknown) => e)

    expect(error).not.toBeInstanceOf(DustConversationGoneError)
  })

  it('refuses a success that carries no message id', async () => {
    // An empty id defers the failure to the reply lookup, which then searches
    // for a reply to `''` and blames the agent for never answering.
    mockFetch(jsonResponse(200, { message: {} }))

    await expect(postMessage(CONTEXT, 'c1', TURN)).rejects.toThrow(/no user message id/)
  })
})

describe('cancelGeneration', () => {
  it('asks Dust to stop the named agent messages', async () => {
    const spy = mockFetch(jsonResponse(200, {}))
    await cancelGeneration(CONTEXT, 'c1', ['am1'])

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dust.tt/api/v1/w/w1/assistant/conversations/c1/cancel')
    expect(init.method).toBe('POST')
    expect(sentBody(spy)).toEqual({ action: 'cancel', messageIds: ['am1'] })
  })

  it('reports a conversation that has gone as recoverable', async () => {
    mockFetch(jsonResponse(404, { error: { message: 'not found' } }))

    await expect(cancelGeneration(CONTEXT, 'c1', ['am1'])).rejects.toBeInstanceOf(
      DustConversationGoneError,
    )
  })
})

describe('findAgentMessageId', () => {
  const conversation = {
    sId: 'c1',
    content: [
      [{ type: 'user_message', sId: 'um1' }],
      [
        { type: 'agent_message', sId: 'am1-v0', parentMessageId: 'um1' },
        { type: 'agent_message', sId: 'am1', parentMessageId: 'um1' },
      ],
    ],
  }

  it('finds the agent reply to a given user message', () => {
    expect(findAgentMessageId(conversation, 'um1')).toBe('am1')
  })

  it('takes the latest version of a retried agent message', () => {
    // Dust stores each message as a version list; only the last is live.
    expect(findAgentMessageId(conversation, 'um1')).not.toBe('am1-v0')
  })

  it('returns nothing when the reply has not been created yet', () => {
    expect(findAgentMessageId({ sId: 'c1', content: [] }, 'um1')).toBeUndefined()
  })

  it('ignores agent messages replying to a different user message', () => {
    expect(findAgentMessageId(conversation, 'um-other')).toBeUndefined()
  })
})

describe('readAgentMessage', () => {
  /** A conversation holding one agent message in the given state. */
  function withStatus(status: unknown, content?: unknown) {
    return {
      sId: 'c1',
      content: [
        [{ type: 'user_message', sId: 'um1' }],
        [{ type: 'agent_message', sId: 'am1', parentMessageId: 'um1', status, content }],
      ],
    }
  }

  it('reports a finished message with the answer Dust stored', () => {
    // The stored answer is what makes a lost event stream recoverable: the
    // turn is paid for and complete, only the delivery failed.
    expect(readAgentMessage(withStatus('succeeded', 'the answer'), 'am1')).toEqual({
      sId: 'am1',
      state: 'succeeded',
      content: 'the answer',
    })
  })

  it('reports a message Dust is still generating as running', () => {
    expect(readAgentMessage(withStatus('created'), 'am1')?.state).toBe('running')
  })

  it('reads a failed and a cancelled message apart', () => {
    expect(readAgentMessage(withStatus('failed'), 'am1')?.state).toBe('failed')
    expect(readAgentMessage(withStatus('cancelled'), 'am1')?.state).toBe('cancelled')
  })

  it('reads a gracefully stopped turn as finished', () => {
    // Dust ends a loop in place with this status and treats it as a success
    // everywhere resumption matters. Reading it as still running leaves the
    // conversation looking permanently busy to this client.
    expect(readAgentMessage(withStatus('gracefully_stopped', 'done'), 'am1')).toEqual({
      sId: 'am1',
      state: 'succeeded',
      content: 'done',
    })
  })

  it('reads an interrupted turn as finished', () => {
    expect(readAgentMessage(withStatus('interrupted'), 'am1')?.state).toBe('cancelled')
  })

  it('treats a status this client does not know as still running', () => {
    // Dust owns this vocabulary. Guessing that an unknown status means
    // finished would report an unfinished turn as a complete answer.
    expect(readAgentMessage(withStatus('reheating'), 'am1')?.state).toBe('running')
  })

  it('returns nothing for a message the conversation does not hold', () => {
    expect(readAgentMessage(withStatus('succeeded'), 'am-other')).toBeUndefined()
  })

  it('reads the live version of a retried message', () => {
    const conversation = {
      sId: 'c1',
      content: [
        [
          { type: 'agent_message', sId: 'am1', parentMessageId: 'um1', status: 'created' },
          { type: 'agent_message', sId: 'am1', parentMessageId: 'um1', status: 'succeeded', content: 'done' },
        ],
      ],
    }

    expect(readAgentMessage(conversation, 'am1')?.state).toBe('succeeded')
  })
})

describe('findUnfinishedAgentMessageIds', () => {
  it('names the generations holding a conversation against the next message', () => {
    // Dust declines to start a second generation while one is running, and
    // accepts the message anyway — so the ones still running are exactly the
    // ones that have to be stopped before the conversation is usable again.
    const conversation = {
      sId: 'c1',
      content: [
        [{ type: 'user_message', sId: 'um1' }],
        [{ type: 'agent_message', sId: 'am1', parentMessageId: 'um1', status: 'succeeded' }],
        [{ type: 'agent_message', sId: 'am2', parentMessageId: 'um2', status: 'created' }],
      ],
    }

    expect(findUnfinishedAgentMessageIds(conversation)).toEqual(['am2'])
  })

  it('finds nothing in a conversation whose every turn is over', () => {
    const conversation = {
      sId: 'c1',
      content: [
        [{ type: 'agent_message', sId: 'am1', parentMessageId: 'um1', status: 'succeeded' }],
        [{ type: 'agent_message', sId: 'am2', parentMessageId: 'um2', status: 'cancelled' }],
      ],
    }

    expect(findUnfinishedAgentMessageIds(conversation)).toEqual([])
  })

  it('counts every terminal status Dust has, not only the three obvious ones', () => {
    // Dust's status vocabulary is `created | succeeded | failed | cancelled |
    // interrupted | gracefully_stopped`, and only `created` is non-terminal.
    // Missing one makes a long-finished turn look like it is still generating
    // for the life of the conversation, so every later turn tries to cancel a
    // message that stopped hours ago and then gives up.
    const conversation = {
      sId: 'c1',
      content: [
        [{ type: 'agent_message', sId: 'am1', parentMessageId: 'um1', status: 'gracefully_stopped' }],
        [{ type: 'agent_message', sId: 'am2', parentMessageId: 'um2', status: 'interrupted' }],
        [{ type: 'agent_message', sId: 'am3', parentMessageId: 'um3', status: 'failed' }],
      ],
    }

    expect(findUnfinishedAgentMessageIds(conversation)).toEqual([])
  })
})

/** Frame agent events the way Dust's SSE stream does: `{ eventId, data }`. */
function sseStream(...records: readonly { eventId: string; data: unknown }[]): Response {
  const body = records.map(record => `data: ${JSON.stringify(record)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** Serve the event stream and the conversation from one stub, by route. */
function routedFetch(handlers: {
  events: () => Response
  conversation: () => Response
}) {
  const spy = vi.fn(async (url: string) =>
    url.includes('/events') ? handlers.events() : handlers.conversation(),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

/** How many times the event stream itself was opened. */
function streamCalls(spy: ReturnType<typeof routedFetch>): number {
  return spy.mock.calls.filter(([url]) => String(url).includes('/events')).length
}

/** A conversation whose one agent message carries the given Dust status. */
function agentMessageStatus(status: string): unknown {
  return {
    conversation: {
      sId: 'c1',
      content: [[{ type: 'agent_message', sId: 'am1', status, content: '' }]],
    },
  }
}

/** Stream options that spend no real time, so the reconnect budget is testable. */
const FAST = { delay: async () => {}, now: () => 0 }

describe('streamAgentEvents', () => {
  it('requests the agent message event stream', async () => {
    const spy = mockFetch(
      sseStream({ eventId: '1', data: { type: 'agent_message_success' } }),
    )
    for await (const _ of streamAgentEvents(CONTEXT, 'c1', 'am1')) void _

    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      'https://dust.tt/api/v1/w/w1/assistant/conversations/c1/messages/am1/events',
    )
  })

  it('unwraps the agent event from the stream envelope', async () => {
    mockFetch(
      sseStream(
        { eventId: '1', data: { type: 'generation_tokens', text: 'hi', classification: 'tokens' } },
        { eventId: '2', data: { type: 'agent_message_success' } },
      ),
    )

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1')) events.push(event)

    expect(events).toEqual([
      { type: 'generation_tokens', text: 'hi', classification: 'tokens' },
      { type: 'agent_message_success' },
    ])
  })

  it('stops at the first terminal event', async () => {
    mockFetch(
      sseStream(
        { eventId: '1', data: { type: 'agent_message_success' } },
        { eventId: '2', data: { type: 'generation_tokens', text: 'late' } },
      ),
    )

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1')) events.push(event)

    expect(events).toHaveLength(1)
  })

  it('resumes from the last event it saw when the stream drops early', async () => {
    const responses = [
      sseStream({ eventId: '7', data: { type: 'generation_tokens', text: 'a' } }),
      sseStream({ eventId: '8', data: { type: 'agent_message_success' } }),
    ]
    const spy = vi.fn(async () => responses.shift() ?? sseStream())
    vi.stubGlobal('fetch', spy)

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1')) events.push(event)

    const [secondUrl] = spy.mock.calls[1] as unknown as [string]
    expect(secondUrl).toContain('lastEventId=7')
    expect(events).toHaveLength(2)
  })

  it('skips the done sentinel Dust writes when a stream ends', async () => {
    mockFetch(
      new Response('data: done\n\ndata: {"eventId":"1","data":{"type":"agent_message_success"}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1')) events.push(event)

    expect(events).toEqual([{ type: 'agent_message_success' }])
  })

  it('keeps following a silent stream while Dust reports the generation running', async () => {
    // The failure this replaces: Dust says nothing while its agent works
    // through a long tool call, and the client read that silence as the end of
    // the turn — failing it, and cancelling a generation still being written.
    let probes = 0
    const spy = routedFetch({
      events: () => sseStream(),
      conversation: () => {
        probes += 1
        return jsonResponse(200, agentMessageStatus(probes < 4 ? 'created' : 'succeeded'))
      },
    })

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1', FAST)) events.push(event)

    expect(probes).toBe(4)
    // Four probes' worth of reconnects, where the old budget spent three in total.
    expect(streamCalls(spy)).toBeGreaterThan(10)
  })

  it('ends the stream once Dust reports the message settled', async () => {
    const spy = routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(200, agentMessageStatus('succeeded')),
    })

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1', FAST)) events.push(event)

    expect(events).toEqual([])
    // Three cheap reconnects, then the one read that settles it.
    expect(streamCalls(spy)).toBe(3)
  })

  it('reports which of its endings stopped the stream', async () => {
    // A caller that only sees the generator return cannot tell a turn that
    // waited out the whole ceiling from one that gave up after seventy
    // seconds, and reports both as the same truncation.
    const endings: string[] = []

    routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(200, agentMessageStatus('succeeded')),
    })
    for await (const _ of streamAgentEvents(CONTEXT, 'c1', 'am1', {
      ...FAST,
      onEnd: end => endings.push(end),
    })) void _

    let clock = 0
    routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(200, agentMessageStatus('created')),
    })
    for await (const _ of streamAgentEvents(CONTEXT, 'c1', 'am1', {
      ...FAST,
      maxSilentMs: 10_000,
      now: () => (clock += 4_000),
      onEnd: end => endings.push(end),
    })) void _

    expect(endings).toEqual(['settled', 'silent-timeout'])
  })

  it('gives up once a generation has been silent for longer than the ceiling', async () => {
    // A generation Dust will never finish must still end the turn, or the
    // harness waits on it for the life of the process.
    let clock = 0
    const spy = routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(200, agentMessageStatus('created')),
    })

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1', {
      ...FAST,
      maxSilentMs: 10_000,
      now: () => (clock += 4_000),
    })) {
      events.push(event)
    }

    expect(events).toEqual([])
    expect(streamCalls(spy)).toBeLessThan(10)
  })

  it('gives up when the conversation cannot be read either', async () => {
    // Without a readable conversation there is nothing left that could say the
    // turn is still running, so following it forever would only hang the turn.
    routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(500, { error: { message: 'nope' } }),
    })

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1', FAST)) events.push(event)

    expect(events).toEqual([])
  })

  it('says what made the conversation unreadable', async () => {
    // An expired token, a rate limit and a gateway outage end the stream the
    // same way; only the probe's own failure tells them apart afterwards.
    let ending: string | undefined
    let cause: Error | undefined

    routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(401, { error: { message: 'expired access token' } }),
    })
    for await (const _ of streamAgentEvents(CONTEXT, 'c1', 'am1', {
      ...FAST,
      onEnd: (end, error) => {
        ending = end
        cause = error
      },
    })) void _

    expect(ending).toBe('probe-unreadable')
    expect(cause?.message).toContain('expired access token')
  })

  it('stops following a conversation Dust has dropped', async () => {
    const spy = routedFetch({
      events: () => sseStream(),
      conversation: () => jsonResponse(404, { error: { message: 'gone' } }),
    })

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1', FAST)) events.push(event)

    expect(events).toEqual([])
    // One probe, not the three an unreadable conversation is given.
    expect(streamCalls(spy)).toBe(3)
  })

  it('resumes a stream the network broke mid-body', async () => {
    // A reset connection is the common way a long turn's stream dies. Failing
    // the turn on it throws away an answer Dust is still generating, and
    // leaves that generation holding the conversation.
    let sent = false
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          if (sent) {
            controller.error(new Error('socket hang up'))
            return
          }
          sent = true
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"eventId":"7","data":{"type":"generation_tokens","text":"a"}}\n\n',
            ),
          )
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const responses = [broken, sseStream({ eventId: '8', data: { type: 'agent_message_success' } })]
    const spy = vi.fn(async () => responses.shift() ?? sseStream())
    vi.stubGlobal('fetch', spy)

    const events = []
    for await (const event of streamAgentEvents(CONTEXT, 'c1', 'am1')) events.push(event)

    expect(events).toEqual([
      { type: 'generation_tokens', text: 'a' },
      { type: 'agent_message_success' },
    ])
    const [secondUrl] = spy.mock.calls[1] as unknown as [string]
    expect(secondUrl).toContain('lastEventId=7')
  })

  it('stops reconnecting once the caller has aborted', async () => {
    // Without this the abort is swallowed as one more disconnect and the
    // client keeps reopening a stream nobody is reading.
    const controller = new AbortController()
    const spy = vi.fn(async () => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    })
    vi.stubGlobal('fetch', spy)

    const run = async () => {
      for await (const _ of streamAgentEvents(
        { ...CONTEXT, signal: controller.signal },
        'c1',
        'am1',
      )) void _
    }

    await expect(run()).rejects.toThrow(/abort/i)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('validateAction', () => {
  it('answers Dust’s tool approval so the harness gate stays the only one', async () => {
    const spy = mockFetch(jsonResponse(200, {}))
    await validateAction(CONTEXT, 'c1', 'am1', 'act-1')

    const [url] = spy.mock.calls[0] as unknown as [string]
    expect(url).toBe(
      'https://dust.tt/api/v1/w/w1/assistant/conversations/c1/messages/am1/validate-action',
    )
    expect(sentBody(spy)).toEqual({ actionId: 'act-1', approved: 'approved' })
  })
})
describe('postContentFragment', () => {
  it('attaches an already-uploaded file to a running conversation', async () => {
    // A new conversation carries its fragments in the create body, but an
    // existing one has no such field: the fragment is its own route.
    const spy = mockFetch(jsonResponse(200, { contentFragment: { sId: 'cf1' } }))
    await postContentFragment(CONTEXT, 'c1', { fileId: 'f1', title: 'notes.md' })

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://dust.tt/api/v1/w/w1/assistant/conversations/c1/content_fragments')
    expect(init.method).toBe('POST')
    expect(sentBody(spy)).toEqual({ fileId: 'f1', title: 'notes.md' })
  })

  it('reports a conversation that has gone as recoverable', async () => {
    mockFetch(jsonResponse(404, { error: { message: 'not found' } }))

    await expect(
      postContentFragment(CONTEXT, 'c1', { fileId: 'f1', title: 'notes.md' }),
    ).rejects.toBeInstanceOf(DustConversationGoneError)
  })
})
