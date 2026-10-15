/**
 * Dust conversations: opening one, continuing one, following the agent's
 * answer, and answering Dust's tool-approval prompts.
 *
 * This is the only module that builds a user-message body, which is what makes
 * the `origin` stamp enforceable: see {@link USER_MESSAGE_ORIGIN}.
 */

import { USER_MESSAGE_ORIGIN } from './constants.ts'
import { DustApiError, dustFetch, dustJson, type DustRequestContext } from './http.ts'
import { readSseEvents } from './sse.ts'

/**
 * Reconnects made before asking Dust whether the generation is still running.
 *
 * Dust closes an idle stream rather than holding it open forever, and Node's
 * `fetch` drops a response body that receives nothing for five minutes. Both
 * are ordinary during a long turn, so a stream that ends without a terminal
 * event is reconnected first and only then questioned.
 */
const MAX_IDLE_RECONNECTS = 2

/**
 * Consecutive unreadable liveness probes tolerated before giving up.
 *
 * The probe is the only thing that can distinguish a finished turn from a
 * working one, so ending the stream on the first failed read would reinstate
 * the guess it replaces.
 */
const MAX_PROBE_FAILURES = 2

/**
 * Pause before reopening a stream that failed to open or broke mid-body.
 *
 * Without it a gateway answering 502 burns the whole reconnect budget in
 * milliseconds and the turn is reported as truncated while Dust is still
 * generating it.
 */
const RECONNECT_DELAY_MS = 500

/**
 * Ceiling for the reconnect pause while Dust reports the generation running.
 *
 * A generation that emits nothing for minutes is followed by reopening a
 * stream that immediately closes; without a growing pause that is a hot loop
 * against Dust for as long as the agent is thinking.
 */
const RECONNECT_MAX_DELAY_MS = 5_000

/**
 * How long to keep following a generation that has produced no event at all.
 *
 * Reached only when Dust keeps reporting the message as running, which is what
 * a long tool call or a long reasoning pass looks like from here. It bounds a
 * generation Dust will never finish; {@link DustStreamOptions.maxSilentMs} is
 * how a deployment whose agents run longer than this raises it.
 */
const MAX_SILENT_MS = 15 * 60 * 1000

/**
 * How long one connection may receive nothing before it is reopened.
 *
 * A dropped connection is not always closed at either end, and Node's `fetch`
 * takes five minutes to call such a body dead — five minutes in which the turn
 * shows nothing and every event Dust buffered is unread. Reopening from the
 * cursor costs one request and Dust replays what was missed, so noticing early
 * is what keeps that stall to a minute.
 */
const STREAM_IDLE_MS = 60_000

/** Agent events after which no further events will arrive for a turn. */
const TERMINAL_EVENT_TYPES = new Set([
  'agent_message_success',
  'agent_message_gracefully_stopped',
  'agent_error',
  'agent_generation_cancelled',
  'user_message_error',
])

/**
 * A conversation Dust will not accept further messages for.
 *
 * Distinguished from every other failure because it is the one case where
 * opening a fresh conversation is the correct recovery.
 */
export class DustConversationGoneError extends Error {
  override readonly name = 'DustConversationGoneError'

  constructor(readonly conversationId: string, cause: DustApiError) {
    super(`Dust conversation ${conversationId} is no longer available.`, { cause })
  }
}

/** Who Dust should attribute a message to. */
export interface DustAuthor {
  readonly username: string
  readonly fullName: string
  readonly email: string
  /** IANA zone; Dust renders timestamps in it. */
  readonly timezone: string
}

/** Per-message model override. Both ids are required when one is sent. */
export interface DustModelSelection {
  readonly providerId: string
  readonly modelId: string
  readonly reasoningEffort?: string
}

/** A file already uploaded to Dust, attached to a conversation as context. */
export interface DustContentFragment {
  readonly title: string
  readonly fileId: string
}

/** One turn to send to an agent. */
export interface DustTurn {
  /** Agent configuration to mention. */
  readonly agentSId: string
  /** The user's message text. */
  readonly content: string
  /** Attribution for the message. */
  readonly author: DustAuthor
  /**
   * Client-side MCP servers this process is currently serving. Dust dials
   * these back when the agent calls one of their tools.
   */
  readonly clientSideMCPServerIds?: readonly string[]
  /** Model override; omitted means the agent runs its configured model. */
  readonly modelSelection?: DustModelSelection
  /** Space to file a newly created conversation under. */
  readonly spaceId?: string
  /** Files to attach as conversation context. */
  readonly contentFragments?: readonly DustContentFragment[]
}

/** The user message a send produced, and the conversation holding it. */
export interface DustTurnHandle {
  readonly conversationId: string
  readonly userMessageId: string
}

/** A conversation as this plugin reads it: an id and its message versions. */
export interface DustConversation {
  readonly sId: string
  /** Each entry is one message's version list, oldest version first. */
  readonly content: readonly (readonly Record<string, unknown>[])[]
}

/** An agent event as Dust emits it; `type` is the only field common to all. */
export type DustAgentEvent = Record<string, unknown> & { readonly type: string }

/**
 * Build the message payload shared by both send routes.
 *
 * `origin` is stamped here and nowhere else, and {@link DustTurn} has no field
 * that could change it. That is deliberate: Dust bills a turn as programmatic
 * unless the origin is one it classifies as interactive, so an override would
 * be a way to accidentally pay API prices.
 */
function messagePayload(turn: DustTurn): Record<string, unknown> {
  return {
    content: turn.content,
    mentions: [{ configurationId: turn.agentSId }],
    context: {
      username: turn.author.username,
      fullName: turn.author.fullName,
      email: turn.author.email,
      timezone: turn.author.timezone,
      origin: USER_MESSAGE_ORIGIN,
      clientSideMCPServerIds: [...(turn.clientSideMCPServerIds ?? [])],
    },
    ...(turn.modelSelection === undefined
      ? {}
      : { modelSelection: turn.modelSelection }),
  }
}

/** Re-throw a dead-conversation failure as the one error callers recover from. */
function rethrowGone(error: unknown, conversationId: string): never {
  if (error instanceof DustApiError && error.kind === 'gone') {
    throw new DustConversationGoneError(conversationId, error)
  }
  throw error
}

/**
 * Open a new conversation and send its first message.
 * @param context - workspace API base, token and cancellation.
 * @param turn - the message, agent, author and any attachments.
 * @returns the new conversation and the user message just created.
 * @throws DustApiError when Dust refuses the request.
 */
export async function createConversation(
  context: DustRequestContext,
  turn: DustTurn,
): Promise<DustTurnHandle> {
  const body = await dustJson<{ conversation?: DustConversation }>(
    context,
    'assistant/conversations',
    {
      method: 'POST',
      body: {
        visibility: 'unlisted',
        ...(turn.spaceId === undefined ? {} : { spaceId: turn.spaceId }),
        ...(turn.contentFragments === undefined
          ? {}
          : { contentFragments: [...turn.contentFragments] }),
        message: messagePayload(turn),
      },
    },
  )

  const conversation = body.conversation
  const userMessageId = lastMessages(conversation).find(
    message => message['type'] === 'user_message',
  )?.['sId']

  return {
    conversationId: requireId(conversation?.sId, 'assistant/conversations', 'conversation'),
    userMessageId: requireId(userMessageId, 'assistant/conversations', 'user message'),
  }
}

/**
 * Send a further message to an existing conversation.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation to continue.
 * @param turn - the message, agent, author and any overrides.
 * @returns the conversation and the user message just created.
 * @throws DustConversationGoneError when the conversation no longer accepts messages.
 * @throws DustApiError for every other refusal.
 */
export async function postMessage(
  context: DustRequestContext,
  conversationId: string,
  turn: DustTurn,
): Promise<DustTurnHandle> {
  const body = await dustJson<{ message?: { sId?: string } }>(
    context,
    `assistant/conversations/${conversationId}/messages`,
    { method: 'POST', body: messagePayload(turn) },
  ).catch(error => rethrowGone(error, conversationId))

  return {
    conversationId,
    userMessageId: requireId(body.message?.sId, 'assistant/conversations/messages', 'user message'),
  }
}

/**
 * Ask Dust to stop generating one or more agent messages.
 *
 * Dust learns about an abandoned turn no other way: aborting locally only
 * stops this client reading the event stream. A generation left running holds
 * the conversation, and Dust then accepts a further message without creating
 * an agent reply to answer it.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation being generated into.
 * @param messageIds - the agent messages to stop.
 * @throws DustConversationGoneError when the conversation no longer exists.
 * @throws DustApiError for every other refusal.
 */
export async function cancelGeneration(
  context: DustRequestContext,
  conversationId: string,
  messageIds: readonly string[],
): Promise<void> {
  await dustJson(context, `assistant/conversations/${conversationId}/cancel`, {
    method: 'POST',
    body: { action: 'cancel', messageIds: [...messageIds] },
  }).catch(error => rethrowGone(error, conversationId))
}

/**
 * Read an id out of a response that is useless without it.
 *
 * Coercing an absent id to an empty string defers the failure to the reply
 * lookup, which then searches for a reply to `''`, never matches, and reports
 * that Dust created no reply — attributing a malformed response to the agent.
 * @param value - the field as Dust sent it.
 * @param route - the route that answered, for attribution.
 * @param what - the id's role in that response.
 * @returns the id.
 * @throws Error when Dust sent no usable id.
 */
function requireId(value: unknown, route: string, what: string): string {
  if (typeof value === 'string' && value !== '') return value
  throw new Error(`Dust ${route} returned no ${what} id.`)
}

/** The live version of every message in a conversation. */
function lastMessages(
  conversation: DustConversation | undefined,
): readonly Record<string, unknown>[] {
  return (conversation?.content ?? []).flatMap(versions => {
    const live = versions[versions.length - 1]
    return live === undefined ? [] : [live]
  })
}

/**
 * Find the agent message replying to a given user message.
 *
 * Dust stores each message as a version list and only the last version is
 * live, so a retried agent message must be read from the end.
 * @param conversation - the conversation to search.
 * @param userMessageId - the user message whose reply is wanted.
 * @returns the agent message id, or nothing when Dust has not created it yet.
 */
export function findAgentMessageId(
  conversation: DustConversation,
  userMessageId: string,
): string | undefined {
  const agentMessage = lastMessages(conversation).find(
    message =>
      message['type'] === 'agent_message' &&
      message['parentMessageId'] === userMessageId,
  )
  const sId = agentMessage?.['sId']
  return typeof sId === 'string' ? sId : undefined
}

/**
 * Where a Dust agent message has got to.
 *
 * `running` covers both a generation in progress and any status this client
 * does not recognise: Dust owns that vocabulary, and reading an unknown status
 * as finished would report an unfinished turn as a complete answer.
 */
export type DustAgentMessageState = 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * The statuses Dust reports for a message that has stopped generating.
 *
 * Dust's vocabulary is `created | succeeded | failed | cancelled | interrupted
 * | gracefully_stopped`, and `created` is the only one that is not terminal.
 * Every terminal status must be listed: one left out reads as still running
 * for the life of the conversation, which makes every later turn cancel a
 * message that finished hours ago and then give up.
 *
 * `gracefully_stopped` is an answer — Dust ends the loop in place and treats
 * it as a success — while `interrupted` ends the turn without one.
 */
const FINISHED_STATES: Record<string, DustAgentMessageState> = {
  succeeded: 'succeeded',
  gracefully_stopped: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'cancelled',
}

/** One agent message as the recovery paths read it. */
export interface DustAgentMessage {
  readonly sId: string
  readonly state: DustAgentMessageState
  /** The answer Dust stored; empty when it produced none. */
  readonly content: string
  /**
   * Why Dust failed the generation, when it did.
   *
   * Dust stores this on the message. Not reading it is what made a failed
   * generation reach the human as a sentence about this client's event
   * stream — true, useless, and the same sentence as four other endings.
   */
  readonly error?: string
}

/** Classify one message row's `status` field. */
function stateOf(message: Record<string, unknown>): DustAgentMessageState {
  const status = message['status']
  return (typeof status === 'string' ? FINISHED_STATES[status] : undefined) ?? 'running'
}

/**
 * Read an agent message's state and stored answer.
 *
 * This is what makes a lost event stream recoverable: Dust holds the finished
 * answer whether or not the client managed to read it as it was generated.
 * @param conversation - the conversation to read.
 * @param agentMessageId - the message wanted.
 * @returns the live version of that message, or nothing when it is absent.
 */
export function readAgentMessage(
  conversation: DustConversation,
  agentMessageId: string,
): DustAgentMessage | undefined {
  const message = lastMessages(conversation).find(
    candidate => candidate['type'] === 'agent_message' && candidate['sId'] === agentMessageId,
  )
  if (message === undefined) return undefined

  const content = message['content']
  const raw = message['error']
  const error = typeof raw === 'object' && raw !== null
    ? (raw as { message?: unknown; code?: unknown })
    : undefined
  const detail = typeof error?.message === 'string' && error.message !== ''
    ? error.message
    : typeof error?.code === 'string' && error.code !== ''
      ? error.code
      : undefined

  return {
    sId: agentMessageId,
    state: stateOf(message),
    content: typeof content === 'string' ? content : '',
    ...(detail === undefined ? {} : { error: detail }),
  }
}

/**
 * Name every generation still running in a conversation.
 *
 * Dust declines to start a second generation while one is running, and accepts
 * the message that asked for it anyway — creating no agent reply to answer it.
 * These ids are what has to be cancelled before the conversation takes another
 * message.
 * @param conversation - the conversation to read.
 * @returns the unfinished agent message ids, in conversation order.
 */
export function findUnfinishedAgentMessageIds(
  conversation: DustConversation,
): readonly string[] {
  return lastMessages(conversation).flatMap(message => {
    if (message['type'] !== 'agent_message' || stateOf(message) !== 'running') return []
    const sId = message['sId']
    return typeof sId === 'string' ? [sId] : []
  })
}

/**
 * Read one conversation.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation to read.
 * @returns the conversation with its message versions.
 * @throws DustConversationGoneError when it no longer exists.
 */
export async function fetchConversation(
  context: DustRequestContext,
  conversationId: string,
): Promise<DustConversation> {
  const body = await dustJson<{ conversation?: DustConversation }>(
    context,
    `assistant/conversations/${conversationId}`,
  ).catch(error => rethrowGone(error, conversationId))

  return body.conversation ?? { sId: conversationId, content: [] }
}

/** One record of the agent event stream: the cursor, and the event itself. */
interface StreamEnvelope {
  eventId?: string
  data?: DustAgentEvent
}

/**
 * Why {@link streamAgentEvents} stopped following a generation.
 *
 * Only `terminal` means Dust said how the turn ended. The other four are this
 * client giving up, and they are not interchangeable: each one implicates a
 * different part of the path, and a caller that reports them as one failure
 * leaves the next occurrence as unattributable as the first.
 */
export type DustStreamEnd =
  /** Dust sent a terminal event; the turn ended where the stream says it did. */
  | 'terminal'
  /** No event arrived within the silence ceiling while Dust reported it running. */
  | 'silent-timeout'
  /** The conversation reported the message no longer running. */
  | 'settled'
  /** Consecutive liveness probes could not be read. */
  | 'probe-unreadable'
  /** Dust no longer holds the conversation. */
  | 'conversation-gone'

/** Tuning for how long a silent generation is followed. */
export interface DustStreamOptions {
  /**
   * Called once with why the stream stopped, before the generator returns.
   *
   * The four non-terminal endings are indistinguishable to a `for await`
   * caller, which is what made a turn that gave up after seventy seconds
   * report the same failure as one that waited out the whole ceiling. The
   * `cause` accompanies `probe-unreadable` and carries the failure that made
   * the last probe unreadable — without it an expired token, a rate limit and
   * a gateway outage all reach the human as the same sentence.
   */
  readonly onEnd?: (end: DustStreamEnd, cause?: Error) => void
  /**
   * How long to keep reconnecting while Dust reports the message running and
   * sends no event. Defaults to {@link MAX_SILENT_MS}.
   */
  readonly maxSilentMs?: number
  /**
   * How long one connection may receive nothing before it is reopened from the
   * cursor. Defaults to {@link STREAM_IDLE_MS}.
   */
  readonly idleTimeoutMs?: number
  /** Current epoch milliseconds; injected so tests need not wait out the ceiling. */
  readonly now?: () => number
  /** Sleep, injected so tests need not wait out the reconnect pause. */
  readonly delay?: (ms: number) => Promise<void>
}

/**
 * Follow an agent message's event stream to its terminal event.
 *
 * Dust ends an idle stream by closing the body rather than by emitting a
 * terminal event, so the stream is reopened from the last seen cursor. A
 * stream that fails to open, or that the network breaks mid-body, is a
 * reconnect too. Those are the ordinary way a long turn's stream dies, and
 * they say nothing about the generation, which Dust runs server-side and keeps
 * running.
 *
 * Silence is therefore never read as an ending. Once the cheap reconnects are
 * spent, the conversation itself decides: while Dust reports the message
 * running this keeps following it, and only a message Dust has settled — or
 * {@link DustStreamOptions.maxSilentMs} of silence — ends the stream. Guessing
 * instead is what reported a turn as truncated, and cancelled its generation,
 * while the agent was still working through a long tool call.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation being followed.
 * @param agentMessageId - the agent message whose events are wanted.
 * @param options - how long to follow a silent generation, and the clock to measure it with.
 * @returns each agent event in order, ending after the first terminal one.
 * @throws whatever the caller's abort signal raises; every other transport
 * failure is retried and then ends the stream.
 */
export async function* streamAgentEvents(
  context: DustRequestContext,
  conversationId: string,
  agentMessageId: string,
  options: DustStreamOptions = {},
): AsyncGenerator<DustAgentEvent> {
  const path = `assistant/conversations/${conversationId}/messages/${agentMessageId}/events`
  const maxSilentMs = options.maxSilentMs ?? MAX_SILENT_MS
  const idleMs = options.idleTimeoutMs ?? STREAM_IDLE_MS
  const now = options.now ?? Date.now
  const delay =
    options.delay ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))

  // Fires at most once: an ending is reported by the return that causes it,
  // and the generator has exactly one.
  const end = (reason: DustStreamEnd, cause?: Error): void => {
    options.onEnd?.(reason, cause)
  }

  let lastEventId: string | undefined
  let idleReconnects = 0
  let probeFailures = 0
  let reconnectDelayMs = RECONNECT_DELAY_MS
  let silentSince = now()
  let reopening = false

  for (;;) {
    if (reopening) {
      await delay(reconnectDelayMs)
      context.signal?.throwIfAborted()
    }
    reopening = true

    const query = lastEventId === undefined ? '' : `?lastEventId=${lastEventId}`
    let sawEvent = false

    // One controller for the whole attempt: it carries the caller's
    // cancellation, and gives up on a Dust gateway that accepts the connection
    // and then never answers, which `fetch` alone waits five minutes for.
    const attempt = new AbortController()
    const abortAttempt = (): void => {
      attempt.abort()
    }
    context.signal?.addEventListener('abort', abortAttempt, { once: true })
    let headersTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(abortAttempt, idleMs)
    headersTimer.unref?.()

    try {
      const response = await dustFetch(
        { ...context, signal: attempt.signal },
        `${path}${query}`,
      )
      clearTimeout(headersTimer)
      headersTimer = undefined
      if (response.ok && response.body !== null) {
        for await (const record of readSseEvents(response.body, idleMs)) {
          // Dust writes a bare `done` sentinel when it closes a stream.
          if (record.data === 'done') continue

          let envelope: StreamEnvelope
          try {
            envelope = JSON.parse(record.data) as StreamEnvelope
          } catch {
            // A record this client cannot parse carries no event to deliver.
            continue
          }

          if (envelope.eventId !== undefined) lastEventId = envelope.eventId
          const event = envelope.data
          if (event?.type === undefined) continue

          sawEvent = true
          yield event
          if (TERMINAL_EVENT_TYPES.has(event.type)) {
            end('terminal')
            return
          }
        }
      }
    } catch (error) {
      context.signal?.throwIfAborted()
      // An abort with the caller's signal intact is this attempt's own headers
      // watchdog, which is a reconnect like any other broken connection.
      if (!attempt.signal.aborted) throwIfAbortError(error)
      // The body died before the turn did. Reopening from the cursor picks the
      // generation back up where this client stopped reading it.
    } finally {
      clearTimeout(headersTimer)
      context.signal?.removeEventListener('abort', abortAttempt)
      // Reached only once this attempt is done with the body, including the
      // early return on a terminal event, which leaves the rest of it unread.
      attempt.abort()
    }

    if (sawEvent) {
      idleReconnects = 0
      probeFailures = 0
      reconnectDelayMs = RECONNECT_DELAY_MS
      silentSince = now()
      continue
    }

    idleReconnects += 1
    if (idleReconnects <= MAX_IDLE_RECONNECTS) continue
    if (now() - silentSince >= maxSilentMs) {
      end('silent-timeout')
      return
    }

    let running: boolean
    try {
      const conversation = await fetchConversation(context, conversationId)
      running = readAgentMessage(conversation, agentMessageId)?.state === 'running'
      probeFailures = 0
    } catch (error) {
      context.signal?.throwIfAborted()
      throwIfAbortError(error)
      // A conversation Dust has dropped holds no generation to wait for.
      if (error instanceof DustConversationGoneError) {
        end('conversation-gone')
        return
      }
      probeFailures += 1
      if (probeFailures > MAX_PROBE_FAILURES) {
        end('probe-unreadable', error instanceof Error ? error : new Error(String(error)))
        return
      }
      // Unreadable says nothing about the generation, and the caller reads the
      // conversation again before reporting a failure, so keep following.
      running = true
    }

    if (!running) {
      end('settled')
      return
    }
    idleReconnects = 0
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS)
  }
}

/**
 * Re-throw an abort so it is never mistaken for a broken connection.
 *
 * A caller that walked away wants the abort, not three more reconnects to a
 * stream nobody is reading.
 * @param error - the failure to inspect.
 */
function throwIfAbortError(error: unknown): void {
  if (error instanceof Error && error.name === 'AbortError') throw error
}

/**
 * Attach an already-uploaded file to a conversation that is already open.
 *
 * A conversation being created carries its fragments in the create body; one
 * that already exists has no such field, so this route is the only way to add
 * context to it.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation to attach to.
 * @param fragment - the uploaded file's id and title.
 * @throws DustConversationGoneError when the conversation no longer exists.
 * @throws DustApiError for every other refusal.
 */
export async function postContentFragment(
  context: DustRequestContext,
  conversationId: string,
  fragment: DustContentFragment,
): Promise<void> {
  await dustJson(context, `assistant/conversations/${conversationId}/content_fragments`, {
    method: 'POST',
    body: { fileId: fragment.fileId, title: fragment.title },
  }).catch(error => rethrowGone(error, conversationId))
}

/**
 * Answer Dust's own tool-approval prompt.
 *
 * Always approves. opencode runs no tools on this route, so the only calls
 * Dust asks about are its own server-side ones, which the agent was
 * configured to make; leaving them unanswered would stall the turn.
 * @param context - workspace API base, token and cancellation.
 * @param conversationId - the conversation the prompt belongs to.
 * @param agentMessageId - the agent message that raised it.
 * @param actionId - the action Dust wants a decision on.
 */
export async function validateAction(
  context: DustRequestContext,
  conversationId: string,
  agentMessageId: string,
  actionId: string,
): Promise<void> {
  await dustJson(
    context,
    `assistant/conversations/${conversationId}/messages/${agentMessageId}/validate-action`,
    { method: 'POST', body: { actionId, approved: 'approved' } },
  )
}
