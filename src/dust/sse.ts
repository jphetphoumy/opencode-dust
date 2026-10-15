/**
 * Minimal `text/event-stream` reader.
 *
 * Dust serves both the agent answer stream and the reverse MCP request stream
 * as SSE. Node has no built-in server-side EventSource, and the browser one
 * cannot carry the `Authorization` header these endpoints require, so the
 * framing is parsed here.
 */

/** One SSE record: the fields this plugin reads, decoded. */
export interface SseEvent {
  /** Joined `data:` lines, newline-separated, with no trailing newline. */
  readonly data: string
  /** The record's `id:` field, absent when the server sent none. */
  readonly id?: string
  /** The record's `event:` field, absent when the server sent none. */
  readonly event?: string
}

/** Strip the single optional space that follows a field's colon. */
function fieldValue(rest: string): string {
  return rest.startsWith(' ') ? rest.slice(1) : rest
}

/** Parse one complete record's lines into an event, or nothing when it carries no data. */
function parseRecord(record: string): SseEvent | undefined {
  const data: string[] = []
  let id: string | undefined
  let event: string | undefined

  for (const line of record.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : fieldValue(line.slice(colon + 1))
    if (field === 'data') data.push(value)
    else if (field === 'id') id = value
    else if (field === 'event') event = value
  }

  if (data.length === 0) return undefined
  return {
    data: data.join('\n'),
    ...(id === undefined ? {} : { id }),
    ...(event === undefined ? {} : { event }),
  }
}

/**
 * Read a response body as a sequence of SSE records.
 *
 * A record the server left unterminated when it closed the body is still
 * yielded: Dust ends a completed turn by closing the connection rather than by
 * writing a final blank line, and dropping that record would lose the last
 * event of every stream.
 * @param body - the response body to consume; fully drained before returning.
 * @param idleTimeoutMs - end the stream when nothing arrives for this long;
 * omitted or non-positive waits indefinitely.
 * @returns each decoded record in arrival order.
 */
export async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs?: number,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''

  // A connection can die without either end saying so, and Node's `fetch`
  // waits five minutes before calling that body dead. Cancelling the reader
  // ends this stream as an ordinary close, which is what callers already
  // reconnect from — sooner, and with no failure to distinguish.
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const rearm = (): void => {
    if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return
    clearTimeout(watchdog)
    watchdog = setTimeout(() => void reader.cancel(), idleTimeoutMs)
    watchdog.unref?.()
  }

  try {
    for (;;) {
      rearm()
      const { done, value } = await reader.read()
      // Disarmed for the whole time this generator is suspended in `yield`: a
      // slow consumer is not a dead connection.
      clearTimeout(watchdog)
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replaceAll('\r\n', '\n')

      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const event = parseRecord(buffer.slice(0, split))
        buffer = buffer.slice(split + 2)
        if (event !== undefined) yield event
        split = buffer.indexOf('\n\n')
      }
    }

    const trailing = parseRecord(buffer.replaceAll('\r\n', '\n'))
    if (trailing !== undefined) yield trailing
  } finally {
    clearTimeout(watchdog)
    reader.releaseLock()
  }
}
