/**
 * How the language model tells the plugin a session's Dust turn started.
 *
 * opencode loads the AI SDK module by its `file://` URL and the plugin through
 * its own loader, so the two may be separate module instances: module-level
 * state is not shared between them. The process is, so the link lives on
 * `globalThis`, keyed by the exchange pod — one per project the plugin serves.
 */

/** What the plugin is told about a session's Dust turns. */
export interface BridgeListener {
  streamStarted(sessionID: string, conversationId: string): void
  streamEnded(sessionID: string): void
}

const KEY = Symbol.for('opencode-dust.bridge-listeners')

/** The process-wide listener table. */
function listeners(): Map<string, BridgeListener> {
  const holder = globalThis as { [KEY]?: Map<string, BridgeListener> }
  holder[KEY] ??= new Map()
  return holder[KEY]
}

/**
 * Register, or with `undefined` remove, the listener for one exchange pod.
 * @param spaceId - the pod.
 * @param listener - who to tell.
 */
export function registerBridge(spaceId: string, listener: BridgeListener | undefined): void {
  if (listener === undefined) listeners().delete(spaceId)
  else listeners().set(spaceId, listener)
}

/**
 * The listener for one exchange pod.
 * @param spaceId - the pod.
 * @returns who to tell, if anyone registered.
 */
export function bridgeListener(spaceId: string): BridgeListener | undefined {
  return listeners().get(spaceId)
}

/** What the plugin's context hook passes a bridged call, under `providerOptions.dust`. */
export interface BridgeCallContext {
  readonly sessionID: string
  readonly spaceId: string
  readonly note: string
}

/** The provider-options key the context hook writes under. */
export const BRIDGE_OPTION = 'dustBridge'

/**
 * Read the bridge context off a call, if the plugin put one there.
 * @param providerOptions - the call's provider options.
 * @returns the context, or nothing for an unbridged call.
 */
export function bridgeContextOf(providerOptions: unknown): BridgeCallContext | undefined {
  const dust = (providerOptions as { dust?: Record<string, unknown> } | undefined)?.dust
  const raw = dust?.[BRIDGE_OPTION] as Partial<BridgeCallContext> | undefined
  if (raw === undefined) return undefined
  if (typeof raw.sessionID !== 'string' || typeof raw.spaceId !== 'string' || typeof raw.note !== 'string') {
    return undefined
  }
  return { sessionID: raw.sessionID, spaceId: raw.spaceId, note: raw.note }
}

/** A streaming Dust turn, taking bridged calls to emit as opencode tool calls. */
export interface NativeSink {
  /**
   * Emit a call into the turn's stream.
   * @returns the tool call id opencode will report it under.
   */
  emit(call: { readonly tool: string; readonly arguments: Record<string, unknown> }): string
}

/** What a bridged tool call ended with. */
export interface NativeOutcome {
  readonly output: string
  readonly isError: boolean
  readonly durationMs: number
}

interface NativeState {
  readonly sinks: Map<string, NativeSink>
  /** Bridged call id → the session it belongs to. */
  readonly calls: Map<string, string>
  readonly waiting: Map<string, (outcome: NativeOutcome) => void>
  /** Outcomes reported before anyone asked for them. */
  readonly early: Map<string, NativeOutcome>
}

const NATIVE_KEY = Symbol.for('opencode-dust.native')

function native(): NativeState {
  const holder = globalThis as { [NATIVE_KEY]?: NativeState }
  holder[NATIVE_KEY] ??= { sinks: new Map(), calls: new Map(), waiting: new Map(), early: new Map() }
  return holder[NATIVE_KEY]
}

/**
 * Register, or with `undefined` remove, a session's streaming turn.
 * @param sessionID - the opencode session.
 * @param sink - the turn taking calls.
 */
export function registerNativeSink(sessionID: string, sink: NativeSink | undefined): void {
  if (sink === undefined) native().sinks.delete(sessionID)
  else native().sinks.set(sessionID, sink)
}

/**
 * The streaming turn of a session, if one is streaming.
 * @param sessionID - the opencode session.
 * @returns the sink, or nothing.
 */
export function nativeSink(sessionID: string): NativeSink | undefined {
  return native().sinks.get(sessionID)
}

/**
 * Remember that a tool call id is the bridge's, not the model's own.
 * @param id - the tool call id.
 * @param sessionID - the session it was emitted in.
 */
export function markBridgedCall(id: string, sessionID: string): void {
  native().calls.set(id, sessionID)
}

/**
 * Whether a tool call id is one the bridge emitted.
 * @param id - the tool call id.
 * @returns true for a bridged call.
 */
export function isBridgedCall(id: string): boolean {
  return native().calls.has(id)
}

/**
 * Forget a bridged call once its follow-up step has been answered.
 * @param id - the tool call id.
 */
export function forgetBridgedCall(id: string): void {
  native().calls.delete(id)
}

/**
 * Wait for opencode to report how a bridged call ended.
 * @param id - the tool call id.
 * @returns the outcome.
 */
export function awaitNativeOutcome(id: string): Promise<NativeOutcome> {
  const state = native()
  const early = state.early.get(id)
  if (early !== undefined) {
    state.early.delete(id)
    return Promise.resolve(early)
  }
  return new Promise(resolve => state.waiting.set(id, resolve))
}

/**
 * Report how a bridged call ended.
 * @param id - the tool call id.
 * @param outcome - its output and verdict.
 * @returns false when the id is not a bridged call.
 */
export function settleNativeOutcome(id: string, outcome: NativeOutcome): boolean {
  const state = native()
  if (!state.calls.has(id)) return false
  const resolve = state.waiting.get(id)
  if (resolve === undefined) state.early.set(id, outcome)
  else {
    state.waiting.delete(id)
    resolve(outcome)
  }
  return true
}
