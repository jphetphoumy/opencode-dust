/**
 * Mapping opencode's prompt onto a Dust conversation.
 *
 * opencode sends the whole history on every call and owns it: it compacts,
 * reverts and forks it. Dust owns an append-only transcript it will not let a
 * client rewrite. This module decides, per call, whether a Dust conversation
 * already holds a faithful prefix of the prompt — in which case only the new
 * user message is sent — or whether a new conversation must be opened.
 *
 * An AI SDK call carries no session id, so threads are keyed by a digest of
 * the history Dust has seen, answer included. A miss is never wrong, only
 * dearer: it replays the transcript into a fresh conversation.
 */

import { createHash } from 'node:crypto'

import type { LanguageModelV3FilePart, LanguageModelV3Message, LanguageModelV3Prompt } from '@ai-sdk/provider'

import { imageTitle, type PendingImage } from '../dust/conversation-images.ts'

/** How many threads a store remembers before evicting the least recently used. */
const DEFAULT_CAPACITY = 256

/** What to do with the current call. */
export type TurnPlan = (
  | { readonly kind: 'create'; readonly content: string }
  | { readonly kind: 'append'; readonly conversationId: string; readonly content: string }
) & {
  /** Files the sent messages carry, to attach as content fragments. */
  readonly images: readonly PendingImage[]
}

/** A message as the digest and the transcript see it: a role and its text. */
interface Rendered {
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/**
 * Which Dust conversation holds which history.
 *
 * Bounded: a long-lived opencode server must not accumulate one entry per
 * turn forever.
 */
export class DustThreadStore {
  private readonly threads = new Map<string, string>()

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  /**
   * Read the conversation holding a history, marking it recently used.
   * @param digest - digest of that history.
   * @returns the conversation id, or nothing when none holds it.
   */
  get(digest: string): string | undefined {
    const conversationId = this.threads.get(digest)
    if (conversationId === undefined) return undefined
    // Re-insert so eviction order tracks use, not first sight.
    this.threads.delete(digest)
    this.threads.set(digest, conversationId)
    return conversationId
  }

  /**
   * Record that a conversation now holds a history.
   * @param digest - digest of that history.
   * @param conversationId - the Dust conversation.
   */
  set(digest: string, conversationId: string): void {
    this.threads.delete(digest)
    this.threads.set(digest, conversationId)

    while (this.threads.size > this.capacity) {
      const oldest = this.threads.keys().next()
      if (oldest.done === true) break
      this.threads.delete(oldest.value)
    }
  }
}

/**
 * Render one message as the text Dust should receive, if it has any.
 *
 * Files are dropped, and so are reasoning and tool parts: Dust keeps its own
 * reasoning and runs its own tools, so echoing either back would duplicate its
 * transcript.
 * @param message - the message to render.
 * @returns the message's role and text, or nothing for system and tool messages.
 */
function render(message: LanguageModelV3Message): Rendered | undefined {
  if (message.role !== 'user' && message.role !== 'assistant') return undefined

  const text = message.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(text => text !== '')
    .join('\n')
  return { role: message.role, text }
}

/** Whether Dust can take a file as model input: an image, or a PDF. */
function attachable(mediaType: string): boolean {
  return mediaType.startsWith('image/') || mediaType === 'application/pdf'
}

/**
 * A file part's bytes as base64, with the media type a data URL may restate.
 *
 * A remote URL is skipped: fetching whatever a prompt links to is not this
 * provider's call to make.
 */
function fileBytes(part: LanguageModelV3FilePart): { data: string; mediaType: string } | undefined {
  const fromDataUrl = (url: string) => {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
    if (match === null) return undefined
    const data = match[2] === undefined ? Buffer.from(decodeURIComponent(match[3] ?? '')).toString('base64') : (match[3] ?? '')
    return { data, mediaType: match[1] ?? part.mediaType }
  }

  const { data } = part
  if (data instanceof Uint8Array) return { data: Buffer.from(data).toString('base64'), mediaType: part.mediaType }
  if (data instanceof URL) return data.protocol === 'data:' ? fromDataUrl(data.href) : undefined
  return data.startsWith('data:') ? fromDataUrl(data) : { data, mediaType: part.mediaType }
}

/**
 * The files a set of user messages carries, each once.
 *
 * Deduplicated by their bytes: opening a fresh conversation replays the whole
 * transcript, and every screenshot in it would otherwise be uploaded — and
 * billed as vision input — once per mention.
 */
function collectImages(messages: readonly LanguageModelV3Message[]): PendingImage[] {
  const images: PendingImage[] = []
  const seen = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'user') continue
    for (const part of message.content) {
      if (part.type !== 'file') continue
      const bytes = fileBytes(part)
      if (bytes === undefined || !attachable(bytes.mediaType)) continue

      const digest = createHash('sha256').update(bytes.data).digest('hex')
      if (seen.has(digest)) continue
      seen.add(digest)

      images.push({
        data: bytes.data,
        mimeType: bytes.mediaType,
        title: part.filename ?? imageTitle(bytes.mediaType, images.length + 1),
      })
    }
  }
  return images
}

/** Render a prompt's conversation, leaving out the system prompt. */
function renderAll(prompt: LanguageModelV3Prompt): Rendered[] {
  const rendered: Rendered[] = []
  for (const message of prompt) {
    const next = render(message)
    if (next === undefined) continue
    const previous = rendered.at(-1)
    // One Dust answer can come back as several assistant messages: opencode
    // splits it around the bridged tool calls it ran, and adds an empty step
    // after them. Dust holds it as one, so it is digested as one.
    if (next.role === 'assistant' && previous?.role === 'assistant') {
      rendered[rendered.length - 1] = { role: 'assistant', text: [previous.text, next.text].filter(Boolean).join('\n') }
      continue
    }
    rendered.push(next)
  }
  return rendered
}

/**
 * Digest a rendered history.
 *
 * Each field is length-prefixed so that no regrouping of the same characters
 * can produce the same digest and let a rewritten history pass as a prefix.
 * The system prompt is deliberately left out: opencode rebuilds it per call,
 * and Dust only ever received it once, at the top of the conversation.
 */
function digest(messages: readonly Rendered[]): string {
  const hash = createHash('sha256')
  for (const message of messages) {
    // Whitespace-blind: the stream and opencode's transcript of it disagree on
    // the breaks between text parts, and that difference is not a rewrite.
    const text = message.text.replace(/\s+/g, '')
    hash.update(`${String(message.role.length)}:${message.role}`)
    hash.update(`${String(text.length)}:${text}`)
  }
  return hash.digest('hex')
}

/**
 * Put the system prompt in front of a conversation's opening message.
 *
 * A Dust agent runs its own instructions and knows nothing of opencode's
 * conventions or project context. Applied only when opening a conversation:
 * Dust keeps the whole transcript, so repeating it every turn would buy the
 * same context again on a workspace that meters per message.
 */
function withSystemPrompt(prompt: LanguageModelV3Prompt, body: string): string {
  const system = prompt
    .flatMap(message => (message.role === 'system' ? [message.content] : []))
    .join('\n\n')
  if (system.trim() === '') return body
  return `${system}\n\n---\n\n${body}`
}

/** Join rendered messages into one user-message body. */
function transcript(messages: readonly Rendered[]): string {
  return messages
    .map(message => message.text)
    .filter(text => text !== '')
    .join('\n')
}

/**
 * Decide how to send a prompt to Dust.
 * @param threads - the conversations known to hold earlier histories.
 * @param prompt - the full prompt for this call.
 * @returns whether to open a conversation or extend one, and the text to send.
 */
export function planTurn(threads: DustThreadStore, prompt: LanguageModelV3Prompt): TurnPlan {
  const messages = renderAll(prompt)
  const lastAnswer = messages.findLastIndex(message => message.role === 'assistant')

  if (lastAnswer !== -1) {
    const conversationId = threads.get(digest(messages.slice(0, lastAnswer + 1)))
    // Only the human's own messages are new to Dust; an append carrying
    // nothing from the human leaves Dust nothing to answer.
    const delta = messages.slice(lastAnswer + 1).filter(message => message.role === 'user')
    if (conversationId !== undefined && transcript(delta) !== '') {
      // The prompt messages after the last answer, which is where the new
      // images are; the rendered list dropped system and tool messages, so
      // the cut is made on the prompt itself.
      const answers = prompt.filter(message => message.role === 'assistant').length
      let seenAnswers = 0
      const fresh = prompt.filter(message => {
        if (message.role === 'assistant') seenAnswers += 1
        return seenAnswers === answers && message.role === 'user'
      })
      return { kind: 'append', conversationId, content: transcript(delta), images: collectImages(fresh) }
    }
  }

  return {
    kind: 'create',
    content: withSystemPrompt(prompt, transcript(messages)),
    images: collectImages(prompt),
  }
}

/**
 * Record that a conversation now holds a prompt and the answer Dust gave it.
 * @param threads - the store to record in.
 * @param prompt - the prompt that was sent.
 * @param answer - the answer text Dust streamed back.
 * @param conversationId - the conversation holding both.
 */
export function rememberTurn(
  threads: DustThreadStore,
  prompt: LanguageModelV3Prompt,
  answer: string,
  conversationId: string,
): void {
  threads.set(digest([...renderAll(prompt), { role: 'assistant', text: answer }]), conversationId)
}
