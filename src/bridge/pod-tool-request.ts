/**
 * The batch of opencode tool calls an agent leaves in the pod instead of calling them.
 *
 * `pod-bash.ts` did this for the shell; this does it for every other tool, and
 * for the same arithmetic. A bridged call is 3 credits because an external MCP
 * server is always `advanced`, while writing and reading a pod file is `basic`
 * with `freeUsage: true`. So `read`, `edit`, `grep` and `ls` cost real money on
 * the bridge and nothing here.
 *
 * It matters most in a folder bound with `/podbash solo`, where the pod holds no
 * copy of the project and Dust's own free file tools therefore reach nothing at
 * all. Before this the only route to the files was `bash`, which meant `sed -i`
 * and heredocs standing in for `edit` and `write` — more fragile, and invisible
 * to opencode's own file bookkeeping.
 *
 * Two things about the shape are load-bearing:
 *
 * - **A request is a batch, not a call.** At two round-trips per request a
 *   single call through here loses to the 3-credit tool, exactly as one command
 *   per script loses to the `bash` tool. The batch is where the saving is.
 * - **The parse is forgiving and its failures are addressed to the agent.**
 *   Nothing validates this file before it is written: there is no schema on the
 *   way in, no editor, and no retry. A rejection the agent cannot read costs it
 *   a whole round-trip to learn nothing, so every refusal here says which call
 *   was wrong and what it should have looked like.
 */

import { MAX_RESULT_CHARS, trimTo } from './pod-bash.ts'

/**
 * The most calls one request may carry.
 *
 * Not a performance limit — they run one at a time and cost nothing. It is a
 * bound on the damage a confused batch can do before anybody sees it, and a
 * bound on the output one `.out` has to hold. A step that genuinely needs more
 * than this is two steps.
 */
export const MAX_BATCH_CALLS = 32

/**
 * The least output any one call in a batch is guaranteed.
 *
 * The per-call budget is the total shared out, which for a large batch would
 * otherwise fall to a few hundred characters and truncate every result into
 * uselessness. Below this a result is not worth returning at all, so a batch
 * that would cross it overruns the total instead — an oversized `.out` is
 * recoverable; a batch of unreadable stubs costs another round-trip.
 */
export const MIN_CALL_CHARS = 4_000

/** One call in a batch, once it has been read out of the request. */
export interface PodToolCall {
  /** The opencode tool to run. */
  readonly tool: string
  /** The arguments to run it with. */
  readonly arguments: Record<string, unknown>
}

/** What a batch should do when one of its calls fails. */
export type PodToolErrorPolicy = 'stop' | 'continue'

/** A request that parsed. */
export interface PodToolRequest {
  readonly calls: readonly PodToolCall[]
  readonly onError: PodToolErrorPolicy
}

/** The result of reading a request file: a batch, or why it is not one. */
export type PodToolParse =
  | { readonly ok: true; readonly request: PodToolRequest }
  | { readonly ok: false; readonly error: string }

/** What one finished call in a batch produced. */
export interface PodToolOutcome {
  /** The tool that ran, as asked for. */
  readonly tool: string
  /** The arguments it ran with. */
  readonly arguments: Record<string, unknown>
  /** Everything it returned, blocks joined. */
  readonly output: string
  /** Whether it failed. */
  readonly isError: boolean
  /** Wall-clock duration. */
  readonly durationMs: number
}

/** How a request is described back to the agent when it will not parse. */
const SHAPE_HINT =
  'Expected {"calls":[{"tool":"read","arguments":{...}},...]} — a JSON object with'
  + ' a `calls` array, or a bare array of the same objects.'

/** Read one member of an object, whatever alias the model reached for. */
function pick(source: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (Object.hasOwn(source, name)) return source[name]
  }
  return undefined
}

/** Whether a value is a plain object, the only thing `arguments` may be. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read one call out of a request.
 *
 * Generous about spelling and strict about substance. `tool`/`name` and
 * `arguments`/`args`/`input`/`parameters` are all accepted because a model
 * writing JSON by hand into a file picks whichever it has seen most recently
 * and there is no schema to correct it — but a call with no tool name is not a
 * call, and guessing one would run something nobody asked for.
 * @param value - the candidate call.
 * @param index - its place in the batch, for the error message.
 * @returns the call, or why it is not one.
 */
function parseCall(value: unknown, index: number): PodToolCall | string {
  const at = `call ${String(index + 1)}`
  if (!isRecord(value)) return `${at} is ${Array.isArray(value) ? 'an array' : typeof value}, not an object.`

  const tool = pick(value, ['tool', 'name'])
  if (typeof tool !== 'string' || tool.trim() === '') {
    return `${at} has no tool name. Give it a \`tool\`, as in {"tool":"read","arguments":{...}}.`
  }

  const args = pick(value, ['arguments', 'args', 'input', 'parameters'])
  // Absent is allowed and empty: a tool that takes nothing should not have to
  // be written with an empty object. A non-object is not, because passing a
  // string where a tool expects named arguments fails inside the tool with a
  // message about a property, which reads as the tool being broken.
  if (args !== undefined && !isRecord(args)) {
    return `${at} (${tool}) has \`arguments\` as ${Array.isArray(args) ? 'an array' : typeof args};`
      + ' it must be an object of named arguments.'
  }

  return { tool: tool.trim(), arguments: args ?? {} }
}

/**
 * Read a request file as a batch of tool calls.
 *
 * Never throws: every way this can fail is a message the agent is meant to
 * read and correct, and a throw here would reach it as the watcher's generic
 * failure instead.
 * @param text - the request file's contents.
 * @returns the batch, or why the file is not one.
 */
export function parseToolRequest(text: string): PodToolParse {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch (error) {
    // The parser's own message is kept — "Unexpected token } in JSON at
    // position 84" is the single most useful sentence available here, and a
    // tidier "invalid JSON" would cost the agent a round-trip to rediscover.
    return {
      ok: false,
      error: `This file is not valid JSON: ${error instanceof Error ? error.message : String(error)}. ${SHAPE_HINT}`,
    }
  }

  // A bare array, `{calls:[...]}`, and a lone call object all mean the same
  // thing to whoever wrote the file, so they mean the same thing here.
  const raw = Array.isArray(body)
    ? body
    : isRecord(body)
      ? pick(body, ['calls', 'tools', 'requests']) ?? [body]
      : undefined

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: raw === undefined
        ? `This file is JSON but not a batch of calls. ${SHAPE_HINT}`
        : `\`calls\` is ${typeof raw}, not an array. ${SHAPE_HINT}`,
    }
  }

  if (raw.length === 0) {
    return { ok: false, error: `This batch has no calls in it. ${SHAPE_HINT}` }
  }
  if (raw.length > MAX_BATCH_CALLS) {
    return {
      ok: false,
      error: `This batch asks for ${String(raw.length)} calls; the most one request may`
        + ` carry is ${String(MAX_BATCH_CALLS)}. Split it across two requests.`,
    }
  }

  const calls: PodToolCall[] = []
  for (const [index, candidate] of raw.entries()) {
    const call = parseCall(candidate, index)
    // The first bad call ends the parse rather than being skipped: a batch
    // silently missing its third step is worse than one that ran nothing, and
    // the agent is about to be told exactly which call to fix.
    if (typeof call === 'string') return { ok: false, error: call }
    calls.push(call)
  }

  const onError = isRecord(body) && pick(body, ['onError', 'on_error']) === 'continue'
    ? 'continue'
    : 'stop'

  return { ok: true, request: { calls, onError } }
}

/**
 * How many characters each call in a batch may return.
 *
 * The total is shared, so one `read` of a 200k file cannot spend the whole
 * allowance and leave the calls behind it empty — but never below
 * `MIN_CALL_CHARS`, because a truncated stub costs the round-trip it was
 * saving.
 * @param count - how many calls are in the batch.
 * @returns the per-call cap.
 */
export function callBudget(count: number): number {
  return Math.max(MIN_CALL_CHARS, Math.floor(MAX_RESULT_CHARS / Math.max(1, count)))
}

/** A tool as the note has to describe it: a name and a parameter schema. */
export interface PodToolSignature {
  readonly name: string
  readonly parameters?: unknown
}

/** The argument names of an object schema, each marked for optionality. */
function argNames(schema: Record<string, unknown>): readonly string[] {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter(name => typeof name === 'string') : [],
  )
  return Object.keys(properties).map(name => (required.has(name) ? name : `${name}?`))
}

/**
 * The shape of one argument, one level deep.
 *
 * A flat list of top-level names is not enough, and this is not a theory: on the
 * first live run the agent called `edit` with
 * `{path, edits:[{oldText, newText, replaceAll:true}]}`. Pi's `edit` has no
 * `replaceAll` at all — the model invented a plausible field to fill a gap the
 * note had left, the call failed on the uniqueness rule, and the agent fell back
 * to `sed -i` in a script. That round-trip is exactly the one this route exists
 * to save, so the batch was worse than useless for that task.
 *
 * One level only. `edits[{oldText, newText}]` is what closes the gap; going
 * deeper would cost context on shapes no bridged tool actually has.
 * @param schema - the property's schema.
 * @returns a suffix like `[{a, b}]` or `{a, b}`, or empty for a scalar.
 */
function argShape(schema: unknown): string {
  if (!isRecord(schema)) return ''

  if (schema.type === 'array') {
    const items = schema.items
    if (isRecord(items) && isRecord(items.properties)) return `[{${argNames(items).join(', ')}}]`
    return '[]'
  }

  if (isRecord(schema.properties)) return `{${argNames(schema).join(', ')}}`
  return ''
}

/**
 * The tools the agent may put in a batch, written as compact signatures.
 *
 * Names and shapes only — no descriptions. The agent already knows what `read`
 * and `grep` do, and the full schemas for six tools would cost more context
 * every turn than the route saves in credits. What it cannot guess is the
 * argument *vocabulary*, and a wrong guess fails inside the tool with a message
 * about a property, which reads as the route being broken rather than the call
 * being wrong — see `argShape` for the live case that proved it.
 *
 * Derived from the live definitions rather than written out here, so a tool that
 * changes its arguments changes this note with it. A hand-kept list would go
 * stale silently and teach the agent to call something that no longer exists.
 * @param tools - the tool definitions to describe.
 * @returns one `name(arg, nested[{a, b}], optional?)` line per tool.
 */
export function toolSignatures(tools: readonly PodToolSignature[]): readonly string[] {
  return tools.map(tool => {
    const schema = isRecord(tool.parameters) ? tool.parameters : {}
    const properties = isRecord(schema.properties) ? schema.properties : {}
    const required = new Set(
      Array.isArray(schema.required) ? schema.required.filter(name => typeof name === 'string') : [],
    )
    const args = Object.keys(properties).map(
      name => `${name}${required.has(name) ? '' : '?'}${argShape(properties[name])}`,
    )
    return `${tool.name}(${args.join(', ')})`
  })
}

/**
 * What a request is about to do, for the human to read before it does it.
 *
 * The gap this fills was found by watching a live turn. The agent writes the
 * request with Dust's own file tool, so the transcript says
 * `write (remote) oc-bash/step1.json — Created (application/json, 1 KB)` and
 * nothing else: a byte count, at the one moment the developer could have seen
 * what was about to run on their machine. The per-call cards come later and
 * only show a tool and a path, so a wrong argument is invisible until it fails.
 *
 * Each call is written the way a tool card reads — `edit greeting.txt`,
 * `read src/a.ts`, `$ npm test` — by going through `callLabel`. A queued `edit` is the same act as an `edit`,
 * and a second vocabulary for it (a tool name beside a blob of JSON) makes the
 * human read the plan as machinery rather than as work. The arguments in full
 * are still in the answer, which prints an `args:` line per call.
 *
 * A request that will not parse is shown as the agent wrote it, not as an error.
 * The point is to see what was asked for, and for a malformed batch the raw text
 * is the only honest answer — a parse error would hide the very thing worth
 * looking at.
 * @param body - the request file's contents.
 * @returns the plan, one call per line.
 */
/** Tools whose header names what they looked for before where. */
const SEARCH_TOOLS = new Set(['grep', 'glob', 'find'])

/** Read a string argument, when the call carries one. */
function field(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * How one call reads in a plan: `$ npm test`, `read src/a.ts`, `grep TODO`.
 * @param tool - the tool name.
 * @param args - the call's arguments.
 * @returns the label.
 */
export function callLabel(tool: string, args: Record<string, unknown>): string {
  if (tool === 'shell' || tool === 'bash') {
    const command = field(args, 'command')
    return command === undefined ? tool : `$ ${command}`
  }
  const pattern = field(args, 'pattern') ?? field(args, 'query')
  const path = field(args, 'path') ?? field(args, 'filePath')
  const detail = SEARCH_TOOLS.has(tool) ? (pattern ?? path) : (path ?? pattern)
  return detail === undefined ? tool : `${tool} ${detail}`
}

export function describeToolRequest(body: string): string {
  const parsed = parseToolRequest(body)
  if (!parsed.ok) return body.trim()

  const lines = parsed.request.calls.map((call, index) => {
    return `${String(index + 1)}. ${callLabel(call.tool, call.arguments)}`
  })
  // Only when it is not the default: a line saying "stops at the first failure"
  // on every batch is noise, and the one that carries on is the exception worth
  // seeing.
  if (parsed.request.onError === 'continue') lines.push('(continues past a failure)')

  return lines.join('\n')
}

/** The line that opens one call's section in the result. */
function callHeader(index: number, outcome: PodToolOutcome): string {
  return `=== call ${String(index + 1)} ${outcome.tool}`
    + ` ${outcome.isError ? 'failed' : 'ok'} ${(outcome.durationMs / 1000).toFixed(1)}s`
}

/**
 * The file the agent reads to find out what its batch did.
 *
 * Deliberately close to `formatBashResult`: the same `status`/`seconds` header
 * and the same `---` before the body, so an agent that has learned to read one
 * route's answer can read the other's without being taught twice. What it adds
 * is a marked section per call, because a batch's output is useless if the
 * agent cannot tell which call produced which half of it.
 *
 * `not run` is spelled out for the calls a stop-on-failure batch never reached.
 * Left unmentioned they read as calls that ran and printed nothing, which is
 * the one misreading that would have the agent carry on as though its edits
 * had landed.
 * @param outcomes - what each call that ran produced, in order.
 * @param asked - how many calls the batch contained.
 * @returns the text to write to the result path.
 */
export function formatToolBatchResult(
  outcomes: readonly PodToolOutcome[],
  asked: number,
): string {
  const failed = outcomes.filter(outcome => outcome.isError).length
  const cap = callBudget(asked)
  const sections = outcomes.map(
    (outcome, index) => [
      callHeader(index, outcome),
      `args: ${JSON.stringify(outcome.arguments)}`,
      trimTo(outcome.output, cap),
    ].join('\n'),
  )

  for (let index = outcomes.length; index < asked; index += 1) {
    sections.push(
      `=== call ${String(index + 1)} not run`
      + ' (the batch stopped at the first failure; send it again from here)',
    )
  }

  return [
    `status: ${failed > 0 ? 'failed' : 'ok'}`,
    `seconds: ${(outcomes.reduce((total, outcome) => total + outcome.durationMs, 0) / 1000).toFixed(1)}`,
    `calls: ${String(asked)} asked, ${String(outcomes.length)} ran, ${String(failed)} failed`,
    '---',
    ...sections,
  ].join('\n')
}
