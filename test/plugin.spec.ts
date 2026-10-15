import { describe, expect, it, vi } from 'vitest'

import plugin from '../server.ts'
import { awaitNativeOutcome, bridgeListener, isBridgedCall, markBridgedCall } from '../src/bridge/registry.ts'
import { deliverForTest, turnForTest } from '../src/plugin.ts'
import { DustLanguageModel } from '../src/provider/language-model.ts'
import { DUST_OAUTH_METHOD_ID } from '../src/provider/login.ts'

type Callback = (editor: never) => void

/** The slice of opencode's plugin context this plugin touches, recording what it registers. */
function fakeContext(options: Record<string, unknown> = {}, credential?: unknown) {
  const transforms = { integration: [] as Callback[], provider: [] as Callback[] }
  const register = (bucket: Callback[]) =>
    vi.fn(async (callback: Callback) => {
      bucket.push(callback)
      return { dispose: async () => undefined }
    })

  const hooks: { name: string; callback: (event: never) => unknown; options: unknown }[] = []
  const events: unknown[] = []
  let pushEvent: (event: unknown) => void = event => events.push(event)
  const context = {
    options,
    location: { directory: '/home/dev/my-project', project: { id: 'p1', directory: '/home/dev/my-project' } },
    aisdk: {
      hook: vi.fn(async (name: string, callback: (event: never) => unknown, hookOptions?: unknown) => {
        hooks.push({ name: `aisdk.${name}`, callback, options: hookOptions })
        return { dispose: async () => undefined }
      }),
    },
    session: {
      hook: vi.fn(async (name: string, callback: (event: never) => unknown, hookOptions?: unknown) => {
        hooks.push({ name, callback, options: hookOptions })
        return { dispose: async () => undefined }
      }),
      synthetic: vi.fn(async () => ({})),
    },
    tool: {
      list: vi.fn(async () => [
        { id: 'read', input: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] }, execute: vi.fn() },
        { id: 'shell', input: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }, execute: vi.fn() },
        { id: 'question', input: {}, execute: vi.fn() },
        { id: 'execute', input: {}, execute: vi.fn() },
      ]),
    },
    event: {
      subscribe: vi.fn((subscribeOptions?: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          const queue: unknown[] = [...events]
          let wake: (() => void) | undefined
          pushEvent = event => {
            queue.push(event)
            wake?.()
          }
          while (subscribeOptions?.signal?.aborted !== true) {
            const next = queue.shift()
            if (next !== undefined) {
              yield next
              continue
            }
            await new Promise<void>(resolve => {
              wake = resolve
              subscribeOptions?.signal?.addEventListener('abort', () => resolve(), { once: true })
            })
          }
        },
      })),
    },
    integration: {
      transform: register(transforms.integration),
      reload: vi.fn(async () => undefined),
      connection: {
        active: vi.fn(async (): Promise<unknown> => (credential === undefined ? undefined : { type: 'credential', id: 'cred1', label: 'x' })),
        resolve: vi.fn(async (): Promise<unknown> => credential),
        status: vi.fn(async () => undefined),
      },
    },
    provider: {
      transform: register(transforms.provider),
      reload: vi.fn(async () => undefined),
    },
  }
  return { context, transforms, hooks, emit: (event: unknown) => pushEvent(event) }
}

function integrationEditor() {
  const methods: unknown[] = []
  const names = new Map<string, string>()
  return {
    methods,
    names,
    editor: {
      list: () => [],
      get: () => undefined,
      update: (id: string, update: (integration: { id: string; name: string }) => void) => {
        const integration = { id, name: id }
        update(integration)
        names.set(id, integration.name)
      },
      remove: () => undefined,
      method: { list: () => [], update: (input: unknown) => methods.push(input), remove: () => undefined },
    },
  }
}

function providerEditor() {
  const added: { info: { id: string; package: string; settings?: unknown }; models: { id: string }[] }[] = []
  return { added, editor: { add: (input: (typeof added)[number]) => added.push(input) } }
}

describe('dust plugin', () => {
  it('has a stable id', () => {
    expect(plugin.id).toBe('dust')
  })

  it('registers the Dust integration with its device login', async () => {
    const { context, transforms } = fakeContext()
    await plugin.setup(context as never)

    const { editor, methods, names } = integrationEditor()
    for (const transform of transforms.integration) transform(editor as never)

    expect(names.get('dust')).toBe('Dust')
    expect(methods).toEqual([
      expect.objectContaining({
        integrationID: 'dust',
        method: expect.objectContaining({ id: DUST_OAUTH_METHOD_ID, type: 'oauth' }),
      }),
    ])
  })

  it('registers the provider, loading its SDK from this plugin', async () => {
    const { context, transforms } = fakeContext()
    await plugin.setup(context as never)

    const { editor, added } = providerEditor()
    for (const transform of transforms.provider) transform(editor as never)

    expect(added).toHaveLength(1)
    expect(added[0]?.info.id).toBe('dust')
    expect(added[0]?.info.package).toMatch(/^aisdk:file:\/\/.*\/src\/provider\/sdk\.ts$/)
    expect(added[0]?.info).not.toHaveProperty('settings')
  })

  it('offers no model before anyone has logged in', async () => {
    const { context, transforms } = fakeContext()
    await plugin.setup(context as never)

    const { editor, added } = providerEditor()
    for (const transform of transforms.provider) transform(editor as never)

    expect(added[0]?.models).toEqual([])
  })

  it('offers the workspace catalog once logged in, asking for it as the Dust CLI', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          models: [
            {
              providerId: 'openai',
              modelId: 'gpt-5',
              displayName: 'GPT 5',
              contextSize: 400_000,
              isSelectable: true,
            },
          ],
        }),
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const { context, transforms } = fakeContext(
      {},
      {
        type: 'oauth',
        methodID: DUST_OAUTH_METHOD_ID,
        access: 'tok',
        refresh: 'r',
        expires: Date.now() + 600_000,
        metadata: { region: 'us-central1', workspaceId: 'w1' },
      },
    )
    await plugin.setup(context as never)

    const { editor, added } = providerEditor()
    for (const transform of transforms.provider) transform(editor as never)

    expect(added[0]?.models.map(model => model.id)).toEqual(['openai:gpt-5'])
    expect(fetch).toHaveBeenCalledWith(
      'https://dust.tt/api/w/w1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'Dust CLI', Authorization: 'Bearer tok' }),
      }),
    )
  })

  it('reloads the catalog once a login lands, without restarting opencode', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            models: [{ providerId: 'openai', modelId: 'gpt-5', displayName: 'GPT 5', isSelectable: true }],
          }),
        ),
      ),
    )
    const { context, transforms } = fakeContext()
    await plugin.setup(context as never)

    // opencode reruns provider transforms when a credential changes.
    context.integration.connection.active.mockResolvedValue({ type: 'credential', id: 'cred1', label: 'x' })
    context.integration.connection.resolve.mockResolvedValue({
      type: 'oauth',
      methodID: DUST_OAUTH_METHOD_ID,
      access: 'tok',
      refresh: 'r',
      expires: Date.now() + 600_000,
      metadata: { region: 'us-central1', workspaceId: 'w1' },
    })
    for (const transform of transforms.provider) transform(providerEditor().editor as never)

    await vi.waitFor(() => expect(context.provider.reload).toHaveBeenCalled())
    const { editor, added } = providerEditor()
    for (const transform of transforms.provider) transform(editor as never)
    expect(added[0]?.models.map(model => model.id)).toEqual(['openai:gpt-5'])
  })

  it('still registers the provider when the catalog cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const { context, transforms } = fakeContext(
      {},
      { type: 'oauth', methodID: DUST_OAUTH_METHOD_ID, access: 'tok', refresh: 'r', expires: 0, metadata: { workspaceId: 'w1' } },
    )
    await plugin.setup(context as never)

    const { editor, added } = providerEditor()
    for (const transform of transforms.provider) transform(editor as never)

    expect(added[0]?.models).toEqual([])
  })
})

describe('dust plugin SDK', () => {
  it('builds the Dust SDK itself, so a reloaded plugin never runs a stale model', async () => {
    const { context, hooks } = fakeContext()
    await plugin.setup(context as never)

    const hook = hooks.find(entry => entry.name === 'aisdk.sdk')
    expect(hook?.options).toEqual({ providerID: 'dust' })

    const event = {
      model: { providerID: 'dust', id: 'openai:gpt-5' },
      package: 'file:///old/sdk.ts',
      options: { apiKey: 'tok', workspaceId: 'w1', region: 'europe-west1' },
      sdk: { stale: true } as unknown,
    }
    await hook?.callback(event as never)

    const model = (event.sdk as { languageModel: (id: string) => unknown }).languageModel('openai:gpt-5')
    expect(model).toBeInstanceOf(DustLanguageModel)
    expect((model as DustLanguageModel).settings).toMatchObject({ accessToken: 'tok', workspaceId: 'w1' })
  })

  it('leaves every other provider’s SDK alone', async () => {
    const { context, hooks } = fakeContext()
    await plugin.setup(context as never)

    const event = { model: { providerID: 'openai' }, package: '@ai-sdk/openai', options: {}, sdk: undefined }
    await hooks.find(entry => entry.name === 'aisdk.sdk')?.callback(event as never)

    expect(event.sdk).toBeUndefined()
  })
})

describe('dust plugin bridge', () => {
  const LOGGED_IN = {
    type: 'oauth',
    methodID: DUST_OAUTH_METHOD_ID,
    access: 'tok',
    refresh: 'r',
    expires: Date.now() + 600_000,
    metadata: { region: 'us-central1', workspaceId: 'w1' },
  }

  /** A Dust that has no pods yet, creates one, and accepts file writes. */
  function fakeDustApi() {
    const calls: { method: string; url: string; body?: string }[] = []
    const fetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
      if (url.endsWith('/api/w/w1/models')) return json({ models: [] })
      if (url.endsWith('/api/w/w1/spaces') && method === 'GET') return json({ spaces: [] })
      if (url.endsWith('/api/w/w1/spaces') && method === 'POST') {
        return json({ space: { sId: 'vlt_pod', name: 'opencode-my-project' } })
      }
      if (url.includes('/files/path/') && method === 'PUT') return new Response(null, { status: 201 })
      if (url.endsWith('/spaces/vlt_pod/files')) return json({ files: [] })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetch)
    return { calls }
  }

  /** What opencode's context hook is handed for one Dust request. */
  function dustRequest() {
    return {
      sessionID: 'ses_1',
      tools: {} as Record<string, { description: string; input: unknown }>,
      options: {} as Record<string, unknown>,
    }
  }

  /** Run the context hook as opencode does before a Dust request. */
  async function firstDustRequest(hooks: { name: string; callback: (event: never) => unknown }[]) {
    const event = dustRequest()
    await hooks.find(entry => entry.name === 'context')?.callback(event as never)
    return event
  }

  it('makes no pod until the project’s first Dust request', async () => {
    const { calls } = fakeDustApi()
    const { context } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(calls.some(call => call.url.endsWith('/spaces'))).toBe(false)
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('creates a private exchange pod named after the project, and leaves the helper in it', async () => {
    const { calls } = fakeDustApi()
    const { context, hooks } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)
    await firstDustRequest(hooks)

    await vi.waitFor(() => {
      expect(calls.some(call => call.method === 'PUT' && call.url.includes('/oc-tools/oc.sh'))).toBe(true)
    })
    const create = calls.find(call => call.method === 'POST' && call.url.endsWith('/spaces'))
    expect(JSON.parse(create?.body ?? '{}')).toMatchObject({
      name: 'opencode-my-project',
      spaceKind: 'project',
      isRestricted: true,
    })
    const helper = calls.find(call => call.url.includes('/oc-tools/oc.sh'))
    expect(helper?.url).toContain('files/path/pod-vlt_pod/oc-tools/oc.sh')
    expect(helper?.body).toContain('#!/usr/bin/env bash')
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('keeps opencode’s tools, which run the bridged calls, and hands the request the bridge', async () => {
    fakeDustApi()
    const { context, hooks } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)

    const hook = hooks.find(entry => entry.name === 'context')
    expect(hook?.options).toEqual({ providerID: 'dust' })

    const event = {
      sessionID: 'ses_1',
      tools: {
        read: { description: 'Read', input: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
        execute: { description: 'Code mode', input: {} },
      },
      options: {} as Record<string, unknown>,
    }
    await hook?.callback(event as never)

    expect(Object.keys(event.tools)).toEqual(['read', 'execute'])
    const bridge = event.options['dustBridge'] as { sessionID: string; spaceId: string; note: string }
    expect(bridge.sessionID).toBe('ses_1')
    expect(bridge.spaceId).toBe('vlt_pod')
    expect(bridge.note).toContain('read(filePath)')
    expect(bridge.note).toContain('shell(command)')
    expect(bridge.note).not.toContain('question(')
    expect(bridge.note).not.toContain('execute(')
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('still answers the request when the pod cannot be made, without the bridge', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const { context, hooks } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)

    const event = await firstDustRequest(hooks)

    expect(event.options).not.toHaveProperty('dustBridge')
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('offers no bridge before anyone has logged in', async () => {
    const { context, hooks } = fakeContext()
    await plugin.setup(context as never)

    const event = { sessionID: 'ses_1', tools: { read: { description: '', input: {} } }, options: {} as Record<string, unknown> }
    await hooks.find(entry => entry.name === 'context')?.callback(event as never)

    expect(event.options).not.toHaveProperty('dustBridge')
  })

  it('listens for its pod’s Dust turns once logged in', async () => {
    fakeDustApi()
    const { context, hooks } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)
    await firstDustRequest(hooks)

    await vi.waitFor(() => expect(bridgeListener('vlt_pod')).toBeDefined())
    await (cleanup as (() => Promise<void>) | undefined)?.()
    expect(bridgeListener('vlt_pod')).toBeUndefined()
  })

  it('delivers a finished request as a queued synthetic message', async () => {
    fakeDustApi()
    const { context, hooks } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)
    await firstDustRequest(hooks)
    await vi.waitFor(() => expect(bridgeListener('vlt_pod')).toBeDefined())

    await deliverForTest('vlt_pod', 'ses_1', 'done')

    expect(context.session.synthetic).toHaveBeenCalledWith({ sessionID: 'ses_1', text: 'done', delivery: 'queue' })
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('runs bridged calls under the step opencode reports for the session', async () => {
    fakeDustApi()
    const { context, emit, hooks } = fakeContext({}, LOGGED_IN)
    const cleanup = await plugin.setup(context as never)
    await firstDustRequest(hooks)
    await vi.waitFor(() => expect(bridgeListener('vlt_pod')).toBeDefined())

    emit({
      type: 'session.step.started',
      data: { sessionID: 'ses_1', assistantMessageID: 'msg_9', agent: 'build', model: { providerID: 'dust' } },
    })

    await vi.waitFor(() => expect(turnForTest('vlt_pod', 'ses_1')).toEqual({ agent: 'build', messageID: 'msg_9' }))
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })
})

describe('dust plugin reading bridged tool results', () => {
  it('settles a bridged call from opencode’s success event', async () => {
    const { context, emit } = fakeContext()
    const cleanup = await plugin.setup(context as never)
    markBridgedCall('call_ok', 'ses_1')
    const outcome = awaitNativeOutcome('call_ok')

    emit({
      type: 'session.tool.success',
      data: { sessionID: 'ses_1', id: 'call_ok', content: [{ type: 'text', text: 'Edit applied.' }] },
    })

    await expect(outcome).resolves.toMatchObject({ output: 'Edit applied.', isError: false })
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('settles a refused or failed call as an error the agent can read', async () => {
    const { context, emit } = fakeContext()
    const cleanup = await plugin.setup(context as never)
    markBridgedCall('call_no', 'ses_1')
    const outcome = awaitNativeOutcome('call_no')

    emit({
      type: 'session.tool.failed',
      data: { sessionID: 'ses_1', id: 'call_no', error: { type: 'permission', message: 'The user rejected permission' } },
    })

    await expect(outcome).resolves.toMatchObject({ isError: true, output: expect.stringContaining('rejected permission') })
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })

  it('leaves the model’s own tool calls alone', async () => {
    const { context, emit } = fakeContext()
    const cleanup = await plugin.setup(context as never)

    emit({ type: 'session.tool.success', data: { sessionID: 'ses_1', id: 'not_ours', content: [{ type: 'text', text: 'x' }] } })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(isBridgedCall('not_ours')).toBe(false)
    await (cleanup as (() => Promise<void>) | undefined)?.()
  })
})
