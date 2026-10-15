/**
 * A Dust workspace agent behind the AI SDK v3 language-model interface.
 *
 * Dust exposes no chat-completions endpoint: its only text-generation surface
 * is the agent conversation API, which runs the agent loop server-side. So a
 * call here sends one user message to a Dust conversation and streams the
 * agent's answer back — its chain of thought as reasoning, its answer as text.
 * opencode's own tools are never offered to the agent.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'

import { dustApiBase } from '../dust/constants.ts'
import {
  DustConversationGoneError,
  cancelGeneration,
  createConversation,
  fetchConversation,
  findAgentMessageId,
  findUnfinishedAgentMessageIds,
  postContentFragment,
  postMessage,
  readAgentMessage,
  streamAgentEvents,
  validateAction,
  type DustAgentEvent,
  type DustAuthor,
  type DustContentFragment,
  type DustTurn,
  type DustTurnHandle,
} from '../dust/conversations.ts'
import type { DustRequestContext } from '../dust/http.ts'
import { decodeModelId, type ReasoningEffort } from '../dust/models.ts'
import {
  bridgeContextOf,
  bridgeListener,
  forgetBridgedCall,
  isBridgedCall,
  markBridgedCall,
  registerNativeSink,
  type BridgeCallContext,
  type NativeSink,
} from '../bridge/registry.ts'
import { opencodeToolName } from '../bridge/runner.ts'
import { debug, describeError } from '../debug.ts'
import { uploadConversationImage, type PendingImage } from '../dust/conversation-images.ts'
import { createTagStripper } from '../dust/tag-stripper.ts'
import { DUST_PROVIDER_ID } from './catalog.ts'
import { DustThreadStore, planTurn, rememberTurn, type TurnPlan } from './history.ts'

/** Reads of the conversation made while waiting for Dust to create the reply. */
const AGENT_MESSAGE_ATTEMPTS = 6

/** Pause between those reads. */
const AGENT_MESSAGE_DELAY_MS = 500

/** Budget for the best-effort cancel sent after the caller walked away. */
const CANCEL_TIMEOUT_MS = 10_000

/** Everything a turn needs to address Dust. */
export interface DustSettings {
  /** WorkOS access token of a user grant. */
  readonly accessToken: string
  /** Dust region holding the workspace. */
  readonly region: string
  /** The workspace every request is scoped to. */
  readonly workspaceId: string
  /** The agent configuration each message mentions. */
  readonly agentSId: string
  /** Reasoning effort sent with a catalog model override. */
  readonly reasoningEffort?: ReasoningEffort
}

/**
 * Which Dust conversation holds which history, shared by every model this
 * process builds: opencode builds a new model whenever its settings change,
 * and a session must still continue its conversation across that.
 */
const sharedThreads = new DustThreadStore()

/** How a terminal agent event ends the AI SDK stream. */
const FINISH: Record<string, LanguageModelV3FinishReason['unified']> = {
  agent_message_success: 'stop',
  agent_message_gracefully_stopped: 'stop',
  agent_generation_cancelled: 'other',
  agent_error: 'error',
  user_message_error: 'error',
}

/** Dust reports no token counts to clients, so every figure is unknown. */
const NO_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
}

/** Who Dust attributes the message to. */
function author(): DustAuthor {
  return {
    username: 'opencode',
    fullName: 'opencode',
    email: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
}

/** The message Dust stored on a failed event, if it carried one. */
function eventError(event: DustAgentEvent): string {
  const raw = event['error']
  const error = typeof raw === 'object' && raw !== null ? (raw as { message?: unknown; code?: unknown }) : {}
  if (typeof error.message === 'string' && error.message !== '') return error.message
  if (typeof error.code === 'string' && error.code !== '') return error.code
  return `Dust ended the turn with ${event.type}.`
}

/**
 * The command an event says the agent ran in its own sandbox, if it is one.
 * @param event - an agent event.
 * @returns the command line, or nothing for any other event.
 */
function sandboxCommand(event: DustAgentEvent): string | undefined {
  if (event.type !== 'agent_action_success') return undefined
  const action = event['action'] as
    | { internalMCPServerName?: unknown; params?: { command?: unknown } }
    | undefined
  if (action?.internalMCPServerName !== 'sandbox') return undefined
  const command = action.params?.command
  return typeof command === 'string' && command !== '' ? command : undefined
}

/** Ids handed to bridged tool calls, unique within the process. */
let calls = 0

/**
 * A step with nothing in it: opencode's follow-up to bridged tool calls.
 * @returns the stream.
 */
function emptyStep(): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start: controller => {
      controller.enqueue({ type: 'stream-start', warnings: [] })
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'bridged' }, usage: NO_USAGE })
      controller.close()
    },
  })
}

/** Wait between conversation reads. */
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** A Dust agent, as an AI SDK language model. */
export class DustLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3'
  readonly provider = DUST_PROVIDER_ID
  readonly supportedUrls = {}
  readonly threads: DustThreadStore

  constructor(
    readonly modelId: string,
    readonly settings: DustSettings,
    deps: { readonly threads?: DustThreadStore } = {},
  ) {
    this.threads = deps.threads ?? sharedThreads
  }

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options)
    let reasoning = ''
    let text = ''
    let finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined }
    let failure: unknown

    for await (const part of stream as unknown as AsyncIterable<LanguageModelV3StreamPart>) {
      if (part.type === 'reasoning-delta') reasoning += part.delta
      else if (part.type === 'text-delta') text += part.delta
      else if (part.type === 'finish') finishReason = part.finishReason
      else if (part.type === 'error') failure = part.error
    }
    if (failure !== undefined && text === '') throw failure

    const content: LanguageModelV3Content[] = []
    if (reasoning !== '') content.push({ type: 'reasoning', text: reasoning })
    if (text !== '') content.push({ type: 'text', text })
    return { content, finishReason, usage: NO_USAGE, warnings: [] }
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    if (this.settings.workspaceId === '') {
      // Guessing one would send this human's turns — and their employer's
      // credits — to a workspace they did not pick.
      throw new Error('No Dust workspace is configured; log in to Dust again and choose one.')
    }

    const selection = decodeModelId(this.modelId)
    if (selection === undefined) {
      // Without a provider/model pair Dust would run the agent's own model,
      // which is not the model the human picked.
      throw new Error(`${this.modelId} is not a Dust model; pick one from the dust provider.`)
    }

    // opencode runs one more step after any step that called a tool, with the
    // results at the end of the prompt. A bridged call's result already went
    // back to Dust through the pod, and the Dust turn that asked for it is
    // over: there is nothing to send and nothing to say.
    const last = options.prompt.at(-1)
    if (last?.role === 'tool') {
      const ids = last.content.flatMap(part => (part.type === 'tool-result' ? [part.toolCallId] : []))
      if (ids.length > 0 && ids.every(isBridgedCall)) {
        for (const id of ids) forgetBridgedCall(id)
        return { stream: emptyStep() }
      }
    }

    const turn = new AbortController()
    const signal = options.abortSignal === undefined
      ? turn.signal
      : AbortSignal.any([options.abortSignal, turn.signal])
    const context: DustRequestContext = {
      base: dustApiBase(this.settings.region, this.settings.workspaceId),
      accessToken: this.settings.accessToken,
      signal,
    }

    const bridge = bridgeContextOf(options.providerOptions)
    const plan = planTurn(this.threads, options.prompt)
    const handle = await this.send(context, plan, options, selection, bridge)
    const listener = bridge === undefined ? undefined : bridgeListener(bridge.spaceId)
    debug('stream.start', {
      model: this.modelId,
      plan: plan.kind,
      conversationId: handle.conversationId,
      bridged: bridge?.spaceId ?? null,
      sessionID: bridge?.sessionID ?? null,
      listener: listener !== undefined,
      providerOptionKeys: Object.keys(options.providerOptions ?? {}),
    })
    // While this turn streams, the bridge hands it the calls the agent leaves
    // in the pod, and they go out as tool calls of this step: opencode runs
    // them as its own — card, diff and permission prompt — and the bridge
    // reads how they went from the session's events.
    const queue: { id: string; call: { tool: string; arguments: Record<string, unknown> } }[] = []
    let wake: (() => void) | undefined
    const sink: NativeSink = {
      emit: call => {
        calls += 1
        const id = `dust-call-${Date.now().toString(36)}-${String(calls)}`
        if (bridge !== undefined) markBridgedCall(id, bridge.sessionID)
        queue.push({ id, call })
        wake?.()
        return id
      },
    }
    if (bridge !== undefined) {
      registerNativeSink(bridge.sessionID, sink)
      listener?.streamStarted(bridge.sessionID, handle.conversationId)
    }
    const agentMessageId = await this.awaitAgentMessage(context, handle)

    // Dust learns about an abandoned turn no other way: aborting locally only
    // stops this client reading the event stream, and a generation left
    // running blocks the conversation's next message.
    let finished = false
    let cancelled = false
    const stop = (): void => {
      if (cancelled) return
      cancelled = true
      turn.abort()
      if (finished) return
      const quiet: DustRequestContext = {
        base: context.base,
        accessToken: context.accessToken,
        signal: AbortSignal.timeout(CANCEL_TIMEOUT_MS),
      }
      void cancelGeneration(quiet, handle.conversationId, [agentMessageId]).catch(() => undefined)
    }
    options.abortSignal?.addEventListener('abort', stop, { once: true })

    const run = async (emit: (part: LanguageModelV3StreamPart) => void): Promise<void> => {
      emit({ type: 'stream-start', warnings: [] })
      emit({ type: 'response-metadata', id: handle.conversationId, modelId: this.modelId })

      const stripper = createTagStripper()
      let open: { kind: 'reasoning' | 'text'; id: string } | undefined
      let blocks = 0
      let answer = ''
      const write = (kind: 'reasoning' | 'text', delta: string): void => {
        if (delta === '') return
        if (open?.kind !== kind) {
          close()
          open = { kind, id: String(blocks++) }
          emit({ type: `${kind}-start`, id: open.id })
        }
        if (kind === 'text') answer += delta
        emit({ type: `${kind}-delta`, id: open.id, delta })
      }
      const close = (): void => {
        if (open === undefined) return
        emit({ type: `${open.kind}-end`, id: open.id })
        open = undefined
      }

      let toolCalls = 0
      const flushCalls = (): void => {
        if (queue.length === 0) return
        // Closed first, so the card lands between the sentences around it.
        close()
        for (const { id, call } of queue.splice(0)) {
          toolCalls += 1
          emit({
            type: 'tool-call',
            toolCallId: id,
            toolName: opencodeToolName(call.tool),
            input: JSON.stringify(call.arguments),
          })
        }
      }

      let finish: LanguageModelV3FinishReason | undefined
      let ending = ''
      const events = streamAgentEvents(context, handle.conversationId, agentMessageId, {
        onEnd: (reason, cause) => {
          ending = cause === undefined ? reason : `${reason}: ${cause.message}`
        },
      })[Symbol.asyncIterator]()
      let pending = events.next()
      for (;;) {
        flushCalls()
        // Dust is silent while the agent waits on a bridged call, so the next
        // call must not wait for the next event to go out.
        const arrived = new Promise<'call'>(resolve => {
          wake = () => resolve('call')
        })
        const next = await Promise.race([pending, arrived])
        wake = undefined
        if (next === 'call') continue
        if (next.done === true) break
        pending = events.next()
        const event = next.value

        if (event.type === 'generation_tokens') {
          const raw = typeof event['text'] === 'string' ? event['text'] : ''
          const kind = event['classification'] === 'chain_of_thought' ? 'reasoning' : 'text'
          write(kind, stripper.push(raw))
          continue
        }

        const command = sandboxCommand(event)
        if (command !== undefined) {
          // Dust runs these in its own sandbox, so opencode never sees them as
          // tool calls; the reasoning is where the developer can follow them.
          write('reasoning', `\n$ ${command}\n`)
          continue
        }

        if (event.type === 'tool_approve_execution') {
          const actionId = event['actionId']
          if (typeof actionId === 'string') {
            await validateAction(context, handle.conversationId, agentMessageId, actionId)
          }
          continue
        }

        const unified = FINISH[event.type]
        if (unified === undefined) continue
        write(open?.kind ?? 'text', stripper.flush())
        if (unified === 'error') {
          close()
          emit({ type: 'error', error: new Error(eventError(event)) })
        }
        finish = { unified, raw: event.type }
      }

      write(open?.kind ?? 'text', stripper.flush())

      if (finish === undefined) {
        // The stream gave up without a terminal event. Dust holds the answer
        // whether or not it was read live, so the conversation decides.
        const stored = readAgentMessage(
          await fetchConversation(context, handle.conversationId),
          agentMessageId,
        )
        if (stored?.state === 'succeeded') {
          if (answer === '') write('text', stored.content)
          finish = { unified: 'stop', raw: 'succeeded' }
        } else {
          close()
          emit({
            type: 'error',
            error: new Error(stored?.error ?? `Dust stopped answering (${ending || 'stream ended'}).`),
          })
          finish = { unified: 'error', raw: stored?.state ?? ending }
        }
      }

      flushCalls()
      close()
      if (finish.unified === 'stop') {
        rememberTurn(this.threads, options.prompt, answer, handle.conversationId)
        if (toolCalls > 0) finish = { unified: 'tool-calls', raw: finish.raw }
      }
      emit({ type: 'finish', finishReason: finish, usage: NO_USAGE })
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: controller => {
        const emit = (part: LanguageModelV3StreamPart): void => {
          if (!cancelled) controller.enqueue(part)
        }
        run(emit)
          .then(() => {
            finished = true
            if (!cancelled) controller.close()
          })
          .catch((error: unknown) => {
            finished = true
            if (cancelled) return
            controller.enqueue({ type: 'error', error })
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'error', raw: undefined },
              usage: NO_USAGE,
            })
            controller.close()
          })
          .finally(() => {
            options.abortSignal?.removeEventListener('abort', stop)
            if (bridge !== undefined) {
              registerNativeSink(bridge.sessionID, undefined)
              listener?.streamEnded(bridge.sessionID)
            }
          })
      },
      cancel: stop,
    })

    return { stream, request: { body: plan } }
  }

  /** Send the turn, opening a new conversation when the old one is gone. */
  private async send(
    context: DustRequestContext,
    plan: TurnPlan,
    options: LanguageModelV3CallOptions,
    selection: { providerId: string; modelId: string },
    bridge: BridgeCallContext | undefined,
  ): Promise<DustTurnHandle> {
    const turn = (content: string): DustTurn => ({
      agentSId: this.settings.agentSId,
      // Every turn, appends included: the note is what keeps the agent off
      // the paths that do not reach the project, and Dust weighs the newest
      // message most.
      content: bridge === undefined ? content : `${bridge.note}\n\n---\n\n${content}`,
      // Filed in the exchange pod so the sandbox mounts it at /files/pod.
      // Only read on create; an existing conversation stays where it is.
      ...(bridge === undefined ? {} : { spaceId: bridge.spaceId }),
      author: author(),
      modelSelection: {
        ...selection,
        // No effort means Dust applies the model's own default.
        ...(this.settings.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: this.settings.reasoningEffort }),
      },
    })

    const create = async (content: string, images: readonly PendingImage[]): Promise<DustTurnHandle> => {
      const fragments = await this.upload(context, images)
      return createConversation(context, {
        ...turn(content),
        ...(fragments.length === 0 ? {} : { contentFragments: fragments }),
      })
    }

    if (plan.kind === 'create') return create(plan.content, plan.images)
    try {
      // Attached before the message: a fragment posted after it arrives
      // behind the sentence it was meant to illustrate.
      for (const fragment of await this.upload(context, plan.images, plan.conversationId)) {
        await postContentFragment(context, plan.conversationId, fragment).catch((error: unknown) => {
          if (error instanceof DustConversationGoneError) throw error
          context.signal?.throwIfAborted()
          debug('image.attach.failed', { title: fragment.title, error: describeError(error) })
        })
      }
      return await postMessage(context, plan.conversationId, turn(plan.content))
    } catch (error) {
      if (!(error instanceof DustConversationGoneError)) throw error
      // The only failure a fresh conversation fixes: replay the whole prompt.
      const fresh = planTurn(new DustThreadStore(), options.prompt)
      return create(fresh.content, fresh.images)
    }
  }

  /**
   * Upload a turn's files, skipping any Dust refuses.
   *
   * A refused picture must not cost the turn: the human asked a question and
   * the words are still worth answering. Only a cancellation gets through.
   */
  private async upload(
    context: DustRequestContext,
    images: readonly PendingImage[],
    conversationId?: string,
  ): Promise<DustContentFragment[]> {
    const fragments: DustContentFragment[] = []
    for (const image of images) {
      try {
        fragments.push({ title: image.title, fileId: await uploadConversationImage(context, image, conversationId) })
      } catch (error) {
        context.signal?.throwIfAborted()
        debug('image.upload.failed', { title: image.title, error: describeError(error) })
      }
    }
    return fragments
  }

  /**
   * Find the agent message Dust created to answer this turn.
   *
   * Not a single read: while a generation is running, a further message is
   * stored pending with no reply, and Dust promotes it only once that
   * generation ends. Cancelling the stale one is what makes this turn
   * answerable.
   */
  private async awaitAgentMessage(
    context: DustRequestContext,
    handle: DustTurnHandle,
  ): Promise<string> {
    const poll = async (): Promise<{ id?: string; running: readonly string[] }> => {
      for (let attempt = 0; attempt < AGENT_MESSAGE_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await delay(AGENT_MESSAGE_DELAY_MS)
        context.signal?.throwIfAborted()
        const conversation = await fetchConversation(context, handle.conversationId)
        const id = findAgentMessageId(conversation, handle.userMessageId)
        if (id !== undefined) return { id, running: [] }
        if (attempt === AGENT_MESSAGE_ATTEMPTS - 1) {
          return { running: findUnfinishedAgentMessageIds(conversation) }
        }
      }
      return { running: [] }
    }

    const first = await poll()
    if (first.id !== undefined) return first.id
    if (first.running.length > 0) {
      await cancelGeneration(context, handle.conversationId, first.running)
      const promoted = await poll()
      if (promoted.id !== undefined) return promoted.id
    }
    throw new Error('Dust accepted the message but created no agent reply to follow.')
  }
}
