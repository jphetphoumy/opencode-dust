/**
 * Wiring the bridge into an opencode plugin context: the exchange pod, the
 * tools a Dust request is stripped of, and the session events the watcher
 * follows.
 */

import type { Plugin } from '@opencode/plugin'

import { debug } from '../debug.ts'
import { dustPrivateApiBase } from '../dust/constants.ts'
import type { DustTokenSource } from '../dust/http.ts'
import { deletePodFile, downloadPodFile, listPodFiles, uploadPodFile } from '../dust/pod-files.ts'
import { ensurePod } from '../dust/pods.ts'
import { HELPER_PATH, helperScript } from './helper.ts'
import { BridgeManager } from './manager.ts'
import { bridgeNote } from './note.ts'
import { toolSignatures } from './pod-tool-request.ts'
import {
  BRIDGE_OPTION,
  awaitNativeOutcome,
  isBridgedCall,
  nativeSink,
  registerBridge,
  settleNativeOutcome,
  type BridgeCallContext,
} from './registry.ts'
import { createToolRunner, type RunnableTool } from './runner.ts'

/**
 * opencode tools the agent is not offered through the bridge.
 *
 * `execute` is code mode's wrapper around the others, which are offered
 * directly. `question` and `subagent` need opencode's own agent loop around
 * them. Web search and fetch are Dust's own, and better served by it.
 */
const NOT_BRIDGED = new Set(['execute', 'question', 'subagent', 'websearch', 'webfetch'])

/** A running bridge for one exchange pod. */
export interface ConnectedBridge {
  readonly spaceId: string
  readonly manager: BridgeManager
  readonly deliver: (sessionID: string, text: string) => Promise<void>
  readonly dispose: () => void
}

/** A sleep that does not hold the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** The pod name a project's exchange lives under. */
export function podNameFor(directory: string): string {
  const base = directory.replace(/\/+$/, '').split('/').pop() ?? ''
  return `opencode-${base === '' ? 'project' : base}`
}

/**
 * Ensure the project's exchange pod, leave the helper in it, and start
 * answering the requests its conversations leave there.
 * @param context - the plugin context.
 * @param login - where the logged-in workspace is, and a token source.
 * @returns the running bridge.
 */
export async function connectBridge(
  context: Plugin.Context,
  login: { readonly region: string; readonly workspaceId: string; readonly accessToken: DustTokenSource },
): Promise<ConnectedBridge> {
  const api = { base: dustPrivateApiBase(login.region, login.workspaceId), accessToken: login.accessToken }
  const pod = await ensurePod(api, podNameFor(context.location.directory))
  debug('pod.ready', { spaceId: pod.sId, name: pod.name, created: pod.created })
  // Rewritten on every connect rather than compared: one small PUT, and a
  // helper left by an older plugin would speak an older protocol.
  await uploadPodFile(api, pod.sId, HELPER_PATH, helperScript())

  const deliver = async (sessionID: string, text: string): Promise<void> => {
    // Queued, not steered: it is the continuation of a turn the agent ended
    // to wait for it, and must not cut into whatever the session runs now.
    await context.session.synthetic({ sessionID: sessionID as never, text, delivery: 'queue' })
  }
  const runTool = createToolRunner({
    tools: async () => (await context.tool.list()) as unknown as readonly RunnableTool[],
  })
  const manager = new BridgeManager({
    pod: {
      list: () => listPodFiles(api, pod.sId),
      read: path => downloadPodFile(api, pod.sId, path),
      write: (path, contents) => uploadPodFile(api, pod.sId, path, contents),
      remove: path => deletePodFile(api, pod.sId, path),
    },
    native: { sink: nativeSink, result: awaitNativeOutcome },
    runTool: async (call, turn, signal) => {
      const outcome = await runTool(call, turn, signal)
      debug('bridge.call', {
        sessionID: turn?.sessionID,
        tool: call.tool,
        isError: outcome.isError,
        durationMs: outcome.durationMs,
      })
      return outcome
    },
    deliver: async (sessionID, text) => {
      debug('bridge.deliver', { sessionID, chars: text.length })
      await deliver(sessionID, text)
    },
    wait: sleep,
    onWarn: message => debug('bridge.warn', { message }),
  })
  registerBridge(pod.sId, manager)

  return {
    spaceId: pod.sId,
    manager,
    deliver,
    dispose: () => {
      manager.dispose()
      registerBridge(pod.sId, undefined)
    },
  }
}

/** Whether a value already is a JSON Schema object, as opposed to a code schema. */
function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'object'
}

/**
 * The context hook for Dust requests: once a bridge runs, hand the request the
 * note and the session it belongs to.
 *
 * opencode's tools stay in the request. Dust never sees them — the provider
 * sends none — but opencode only runs a tool call whose tool the request
 * carried, and every bridged call goes out as one.
 * @param context - the plugin context.
 * @param bridge - the running bridge, read at each request.
 * @returns the hook callback.
 */
export function bridgeContextHook(
  context: Plugin.Context,
  bridge: () => Promise<ConnectedBridge | undefined>,
): (event: {
  readonly sessionID: string
  tools: Record<string, { description: string; input: unknown }>
  options: Record<string, unknown>
}) => Promise<void> {
  return async event => {
    const definitions = event.tools

    const running = await bridge()
    debug('hook.context', {
      sessionID: event.sessionID,
      tools: Object.keys(definitions).length,
      bridged: running?.spaceId ?? null,
    })
    if (running === undefined) return

    // Named from the registry rather than from the request: with code mode on,
    // the request carries only `execute`, and the tools behind it are what the
    // agent needs to know about. The request's JSON schemas win where present.
    const tools = (await context.tool.list()) as unknown as readonly (RunnableTool & { input?: unknown })[]
    const signatures = toolSignatures(
      tools
        .filter(tool => !NOT_BRIDGED.has(tool.id))
        .map(tool => {
          const schema = definitions[tool.id]?.input ?? tool.input
          return { name: tool.id, ...(isJsonSchema(schema) ? { parameters: schema } : {}) }
        }),
    )

    event.options[BRIDGE_OPTION] = {
      sessionID: event.sessionID,
      spaceId: running.spaceId,
      note: bridgeNote(signatures),
    } satisfies BridgeCallContext
  }
}

/** The text of a tool event's content, files named rather than inlined. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      const item = part as { type?: unknown; text?: unknown; name?: unknown; uri?: unknown }
      if (item.type === 'text' && typeof item.text === 'string') return item.text
      return `[file ${String(item.name ?? item.uri ?? '')}]`
    })
    .join('\n')
}

/**
 * Follow opencode's session events into the bridge: the step a session's
 * calls run under, and the interrupt that cancels them.
 * @param context - the plugin context.
 * @param bridge - the running bridge, read at each event.
 * @returns a function that stops following.
 */
export function followSessionEvents(
  context: Plugin.Context,
  bridge: () => ConnectedBridge | undefined,
): () => void {
  const stop = new AbortController()
  void (async () => {
    for await (const raw of context.event.subscribe({ signal: stop.signal }) as AsyncIterable<unknown>) {
      const event = raw as { type?: string; data?: Record<string, unknown> }
      const data = event.data ?? {}
      const sessionID = typeof data['sessionID'] === 'string' ? data['sessionID'] : undefined

      // How opencode ran a bridged call: the result goes back to the agent
      // waiting in its sandbox, through the pod.
      if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
        const id = data['id']
        if (typeof id === 'string' && isBridgedCall(id)) {
          const failed = event.type === 'session.tool.failed'
          const error = (data['error'] as { message?: unknown } | undefined)?.message
          const text = contentText(data['content'])
          settleNativeOutcome(id, {
            output: failed ? [typeof error === 'string' ? error : 'The tool call failed.', text].filter(Boolean).join('\n') : text,
            isError: failed,
            durationMs: 0,
          })
          debug('bridge.native', { id, failed })
        }
        continue
      }

      const manager = bridge()?.manager
      if (sessionID === undefined || manager === undefined) continue

      if (event.type === 'session.step.started' || event.type === 'session.execution.interrupted') {
        debug('event', { type: event.type, sessionID })
      }
      if (event.type === 'session.step.started') {
        const agent = data['agent']
        const messageID = data['assistantMessageID']
        if (typeof agent === 'string' && typeof messageID === 'string') {
          manager.stepStarted(sessionID, { agent, messageID })
        }
      } else if (event.type === 'session.execution.interrupted' && data['reason'] === 'user') {
        manager.interrupted(sessionID)
      }
    }
  })().catch(error => debug('events.failed', { error: String(error) }))
  return () => stop.abort()
}
