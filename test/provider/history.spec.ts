import type { LanguageModelV3Prompt } from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'

import { DustThreadStore, planTurn, rememberTurn } from '../../src/provider/history.ts'

const system = (content: string) => ({ role: 'system' as const, content })
const user = (text: string) => ({
  role: 'user' as const,
  content: [{ type: 'text' as const, text }],
})
const assistant = (text: string) => ({
  role: 'assistant' as const,
  content: [{ type: 'text' as const, text }],
})

describe('planTurn', () => {
  it('opens a conversation for a first message, with the system prompt in front', () => {
    const prompt: LanguageModelV3Prompt = [system('Be terse.'), user('hello')]

    expect(planTurn(new DustThreadStore(), prompt)).toEqual({
      kind: 'create',
      content: 'Be terse.\n\n---\n\nhello',
      images: [],
    })
  })

  it('sends the bare message when there is no system prompt', () => {
    expect(planTurn(new DustThreadStore(), [user('hello')])).toEqual({
      kind: 'create',
      content: 'hello',
      images: [],
    })
  })

  it('appends only the new user message to a conversation Dust already holds', () => {
    const threads = new DustThreadStore()
    rememberTurn(threads, [system('s'), user('hello')], 'hi there', 'c1')

    const plan = planTurn(threads, [
      system('s'),
      user('hello'),
      assistant('hi there'),
      user('and now?'),
    ])

    expect(plan).toEqual({ kind: 'append', conversationId: 'c1', content: 'and now?', images: [] })
  })

  it('ignores a system prompt that changed between turns', () => {
    const threads = new DustThreadStore()
    rememberTurn(threads, [system('old'), user('hello')], 'hi', 'c1')

    const plan = planTurn(threads, [system('new'), user('hello'), assistant('hi'), user('next')])

    expect(plan).toMatchObject({ kind: 'append', conversationId: 'c1' })
  })

  it('opens a fresh conversation when the history was rewritten', () => {
    const threads = new DustThreadStore()
    rememberTurn(threads, [user('hello')], 'hi', 'c1')

    const plan = planTurn(threads, [user('hello'), assistant('edited'), user('next')])

    expect(plan.kind).toBe('create')
  })

  it('replays the whole transcript when it has to open a new conversation mid-session', () => {
    const plan = planTurn(new DustThreadStore(), [
      system('s'),
      user('one'),
      assistant('two'),
      user('three'),
    ])

    expect(plan).toEqual({ kind: 'create', content: 's\n\n---\n\none\ntwo\nthree', images: [] })
  })

  it('keeps files out of the text, which carries only what the human wrote', () => {
    const plan = planTurn(new DustThreadStore(), [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'file', data: 'aGk=', mediaType: 'image/png' },
        ],
      },
    ])

    expect(plan).toMatchObject({ kind: 'create', content: 'look' })
  })
})

describe('DustThreadStore', () => {
  it('forgets the least recently used thread beyond its capacity', () => {
    const threads = new DustThreadStore(1)
    rememberTurn(threads, [user('a')], 'A', 'c1')
    rememberTurn(threads, [user('b')], 'B', 'c2')

    expect(planTurn(threads, [user('a'), assistant('A'), user('x')]).kind).toBe('create')
    expect(planTurn(threads, [user('b'), assistant('B'), user('x')])).toMatchObject({
      kind: 'append',
      conversationId: 'c2',
    })
  })
})

describe('the images a turn carries', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const image = (data: Uint8Array | string | URL, mediaType = 'image/png', filename?: string) => ({
    type: 'file' as const,
    data,
    mediaType,
    ...(filename === undefined ? {} : { filename }),
  })
  const withImage = (text: string, ...files: ReturnType<typeof image>[]) => ({
    role: 'user' as const,
    content: [{ type: 'text' as const, text }, ...files],
  })

  it('collects the images of the message being sent, as base64 with a title', () => {
    const plan = planTurn(new DustThreadStore(), [withImage('look', image(PNG))])

    expect(plan.images).toEqual([
      { data: Buffer.from(PNG).toString('base64'), mimeType: 'image/png', title: 'pasted-1.png' },
    ])
  })

  it('keeps the filename opencode gave a file', () => {
    const plan = planTurn(new DustThreadStore(), [withImage('look', image(PNG, 'image/png', 'shot.png'))])

    expect(plan.images[0]?.title).toBe('shot.png')
  })

  it('reads base64 strings and data URLs alike', () => {
    const base64 = Buffer.from(PNG).toString('base64')
    const plan = planTurn(new DustThreadStore(), [
      withImage('a', image(base64)),
      withImage('b', image(new URL(`data:image/jpeg;base64,${Buffer.from([9, 9]).toString('base64')}`), 'image/jpeg')),
    ])

    expect(plan.images.map(entry => entry.mimeType)).toEqual(['image/png', 'image/jpeg'])
    expect(plan.images[0]?.data).toBe(base64)
  })

  it('attaches only the new message’s images to a conversation that already has the rest', () => {
    const threads = new DustThreadStore()
    rememberTurn(threads, [withImage('first', image(PNG))], 'seen', 'c1')

    const plan = planTurn(threads, [
      withImage('first', image(PNG)),
      assistant('seen'),
      withImage('second', image(new Uint8Array([7, 7, 7]))),
    ])

    expect(plan).toMatchObject({ kind: 'append', conversationId: 'c1' })
    expect(plan.images).toHaveLength(1)
  })

  it('attaches the same picture once, however often the history repeats it', () => {
    const plan = planTurn(new DustThreadStore(), [
      withImage('one', image(PNG)),
      assistant('ok'),
      withImage('two', image(PNG)),
    ])

    expect(plan.images).toHaveLength(1)
  })

  it('passes PDFs, and nothing else Dust could not read', () => {
    const plan = planTurn(new DustThreadStore(), [
      withImage('docs', image(PNG, 'application/pdf', 'spec.pdf'), image(PNG, 'application/zip', 'a.zip')),
    ])

    expect(plan.images.map(entry => entry.title)).toEqual(['spec.pdf'])
  })

  it('skips a remote URL, which this side has no business fetching', () => {
    const plan = planTurn(new DustThreadStore(), [withImage('web', image(new URL('https://example.com/x.png')))])

    expect(plan.images).toEqual([])
  })
})

describe('a turn whose answer was interleaved with bridged tool calls', () => {
  const toolCall = (id: string) => ({
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'edit',
    input: { path: 'a.ts' },
  })
  const toolResults = (id: string) => ({
    role: 'tool' as const,
    content: [
      { type: 'tool-result' as const, toolCallId: id, toolName: 'edit', output: { type: 'text' as const, value: 'ok' } },
    ],
  })

  it('still extends the same conversation, however opencode split and replayed the answer', () => {
    const threads = new DustThreadStore()
    // What the stream sent: one answer, with a tool call in the middle of it.
    rememberTurn(threads, [user('fix it')], 'Looking.\nFixed it.', 'c1')

    const plan = planTurn(threads, [
      user('fix it'),
      { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, toolCall('t1')] },
      toolResults('t1'),
      { role: 'assistant', content: [{ type: 'text', text: 'Fixed it.' }] },
      // The empty continuation step opencode runs after a tool call.
      { role: 'assistant', content: [] },
      user('thanks'),
    ])

    expect(plan).toMatchObject({ kind: 'append', conversationId: 'c1', content: 'thanks' })
  })

  it('is not fooled by whitespace the stream and the transcript disagree on', () => {
    const threads = new DustThreadStore()
    rememberTurn(threads, [user('go')], 'one two', 'c1')

    const plan = planTurn(threads, [
      user('go'),
      { role: 'assistant', content: [{ type: 'text', text: 'one' }, { type: 'text', text: ' two\n' }] },
      user('next'),
    ])

    expect(plan).toMatchObject({ kind: 'append', conversationId: 'c1' })
  })
})
