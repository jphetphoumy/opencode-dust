/**
 * The opencode v2 plugin: a Dust integration to log in with, a Dust provider
 * whose models are the workspace's catalog, and the bridge that lets the Dust
 * agent work on the developer's machine through opencode's own tools.
 *
 * Nothing here is imported from `@opencode/plugin` at runtime — `define` is an
 * identity function — so the plugin loads from its directory with no install.
 */

import type { Plugin } from '@opencode/plugin'

import { dustPrivateApiBase, DUST_DEFAULT_REGION } from './dust/constants.ts'
import { fetchModels, type DustModel } from './dust/models.ts'
import { DUST_PROVIDER_ID, providerInfo, toOpencodeModels } from './provider/catalog.ts'
import { createDustOAuth } from './provider/login.ts'
import { createDust } from './provider/sdk.ts'
import { routeCall } from './bridge/routes.ts'
import { debug, describeError } from './debug.ts'
import {
  bridgeContextHook,
  connectBridge,
  followSessionEvents,
  type ConnectedBridge,
} from './bridge/connect.ts'

/** Where opencode imports the AI SDK provider from. */
const SDK_URL = new URL('./provider/sdk.ts', import.meta.url).href

/** Bridges this process runs, by exchange pod; read only by the test seams below. */
const running = new Map<string, ConnectedBridge>()

/**
 * Test seam: deliver a message through a running bridge.
 * @param spaceId - the exchange pod.
 * @param sessionID - the opencode session.
 * @param text - the message.
 */
export async function deliverForTest(spaceId: string, sessionID: string, text: string): Promise<void> {
  await running.get(spaceId)?.deliver(sessionID, text)
}

/**
 * Test seam: how a running bridge would route a session's call.
 * @param spaceId - the exchange pod.
 * @param sessionID - the opencode session.
 * @param call - the call as the agent wrote it.
 * @returns the route, if the session has routes.
 */
export function routeForTest(
  spaceId: string,
  sessionID: string,
  call: { tool: string; arguments: Record<string, unknown> },
): unknown {
  const routes = running.get(spaceId)?.routes.get(sessionID)
  return routes === undefined ? undefined : routeCall(routes, call)
}

/**
 * Test seam: the turn a running bridge runs a session's calls under.
 * @param spaceId - the exchange pod.
 * @param sessionID - the opencode session.
 * @returns the turn, if opencode reported one.
 */
export function turnForTest(spaceId: string, sessionID: string): unknown {
  return running.get(spaceId)?.manager.turnOf(sessionID)
}

export default {
  id: DUST_PROVIDER_ID,
  setup: async context => {
    debug('plugin.setup', { directory: context.location.directory })
    await context.integration.transform(editor => {
      editor.method.update(createDustOAuth())
      editor.update(DUST_PROVIDER_ID, integration => {
        integration.name = 'Dust'
      })
    })

    // The provider's package points at `sdk.ts` too, but opencode imports that
    // once per process and keeps it: after a plugin reload it would go on
    // running the old model. The plugin is reloaded whole, so building the SDK
    // here is what makes an edit take effect without restarting the service.
    await context.aisdk.hook(
      'sdk',
      event => {
        if (event.model.providerID !== DUST_PROVIDER_ID) return
        event.sdk = createDust(event.options)
      },
      { providerID: DUST_PROVIDER_ID },
    )

    let bridge: ConnectedBridge | undefined
    /** The logged-in workspace the bridge is made for, once the catalog read one. */
    let login: { readonly key: string; readonly region: string; readonly workspaceId: string } | undefined
    let connecting: Promise<ConnectedBridge | undefined> | undefined
    const stopBridge = (): void => {
      connecting = undefined
      if (bridge === undefined) return
      bridge.dispose()
      running.delete(bridge.spaceId)
      bridge = undefined
    }

    /**
     * The bridge for this project, made on its first Dust request.
     *
     * Not at setup: opencode starts the plugin for every directory it is
     * opened in — the home folder included — and a pod per directory would
     * fill the workspace with pods nobody worked in. A pod that cannot be
     * made costs the bridge for this request, not the request.
     */
    const ensureBridge = (): Promise<ConnectedBridge | undefined> => {
      if (bridge !== undefined) return Promise.resolve(bridge)
      const wanted = login
      if (wanted === undefined) return Promise.resolve(undefined)
      connecting ??= connectBridge(context, { region: wanted.region, workspaceId: wanted.workspaceId, accessToken })
        .then(connected => {
          if (login?.key !== wanted.key) {
            connected.dispose()
            return undefined
          }
          bridge = connected
          running.set(connected.spaceId, connected)
          debug('bridge.connected', { spaceId: connected.spaceId })
          return connected
        })
        .catch((error: unknown) => {
          debug('bridge.failed', { error: describeError(error) })
          connecting = undefined
          return undefined
        })
      return connecting
    }

    await context.session.hook('context', bridgeContextHook(context, ensureBridge), {
      providerID: DUST_PROVIDER_ID,
    })
    const stopEvents = followSessionEvents(context, () => bridge)

    /** The current access token, which opencode refreshes before it expires. */
    const accessToken = async (): Promise<string> => {
      const connection = await context.integration.connection.active(DUST_PROVIDER_ID)
      const credential =
        connection === undefined ? undefined : await context.integration.connection.resolve(connection)
      if (credential?.type !== 'oauth') throw new Error('Not logged in to Dust.')
      return credential.access
    }

    let catalog: readonly DustModel[] = []
    // Which login the catalog was read for. The token is left out: it rotates
    // every few minutes without the catalog changing.
    let catalogFor: string | undefined
    let loading: Promise<void> | undefined

    /** Read the catalog of the logged-in workspace, if the login changed. */
    const loadCatalog = async (): Promise<boolean> => {
      const connection = await context.integration.connection.active(DUST_PROVIDER_ID)
      const credential =
        connection === undefined ? undefined : await context.integration.connection.resolve(connection)
      const metadata = credential?.type === 'oauth' ? (credential.metadata ?? {}) : {}
      const workspaceId = typeof metadata['workspaceId'] === 'string' ? metadata['workspaceId'] : ''
      const region = typeof metadata['region'] === 'string' ? metadata['region'] : DUST_DEFAULT_REGION
      const key = credential?.type === 'oauth' && workspaceId !== '' ? `${region}/${workspaceId}` : ''
      if (key === catalogFor) return false

      catalogFor = key
      stopBridge()
      debug('login', { loggedIn: key !== '', region, workspaceId })
      login = key === '' ? undefined : { key, region, workspaceId }
      // `fetchModels` answers only the agent default on any failure, which
      // offers no model: losing the catalog must not lose the provider.
      catalog = credential?.type === 'oauth' && key !== ''
        ? await fetchModels({ base: dustPrivateApiBase(region, workspaceId), accessToken: credential.access })
        : []
      return true
    }

    await loadCatalog().catch(() => undefined)

    await context.provider.transform(editor => {
      editor.add({ info: providerInfo(SDK_URL), models: toOpencodeModels(catalog) })

      // opencode reruns this transform when a credential changes, and a
      // transform cannot wait. So the new login's catalog is read behind it,
      // and the provider reloaded once that catalog differs.
      loading ??= loadCatalog()
        .then(async changed => {
          if (changed) await context.provider.reload()
        })
        .catch(() => undefined)
        .finally(() => {
          loading = undefined
        })
    })

    return () => {
      stopEvents()
      stopBridge()
    }
  },
} satisfies Plugin.Plugin
