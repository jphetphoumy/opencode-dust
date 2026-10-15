/**
 * Running a shell command by leaving it in the Pod, rather than by calling a
 * tool.
 *
 * Ported from pi-dust-next. Here the agent leaves the request from its own
 * Computer sandbox, where the pod is mounted at `/files/pod`, and waits for
 * the answer inside the same free `bash` call — see `helper.ts`.
 *
 * A bridged tool call is 3 credits, because an external MCP server is always
 * `advanced`. Dust's own `files` tools are `basic` with `freeUsage: true`. The
 * two facts together are the whole of this module: the agent *writes* the
 * command into the pod for nothing, this side notices it, runs it on the
 * developer's machine, and writes what it printed back into the pod, where the
 * agent *reads* it for nothing.
 *
 * What it costs instead is a round-trip. The tool route is one model
 * invocation — call, result, carry on. This route is two — write the script,
 * then read the answer — and at a 50k-token context a cached invocation is
 * already worth a credit or two. **So one command per script is not a saving.**
 * The saving is a whole step of work in one script: N commands for two
 * round-trips and no credits, against N round-trips and up to 3N credits. That
 * is why the turn note spends a sentence on it, and why nothing here is
 * addressed to a single command.
 *
 * The same exchange carries opencode's other tools, as a batch of calls in a `.json`
 * request — see `pod-tool-request.ts`. One directory, one claim set and one
 * queue, because a batch that edits a file and a script that runs the suite
 * over it are two steps of one plan.
 *
 * Two shapes of the protocol were rejected:
 *
 * - **A fixed request path.** Then "is this request new?" has no answer that
 *   does not involve the model maintaining a counter, and a stale answer at a
 *   fixed result path reads exactly like a fresh one.
 * - **A dot-directory.** Dust's listing omits dot-directories entirely (see
 *   `POD_SKILLS_DIR`), and here the listing is not a convenience — it is the
 *   only way this side learns that a request exists at all.
 */

import type { PodFile } from '../dust/pod-files.ts'

/**
 * Where a pod keeps the shell exchange, apart from the project.
 *
 * Not dot-prefixed, for the reason in the header: a `.oc-bash/` would hold the
 * files perfectly well and be invisible to the listing this side polls.
 */
export const POD_BASH_DIR = 'oc-bash'

/** What the agent writes: the script to run. */
const REQUEST_SUFFIX = '.sh'

/**
 * What the agent writes to run opencode's tools instead of a shell.
 *
 * The second half of the same trick. A bridged tool call is 3 credits because
 * an external MCP server is always `advanced`, so `read`, `edit` and `grep`
 * cost exactly what `bash` did — and in a folder using `/podbash solo` the pod
 * file tools reach nothing, which left `sed` and heredocs doing work `edit` is
 * better at. A batch of calls left here runs for the price of the same two
 * round-trips a script costs.
 *
 * Batched rather than one call per file, and that is not a convenience: at two
 * round-trips per request a *single* bridged call through here is not a saving
 * over the 3-credit tool, for the reason in the header. The saving only appears
 * when one request carries the whole step.
 */
const TOOL_REQUEST_SUFFIX = '.json'

/** What this side writes back: what the script printed. */
const RESULT_SUFFIX = '.out'

/**
 * The line between the header and the program's own bytes.
 *
 * Everything above it is this side's, everything below is the command's, and
 * the split is literal so the agent can take the tail as output verbatim.
 */
export const BASH_RESULT_SEPARATOR = '---'

/**
 * How much command output is worth sending back.
 *
 * The agent pays for every character of this file in its own context, and a
 * build log is mostly progress lines. Generous rather than tight: cutting a
 * test report in half to save tokens costs a whole turn when the agent cannot
 * see which test failed.
 */
export const MAX_RESULT_CHARS = 60_000

/**
 * A request name this side is willing to turn into a path.
 *
 * The id is chosen by the model and becomes part of a path this process writes
 * to. Anything outside this set — a slash above all — is not a name.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Where the agent writes the script for one request. */
export function bashRequestPath(id: string): string {
  return `${POD_BASH_DIR}/${id}${REQUEST_SUFFIX}`
}

/** Where the agent writes a batch of tool calls for one request. */
export function toolRequestPath(id: string): string {
  return `${POD_BASH_DIR}/${id}${TOOL_REQUEST_SUFFIX}`
}

/**
 * Which of the two routes a request came in on.
 *
 * `script` is a shell script; `tools` is a batch of opencode tool calls. They share
 * the directory, the claim set and the queue deliberately — see
 * `pendingRequests`.
 */
export type PodRequestKind = 'script' | 'tools'

/** One request the agent has left in the pod, and how to read it. */
export interface PodRequest {
  /** The name the agent chose, without its suffix. */
  readonly id: string
  /** Which route it came in on. */
  readonly kind: PodRequestKind
  /** The pod path to read it from. */
  readonly path: string
}

/** Where this side writes the answer to one request. */
export function bashResultPath(id: string): string {
  return `${POD_BASH_DIR}/${id}${RESULT_SUFFIX}`
}

/**
 * Whether a pod path belongs to the shell exchange rather than the project.
 *
 * The sync uses this to leave these files alone in both directions. Without it
 * they are files in the pod with no local copy, which is indistinguishable
 * from "the human deleted them": the first sync drops a `oc-bash/` into the
 * working tree, and the next one deletes a request out from under the command
 * it asked for.
 * @param path - a pod-relative path.
 * @returns whether it is part of the exchange.
 */
export function isPodBashPath(path: string): boolean {
  return path === POD_BASH_DIR || path.startsWith(`${POD_BASH_DIR}/`)
}

/**
 * The requests this side has not answered yet, oldest first.
 *
 * Order is by Dust's own modification stamp rather than by name, because the
 * agent writes a script per step and expects step two to see what step one
 * did — and by name `10.sh` runs before `2.sh`.
 *
 * Both routes come back from one call, interleaved by that same stamp, because
 * they are one queue: a batch that edits a file and a script that runs the
 * suite over it are two steps of one plan, and answering them out of order
 * tests the tree as it was before the edit. Sharing the claim set matters for
 * the same reason the set exists — an id is taken once whichever suffix it
 * arrived under.
 *
 * `claimed` is held in memory by the watcher rather than derived from the
 * listing, and that is deliberate: the delete and the listing both go through
 * Cloudflare, so a request already taken can reappear in the next listing.
 * Re-running `npm run deploy` because a cache had not caught up is not a
 * recoverable mistake.
 * @param files - the pod listing.
 * @param claimed - ids this process has already taken.
 * @returns the requests to run, in the order they were asked for.
 */
export function pendingRequests(
  files: readonly PodFile[],
  claimed: ReadonlySet<string>,
): readonly PodRequest[] {
  return files
    .filter(file => file.path.startsWith(`${POD_BASH_DIR}/`))
    .map(file => ({ file, name: file.path.slice(POD_BASH_DIR.length + 1) }))
    // The suffix check runs before the name check so a result file is dropped
    // quietly rather than reported as a malformed request.
    .flatMap(({ file, name }) => {
      for (const [suffix, kind] of [
        [REQUEST_SUFFIX, 'script'],
        [TOOL_REQUEST_SUFFIX, 'tools'],
      ] as const) {
        if (!name.endsWith(suffix)) continue
        return [{ file, id: name.slice(0, -suffix.length), kind, path: file.path }]
      }
      return []
    })
    .filter(({ id }) => SAFE_ID.test(id) && !claimed.has(id))
    .sort((a, b) => a.file.modifiedMs - b.file.modifiedMs || a.id.localeCompare(b.id))
    .map(({ id, kind, path }) => ({ id, kind, path }))
}

/** What one finished command produced. */
export interface BashOutcome {
  /** Everything it printed, as the tool host joined it. */
  readonly output: string
  /** Whether it could not be run, or ran and failed. */
  readonly isError: boolean
  /** Wall-clock duration. */
  readonly durationMs: number
}

/**
 * Cut an output too long to send, keeping both ends.
 *
 * The middle is what a build log has most of; the two ends are the command's
 * opening and the error that stopped it.
 *
 * Takes its own cap rather than reading `MAX_RESULT_CHARS`, because a batch of
 * tool calls has to share one budget between them: a single `read` of a huge
 * file must not spend the whole allowance and leave the five calls behind it
 * with nothing.
 * @param output - everything the call printed.
 * @param cap - the most characters to keep.
 * @returns the output, or a head and tail with the cut marked between them.
 */
export function trimTo(output: string, cap: number): string {
  if (output.length <= cap) return output

  const half = Math.floor(cap / 2)
  const cut = output.length - cap
  return `${output.slice(0, half)}\n\n[${String(cut)} characters cut from the middle]\n\n`
    + `${output.slice(-half)}`
}

/**
 * The file the agent reads to find out what happened.
 *
 * The verdict is the first line because the agent reads this top-down and may
 * stop early on a long one; the duration is there so it can pace the next
 * request rather than polling a two-minute build every second.
 * @param outcome - what the command produced.
 * @returns the text to write to the result path.
 */
export function formatBashResult(outcome: BashOutcome): string {
  return [
    `status: ${outcome.isError ? 'failed' : 'ok'}`,
    `seconds: ${(outcome.durationMs / 1000).toFixed(1)}`,
    BASH_RESULT_SEPARATOR,
    // No trailing newline of this module's own: program output is literal, and
    // an agent diffing one test report against the last cannot be handed a
    // copy this side has tidied.
    trimTo(outcome.output, MAX_RESULT_CHARS),
  ].join('\n')
}

/**
 * The message one finished command is delivered in.
 *
 * The output comes back as a message rather than as a file the agent goes and
 * fetches, and the first live run is why. Told to read the result path, the
 * agent read the missing `.out` twice, then ran two semantic searches and a
 * `wait`, all billed, to discover something this side already knew. Waiting
 * costs a model invocation every time it looks; being told costs one, and
 * spends no tool call at all.
 *
 * It arrives as a *user* message because that is the only channel into a turn
 * the agent has already ended — hence the opening line. Unmarked, a wall of
 * `ls` output reads as something the human typed, and the agent answers it as
 * a request rather than as the answer to its own.
 * @param id - the request this answers.
 * @param outcome - what the command produced.
 * @returns the text to send into the conversation.
 */
export function formatBashDelivery(id: string, outcome: BashOutcome): string {
  return formatDelivery('script', bashRequestPath(id), formatBashResult(outcome))
}

/**
 * The message one finished request is delivered in.
 *
 * Shared by both routes for the reason `formatBashDelivery`'s own note gives:
 * the opening marker is what stops a wall of `ls` output reading as something
 * the human typed, and a batch of `read` results needs that marker exactly as
 * much as a script's output does.
 * @param what - the kind of request, named as the agent will recognise it.
 * @param path - the pod path the request was left at.
 * @param body - the formatted result.
 * @returns the text to send into the conversation.
 */
export function formatDelivery(
  what: 'script' | 'batch',
  path: string,
  body: string,
): string {
  return (
    `[automatic message, not the developer] The ${what} you left at`
    + ` \`${path}\` has finished. Carry on from here.\n\n${body}`
  )
}
