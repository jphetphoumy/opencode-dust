import { describe, expect, it } from 'vitest'

import { codeModeCatalog } from '../../src/bridge/connect.ts'

const catalog = (line: string) => `# Code Mode\n\nUse execute.\n\n## Available tools\n${line}\n\n# Environment\ncwd: /x`

describe('codeModeCatalog', () => {
  it('reads the catalog from the system prompt, up to the next section', () => {
    expect(codeModeCatalog({ system: [{ type: 'text', text: catalog('- opencode (2 tools)') }] })).toBe(
      '## Available tools\n- opencode (2 tools)',
    )
  })

  it('reads it from a system message in the history too', () => {
    const found = codeModeCatalog({
      system: [{ type: 'text', text: 'You are opencode.' }],
      messages: [{ role: 'system', content: [{ type: 'text', text: catalog('- browser (40 tools, 0 shown)') }] }],
    })

    expect(found).toContain('- browser (40 tools, 0 shown)')
  })

  it('takes the latest catalog, which supersedes the ones before it', () => {
    const found = codeModeCatalog({
      system: [{ type: 'text', text: catalog('- old (1 tool)') }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        {
          role: 'system',
          content: [{ type: 'text', text: `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n${catalog('- new (3 tools)')}` }],
        },
      ],
    })

    expect(found).toContain('- new (3 tools)')
    expect(found).not.toContain('- old')
  })

  it('finds nothing when the session has no code mode', () => {
    expect(codeModeCatalog({ system: [{ type: 'text', text: 'You are opencode.' }] })).toBeUndefined()
  })
})
