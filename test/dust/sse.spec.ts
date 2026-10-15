import { describe, expect, it } from 'vitest'

import { readSseEvents } from '../../src/dust/sse.ts'

/** Build a byte stream from chunks written exactly as a server would frame them. */
function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const out: { data: string; id?: string; event?: string }[] = []
  for await (const event of readSseEvents(stream)) out.push(event)
  return out
}

describe('readSseEvents', () => {
  it('yields one event per record', async () => {
    const events = await collect(streamOf('data: one\n\ndata: two\n\n'))
    expect(events.map(e => e.data)).toEqual(['one', 'two'])
  })

  it('joins multi-line data with newlines, per the EventSource grammar', async () => {
    const events = await collect(streamOf('data: first\ndata: second\n\n'))
    expect(events[0]?.data).toBe('first\nsecond')
  })

  it('carries the id and event fields when present', async () => {
    const events = await collect(streamOf('id: 42\nevent: tick\ndata: payload\n\n'))
    expect(events[0]).toEqual({ id: '42', event: 'tick', data: 'payload' })
  })

  it('tolerates CRLF framing', async () => {
    const events = await collect(streamOf('data: one\r\n\r\ndata: two\r\n\r\n'))
    expect(events.map(e => e.data)).toEqual(['one', 'two'])
  })

  it('reassembles a record split across transport chunks', async () => {
    const events = await collect(streamOf('data: sp', 'lit acr', 'oss chunks\n\n'))
    expect(events.map(e => e.data)).toEqual(['split across chunks'])
  })

  it('accepts a field with no space after the colon', async () => {
    const events = await collect(streamOf('data:tight\n\n'))
    expect(events[0]?.data).toBe('tight')
  })

  it('ignores comment lines', async () => {
    const events = await collect(streamOf(': keep-alive\ndata: real\n\n'))
    expect(events.map(e => e.data)).toEqual(['real'])
  })

  it('skips records that carry no data field', async () => {
    const events = await collect(streamOf('event: ping\n\ndata: real\n\n'))
    expect(events.map(e => e.data)).toEqual(['real'])
  })

  it('yields a trailing record the server never terminated', async () => {
    // Dust closes the response body without a blank line at the end of a turn.
    const events = await collect(streamOf('data: last\n'))
    expect(events.map(e => e.data)).toEqual(['last'])
  })

  it('yields nothing for an empty stream', async () => {
    expect(await collect(streamOf())).toEqual([])
  })

  it('ends a stream that has gone quiet, so a dead connection is noticed', async () => {
    // A connection can die with neither end closing it, and Node's `fetch`
    // waits five minutes before saying so. Ending here lets the caller
    // resubscribe from its cursor instead of showing nothing for that long.
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: one\n\n'))
      },
      // Never enqueues again and never closes: a half-open connection.
      pull() {},
    })

    const out: string[] = []
    for await (const event of readSseEvents(stream, 20)) out.push(event.data)

    expect(out).toEqual(['one'])
  })

  it('does not end a healthy stream while the consumer is slow', async () => {
    // The watchdog measures the connection, not what the caller does with each
    // event; a tool call outlasting the timeout must not close the channel.
    const out: string[] = []
    for await (const event of readSseEvents(streamOf('data: one\n\ndata: two\n\n'), 20)) {
      await new Promise(resolve => setTimeout(resolve, 40))
      out.push(event.data)
    }

    expect(out).toEqual(['one', 'two'])
  })
})
