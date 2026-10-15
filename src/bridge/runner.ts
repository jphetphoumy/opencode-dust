/**
 * Running one bridged call through opencode's own tools.
 *
 * The watcher hands every request here, script or batch. The call runs the
 * genuine tool from `ctx.tool.list()` — not a second implementation — so it
 * behaves exactly as it would in an ordinary opencode turn, permission check
 * included: `shell` asks, allows or denies by the developer's rules before it
 * spawns anything, and the question appears in their session.
 *
 * The arguments are passed as the agent wrote them. opencode decodes a model's
 * tool input against the tool's schema before executing it; this path cannot,
 * so a wrong argument fails inside the tool with the tool's own message.
 */

import type { BashOutcome } from './pod-bash.ts'
import type { PodToolCall } from './pod-tool-request.ts'

/** The opencode turn a bridged call runs under, which its permission check needs. */
export interface TurnContext {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
}

/** What a tool's executor is handed. */
export interface RunnableToolContext extends TurnContext {
  readonly id: string
  readonly signal: AbortSignal
  readonly progress: (update: Record<string, unknown>) => Promise<void>
}

/** A tool's result, as opencode's promise API returns it. */
export interface RunnableToolResult {
  readonly output?: unknown
  readonly content?: string | readonly ({ type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string })[]
}

/** An opencode tool as `ctx.tool.list()` hands it over. */
export interface RunnableTool {
  readonly id: string
  readonly execute: (input: never, context: RunnableToolContext) => Promise<RunnableToolResult>
}

/**
 * Names the agent may reach for that opencode spells differently.
 *
 * The agent knows a shell as `bash` from every other harness; refusing it
 * would cost a round-trip to learn a synonym.
 */
const ALIASES: Record<string, string> = { bash: 'shell' }

let calls = 0

/**
 * The opencode tool a bridged call names.
 * @param tool - the name the agent used.
 * @returns opencode's name for it.
 */
export function opencodeToolName(tool: string): string {
  return ALIASES[tool] ?? tool
}

/** Render a tool result as the text the agent reads. */
function textOf(result: RunnableToolResult): string {
  const content = result.content
  if (typeof content === 'string') return content
  if (content !== undefined && content.length > 0) {
    return content
      .map(part => (part.type === 'text' ? part.text : `[file ${part.name ?? part.uri}]`))
      .join('\n')
  }
  if (result.output === undefined) return ''
  return typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
}

/** Read a thrown value as a message worth handing back to the agent. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return String(error)
}

/** Runs one bridged call under a turn, cancellable by `signal`. */
export type ToolRunner = (
  call: PodToolCall,
  turn: TurnContext | undefined,
  signal: AbortSignal,
) => Promise<BashOutcome>

/**
 * Build the function the watcher runs every call through.
 * @param deps - where the tools come from, and a clock.
 * @returns a runner that never throws: every failure is an error outcome.
 */
export function createToolRunner(deps: {
  readonly tools: () => Promise<readonly RunnableTool[]>
  readonly now?: () => number
}): ToolRunner {
  const now = deps.now ?? Date.now

  return async (call, turn, signal) => {
    const started = now()
    const done = (output: string, isError: boolean): BashOutcome => ({
      output,
      isError,
      durationMs: now() - started,
    })

    if (turn === undefined) {
      // A permission check needs a session and an agent to ask on behalf of.
      return done('No opencode turn is running to run this under; nothing was run.', true)
    }

    const name = opencodeToolName(call.tool)
    try {
      const tools = await deps.tools()
      const tool = tools.find(candidate => candidate.id === name)
      if (tool === undefined) {
        return done(
          `There is no tool named ${call.tool}. Available: ${tools.map(candidate => candidate.id).join(', ')}.`,
          true,
        )
      }

      calls += 1
      const result = await tool.execute(call.arguments as never, {
        ...turn,
        id: `dust-bridge-${Date.now().toString(36)}-${String(calls)}`,
        signal,
        progress: async () => undefined,
      })
      return done(textOf(result), false)
    } catch (error) {
      return done(messageOf(error), true)
    }
  }
}
