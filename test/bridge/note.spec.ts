import { describe, expect, it } from 'vitest'

import { bridgeNote } from '../../src/bridge/note.ts'

const TOOLS = ['read(filePath, offset?, limit?)', 'shell(command, workdir?, timeout?)']

describe('bridgeNote', () => {
  const note = bridgeNote(TOOLS)

  it('tells the agent the project is on the developer’s machine, not in its sandbox', () => {
    expect(note).toMatch(/developer's machine/)
    expect(note).toMatch(/not in `\/files\/pod`/)
  })

  it('gives the one command that runs work there, with the timeout it needs', () => {
    expect(note).toContain('bash /files/pod/oc-tools/oc.sh <name>')
    expect(note).toContain('timeoutMs: 120000')
  })

  it('lists the developer’s tools with their argument names', () => {
    for (const signature of TOOLS) expect(note).toContain(signature)
  })

  it('shows a batch and a shell call in the exact request shape', () => {
    expect(note).toContain('{"calls":[')
    expect(note).toContain('{"tool":"shell","arguments":{"command":')
  })

  it('asks for a whole step per request, because that is where the saving is', () => {
    expect(note).toMatch(/whole step/i)
  })

  it('says what to do when the helper reports the work is still running', () => {
    expect(note).toMatch(/still running/i)
    expect(note).toMatch(/end your turn/i)
  })

  it('keeps the sandbox for scratch work, which costs nothing', () => {
    expect(note).toMatch(/scratch/i)
  })

  it('says a script needs --sh, and that the request is never a prompt', () => {
    expect(note).toContain('--sh')
    expect(note).toMatch(/not a prompt/i)
  })

  it('asks for a fresh name per request', () => {
    expect(note).toMatch(/never used/i)
  })

  it('says the sandbox `bash` comes with the Computer skill, to enable first when missing', () => {
    expect(note).toMatch(/Computer/)
    expect(note).toMatch(/enable_skill/)
  })

  it('says the pod’s own file tools see only the exchange, never the project', () => {
    expect(note).toMatch(/pod's own file tools/i)
    expect(note).toMatch(/never the project/i)
  })

  it('says to run the helper, not read it', () => {
    expect(note).toMatch(/do not read the helper/i)
  })
})

describe('bridgeNote layout', () => {
  it('keeps its paragraphs apart, so the agent reads them as separate rules', () => {
    const note = bridgeNote(TOOLS, { catalog: '## Available tools\n- opencode (2 tools)' })

    expect(note).toContain('in the same call.\n\nThat `bash` tool')
    expect(note).toContain('run it.\n\nA request is a batch')
    expect(note).toContain('refused unread.\n\nEach request costs')
    expect(note).toContain('project\'s files.\n\nOther tools')
    expect(note).toContain('do not guess tool names.\n\n## Available tools')
  })
})

describe('bridgeNote with opencode’s code mode', () => {
  const CATALOG = [
    '## Available tools',
    '- opencode (2 tools)',
    '  - tools.opencode.list_mcp_resources({ server?: string })',
    '- browser (40 tools, 0 shown)',
  ].join('\n')

  it('hands the agent the session’s own code-mode catalog, not a guess at it', () => {
    const note = bridgeNote(TOOLS, { catalog: CATALOG })

    expect(note).toContain('tools.opencode.list_mcp_resources({ server?: string })')
    expect(note).toContain('- browser (40 tools, 0 shown)')
  })

  it('shows how to reach a code-mode tool through execute, and to search before guessing', () => {
    const note = bridgeNote(TOOLS, { catalog: CATALOG })

    expect(note).toContain('{"tool":"execute","arguments":{"code":"return await tools.')
    expect(note).toMatch(/search\(/)
    expect(note).toMatch(/do not guess/i)
  })

  it('says nothing of code mode when the session offers none', () => {
    expect(bridgeNote(TOOLS)).not.toContain('execute')
  })
})
