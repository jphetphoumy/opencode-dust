import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HELPER_PATH, SANDBOX_POD_ROOT, detachedPath, exchangeDir, helperScript } from '../../src/bridge/helper.ts'
import { POD_BASH_DIR } from '../../src/bridge/pod-bash.ts'

let pod: string

beforeEach(() => {
  pod = mkdtempSync(join(tmpdir(), 'oc-pod-'))
  mkdirSync(join(pod, 'oc-tools'))
  writeFileSync(join(pod, HELPER_PATH), helperScript())
})

afterEach(() => {
  rmSync(pod, { recursive: true, force: true })
})

/** Run the helper the way the agent does, with the pod mounted at a temp dir. */
function run(args: readonly string[], stdin: string, wait = 2, onSpawn?: () => void) {
  return new Promise<{ code: number | null; stdout: string }>(resolve => {
    const child = spawn('bash', [join(pod, HELPER_PATH), ...args], {
      env: { ...process.env, OC_POD_ROOT: pod, OC_WAIT: String(wait), OC_CONVERSATION: 'conv1' },
    })
    let stdout = ''
    child.stdout.on('data', chunk => (stdout += String(chunk)))
    child.stderr.on('data', chunk => (stdout += String(chunk)))
    child.on('close', code => resolve({ code, stdout }))
    child.stdin.end(stdin)
    onSpawn?.()
  })
}

const exchange = (name: string) => join(pod, exchangeDir('conv1'), name)

describe('the helper the agent runs from its sandbox', () => {
  it('lives outside the exchange, under the sandbox pod mount', () => {
    expect(HELPER_PATH.startsWith(`${POD_BASH_DIR}/`)).toBe(false)
    expect(HELPER_PATH.startsWith('.')).toBe(false)
    expect(SANDBOX_POD_ROOT).toBe('/files/pod')
  })

  it('leaves a batch as a .json request and prints the answer once it lands', async () => {
    const result = await run(['step1'], '{"calls":[{"tool":"read","arguments":{"filePath":"a.ts"}}]}', 5, () => {
      setTimeout(() => {
        writeFileSync(exchange('step1.out'), 'status: ok\nseconds: 0.1\n---\nhello\n')
      }, 700)
    })

    expect(readFileSync(exchange('step1.json'), 'utf8')).toContain('"tool":"read"')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('status: ok')
    expect(result.stdout).toContain('hello')
  })

  it('leaves anything that is not JSON as a .sh script', async () => {
    const pending = run(['step2'], 'npm test\n', 1)

    await pending
    expect(readFileSync(exchange('step2.sh'), 'utf8')).toBe('npm test\n')
  })

  it('marks the request detached and says so when the answer takes too long', async () => {
    const result = await run(['step3'], 'sleep 600\n', 1)

    expect(result.code).toBe(0)
    expect(existsSync(join(pod, detachedPath('conv1', 'step3')))).toBe(true)
    expect(result.stdout).toMatch(/still running/i)
    expect(result.stdout).toMatch(/end your turn/i)
  })

  it('keeps each conversation’s requests apart, so two sessions can both use step1', () => {
    expect(exchangeDir('conv1')).toBe(`${POD_BASH_DIR}/conv1`)
    expect(detachedPath('conv1', 'step1')).toBe(`${POD_BASH_DIR}/conv1/step1.detached`)
  })

  it('finds its conversation from the sandbox’s conversation mount', () => {
    expect(helperScript()).toContain('readlink /files/conversation')
  })

  it('refuses a name that was used before, rather than reading a stale answer', async () => {
    mkdirSync(join(pod, exchangeDir('conv1')), { recursive: true })
    writeFileSync(exchange('step4.out'), 'status: ok\n---\nold\n')

    const result = await run(['step4'], 'ls\n', 1)

    expect(result.code).not.toBe(0)
    expect(result.stdout).toMatch(/already used/i)
    expect(existsSync(exchange('step4.sh'))).toBe(false)
  })

  it('refuses a name the watcher would ignore', async () => {
    const result = await run(['../escape'], 'ls\n', 1)

    expect(result.code).not.toBe(0)
    expect(existsSync(join(pod, 'escape.sh'))).toBe(false)
  })

  it('refuses an empty request', async () => {
    const result = await run(['step5'], '   \n', 1)

    expect(result.code).not.toBe(0)
    expect(existsSync(exchange('step5.sh'))).toBe(false)
  })
})
