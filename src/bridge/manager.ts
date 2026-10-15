/**
 * Which opencode session owns which Dust conversation's requests, and how a
 * finished request gets back to the agent.
 *
 * One pod serves a whole project; each conversation leaves its requests under
 * its own `oc-bash/<conversationId>/`. A session is watched while its Dust
 * turn streams and for a grace window after, because the agent may leave a
 * request in the same breath as it ends its turn.
 *
 * A finished request goes back one of two ways:
 * - **In the sandbox**, by default: the agent is waiting in the helper, which
 *   prints the `.out` the moment it lands. Nothing else to send.
 * - **As a message**, when nobody is waiting: the helper gave up and left a
 *   `.detached` marker, or the Dust turn has already ended. Queued behind the
 *   session's work, it starts the turn that carries on.
 */

import type { PodFile } from '../dust/pod-files.ts'
import { PodBashWatcher } from './bash-watcher.ts'
import { detachedPath, exchangeDir } from './helper.ts'
import { POD_BASH_DIR, formatDelivery } from './pod-bash.ts'
import type { BashOutcome } from './pod-bash.ts'
import type { PodToolCall } from './pod-tool-request.ts'
import type { Route } from './routes.ts'
import type { ToolRunner } from './runner.ts'

/** How long a session is still watched after its Dust turn ends. */
const GRACE_MS = 20_000

/** The exchange pod's files, pod-relative. */
export interface PodOps {
  readonly list: () => Promise<readonly PodFile[]>
  readonly read: (path: string) => Promise<string>
  readonly write: (path: string, contents: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
}

/**
 * opencode's own loop, reached through the session's streaming Dust turn.
 *
 * A call handed to `sink(...).emit` becomes a tool call in the turn's stream:
 * opencode runs it as it runs any model's tool call — its own card, diff and
 * permission prompt — and reports how it went under the id `emit` returned.
 */
export interface NativeLoop {
  /** The streaming turn of a session, if one is streaming. */
  readonly sink: (sessionID: string) => { readonly emit: (call: PodToolCall) => string } | undefined
  /** How the tool call with this id ended, once opencode reports it. */
  readonly result: (id: string) => Promise<BashOutcome>
  /**
   * How opencode's loop can carry a call — see `routes.ts`. Absent sends
   * every call as written.
   */
  readonly route?: (call: PodToolCall, sessionID: string) => Route
}

/** Everything the manager touches, injected so tests drive it directly. */
export interface BridgeManagerOptions {
  readonly pod: PodOps
  readonly runTool: ToolRunner
  /** Run calls through opencode's loop while a Dust turn streams; absent runs them here. */
  readonly native?: NativeLoop
  /** Hand a finished request to the session as a queued message. */
  readonly deliver: (sessionID: string, text: string) => Promise<void>
  readonly wait: (ms: number) => Promise<void>
  readonly graceMs?: number
  readonly intervalMs?: number
  readonly onWarn?: (message: string) => void
}

/** What the manager knows about one session. */
interface Watched {
  readonly conversationId: string
  readonly watcher: PodBashWatcher
  readonly abort: AbortController
  /** Bumped by every stream start and end, so a stale grace timer stands down. */
  generation: number
  streaming: boolean
  stopped: boolean
  /** False once the developer interrupted: nothing is delivered after that. */
  deliver: boolean
  readonly deliveries: Set<Promise<void>>
}

/** The opencode turn a session's calls run under. */
type Turn = { readonly agent: string; readonly messageID: string }

export class BridgeManager {
  private readonly sessions = new Map<string, Watched>()
  private readonly turns = new Map<string, Turn>()

  constructor(private readonly options: BridgeManagerOptions) {}

  /**
   * A Dust turn for this session has started streaming.
   * @param sessionID - the opencode session.
   * @param conversationId - the Dust conversation the turn runs in.
   */
  streamStarted(sessionID: string, conversationId: string): void {
    let session = this.sessions.get(sessionID)
    if (session !== undefined && (session.stopped || session.conversationId !== conversationId)) {
      session.watcher.dispose()
      session = undefined
    }
    if (session === undefined) {
      session = this.watch(sessionID, conversationId)
      this.sessions.set(sessionID, session)
      void session.watcher.run()
    }
    session.generation += 1
    session.streaming = true
  }

  /**
   * The session's Dust turn has ended; keep watching for a grace window.
   * @param sessionID - the opencode session.
   */
  streamEnded(sessionID: string): void {
    const session = this.sessions.get(sessionID)
    if (session === undefined) return
    session.streaming = false
    const generation = ++session.generation
    void this.options.wait(this.options.graceMs ?? GRACE_MS).then(() => {
      if (session.generation !== generation || session.streaming) return
      // Only stops looking for new requests: one already running still
      // finishes and still delivers.
      session.stopped = true
      session.watcher.dispose()
    })
  }

  /**
   * opencode started a step for this session: the turn calls run under.
   * @param sessionID - the opencode session.
   * @param turn - the agent and the assistant message of that step.
   */
  stepStarted(sessionID: string, turn: Turn): void {
    this.turns.set(sessionID, turn)
  }

  /**
   * The turn a session's calls currently run under.
   * @param sessionID - the opencode session.
   * @returns its latest step, if opencode reported one.
   */
  turnOf(sessionID: string): Turn | undefined {
    return this.turns.get(sessionID)
  }

  /**
   * The developer interrupted the session: kill the running work and send
   * nothing, because a message would start the very turn they just stopped.
   * @param sessionID - the opencode session.
   */
  interrupted(sessionID: string): void {
    const session = this.sessions.get(sessionID)
    if (session === undefined) return
    session.deliver = false
    session.stopped = true
    session.abort.abort()
    session.watcher.dispose()
  }

  /**
   * Whether a session's exchange is still being polled.
   * @param sessionID - the opencode session.
   * @returns true while new requests would be picked up.
   */
  watching(sessionID: string): boolean {
    const session = this.sessions.get(sessionID)
    return session !== undefined && !session.stopped
  }

  /**
   * List once, answer everything found, and settle every delivery.
   * @param sessionID - the opencode session.
   */
  async poll(sessionID: string): Promise<void> {
    const session = this.sessions.get(sessionID)
    if (session === undefined) return
    await session.watcher.pollOnce()
    await Promise.all(session.deliveries)
  }

  /** Stop watching every session. */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.stopped = true
      session.watcher.dispose()
    }
  }

  /** Build the watch for one session's conversation. */
  private watch(sessionID: string, conversationId: string): Watched {
    const { pod } = this.options
    const scope = `${exchangeDir(conversationId)}/`
    // The watcher speaks the flat `oc-bash/<name>` protocol; this conversation's
    // files live one level down, so paths are moved in and out of its folder.
    const inward = (path: string): string => `${scope}${path.slice(POD_BASH_DIR.length + 1)}`

    const abort = new AbortController()
    const deliveries = new Set<Promise<void>>()
    const session: Watched = {
      conversationId,
      abort,
      generation: 0,
      streaming: false,
      stopped: false,
      deliver: true,
      deliveries,
      watcher: new PodBashWatcher({
        list: async () =>
          (await pod.list())
            .filter(file => file.path.startsWith(scope))
            .map(file => ({ ...file, path: `${POD_BASH_DIR}/${file.path.slice(scope.length)}` })),
        read: path => pod.read(inward(path)),
        write: (path, contents) => pod.write(inward(path), contents),
        remove: path => pod.remove(inward(path)),
        run: call => {
          const native = this.options.native
          const route = native?.route?.(call, sessionID) ?? { kind: 'native', call }
          const sink = route.kind === 'native' ? native?.sink(sessionID) : undefined
          if (native !== undefined && sink !== undefined && !abort.signal.aborted) {
            return this.runNative(native, sink, route.call, abort.signal)
          }
          const turn = this.turns.get(sessionID)
          return this.options.runTool(
            route.kind === 'local' ? route.call : call,
            turn === undefined ? undefined : { sessionID, ...turn },
            abort.signal,
          )
        },
        wait: this.options.wait,
        ...(this.options.intervalMs === undefined ? {} : { intervalMs: this.options.intervalMs }),
        onDone: (id, what, body) => {
          const delivery = this.deliverIfAlone(sessionID, session, id, what, body)
            .catch(error => this.options.onWarn?.(`could not deliver ${id}: ${String(error)}`))
            .finally(() => deliveries.delete(delivery))
          deliveries.add(delivery)
        },
        ...(this.options.onWarn === undefined ? {} : { onWarn: this.options.onWarn }),
      }),
    }
    return session
  }

  /**
   * Run one call as a tool call of the streaming Dust turn, and wait for
   * opencode to report how it went.
   *
   * One call at a time, which is what keeps a batch in order: opencode starts
   * every tool call of a step at once, and an edit raced by the test run that
   * checks it is no batch at all.
   */
  private async runNative(
    native: NativeLoop,
    sink: { readonly emit: (call: PodToolCall) => string },
    call: PodToolCall,
    signal: AbortSignal,
  ): Promise<BashOutcome> {
    const started = Date.now()
    const id = sink.emit(call)
    // An interrupt cancels the call opencode was running, and opencode may
    // never report it: answering here is what keeps the batch from waiting
    // on it forever.
    const interrupted = new Promise<BashOutcome>(resolve => {
      signal.addEventListener(
        'abort',
        () =>
          resolve({
            output: 'The developer interrupted the session; this call was not completed.',
            isError: true,
            durationMs: Date.now() - started,
          }),
        { once: true },
      )
    })
    // Timed here: opencode's events carry no duration of their own.
    const outcome = await Promise.race([native.result(id), interrupted])
    return { ...outcome, durationMs: Date.now() - started }
  }

  /** Send a finished request as a message, unless the agent is waiting for it. */
  private async deliverIfAlone(
    sessionID: string,
    session: Watched,
    id: string,
    what: 'script' | 'batch',
    body: string,
  ): Promise<void> {
    if (!session.deliver) return
    const detached = await this.options.pod
      .read(detachedPath(session.conversationId, id))
      .then(() => true, () => false)
    if (session.streaming && !detached) return
    if (!session.deliver) return

    const path = `${exchangeDir(session.conversationId)}/${id}.${what === 'script' ? 'sh' : 'json'}`
    await this.options.deliver(sessionID, formatDelivery(what, path, body))
  }
}
