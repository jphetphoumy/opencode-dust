/**
 * The AI SDK provider module opencode loads for Dust models.
 *
 * opencode imports this file by its `file://` URL and calls the first export
 * whose name starts with `create`, so `createDust` must stay the only one.
 * The options it passes are the provider's settings merged with the active
 * credential: the access token arrives as `apiKey`, and the login's metadata
 * (`region`, `workspaceId`) is spread in beside it.
 */

import { DUST_DEFAULT_REGION } from '../dust/constants.ts'
import { isReasoningEffort } from '../dust/models.ts'
import { DustLanguageModel } from './language-model.ts'

/**
 * The agent every turn mentions: Dust's own general-purpose global agent,
 * present in every workspace. The model is the human's pick, sent as a
 * `modelSelection` override, so the agent only lends its loop and its tools.
 */
const DEFAULT_AGENT = 'dust'

/** What opencode hands the factory; only the fields read here are named. */
export interface DustProviderOptions {
  readonly apiKey?: string
  readonly region?: string
  readonly workspaceId?: string
  /** Set by a model variant. */
  readonly reasoningEffort?: string
  readonly [key: string]: unknown
}

/** Read an option that must be a non-empty string to mean anything. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Build the Dust provider.
 * @param options - provider settings and credential, as opencode resolved them.
 * @returns an AI SDK provider whose models run Dust agent turns.
 */
export function createDust(options: DustProviderOptions) {
  const effort = text(options.reasoningEffort)
  const settings = {
    accessToken: text(options.apiKey) ?? '',
    region: text(options.region) ?? DUST_DEFAULT_REGION,
    workspaceId: text(options.workspaceId) ?? '',
    agentSId: DEFAULT_AGENT,
    // Dust does not reject an effort it does not know: it silently runs the
    // model's default instead, so an unknown one is dropped here, visibly.
    ...(effort !== undefined && isReasoningEffort(effort) ? { reasoningEffort: effort } : {}),
  }

  return {
    languageModel: (modelId: string) => new DustLanguageModel(modelId, settings),
  }
}
