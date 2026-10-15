import { describe, expect, it, vi } from 'vitest'

import type { PodFile } from '../../src/dust/pod-files.ts'
import { detachedPath } from '../../src/bridge/helper.ts'
import { BridgeManager, type BridgeManagerOptions } from '../../src/bridge/manager.ts'
import type { PodToolCall } from '../../src/bridge/pod-tool-request.ts'
import type { TurnContext } from '../../src/bridge/runner.ts'

/** An in-memory pod, holding only the exchange. */
function fakePod(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  let clock = 0
  const modified = new Map<string, number>()
  for (const path of files.keys()) modified.set(path, clock++)
  return {
    files,
    ops: {
      list: vi.fn(async (): Promise<readonly PodFile[]> =>
        [...files.keys()].map(path => ({ path, bytes: 0, modifiedMs: modified.get(path) ?? 0 }))),
      read: vi.fn(async (path: string) => {
        const body = files.get(path)
        if (body === undefined) throw new Error(`404 ${path}`)
        return body
      }),
      write: vi.fn(async (path: string, contents: string) => {
        files.set(path, contents)
        modified.set(path, clock++)
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path)
      }),
    },
  }
}

/** A sleep that never ends, so no background loop moves unless a test drives it. */
const never = () => new Promise<void>(() => undefined)

function manager(overrides: Partial<BridgeManagerOptions> = {}, pod = fakePod()) {
  const options: BridgeManagerOptions = {
    pod: pod.ops,
    runTool: vi.fn(async () => ({ output: 'ran', isError: false, durationMs: 5 })),
    deliver: vi.fn(async () => undefined),
    wait: never,
    ...overrides,
  }
  return { bridge: new BridgeManager(options), options, pod }
}

const TURN = { agent: 'build', messageID: 'msg_1' }

describe('BridgeManager', () => {
  it('runs a conversation’s request under its session’s turn, and answers beside it', async () => {
    const pod = fakePod({ 'oc-bash/c1/step1.json': '{"calls":[{"tool":"read","arguments":{"filePath":"a.ts"}}]}' })
    const { bridge, options } = manager({}, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    await bridge.poll('ses_1')

    expect(options.runTool).toHaveBeenCalledWith(
      { tool: 'read', arguments: { filePath: 'a.ts' } },
      { sessionID: 'ses_1', ...TURN } satisfies TurnContext,
      expect.any(AbortSignal),
    )
    expect(pod.files.get('oc-bash/c1/step1.out')).toContain('status: ok')
    expect(pod.files.has('oc-bash/c1/step1.json')).toBe(false)
  })

  it('leaves another conversation’s requests alone', async () => {
    const pod = fakePod({ 'oc-bash/c2/step1.sh': 'ls' })
    const { bridge, options } = manager({}, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    await bridge.poll('ses_1')

    expect(options.runTool).not.toHaveBeenCalled()
    expect(pod.files.has('oc-bash/c2/step1.sh')).toBe(true)
  })

  it('runs a script as opencode’s shell tool', async () => {
    const pod = fakePod({ 'oc-bash/c1/step1.sh': 'npm test' })
    const { bridge, options } = manager({}, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    await bridge.poll('ses_1')

    expect(vi.mocked(options.runTool).mock.calls[0]?.[0]).toEqual<PodToolCall>({
      tool: 'shell',
      arguments: { command: 'npm test' },
    })
  })

  it('sends no message while the agent is still waiting for the answer in its sandbox', async () => {
    const pod = fakePod({ 'oc-bash/c1/step1.sh': 'ls' })
    const { bridge, options } = manager({}, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    await bridge.poll('ses_1')

    expect(options.deliver).not.toHaveBeenCalled()
  })

  it('delivers the answer as a message when the helper gave up waiting', async () => {
    const pod = fakePod({
      'oc-bash/c1/step1.sh': 'npm run build',
      [detachedPath('c1', 'step1')]: '',
    })
    const { bridge, options } = manager({}, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    await bridge.poll('ses_1')

    expect(options.deliver).toHaveBeenCalledWith(
      'ses_1',
      expect.stringMatching(/^\[automatic message, not the developer\][\s\S]*oc-bash\/c1\/step1\.sh[\s\S]*ran/),
    )
  })

  it('delivers the answer as a message when the Dust turn already ended', async () => {
    const pod = fakePod({ 'oc-bash/c1/step1.sh': 'ls' })
    let release!: () => void
    const { bridge, options } = manager(
      {
        runTool: vi.fn(async () => {
          await new Promise<void>(resolve => (release = resolve))
          return { output: 'late', isError: false, durationMs: 1 }
        }),
      },
      pod,
    )
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(options.runTool).toHaveBeenCalled())
    bridge.streamEnded('ses_1')
    release()
    await polling

    expect(options.deliver).toHaveBeenCalledWith('ses_1', expect.stringContaining('late'))
  })

  it('kills the running work and delivers nothing when the developer interrupts', async () => {
    const pod = fakePod({ 'oc-bash/c1/step1.sh': 'sleep 100' })
    let seen: AbortSignal | undefined
    const { bridge, options } = manager(
      {
        runTool: vi.fn(async (_call, _turn, signal: AbortSignal) => {
          seen = signal
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve()))
          return { output: 'aborted', isError: true, durationMs: 1 }
        }),
      },
      pod,
    )
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(seen).toBeDefined())
    bridge.streamEnded('ses_1')
    bridge.interrupted('ses_1')
    await polling

    expect(seen?.aborted).toBe(true)
    expect(options.deliver).not.toHaveBeenCalled()
  })

  it('does nothing for a session it has never seen stream', async () => {
    const { bridge, pod } = manager({}, fakePod({ 'oc-bash/c1/step1.sh': 'ls' }))

    await bridge.poll('ses_unknown')

    expect(pod.ops.list).not.toHaveBeenCalled()
  })

  it('keeps watching through the grace window after a turn ends, then stops', async () => {
    const waits: { ms: number; resolve: () => void }[] = []
    const wait = (ms: number) => new Promise<void>(resolve => waits.push({ ms, resolve }))
    const { bridge, pod } = manager({ wait, graceMs: 20_000, intervalMs: 1000 })
    bridge.streamStarted('ses_1', 'c1')
    await vi.waitFor(() => expect(pod.ops.list).toHaveBeenCalledTimes(1))

    bridge.streamEnded('ses_1')
    const grace = waits.find(entry => entry.ms === 20_000)
    expect(grace).toBeDefined()
    grace?.resolve()
    await Promise.resolve()

    expect(bridge.watching('ses_1')).toBe(false)
  })

  it('a new turn inside the grace window keeps the same watch', async () => {
    const waits: { ms: number; resolve: () => void }[] = []
    const wait = (ms: number) => new Promise<void>(resolve => waits.push({ ms, resolve }))
    const { bridge } = manager({ wait, graceMs: 20_000 })
    bridge.streamStarted('ses_1', 'c1')
    bridge.streamEnded('ses_1')
    bridge.streamStarted('ses_1', 'c1')

    waits.find(entry => entry.ms === 20_000)?.resolve()
    await Promise.resolve()

    expect(bridge.watching('ses_1')).toBe(true)
  })
})

describe('BridgeManager through opencode’s own loop', () => {
  /** A Dust stream that turns each call into a tool call, settled by the test. */
  function nativeLoop() {
    const emitted: { id: string; call: PodToolCall }[] = []
    const waiting = new Map<string, (outcome: { output: string; isError: boolean; durationMs: number }) => void>()
    let next = 0
    const sinks = new Map<string, { emit: (call: PodToolCall) => string }>()
    return {
      emitted,
      settle: (id: string, output: string, isError = false) => waiting.get(id)?.({ output, isError, durationMs: 3 }),
      open: (sessionID: string) =>
        sinks.set(sessionID, {
          emit: call => {
            const id = `call_${String(++next)}`
            emitted.push({ id, call })
            return id
          },
        }),
      close: (sessionID: string) => sinks.delete(sessionID),
      native: {
        sink: (sessionID: string) => sinks.get(sessionID),
        result: (id: string) =>
          new Promise<{ output: string; isError: boolean; durationMs: number }>(resolve => waiting.set(id, resolve)),
      },
    }
  }

  it('hands the call to the streaming Dust turn, so opencode runs it with its own card', async () => {
    const loop = nativeLoop()
    const pod = fakePod({ 'oc-bash/c1/step1.json': '{"calls":[{"tool":"edit","arguments":{"path":"a.ts"}}]}' })
    const { bridge, options } = manager({ native: loop.native }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)
    loop.open('ses_1')

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(loop.emitted).toHaveLength(1))
    loop.settle(loop.emitted[0]!.id, 'Edit applied successfully.')
    await polling

    expect(loop.emitted[0]?.call).toEqual({ tool: 'edit', arguments: { path: 'a.ts' } })
    expect(options.runTool).not.toHaveBeenCalled()
    expect(pod.files.get('oc-bash/c1/step1.out')).toContain('Edit applied successfully.')
  })

  it('runs a batch one call at a time, in order', async () => {
    const loop = nativeLoop()
    const pod = fakePod({
      'oc-bash/c1/step1.json': '{"calls":[{"tool":"edit","arguments":{}},{"tool":"shell","arguments":{"command":"npm test"}}]}',
    })
    const { bridge } = manager({ native: loop.native }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)
    loop.open('ses_1')

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(loop.emitted).toHaveLength(1))
    expect(loop.emitted[0]?.call.tool).toBe('edit')
    loop.settle(loop.emitted[0]!.id, 'ok')
    await vi.waitFor(() => expect(loop.emitted).toHaveLength(2))
    loop.settle(loop.emitted[1]!.id, '2 passed')
    await polling

    expect(loop.emitted[1]?.call.tool).toBe('shell')
    expect(pod.files.get('oc-bash/c1/step1.out')).toContain('2 passed')
  })

  it('stops the batch at a call opencode reports failed, as the batch asks', async () => {
    const loop = nativeLoop()
    const pod = fakePod({
      'oc-bash/c1/step1.json': '{"calls":[{"tool":"shell","arguments":{"command":"rm -rf /"}},{"tool":"read","arguments":{}}]}',
    })
    const { bridge } = manager({ native: loop.native }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)
    loop.open('ses_1')

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(loop.emitted).toHaveLength(1))
    loop.settle(loop.emitted[0]!.id, 'The user rejected permission to use this tool', true)
    await polling

    expect(loop.emitted).toHaveLength(1)
    expect(pod.files.get('oc-bash/c1/step1.out')).toMatch(/status: failed[\s\S]*rejected permission/)
  })

  it('sends the call opencode can run, as routed', async () => {
    const loop = nativeLoop()
    const pod = fakePod({ 'oc-bash/c1/step1.json': '{"calls":[{"tool":"opencode_list_mcp_resources","arguments":{}}]}' })
    const route = vi.fn((call: PodToolCall) => ({
      kind: 'native' as const,
      call: { tool: 'execute', arguments: { code: `return await tools.opencode.list_mcp_resources(${JSON.stringify(call.arguments)})` } },
    }))
    const { bridge } = manager({ native: { ...loop.native, route } }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)
    loop.open('ses_1')

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(loop.emitted).toHaveLength(1))
    loop.settle(loop.emitted[0]!.id, '{"resources":[]}')
    await polling

    expect(loop.emitted[0]?.call).toEqual({
      tool: 'execute',
      arguments: { code: 'return await tools.opencode.list_mcp_resources({})' },
    })
  })

  it('runs here a call opencode’s loop cannot carry', async () => {
    const loop = nativeLoop()
    const pod = fakePod({ 'oc-bash/c1/step1.json': '{"calls":[{"tool":"opencode_list_mcp_resources","arguments":{}}]}' })
    const route = vi.fn((call: PodToolCall) => ({ kind: 'local' as const, call }))
    const { bridge, options } = manager({ native: { ...loop.native, route } }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)
    loop.open('ses_1')

    await bridge.poll('ses_1')

    expect(loop.emitted).toHaveLength(0)
    expect(vi.mocked(options.runTool).mock.calls[0]?.[0]).toEqual({ tool: 'opencode_list_mcp_resources', arguments: {} })
  })

  it('runs the call itself when no Dust turn is streaming to carry it', async () => {
    const loop = nativeLoop()
    const pod = fakePod({ 'oc-bash/c1/step1.sh': 'ls' })
    const { bridge, options } = manager({ native: loop.native }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)

    await bridge.poll('ses_1')

    expect(loop.emitted).toHaveLength(0)
    expect(options.runTool).toHaveBeenCalled()
  })

  it('answers a call left waiting when the developer interrupts', async () => {
    const loop = nativeLoop()
    const pod = fakePod({ 'oc-bash/c1/step1.sh': 'sleep 100' })
    const { bridge, options } = manager({ native: loop.native }, pod)
    bridge.streamStarted('ses_1', 'c1')
    bridge.stepStarted('ses_1', TURN)
    loop.open('ses_1')

    const polling = bridge.poll('ses_1')
    await vi.waitFor(() => expect(loop.emitted).toHaveLength(1))
    bridge.interrupted('ses_1')
    await polling

    expect(pod.files.get('oc-bash/c1/step1.out')).toMatch(/status: failed[\s\S]*interrupted/)
    expect(options.deliver).not.toHaveBeenCalled()
  })
})
