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

  it('asks for a fresh name per request', () => {
    expect(note).toMatch(/never used/i)
  })
})
