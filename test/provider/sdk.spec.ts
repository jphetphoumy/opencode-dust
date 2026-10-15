import { describe, expect, it } from 'vitest'

import { DustLanguageModel } from '../../src/provider/language-model.ts'
import { createDust } from '../../src/provider/sdk.ts'

describe('createDust', () => {
  it('is the factory opencode finds by its create prefix', async () => {
    const module = await import('../../src/provider/sdk.ts')

    expect(Object.keys(module).filter(name => name.startsWith('create'))).toEqual(['createDust'])
  })

  it('builds a Dust language model from the settings opencode resolved', () => {
    const sdk = createDust({
      name: 'dust',
      apiKey: 'tok',
      region: 'europe-west1',
      workspaceId: 'w1',
      reasoningEffort: 'light',
    })

    const model = sdk.languageModel('openai:gpt-5')

    expect(model).toBeInstanceOf(DustLanguageModel)
    expect(model.modelId).toBe('openai:gpt-5')
    expect(model.settings).toEqual({
      accessToken: 'tok',
      region: 'europe-west1',
      workspaceId: 'w1',
      agentSId: 'dust',
      reasoningEffort: 'light',
    })
  })

  it('always runs Dust’s default agent, whatever the options name', () => {
    const model = createDust({ apiKey: 'tok', workspaceId: 'w1', agent: 'helper' })
      .languageModel('openai:gpt-5')

    expect(model.settings.agentSId).toBe('dust')
  })

  it('defaults to the US region, as the access token does when it carries none', () => {
    const model = createDust({ apiKey: 'tok', workspaceId: 'w1' }).languageModel('openai:gpt-5')

    expect(model.settings.region).toBe('us-central1')
  })

  it('ignores a reasoning effort Dust does not define', () => {
    const model = createDust({ apiKey: 'tok', workspaceId: 'w1', reasoningEffort: 'max' })
      .languageModel('openai:gpt-5')

    expect(model.settings).not.toHaveProperty('reasoningEffort')
  })

  it('shares one conversation store across models, so a turn can continue its thread', () => {
    const sdk = createDust({ apiKey: 'tok', workspaceId: 'w1' })

    expect(sdk.languageModel('a').threads).toBe(createDust({ apiKey: 'x' }).languageModel('b').threads)
  })
})
