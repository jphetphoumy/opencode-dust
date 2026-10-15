/**
 * The Dust workspace catalog projected onto opencode's provider and models.
 *
 * The catalog id is carried through untouched as the model id, because the
 * SDK decodes it back into Dust's `modelSelection`.
 */

import type { Model, Provider } from '@opencode/plugin'

import { AGENT_DEFAULT_MODEL_ID, type DustModel } from '../dust/models.ts'

/** The provider and integration id this plugin registers under. */
export const DUST_PROVIDER_ID = 'dust'

/**
 * Output ceiling used when Dust publishes none.
 *
 * Dust enforces the real ceiling server-side, so a generous guess costs
 * nothing, whereas a small one would have opencode truncate its own requests.
 */
const FALLBACK_MAX_TOKENS = 16_000

/**
 * The provider definition.
 * @param sdkUrl - `file://` URL of this plugin's SDK module, which opencode
 * imports and calls through its `create` export.
 * @returns the provider to register.
 */
export function providerInfo(sdkUrl: string): Provider.Info {
  return {
    id: DUST_PROVIDER_ID as Provider.ID,
    integrationID: DUST_PROVIDER_ID as NonNullable<Provider.Info['integrationID']>,
    name: 'Dust',
    activation: 'auto',
    package: `aisdk:${sdkUrl}`,
  }
}

/** Project one Dust catalog entry onto an opencode model. */
function toOpencodeModel(model: DustModel): Model.Info {
  const id = model.id as Model.ID
  return {
    id,
    modelID: id,
    providerID: DUST_PROVIDER_ID as Provider.ID,
    name: model.displayName,
    // The Dust agent runs its own tool loop server-side and cannot call
    // opencode's tools, so offering them would only invite calls that never
    // come back. Images travel as content fragments; opencode drops an image
    // before it reaches a model that does not declare them.
    capabilities: {
      tools: false,
      input: model.supportsVision ? ['text', 'image'] : ['text'],
      output: ['text'],
    },
    variants: model.reasoningEfforts.map(effort => ({
      id: effort as Model.VariantID,
      settings: { reasoningEffort: effort },
    })),
    time: { released: 0 },
    // Dust meters in workspace credits and reports no token counts to clients.
    cost: [],
    status: 'active',
    enabled: true,
    limit: {
      context: model.contextWindow,
      output: model.maxOutputTokens ?? FALLBACK_MAX_TOKENS,
    },
  }
}

/**
 * Project the catalog's real models.
 *
 * The agent default is left out: it stands for whatever model the agent is
 * configured with, which Dust never reports, so it is not a model a human can
 * pick knowingly. Every entry offered sends a `modelSelection` override, which
 * Dust refuses with HTTP 403 unless the workspace has the `models_picker`
 * feature.
 * @param models - the Dust catalog, as `fetchModels` returned it.
 * @returns the opencode models to register, in catalog order.
 */
export function toOpencodeModels(models: readonly DustModel[]): Model.Info[] {
  return models.filter(model => model.id !== AGENT_DEFAULT_MODEL_ID).map(toOpencodeModel)
}
