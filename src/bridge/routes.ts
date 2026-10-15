/**
 * How a bridged call reaches the opencode tool it names.
 *
 * opencode offers a model two kinds of tool. A *direct* tool (`codemode:
 * false` — read, edit, shell…) is a tool call of its own. Every other tool —
 * MCP servers' tools, `opencode_list_mcp_resources` and the like — lives
 * behind code mode: the request carries one `execute` tool, and the model
 * calls `tools.<namespace>.<name>(…)` from the code it passes. A bridged call
 * to such a tool by its own name is one opencode has never heard of.
 *
 * So a code-mode call goes out as `execute` running that one call. Where the
 * request has no `execute` (code mode denied by permission), opencode has no
 * way to run it in its loop at all, and it runs here instead.
 */

import type { PodToolCall } from './pod-tool-request.ts'
import { opencodeToolName } from './runner.ts'

/** An opencode tool as the registry lists it. */
export interface RoutableTool {
  /** The effective name: `namespace_name`, or the bare name. */
  readonly id: string
  readonly name?: string
  readonly options?: { readonly namespace?: string; readonly codemode?: boolean }
}

/** Where a call goes. */
export type Route =
  /** As a tool call of the streaming turn, so opencode runs it in its loop. */
  | { readonly kind: 'native'; readonly call: PodToolCall }
  /** Through the tool directly, outside opencode's loop. */
  | { readonly kind: 'local'; readonly call: PodToolCall }

/** A code-mode tool's path under `tools`. */
type CodeModePath = readonly string[]

/** What `routeCall` looks names up in. */
export interface Routes {
  /** Code-mode tools by every name an agent may use for them. */
  readonly codeMode: ReadonlyMap<string, { readonly id: string; readonly path: CodeModePath }>
  /** Whether the request offers `execute`. */
  readonly executable: boolean
}

/** A JavaScript identifier, which may follow a dot. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render a path under `tools`, bracketing the segments that are not identifiers. */
function accessor(path: CodeModePath): string {
  return path.map(segment => (IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`)).join('')
}

/**
 * Index the registry's tools for routing.
 * @param tools - every registered tool, from `ctx.tool.list()`.
 * @param requested - the tool names the Dust request carries.
 * @returns the routes.
 */
export function buildRoutes(tools: readonly RoutableTool[], requested: ReadonlySet<string>): Routes {
  const codeMode = new Map<string, { id: string; path: CodeModePath }>()
  const bareCount = new Map<string, number>()

  const entries = tools
    .filter(tool => tool.options?.codemode !== false)
    .map(tool => {
      const name = tool.name ?? tool.id
      const namespace = tool.options?.namespace
      const path = namespace === undefined ? [name] : [...namespace.split('.'), name]
      bareCount.set(name, (bareCount.get(name) ?? 0) + 1)
      return { id: tool.id, name, namespace, path }
    })

  for (const entry of entries) {
    const target = { id: entry.id, path: entry.path }
    codeMode.set(entry.id, target)
    if (entry.namespace !== undefined) codeMode.set(`${entry.namespace}.${entry.name}`, target)
    // A bare name only when it names one tool: guessing between two would
    // run one the agent did not mean.
    if (bareCount.get(entry.name) === 1) codeMode.set(entry.name, target)
  }

  return { codeMode, executable: requested.has('execute') }
}

/**
 * Decide how one bridged call runs.
 * @param routes - from `buildRoutes`.
 * @param call - the call as the agent wrote it.
 * @returns where it goes, and the call to send there.
 */
export function routeCall(routes: Routes, call: PodToolCall): Route {
  const target = routes.codeMode.get(call.tool)
  if (target === undefined) {
    // Direct, or unknown: opencode's own refusal names the tools there are.
    return { kind: 'native', call: { tool: opencodeToolName(call.tool), arguments: call.arguments } }
  }
  if (!routes.executable) return { kind: 'local', call: { tool: target.id, arguments: call.arguments } }

  return {
    kind: 'native',
    call: {
      tool: 'execute',
      arguments: { code: `return await tools${accessor(target.path)}(${JSON.stringify(call.arguments)})` },
    },
  }
}
