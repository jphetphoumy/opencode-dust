import { describe, expect, it, vi } from 'vitest'

import { createToolRunner, type RunnableTool, type TurnContext } from '../../src/bridge/runner.ts'

const TURN: TurnContext = { sessionID: 'ses_1', agent: 'build', messageID: 'msg_1' }

function tool(id: string, execute: RunnableTool['execute']): RunnableTool {
  return { id, execute }
}

function runner(tools: readonly RunnableTool[], clock: () => number = Date.now) {
  const run = createToolRunner({ tools: async () => tools, now: clock })
  return (call: Parameters<typeof run>[0], turn: TurnContext | undefined = TURN, signal = new AbortController().signal) =>
    run(call, turn, signal)
}

describe('createToolRunner', () => {
  it('runs opencode’s own tool under the current turn, so its permission check applies', async () => {
    const execute = vi.fn(async () => ({ content: 'file body' }))
    const run = runner([tool('read', execute)])

    const outcome = await run({ tool: 'read', arguments: { filePath: 'a.ts' } })

    expect(outcome).toMatchObject({ output: 'file body', isError: false })
    expect(execute).toHaveBeenCalledWith(
      { filePath: 'a.ts' },
      expect.objectContaining({
        sessionID: 'ses_1',
        agent: 'build',
        messageID: 'msg_1',
        id: expect.stringMatching(/^dust-bridge-/),
        signal: expect.any(AbortSignal),
        progress: expect.any(Function),
      }),
    )
  })

  it('hands the tool the signal that cancels the call', async () => {
    let seen: AbortSignal | undefined
    const run = runner([
      tool('shell', async (_input, context) => {
        seen = context.signal
        return { content: '' }
      }),
    ])
    const controller = new AbortController()

    await run({ tool: 'shell', arguments: { command: 'ls' } }, TURN, controller.signal)

    expect(seen).toBe(controller.signal)
  })

  it('gives every call its own id', async () => {
    const ids: string[] = []
    const run = runner([
      tool('read', async (_input, context) => {
        ids.push(context.id)
        return { content: '' }
      }),
    ])

    await run({ tool: 'read', arguments: {} })
    await run({ tool: 'read', arguments: {} })

    expect(new Set(ids).size).toBe(2)
  })

  it('answers bash with opencode’s shell tool, the name the agent knows it by elsewhere', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }))
    const run = runner([tool('shell', execute)])

    await run({ tool: 'bash', arguments: { command: 'ls' } })

    expect(execute).toHaveBeenCalledWith({ command: 'ls' }, expect.anything())
  })

  it('joins text content and names the files it cannot inline', async () => {
    const run = runner([
      tool('read', async () => ({
        content: [
          { type: 'text', text: 'one' },
          { type: 'file', uri: 'file:///x.png', mime: 'image/png', name: 'x.png' },
          { type: 'text', text: 'two' },
        ],
      })),
    ])

    expect((await run({ tool: 'read', arguments: {} })).output).toBe('one\n[file x.png]\ntwo')
  })

  it('falls back to the structured output when a tool returns no content', async () => {
    const run = runner([tool('glob', async () => ({ output: { files: ['a.ts'] } }))])

    expect((await run({ tool: 'glob', arguments: {} })).output).toBe('{"files":["a.ts"]}')
  })

  it('reports a failing tool as an error carrying its message', async () => {
    const run = runner([
      tool('shell', async () => {
        throw Object.assign(new Error('Permission denied by the developer'), { _tag: 'Tool.Error' })
      }),
    ])

    expect(await run({ tool: 'shell', arguments: { command: 'rm -rf /' } })).toMatchObject({
      isError: true,
      output: expect.stringContaining('Permission denied by the developer'),
    })
  })

  it('names the tools that exist when asked for one that does not', async () => {
    const run = runner([tool('read', async () => ({})), tool('edit', async () => ({}))])

    const outcome = await run({ tool: 'patchy', arguments: {} })

    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('patchy')
    expect(outcome.output).toContain('read, edit')
  })

  it('refuses to run outside an opencode turn, which has no permission context', async () => {
    const execute = vi.fn(async () => ({}))
    const run = createToolRunner({ tools: async () => [tool('read', execute)] })

    expect((await run({ tool: 'read', arguments: {} }, undefined, new AbortController().signal)).isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })

  it('times the call', async () => {
    let now = 1000
    const run = runner(
      [
        tool('read', async () => {
          now += 250
          return { content: '' }
        }),
      ],
      () => now,
    )

    expect((await run({ tool: 'read', arguments: {} })).durationMs).toBe(250)
  })
})
