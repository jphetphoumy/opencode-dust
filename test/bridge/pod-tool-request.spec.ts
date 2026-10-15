import { describe, expect, it } from 'vitest'

import { MAX_RESULT_CHARS } from '../../src/bridge/pod-bash.ts'
import {
  callBudget,
  describeToolRequest,
  formatToolBatchResult,
  MAX_BATCH_CALLS,
  MIN_CALL_CHARS,
  parseToolRequest,
  toolSignatures,
  type PodToolOutcome,
} from '../../src/bridge/pod-tool-request.ts'

/** One finished call, reduced to what the formatter reads. */
function outcome(overrides: Partial<PodToolOutcome> = {}): PodToolOutcome {
  return {
    tool: 'read',
    arguments: { path: 'src/a.ts' },
    output: 'contents',
    isError: false,
    durationMs: 100,
    ...overrides,
  }
}

/** The calls a parse produced, for the cases that only care about those. */
function calls(text: string): readonly { tool: string; arguments: Record<string, unknown> }[] {
  const parsed = parseToolRequest(text)
  if (!parsed.ok) throw new Error(`expected a batch, got: ${parsed.error}`)
  return parsed.request.calls
}

/** Why a parse refused, for the cases that are about the message. */
function refusal(text: string): string {
  const parsed = parseToolRequest(text)
  if (parsed.ok) throw new Error('expected a refusal')
  return parsed.error
}

describe('reading the batch of tool calls an agent left in the pod', () => {
  it('reads the documented shape', () => {
    expect(calls('{"calls":[{"tool":"read","arguments":{"path":"src/a.ts"}}]}')).toEqual([
      { tool: 'read', arguments: { path: 'src/a.ts' } },
    ])
  })

  it('accepts a bare array, the note\'s shape without its wrapper', () => {
    expect(calls('[{"tool":"ls","arguments":{}}]')).toEqual([{ tool: 'ls', arguments: {} }])
  })

  it('accepts a lone call object as a batch of one', () => {
    // Nothing validates this file before it is written. A model that omits the
    // wrapper has still said exactly what it wants, and refusing would cost a
    // round-trip to be told about a pair of brackets.
    expect(calls('{"tool":"ls","arguments":{}}')).toEqual([{ tool: 'ls', arguments: {} }])
  })

  it('accepts the argument keys a model actually reaches for', () => {
    // `args`, `input` and `parameters` are all names the model has seen in tool
    // schemas, and there is no schema here to correct it.
    for (const key of ['arguments', 'args', 'input', 'parameters']) {
      expect(calls(`[{"tool":"read","${key}":{"path":"a"}}]`)).toEqual([
        { tool: 'read', arguments: { path: 'a' } },
      ])
    }
  })

  it('accepts `name` as well as `tool`', () => {
    expect(calls('[{"name":"ls","arguments":{}}]')).toEqual([{ tool: 'ls', arguments: {} }])
  })

  it('treats missing arguments as none, rather than as a mistake', () => {
    expect(calls('[{"tool":"ls"}]')).toEqual([{ tool: 'ls', arguments: {} }])
  })

  it('stops on the first failure unless asked not to', () => {
    const parsed = parseToolRequest('{"calls":[{"tool":"ls"}]}')
    expect(parsed.ok && parsed.request.onError).toBe('stop')
  })

  it('carries a continue-on-error batch through', () => {
    const parsed = parseToolRequest('{"onError":"continue","calls":[{"tool":"ls"}]}')
    expect(parsed.ok && parsed.request.onError).toBe('continue')
  })

  it('keeps the JSON parser\'s own complaint, which is the useful sentence', () => {
    // "Unexpected token } at position 23" is the one thing that locates the
    // typo. A tidier "invalid JSON" costs the agent a round-trip to rediscover
    // what this already knew.
    const error = refusal('{"calls":[{"tool":"ls"},]}')
    expect(error).toMatch(/not valid JSON/i)
    expect(error).toMatch(/position|token|JSON at/i)
  })

  it('says which call is wrong, not merely that one is', () => {
    // The agent gets one message and has to fix the file from it.
    expect(refusal('[{"tool":"ls"},{"arguments":{}}]')).toMatch(/call 2/)
  })

  it('refuses a call with no tool name rather than guessing one', () => {
    expect(refusal('[{"arguments":{"path":"a"}}]')).toMatch(/no tool name/i)
  })

  it('refuses arguments that are not an object, naming the tool', () => {
    // Passed through, a string where named arguments belong fails inside the
    // tool with a message about a property, which reads as the tool being
    // broken rather than the call being malformed.
    const error = refusal('[{"tool":"read","arguments":"src/a.ts"}]')
    expect(error).toMatch(/read/)
    expect(error).toMatch(/object of named arguments/i)
  })

  it('refuses an empty batch, which would answer with nothing at all', () => {
    expect(refusal('{"calls":[]}')).toMatch(/no calls/i)
  })

  it('refuses JSON that is not a batch in any reading', () => {
    expect(refusal('"just a string"')).toMatch(/not a batch/i)
    expect(refusal('42')).toMatch(/not a batch/i)
  })

  it('refuses a batch too large to run unsupervised, and says to split it', () => {
    const many = JSON.stringify({
      calls: Array.from({ length: MAX_BATCH_CALLS + 1 }, () => ({ tool: 'ls' })),
    })

    const error = refusal(many)
    expect(error).toMatch(new RegExp(String(MAX_BATCH_CALLS)))
    expect(error).toMatch(/split/i)
  })

  it('allows a batch exactly at the limit', () => {
    const many = JSON.stringify({
      calls: Array.from({ length: MAX_BATCH_CALLS }, () => ({ tool: 'ls' })),
    })

    expect(calls(many)).toHaveLength(MAX_BATCH_CALLS)
  })
})

describe('sharing the output budget between the calls in a batch', () => {
  it('gives a single call the whole allowance, so one call behaves as it always did', () => {
    expect(callBudget(1)).toBe(MAX_RESULT_CHARS)
  })

  it('divides the allowance, so one huge read cannot starve the calls behind it', () => {
    expect(callBudget(4)).toBe(MAX_RESULT_CHARS / 4)
  })

  it('never falls below a floor, because a truncated stub costs the round-trip it saved', () => {
    expect(callBudget(1000)).toBe(MIN_CALL_CHARS)
  })
})

describe('the answer a batch writes back into the pod', () => {
  it('opens with the same status line the shell route uses', () => {
    // One shape to learn. An agent that has read a `.sh` answer can read this.
    expect(formatToolBatchResult([outcome()], 1)).toMatch(/^status: ok\n/)
  })

  it('reports failure when any call in the batch failed', () => {
    expect(formatToolBatchResult([outcome({ isError: true })], 1)).toMatch(/^status: failed/)
  })

  it('counts what was asked for against what ran', () => {
    expect(formatToolBatchResult([outcome(), outcome({ isError: true })], 3))
      .toContain('calls: 3 asked, 2 ran, 1 failed')
  })

  it('marks each call, so the agent can tell which output came from which', () => {
    const text = formatToolBatchResult(
      [outcome({ tool: 'read' }), outcome({ tool: 'edit', output: 'edited' })],
      2,
    )

    expect(text).toContain('=== call 1 read ok')
    expect(text).toContain('=== call 2 edit ok')
    expect(text).toContain('edited')
  })

  it('shows the arguments each call ran with', () => {
    // The agent wrote them, but it wrote them a round-trip ago, and a `read`
    // that returned nothing is a different problem depending on the path.
    expect(formatToolBatchResult([outcome({ arguments: { path: 'src/b.ts' } })], 1))
      .toContain('args: {"path":"src/b.ts"}')
  })

  it('says outright that the calls it never reached did not run', () => {
    // Left unmentioned they read as calls that ran and printed nothing, which
    // is the one misreading that has the agent carry on believing its edits
    // landed.
    const text = formatToolBatchResult([outcome({ isError: true })], 3)
    expect(text).toContain('=== call 2 not run')
    expect(text).toContain('=== call 3 not run')
  })

  it('keeps a call\'s output literal, so a diff against the last one still works', () => {
    expect(formatToolBatchResult([outcome({ output: '  spaced\n\n' })], 1))
      .toContain('  spaced\n\n')
  })

  it('trims a call that would spend the whole batch\'s allowance', () => {
    const text = formatToolBatchResult(
      [outcome({ output: 'x'.repeat(MAX_RESULT_CHARS * 2) }), outcome()],
      2,
    )

    expect(text).toContain('characters cut from the middle')
    // The call behind it still got its own output through, which is the whole
    // point of sharing the budget rather than spending it first-come.
    expect(text).toContain('=== call 2 read ok')
  })
})

describe('showing the human what a request is about to do', () => {
  it('writes each call the way Pi writes its own cards', () => {
    // The gap a live run exposed: the transcript said `Created
    // oc-bash/step1.json (application/json, 1 KB)` and nothing else, at the one
    // moment the developer could have seen what was about to touch their files.
    // A queued `edit` is the same act as an `edit`, so it reads the same way —
    // not as a tool name beside a blob of JSON.
    expect(describeToolRequest(JSON.stringify({
      calls: [
        { tool: 'read', arguments: { path: 'a.ts' } },
        { tool: 'edit', arguments: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } },
      ],
    }))).toBe('1. read a.ts\n2. edit a.ts')
  })

  it('shows a queued command as a command prompt, as the bash card does', () => {
    expect(describeToolRequest('[{"tool":"bash","arguments":{"command":"npm test"}}]'))
      .toBe('1. $ npm test')
  })

  it('names a call that carries nothing to show beside it', () => {
    expect(describeToolRequest('[{"tool":"ls"}]')).toBe('1. ls')
  })

  it('leads a search with what it looked for, as the card does', () => {
    expect(describeToolRequest('[{"tool":"grep","arguments":{"pattern":"TODO","path":"src"}}]'))
      .toBe('1. grep TODO')
  })

  it('says when a batch will carry on past a failure, since that is the exception', () => {
    expect(describeToolRequest('{"onError":"continue","calls":[{"tool":"ls"}]}'))
      .toContain('(continues past a failure)')
  })

  it('stays quiet about the default, which would be noise on every batch', () => {
    // Stop-on-failure is what almost every batch does; a line saying so on all
    // of them buries the one batch that behaves differently.
    expect(describeToolRequest('[{"tool":"ls"}]')).not.toMatch(/continues|failure/)
  })

  it('shows a malformed request exactly as the agent wrote it', () => {
    // A parse error here would hide the one thing worth looking at. The point is
    // to see what was asked for, not to grade it.
    expect(describeToolRequest('{ not json at all ')).toBe('{ not json at all')
  })
})

describe('telling the agent which tools the batch route can reach', () => {
  it('names each tool with its argument names', () => {
    expect(toolSignatures([
      {
        name: 'read',
        parameters: {
          properties: { path: {}, offset: {} },
          required: ['path'],
        },
      },
    ])).toEqual(['read(path, offset?)'])
  })

  it('marks the optional arguments, because a required one omitted fails inside the tool', () => {
    expect(toolSignatures([
      { name: 'grep', parameters: { properties: { pattern: {}, path: {} }, required: ['pattern'] } },
    ])).toEqual(['grep(pattern, path?)'])
  })

  it('handles a tool that takes nothing', () => {
    expect(toolSignatures([{ name: 'ls' }])).toEqual(['ls()'])
  })

  it('shows the element shape of an array argument', () => {
    // The case a live run failed on. Given only `edit(path, edits)` the agent
    // invented `replaceAll: true` — a field Pi's `edit` does not have — the call
    // failed on the uniqueness rule, and it fell back to `sed -i` in a script.
    // That is the round-trip the batch route exists to save.
    expect(toolSignatures([
      {
        name: 'edit',
        parameters: {
          properties: {
            path: {},
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: { oldText: {}, newText: {} },
                required: ['oldText', 'newText'],
              },
            },
          },
          required: ['path', 'edits'],
        },
      },
    ])).toEqual(['edit(path, edits[{oldText, newText}])'])
  })

  it('marks an array of scalars without inventing a shape for it', () => {
    expect(toolSignatures([
      { name: 'many', parameters: { properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } },
    ])).toEqual(['many(paths[])'])
  })

  it('shows a nested object argument', () => {
    expect(toolSignatures([
      {
        name: 'cfg',
        parameters: {
          properties: { opts: { properties: { deep: {} }, required: ['deep'] } },
          required: ['opts'],
        },
      },
    ])).toEqual(['cfg(opts{deep})'])
  })

  it('keeps the optional marker on the name, not after the shape', () => {
    // `edits?[{...}]` reads as a shape that is itself optional; the `?` belongs
    // to the argument.
    expect(toolSignatures([
      {
        name: 'edit',
        parameters: {
          properties: { edits: { type: 'array', items: { properties: { a: {} } } } },
        },
      },
    ])).toEqual(['edit(edits?[{a?}])'])
  })

  it('survives a schema shaped in none of the expected ways', () => {
    // These come from live tool definitions. A note that throws takes the whole
    // turn's system prompt with it.
    expect(toolSignatures([{ name: 'odd', parameters: 'not a schema' }])).toEqual(['odd()'])
  })
})
