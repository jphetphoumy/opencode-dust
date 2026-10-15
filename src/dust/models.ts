/**
 * The workspace model catalog, and the codec that carries a Dust
 * provider/model pair through the harness's single-identifier model seam.
 */

import { dustJson, type DustRequestContext } from './http.ts'

/**
 * Model id meaning "whatever the agent is configured with".
 *
 * Sending any `modelSelection` override requires the workspace's
 * `models_picker` feature; without it Dust answers HTTP 403. This id sends no
 * override, so it is the one model that always works.
 */
export const AGENT_DEFAULT_MODEL_ID = 'agent-default'

/** Reasoning efforts Dust defines, weakest first. */
export const REASONING_EFFORTS = ['none', 'light', 'medium', 'high'] as const

/** One reasoning effort Dust accepts. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** A model offered on the Dust route. */
export interface DustModel {
  /** Harness model id: `agent-default`, or `<providerId>:<modelId>`. */
  readonly id: string
  readonly displayName: string
  /** Total context window in tokens, as Dust reports it. */
  readonly contextWindow: number
  /** Largest generation Dust will produce, when it reports one. */
  readonly maxOutputTokens?: number
  /** Efforts this model accepts, weakest first; empty when it does no reasoning. */
  readonly reasoningEfforts: readonly ReasoningEffort[]
  /** Effort used when the caller names none. */
  readonly defaultReasoningEffort?: ReasoningEffort
  /** Whether the model accepts image input. */
  readonly supportsVision: boolean
}

/**
 * Whether a string is a reasoning effort Dust defines.
 * @param value - the candidate effort.
 * @returns true when Dust would accept it.
 */
export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Encode a Dust provider/model pair as one harness model id.
 * @param providerId - Dust's model provider id.
 * @param modelId - Dust's model id.
 * @returns the harness model id.
 */
export function encodeModelId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

/**
 * Decode a harness model id back into a Dust model override.
 *
 * An id that names no provider — including {@link AGENT_DEFAULT_MODEL_ID} —
 * decodes to no override, so the agent runs its configured model. Guessing a
 * provider would produce a request Dust rejects.
 * @param id - the harness model id.
 * @returns the override to send, or nothing when none should be sent.
 */
export function decodeModelId(
  id: string,
): { providerId: string; modelId: string } | undefined {
  const separator = id.indexOf(':')
  if (separator <= 0 || separator === id.length - 1) return undefined
  return { providerId: id.slice(0, separator), modelId: id.slice(separator + 1) }
}

/** The private catalog route's answer. */
interface EnabledModelsResponse {
  models?: readonly {
    providerId?: string
    modelId?: string
    displayName?: string
    contextSize?: number
    generationTokensCount?: number
    isSelectable?: boolean
    supportsVision?: boolean
    supportedReasoningEfforts?: Partial<Record<ReasoningEffort, boolean>>
    defaultReasoningEffort?: string
  }[]
}

/**
 * The always-available entry, offered whether or not the catalog can be read —
 * including before anyone has logged in, which is what lets a session start at
 * all on a Dust-only harness.
 */
export const AGENT_DEFAULT_MODEL: DustModel = {
  id: AGENT_DEFAULT_MODEL_ID,
  displayName: 'Agent default',
  // Dust does not report the agent's configured model, so its window is
  // unknown; a conservative figure keeps the harness from over-filling a
  // request it cannot measure.
  contextWindow: 100_000,
  reasoningEfforts: [],
  supportsVision: true,
}

/**
 * Read the models a workspace may select.
 *
 * A catalog that cannot be read is not an error: the adapter contract forbids
 * turning catalog absence into a rejected request, and the agent default works
 * without it.
 * @param context - private workspace API base (`/api/w/<wId>`), token and cancellation.
 * @returns the agent default followed by every selectable model.
 */
export async function fetchModels(
  context: DustRequestContext,
): Promise<readonly DustModel[]> {
  let body: EnabledModelsResponse
  try {
    body = await dustJson<EnabledModelsResponse>(context, 'models')
  } catch {
    // The catalog is advisory. Losing it costs the model picker its choices,
    // not the route its ability to run a turn.
    return [AGENT_DEFAULT_MODEL]
  }

  const models = (body.models ?? [])
    .filter(model => model.isSelectable === true)
    .map(model => {
      const supported = model.supportedReasoningEfforts ?? {}
      const efforts = REASONING_EFFORTS.filter(effort => supported[effort] === true)
      const fallback = model.defaultReasoningEffort

      return {
        id: encodeModelId(String(model.providerId ?? ''), String(model.modelId ?? '')),
        displayName: String(model.displayName ?? model.modelId ?? ''),
        contextWindow: Number(model.contextSize ?? AGENT_DEFAULT_MODEL.contextWindow),
        ...(model.generationTokensCount === undefined
          ? {}
          : { maxOutputTokens: model.generationTokensCount }),
        reasoningEfforts: efforts,
        ...(fallback !== undefined && isReasoningEffort(fallback)
          ? { defaultReasoningEffort: fallback }
          : {}),
        supportsVision: model.supportsVision !== false,
      } satisfies DustModel
    })

  return [AGENT_DEFAULT_MODEL, ...models]
}
