/**
 * How a long turn survives the connection under it dying.
 *
 * The rest of the suite stubs `fetch`, which cannot reproduce this: the
 * failures here are properties of a real socket and of Node's own timeouts,
 * and a stubbed transport recovers from them by construction. So these run
 * against a loopback server that reproduces the two ways a Dust stream stops
 * without saying so — headers that never arrive, and a body that stops mid
 * turn with the connection still open.
 *
 * The turn this was written from failed after 112 seconds of work: the
 * connection went half-open, `fetch` said nothing for five minutes, and the
 * client then reported `DUST_STREAM_TRUNCATED` and cancelled a generation Dust
 * was still running.
 */

import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAgentEvents } from '../../src/dust/conversations.ts'

/** The real `fetch`, captured before the suite guard replaces it. */
const realFetch = globalThis.fetch

/** How a stalled stream attempt is ended, per attempt index. */
type Stall = 'no-headers' | 'half-open' | 'answer'

/** One SSE record as Dust frames it. */
function record(eventId: string, data: unknown): string {
  return `data: ${JSON.stringify({ eventId, data })}\n\n`
}

/**
 * A Dust-shaped server: an event stream that stalls, and a conversation that
 * keeps reporting the generation running until the stream answers.
 * @param stalls - how each successive stream attempt behaves.
 * @returns the server, its base URL, and how often each route was reached.
 */
async function dustLike(stalls: readonly Stall[]) {
  const counts = { streams: 0, probes: 0 }
  let status = 'created'

  const server = http.createServer((request, response) => {
    if (request.url?.includes('/events') === true) {
      const stall = stalls[counts.streams] ?? 'answer'
      counts.streams += 1
      // A gateway that accepts the connection and never answers: no headers,
      // no close. Node's `fetch` waits five minutes on this.
      if (stall === 'no-headers') return

      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (stall === 'half-open') {
        // Headers and one keep-alive, then nothing, with the socket still up.
        response.write(':\n')
        return
      }

      status = 'succeeded'
      response.write(record('9', { type: 'agent_message_success' }))
      response.end()
      return
    }

    counts.probes += 1
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        conversation: {
          sId: 'c1',
          content: [[{ type: 'agent_message', sId: 'am1', status, content: '' }]],
        },
      }),
    )
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve()
    })
  })
  const { port } = server.address() as { port: number }
  return { server, counts, base: `http://127.0.0.1:${port}` }
}

let running: http.Server | undefined

afterEach(() => {
  running?.close()
  running = undefined
})

/** Follow one stream against the loopback server and collect its event types. */
async function follow(base: string): Promise<string[]> {
  // Loopback only, and only for the request this test just started; the suite
  // guard is what keeps every other test off the network.
  vi.stubGlobal('fetch', realFetch)

  const types: string[] = []
  for await (const event of streamAgentEvents(
    { base, accessToken: 'test' },
    'c1',
    'am1',
    { idleTimeoutMs: 300 },
  )) {
    types.push(event.type)
  }
  return types
}

describe('following a Dust generation across a dead connection', () => {
  it('resumes a connection that stopped mid-turn without closing', async () => {
    const { server, counts, base } = await dustLike(['half-open', 'half-open', 'half-open'])
    running = server

    expect(await follow(base)).toEqual(['agent_message_success'])
    // Three stalls is one more than the reconnect budget, so the turn survived
    // only because the conversation was asked whether it was still running.
    expect(counts.streams).toBe(4)
    expect(counts.probes).toBe(1)
  }, 30_000)

  it('reopens on a gateway that accepts the connection and never answers', async () => {
    const { server, counts, base } = await dustLike(['no-headers', 'no-headers'])
    running = server

    expect(await follow(base)).toEqual(['agent_message_success'])
    expect(counts.streams).toBe(3)
  }, 30_000)
})
