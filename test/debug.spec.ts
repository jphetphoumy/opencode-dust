import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { debug, describeError } from '../src/debug.ts'

describe('debug', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-dust-log-'))

  afterEach(() => {
    process.env['OPENCODE_DUST_LOG'] = 'off'
  })

  it('appends one JSON line per event', () => {
    const path = join(dir, 'nested', 'debug.log')
    process.env['OPENCODE_DUST_LOG'] = path

    debug('bridge.connected', { spaceId: 'vlt_1' })
    debug('hook', { bridged: false })

    const lines = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toMatchObject([
      { event: 'bridge.connected', spaceId: 'vlt_1' },
      { event: 'hook', bridged: false },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes nothing, and never throws, when disabled or unwritable', () => {
    process.env['OPENCODE_DUST_LOG'] = 'off'
    expect(() => debug('x')).not.toThrow()
    const file = join(mkdtempSync(join(tmpdir(), 'oc-dust-file-')), 'a-file')
    writeFileSync(file, '')
    process.env['OPENCODE_DUST_LOG'] = join(file, 'under-a-file.log')
    expect(() => debug('x')).not.toThrow()
  })

  it('describes errors by name and message', () => {
    expect(describeError(new TypeError('boom'))).toBe('TypeError: boom')
    expect(describeError('plain')).toBe('plain')
  })
})
