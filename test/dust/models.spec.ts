import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_DEFAULT_MODEL_ID,
  decodeModelId,
  encodeModelId,
  fetchModels,
  isReasoningEffort,
} from '../../src/dust/models.ts'

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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model id codec', () => {
  // Dust needs both a providerId and a modelId to accept a model override, but
  // the harness model seam carries a single string, so the pair is encoded.
  it('round-trips a provider and model pair', () => {
    const encoded = encodeModelId('anthropic', 'claude-3-5-sonnet')
    expect(decodeModelId(encoded)).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
    })
  })

  it('splits on the first colon, so a model id may contain colons', () => {
    expect(decodeModelId('openai:ft:gpt-4:custom')).toEqual({
      providerId: 'openai',
      modelId: 'ft:gpt-4:custom',
    })
  })

  it('decodes the agent-default id to no override at all', () => {
    // Sending any override requires the workspace's models_picker feature, so
    // the route must always offer a model that sends none.
    expect(decodeModelId(AGENT_DEFAULT_MODEL_ID)).toBeUndefined()
  })

  it('treats an id with no provider as no override rather than guessing one', () => {
    expect(decodeModelId('claude-3')).toBeUndefined()
  })
})

describe('isReasoningEffort', () => {
  it.each(['none', 'light', 'medium', 'high'])('accepts %s', effort => {
    expect(isReasoningEffort(effort)).toBe(true)
  })

  it('rejects an effort Dust does not define', () => {
    expect(isReasoningEffort('extreme')).toBe(false)
  })
})

const MODELS_BODY = {
  models: [
    {
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      displayName: 'Claude 3.5 Sonnet',
      contextSize: 200_000,
      generationTokensCount: 8192,
      isSelectable: true,
      supportsVision: true,
      supportedReasoningEfforts: { none: true, light: false, medium: true, high: true },
      defaultReasoningEffort: 'medium',
    },
    {
      providerId: 'openai',
      modelId: 'gpt-4o',
      displayName: 'GPT-4o',
      contextSize: 128_000,
      generationTokensCount: 4096,
      isSelectable: false,
      supportsVision: true,
      supportedReasoningEfforts: { none: true, light: false, medium: false, high: false },
      defaultReasoningEffort: 'none',
    },
  ],
}

const PRIVATE = { base: 'https://dust.tt/api/w/w1', accessToken: 'tok' }

describe('fetchModels', () => {
  it('reads the private workspace model catalog', async () => {
    const spy = mockFetch(jsonResponse(200, MODELS_BODY))
    await fetchModels(PRIVATE)

    const [url] = spy.mock.calls[0] as unknown as [string]
    // This route has no public equivalent; a WorkOS user grant reaches it and
    // a workspace API key does not.
    expect(url).toBe('https://dust.tt/api/w/w1/models')
  })

  it('always offers the agent-default model first', async () => {
    mockFetch(jsonResponse(200, MODELS_BODY))
    const models = await fetchModels(PRIVATE)

    expect(models[0]?.id).toBe(AGENT_DEFAULT_MODEL_ID)
  })

  it('drops models the workspace cannot select', async () => {
    mockFetch(jsonResponse(200, MODELS_BODY))
    const models = await fetchModels(PRIVATE)

    expect(models.map(model => model.id)).toEqual([
      AGENT_DEFAULT_MODEL_ID,
      'anthropic:claude-3-5-sonnet',
    ])
  })

  it('carries the real context window and generation limit', async () => {
    mockFetch(jsonResponse(200, MODELS_BODY))
    const [, sonnet] = await fetchModels(PRIVATE)

    expect(sonnet).toMatchObject({
      id: 'anthropic:claude-3-5-sonnet',
      displayName: 'Claude 3.5 Sonnet',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
    })
  })

  it('lists only the reasoning efforts the model actually supports', async () => {
    mockFetch(jsonResponse(200, MODELS_BODY))
    const [, sonnet] = await fetchModels(PRIVATE)

    // supportedReasoningEfforts is a boolean map, not a list.
    expect(sonnet?.reasoningEfforts).toEqual(['none', 'medium', 'high'])
    expect(sonnet?.defaultReasoningEffort).toBe('medium')
  })

  it('reports no reasoning support when Dust sends no effort map', async () => {
    mockFetch(
      jsonResponse(200, {
        models: [
          {
            providerId: 'x',
            modelId: 'y',
            displayName: 'Y',
            contextSize: 1000,
            isSelectable: true,
          },
        ],
      }),
    )
    const [, model] = await fetchModels(PRIVATE)

    expect(model?.reasoningEfforts).toEqual([])
  })

  it('still offers the agent default when the catalog cannot be read', async () => {
    // Catalog absence must never make the route unusable: the adapter contract
    // forbids turning a missing catalog into a rejected request.
    mockFetch(jsonResponse(403, { error: { type: 'not_authorized' } }))
    const models = await fetchModels(PRIVATE)

    expect(models.map(model => model.id)).toEqual([AGENT_DEFAULT_MODEL_ID])
  })
})
