import { describe, expect, it } from 'vitest'

import { AGENT_DEFAULT_MODEL, type DustModel } from '../../src/dust/models.ts'
import { DUST_PROVIDER_ID, providerInfo, toOpencodeModels } from '../../src/provider/catalog.ts'

const PLAIN: DustModel = {
  id: 'mistral:mistral-large-latest',
  displayName: 'Mistral Large',
  contextWindow: 128_000,
  reasoningEfforts: [],
  supportsVision: false,
}

const REASONING: DustModel = {
  id: 'openai:gpt-5',
  displayName: 'GPT 5',
  contextWindow: 400_000,
  maxOutputTokens: 64_000,
  reasoningEfforts: ['light', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  supportsVision: true,
}

describe('providerInfo', () => {
  it('registers the provider as an AI SDK package loaded from this plugin', () => {
    const info = providerInfo('file:///plugin/src/provider/sdk.ts')

    expect(info).toEqual({
      id: DUST_PROVIDER_ID,
      integrationID: DUST_PROVIDER_ID,
      name: 'Dust',
      activation: 'auto',
      package: 'aisdk:file:///plugin/src/provider/sdk.ts',
    })
  })
})

describe('toOpencodeModels', () => {
  it('offers the real models only, never the agent default', () => {
    const models = toOpencodeModels([AGENT_DEFAULT_MODEL, REASONING, PLAIN])

    expect(models.map(model => model.id)).toEqual(['openai:gpt-5', 'mistral:mistral-large-latest'])
  })

  it('offers nothing when the catalog could not be read', () => {
    expect(toOpencodeModels([AGENT_DEFAULT_MODEL])).toEqual([])
  })

  it('keeps the catalog id as the model id, so the SDK can decode the selection', () => {
    const [model] = toOpencodeModels([AGENT_DEFAULT_MODEL, REASONING])

    expect(model).toMatchObject({
      id: 'openai:gpt-5',
      modelID: 'openai:gpt-5',
      providerID: 'dust',
      name: 'GPT 5',
      status: 'active',
      enabled: true,
      limit: { context: 400_000, output: 64_000 },
    })
  })

  it('advertises no tool calling, because Dust runs the agent loop itself', () => {
    const [model] = toOpencodeModels([PLAIN])

    expect(model?.capabilities).toEqual({ tools: false, input: ['text'], output: ['text'] })
  })

  it('takes images for a model with vision, so opencode lets a pasted screenshot through', () => {
    const [model] = toOpencodeModels([REASONING])

    expect(model?.capabilities.input).toEqual(['text', 'image'])
  })

  it('offers one variant per reasoning effort Dust accepts', () => {
    const [model] = toOpencodeModels([REASONING])

    expect(model?.variants).toEqual([
      { id: 'light', settings: { reasoningEffort: 'light' } },
      { id: 'medium', settings: { reasoningEffort: 'medium' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
    ])
  })

  it('reports no cost, because Dust bills credits and reports no tokens', () => {
    const [model] = toOpencodeModels([PLAIN])

    expect(model?.cost).toEqual([])
  })

  it('falls back to a generous output ceiling when Dust publishes none', () => {
    const [model] = toOpencodeModels([PLAIN])

    expect(model?.limit.output).toBe(16_000)
  })
})
