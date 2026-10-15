/**
 * The side of the free shell route that watches the pod.
 *
 * `pod-bash.ts` says what the exchange looks like; this runs it. While a turn
 * is in flight it lists the pod, and for every request the agent has left in
 * `oc-bash/` it takes the request away, runs it through opencode's real tools,
 * and writes what they printed back beside it.
 *
 * Three properties matter more than anything else here, and each of them is a
 * failure that has an obvious cheaper implementation:
 *
 * - **A request is taken exactly once.** The listing and the delete both go
 *   through Cloudflare's cache, so "it is still in the listing" is not
 *   evidence that it has not run. The claim is held in memory.
 * - **A request always gets an answer.** The agent is sitting in a read loop
 *   waiting for the result file, and every look costs it a round-trip. A
 *   failure that writes nothing leaves it polling a path that will never
 *   appear — so every path out of `answer` writes something.
 * - **The loop never dies.** An expired token fails every listing until it is
 *   refreshed. A throw escaping the loop would take the agent's only shell
 *   away for the rest of the session, silently.
 *
 * Every API call this makes is a direct call from this plugin rather than a
 * tool call the agent made, so the polling itself is free however long the turn runs.
 */

import type { PodFile } from '../dust/pod-files.ts'
import {
  BASH_RESULT_SEPARATOR,
  bashResultPath,
  formatBashResult,
  pendingRequests,
  type BashOutcome,
  type PodRequestKind,
} from './pod-bash.ts'
import {
  formatToolBatchResult,
  parseToolRequest,
  type PodToolCall,
  type PodToolOutcome,
} from './pod-tool-request.ts'

/** What one finished command produced. */
export type PodBashRun = BashOutcome

/** How long to leave between listings. */
const DEFAULT_INTERVAL_MS = 1000

/** Everything the watcher needs, injected so a test never waits on a clock. */
export interface PodBashWatcherOptions {
  /** List the pod this folder is bound to. */
  readonly list: () => Promise<readonly PodFile[]>
  /** Read one pod file. */
  readonly read: (path: string) => Promise<string>
  /** Write one pod file, replacing whatever was there. */
  readonly write: (path: string, contents: string) => Promise<void>
  /** Remove one pod file. */
  readonly remove: (path: string) => Promise<void>
  /**
   * Run one tool call on this machine.
   *
   * Runs opencode's genuine tool rather than a second implementation of it,
   * and so inherits its permission check: `shell` asks, allows or denies by
   * the developer's opencode rules before it spawns anything.
   *
   * A script is passed as `shell` with a `command`, which is not a shortcut
   * but the point: every request this side runs, of either kind, arrives at
   * this one function, where that check sits, and it cannot be reached around
   * by choosing the other suffix.
   */
  readonly run: (call: PodToolCall) => Promise<PodBashRun>
  /**
   * Ask whether a call may run, before it does.
   *
   * An extra policy on top of opencode's own permissions. Absent leaves every
   * call to those permissions alone.
   *
   * Consulted here rather than at the two request kinds, because here is the one
   * place both of them reach: a policy that sat on the batch route could be
   * walked around by writing a script, and one that sat on the script route by
   * writing a batch.
   */
  readonly gate?: (call: PodToolCall) => Promise<{ allowed: boolean; reason?: string }>
  /** Sleep, injected so the loop can be driven a poll at a time. */
  readonly wait: (ms: number) => Promise<void>
  /** How long to leave between listings. */
  readonly intervalMs?: number
  /**
   * Hand a finished command to the caller, to be delivered to the agent.
   *
   * The `.out` file is the record; this is the channel. By the time a command
   * finishes the agent has ended its turn — it was told to — and a message is
   * the only way back into a settled session. A run nobody is handed is one
   * the agent waits on forever.
   *
   * Handed the formatted body rather than the raw outcome, because the two
   * routes format differently and the record and the message must not be able
   * to disagree about what happened.
   */
  readonly onDone?: (id: string, what: 'script' | 'batch', body: string) => void
  /**
   * Report a request as it is taken, before any of it runs.
   *
   * The only moment the human can see what is queued. The agent writes the
   * request with Dust's own file tool, so the transcript shows a path and a byte
   * count — `Created oc-bash/step1.json (application/json, 1 KB)` — and the
   * per-call reports come afterwards, one tool and one path at a time. A step
   * that takes minutes is otherwise a silence with a file size in front of it.
   *
   * Handed the raw body rather than a parsed plan, so a request that will not
   * parse is still shown as the agent wrote it.
   */
  readonly onRequest?: (id: string, kind: PodRequestKind, body: string) => void

  /**
   * Report a finished call, so the transcript can card it.
   *
   * Dust's loop never sees these calls and opencode draws no card for them, so
   * without this a turn in this mode is a minute of silence while the
   * developer's machine runs commands they cannot see.
   */
  readonly onRan?: (call: PodToolCall, run: PodBashRun) => void
  /** Report trouble that did not stop the loop. */
  readonly onWarn?: (message: string) => void
}

/** Read a thrown value as a message worth writing into the pod. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Polls a pod for shell requests and answers them. */
export class PodBashWatcher {
  /** Ids this process has taken, whatever the listing says next. */
  private readonly claimed = new Set<string>()

  /** Commands taken and not yet delivered. */
  private running = 0

  /** Claimed and not yet run, in the order they were asked for. */
  private readonly queue: {
    readonly id: string
    readonly kind: PodRequestKind
    readonly path: string
    readonly stale: boolean
  }[] = []

  /** The drain in flight, so a second claim joins it rather than racing it. */
  private draining: Promise<void> | undefined

  private stopped = false

  constructor(private readonly options: PodBashWatcherOptions) {}

  /**
   * How many commands the agent is still waiting on.
   *
   * `/goal` and `/loop` both send their next iteration when a turn settles,
   * and under this design a settled turn is usually the agent *waiting* — it
   * was told to write its script and stop. Read this before sending one: the
   * delivery is the continuation, and a loop that fires anyway prompts the
   * agent to carry on without the output it asked for, burns an iteration of
   * its own cap, and — if the plan happened to be complete — can declare the
   * goal finished on a turn that was only a pause.
   * @returns the number of commands claimed and not yet delivered.
   */
  outstanding(): number {
    return this.running
  }

  /**
   * List the pod and take ownership of every request in it, without waiting
   * for any of them to run.
   *
   * Split from the running because `/goal` decides whether to fire its next
   * iteration the instant a turn settles, and the agent writes its script and
   * ends its turn in the same breath — so at that moment the once-a-second
   * poll has usually not seen the request yet. `outstanding()` read 0, the
   * goal fired anyway, and a live run burned 25 iterations on turns that were
   * only pauses. An awaited claim at that point settles the question.
   *
   * Never throws: every caller is either a loop that must outlive a bad
   * listing, or an event handler that must not fail one.
   * @returns how many commands are now outstanding.
   */
  async claim(): Promise<number> {
    let files: readonly PodFile[]
    try {
      files = await this.options.list()
    } catch (error) {
      this.options.onWarn?.(`could not list the pod for shell requests: ${messageOf(error)}`)
      return this.running
    }

    const results = new Set(files.map(file => file.path))

    for (const { id, kind, path } of pendingRequests(files, this.claimed)) {
      this.claimed.add(id)
      this.running += 1
      this.queue.push({ id, kind, path, stale: results.has(bashResultPath(id)) })
    }

    // Started but not awaited: a claim exists to answer a question now, and
    // the command behind it may run for minutes.
    void this.drain()
    return this.running
  }

  /**
   * Run everything claimed, one at a time.
   *
   * Sequential, and deliberately so. The agent writes a script per step and
   * expects step two to see what step one did; two shells in the same working
   * tree do not give it that.
   *
   * Disposal is deliberately not checked in here. It happens a grace period
   * after the turn settles, which under the push model is *while* these are
   * running — the agent ended its turn precisely because it is waiting — so
   * bailing out would strand whatever is left of the batch.
   */
  private async drain(): Promise<void> {
    if (this.draining !== undefined) return
    const run = (async () => {
      let next = this.queue.shift()
      while (next !== undefined) {
        try {
          await this.answer(next)
        } finally {
          // In a `finally` because the count is what a loop stands aside for.
          // A path that left it raised would hold `/goal` for the rest of the
          // session, waiting on a delivery that had already failed.
          this.running -= 1
        }
        next = this.queue.shift()
      }
    })()
    this.draining = run.finally(() => {
      this.draining = undefined
    })
    await this.draining
  }

  /**
   * Settle once nothing claimed is still running.
   * @returns when the queue is empty.
   */
  async idle(): Promise<void> {
    await this.draining
  }

  /** One listing, and every request in it answered. */
  async pollOnce(): Promise<void> {
    await this.claim()
    await this.idle()
  }

  /**
   * Run one call, reporting it, and never throwing.
   *
   * The single point every request of either kind passes through, so a card is
   * drawn for each call and a failure inside a tool comes back as a result the
   * agent can read rather than as a dead batch.
   * @param call - the tool and arguments to run.
   * @returns what it produced.
   */
  private async runOne(call: PodToolCall): Promise<PodBashRun> {
    // Before the call, and reported as a failed call rather than thrown: the
    // agent can read a refusal and choose another way, and the batch's
    // stop-at-first-failure then keeps the rest of the step from running against
    // a state the denial has changed.
    //
    // Carded as well, because a denial the human cannot see is a policy they
    // cannot tell is working.
    const verdict = await this.gateFor(call)
    if (!verdict.allowed) {
      const denied = {
        output: `Denied by a PreToolUse hook: ${verdict.reason ?? 'no reason given'}`,
        isError: true,
        durationMs: 0,
      }
      try {
        this.options.onRan?.(call, denied)
      } catch {
        // The card is decoration; the denial stands either way.
      }
      return denied
    }

    // A tool host failure — no session yet, a refused approval, a sync that
    // could not settle — is reported the same way a failing tool is.
    const run = await this.options.run(call).catch((error: unknown) => ({
      output: messageOf(error),
      isError: true,
      durationMs: 0,
    }))

    try {
      this.options.onRan?.(call, run)
    } catch {
      // The card is decoration; the agent's answer is not.
    }

    return run
  }

  /**
   * Ask the gate, and allow when the gate itself fails.
   *
   * A throw here is the policy machinery breaking, not a policy decision. It
   * allows, for the reason `tool-hooks.ts` sets out at length: a guard that
   * denied everything whenever its own plumbing broke would be indistinguishable
   * from the policy working, and would be switched off rather than fixed.
   * @param call - the call to ask about.
   * @returns the verdict, allowing when there was no answer to be had.
   */
  private async gateFor(call: PodToolCall): Promise<{ allowed: boolean; reason?: string }> {
    if (this.options.gate === undefined) return { allowed: true }
    try {
      return await this.options.gate(call)
    } catch (error) {
      this.options.onWarn?.(`could not check the hooks for ${call.tool}: ${messageOf(error)}`)
      return { allowed: true }
    }
  }

  /**
   * Run a batch of tool calls, in order, and say what each one did.
   *
   * Stops at the first failure by default, and the default is the careful one:
   * the calls in a batch are usually the steps of one edit, so carrying on past
   * a failed `read` applies an `edit` to a file whose contents are not what the
   * agent thinks. The calls it never reached are reported as `not run` rather
   * than omitted — see `formatToolBatchResult`.
   * @param request - the parsed batch.
   * @returns what each call that ran produced, in order.
   */
  private async runBatch(request: {
    readonly calls: readonly PodToolCall[]
    readonly onError: 'stop' | 'continue'
  }): Promise<readonly PodToolOutcome[]> {
    const outcomes: PodToolOutcome[] = []

    for (const call of request.calls) {
      const run = await this.runOne(call)
      outcomes.push({
        tool: call.tool,
        arguments: call.arguments,
        output: run.output,
        isError: run.isError,
        durationMs: run.durationMs,
      })
      if (run.isError && request.onError === 'stop') break
    }

    return outcomes
  }

  /**
   * Take one request, run it, and write the answer back.
   * @param claimed - the request, as the listing described it.
   */
  private async answer(claimed: {
    readonly id: string
    readonly kind: PodRequestKind
    readonly path: string
    readonly stale: boolean
  }): Promise<void> {
    const { id, kind, path: request, stale } = claimed
    const result = bashResultPath(id)

    // The read comes first, and the order is the whole of it: deleting before
    // reading is what the first live turn did, and every command came back
    // `could not be read (404)` while the pod listing showed only the `.out`
    // — indistinguishable from the agent's write never having landed. It had.
    //
    // Nothing is lost by waiting: the caller has already claimed this id in
    // memory, so no second poll can take it while the read is in flight.
    const body = await this.options.read(request).catch((error: unknown) => error as Error)

    // Before the command starts, not after it finishes: a command can run for
    // minutes and the poll comes round every second, so a request still in the
    // pod is one a *restarted* process would run again. The in-memory claim
    // covers this process; this covers the next one.
    await this.forget(request)

    // Only when the listing actually showed one, because the delete route
    // answers 404 for a path that is not there and a warning on every
    // ordinary command would bury the ones that mean something.
    //
    // This is what the turn note's "use a name you have never used" is
    // insurance for, and the insurance is needed: with the previous run's
    // output still at that path, the agent reads a passing test report as the
    // answer to a test run that has not started.
    if (stale) await this.forget(result)

    // Announced before anything runs, and only when there is something to
    // announce: a body this side could not read is reported by the answer below
    // rather than as an empty plan. Swallowed, because the card is decoration
    // and the agent's answer is not.
    if (!(body instanceof Error)) {
      try {
        this.options.onRequest?.(id, kind, body)
      } catch {
        // Nothing to do: the request still runs.
      }
    }

    // One exit, deliberately. The agent has ended its turn over this request
    // and is waiting to be spoken to, so a path that leaves without
    // delivering is one it waits on forever — and, with a loop running, one
    // that holds the loop too. Every branch below ends in a `published`.
    const published = body instanceof Error
      ? `status: failed\nseconds: 0.0\n${BASH_RESULT_SEPARATOR}\n`
        + `The request at ${request} could not be read: ${messageOf(body)}.`
      : kind === 'script'
        ? formatBashResult(await this.runOne({ tool: 'shell', arguments: { command: body } }))
        : await this.answerBatch(request, body)

    // The record first, then the channel — but the delivery does not depend on
    // the record landing. A pod that refuses the write has cost a debugging
    // aid; it must not also cost the agent the answer it is waiting for.
    await this.publish(result, published)

    try {
      this.options.onDone?.(id, kind === 'script' ? 'script' : 'batch', published)
    } catch (error) {
      this.options.onWarn?.(`could not deliver the result of ${id}: ${messageOf(error)}`)
    }
  }

  /**
   * Run a `.json` request and format what it did.
   *
   * A file that will not parse is answered with the parser's own complaint
   * rather than with nothing. The agent is waiting on a message either way, and
   * "call 2 has `arguments` as a string" is a thing it can fix on the next
   * round-trip; silence is not.
   * @param request - the pod path, for the error message.
   * @param body - the request file's contents.
   * @returns the text to write back.
   */
  private async answerBatch(request: string, body: string): Promise<string> {
    const parsed = parseToolRequest(body)
    if (!parsed.ok) {
      return `status: failed\nseconds: 0.0\ncalls: none\n${BASH_RESULT_SEPARATOR}\n`
        + `${request} was not run: ${parsed.error}`
    }

    const outcomes = await this.runBatch(parsed.request)
    return formatToolBatchResult(outcomes, parsed.request.calls.length)
  }

  /**
   * Write one answer, reporting rather than throwing when the pod refuses.
   *
   * A failed write costs this one request, which the agent will notice by
   * waiting. Throwing would cost every request queued behind it.
   */
  private async publish(path: string, body: string): Promise<void> {
    try {
      await this.options.write(path, body)
    } catch (error) {
      this.options.onWarn?.(`could not write ${path} back to the pod: ${messageOf(error)}`)
    }
  }

  /** Remove a pod file, reporting rather than throwing when it will not go. */
  private async forget(path: string): Promise<void> {
    try {
      await this.options.remove(path)
    } catch (error) {
      this.options.onWarn?.(`could not clear ${path} from the pod: ${messageOf(error)}`)
    }
  }

  /**
   * Poll until disposed.
   *
   * Started when a turn starts and disposed when it ends: outside a turn there
   * is no agent to write a request, and a listing a second forever is traffic
   * for nothing.
   */
  async run(): Promise<void> {
    while (!this.stopped) {
      await this.pollOnce()
      if (this.stopped) return
      await this.options.wait(this.options.intervalMs ?? DEFAULT_INTERVAL_MS)
    }
  }

  /**
   * Stop polling.
   *
   * A command already running is not interrupted here — the caller owns the
   * signal it was started with — but it does still write its result into the
   * pod, so an agent that comes back to look is told what happened rather than
   * waiting on a file that is never coming.
   */
  dispose(): void {
    this.stopped = true
  }
}
