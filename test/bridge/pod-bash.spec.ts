import { describe, expect, it } from 'vitest'

import type { PodFile } from '../../src/dust/pod-files.ts'
import {
  BASH_RESULT_SEPARATOR,
  MAX_RESULT_CHARS,
  POD_BASH_DIR,
  bashRequestPath,
  bashResultPath,
  formatBashDelivery,
  formatBashResult,
  isPodBashPath,
  pendingRequests,
} from '../../src/bridge/pod-bash.ts'

/** A listing entry, reduced to what the planner reads. */
function listed(path: string, modifiedMs = 0): PodFile {
  return { path, bytes: 0, modifiedMs }
}

describe('where a shell request and its answer live in the pod', () => {
  it('puts a request and its result under one reserved directory', () => {
    expect(bashRequestPath('t1')).toBe(`${POD_BASH_DIR}/t1.sh`)
    expect(bashResultPath('t1')).toBe(`${POD_BASH_DIR}/t1.out`)
  })

  it('names the exchange after opencode', () => {
    expect(POD_BASH_DIR).toBe('oc-bash')
  })

  it('does not dot-prefix the directory, because the listing is the channel', () => {
    // Dust's listing route omits dot-directories entirely — the same fact that
    // sent `pi-skills` to a bare name. Here it is load-bearing rather than
    // cosmetic: the listing is how this side *discovers* that the agent asked
    // for a command at all, so a `.pi-bash/` request would be written, be
    // readable by exact path, and never once be noticed.
    expect(POD_BASH_DIR.startsWith('.')).toBe(false)
  })

  it('recognises its own files, so the sync leaves them alone', () => {
    // Without this the request and result files are files in the pod with no
    // local copy — indistinguishable from "the human deleted them" — so the
    // first sync drops a `pi-bash/` directory into the working tree and the
    // second deletes the request out from under a command that is running.
    expect(isPodBashPath(`${POD_BASH_DIR}/t1.sh`)).toBe(true)
    expect(isPodBashPath(`${POD_BASH_DIR}/t1.out`)).toBe(true)
    expect(isPodBashPath('src/oc-bash/t1.sh')).toBe(false)
    expect(isPodBashPath('src/index.ts')).toBe(false)
  })
})

/** The names of the pending requests, for the cases that only care about those. */
function ids(files: readonly PodFile[], claimed: ReadonlySet<string>): readonly string[] {
  return pendingRequests(files, claimed).map(request => request.id)
}

describe('which requests this side still owes an answer', () => {
  it('finds a script the agent has written', () => {
    expect(ids([listed(`${POD_BASH_DIR}/t1.sh`)], new Set())).toEqual(['t1'])
  })

  it('ignores its own results, which are answers rather than requests', () => {
    expect(ids([listed(`${POD_BASH_DIR}/t1.out`)], new Set())).toEqual([])
  })

  it('ignores anything outside the reserved directory', () => {
    // The pod holds the human's project, and a `scripts/deploy.sh` in it is a
    // file the agent asked to *edit*, not a command it asked to run. Running
    // one would execute the repository on the developer's machine because
    // somebody saved a file.
    expect(ids([listed('scripts/deploy.sh')], new Set())).toEqual([])
  })

  it('never offers the same request twice', () => {
    // The claim is held in memory because the listing is eventually consistent:
    // a request deleted on this side can still appear in the next listing, and
    // running `npm run deploy` a second time because Cloudflare had not caught
    // up is not a recoverable mistake.
    expect(ids([listed(`${POD_BASH_DIR}/t1.sh`)], new Set(['t1']))).toEqual([])
  })

  it('refuses an id that is a path rather than a name', () => {
    // The id is chosen by the model and becomes part of a path this side
    // writes to. `../../etc/x` must not be a request.
    expect(ids(
      [listed(`${POD_BASH_DIR}/../../etc/x.sh`), listed(`${POD_BASH_DIR}/sub/t1.sh`)],
      new Set(),
    )).toEqual([])
  })

  it('runs them in the order they were asked for', () => {
    // The agent writes a script per step and expects step two to see what step
    // one did. Alphabetical order would run `10.sh` before `2.sh`.
    const files = [
      listed(`${POD_BASH_DIR}/b.sh`, 2000),
      listed(`${POD_BASH_DIR}/a.sh`, 3000),
      listed(`${POD_BASH_DIR}/c.sh`, 1000),
    ]

    expect(ids(files, new Set())).toEqual(['c', 'b', 'a'])
  })

  it('finds a batch of tool calls, and says which route it came in on', () => {
    expect(pendingRequests([listed(`${POD_BASH_DIR}/t1.json`)], new Set())).toEqual([
      { id: 't1', kind: 'tools', path: `${POD_BASH_DIR}/t1.json` },
    ])
  })

  it('reports a script as a script', () => {
    expect(pendingRequests([listed(`${POD_BASH_DIR}/t1.sh`)], new Set())).toEqual([
      { id: 't1', kind: 'script', path: `${POD_BASH_DIR}/t1.sh` },
    ])
  })

  it('interleaves the two routes by the order they were asked for', () => {
    // One queue on purpose: a batch that edits a file and a script that runs
    // the suite over it are two steps of one plan, and answering them out of
    // order tests the tree as it was before the edit.
    const files = [
      listed(`${POD_BASH_DIR}/test.sh`, 3000),
      listed(`${POD_BASH_DIR}/edit.json`, 2000),
      listed(`${POD_BASH_DIR}/look.json`, 1000),
    ]

    expect(ids(files, new Set())).toEqual(['look', 'edit', 'test'])
  })

  it('shares one claim set across the two routes', () => {
    // The suffix is not part of the id, so a name taken once is taken for both
    // routes — otherwise `t1.json` could run again as `t1.sh`.
    expect(ids([listed(`${POD_BASH_DIR}/t1.json`)], new Set(['t1']))).toEqual([])
  })

  it('refuses an id that is a path on the tool route too', () => {
    expect(ids([listed(`${POD_BASH_DIR}/../../etc/x.json`)], new Set())).toEqual([])
  })
})

describe('the answer written back into the pod', () => {
  it('says whether the command worked before it says anything else', () => {
    // The agent reads this file top-down and may stop early on a long one, so
    // the verdict cannot be at the bottom.
    const text = formatBashResult({ output: 'ok', isError: false, durationMs: 1200 })

    expect(text.split('\n')[0]).toBe('status: ok')
    expect(text).toContain(BASH_RESULT_SEPARATOR)
    expect(text.endsWith('ok')).toBe(true)
  })

  it('marks a command that failed', () => {
    const text = formatBashResult({ output: 'boom', isError: true, durationMs: 5 })

    expect(text.split('\n')[0]).toBe('status: failed')
  })

  it('reports how long it took, so the agent can pace its next poll', () => {
    expect(formatBashResult({ output: '', isError: false, durationMs: 2500 }))
      .toContain('seconds: 2.5')
  })

  it('keeps both ends of an output too big to send whole', () => {
    // The agent pays for every character of this file in its own context. A
    // build log is mostly progress lines in the middle; what identifies the
    // failure is the command at the top and the error at the bottom.
    const output = `${'A'.repeat(MAX_RESULT_CHARS)}NEEDLE${'B'.repeat(MAX_RESULT_CHARS)}`
    const text = formatBashResult({ output, isError: false, durationMs: 1 })

    expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 2000)
    expect(text).toContain('AAA')
    expect(text).toContain('BBB')
    expect(text).not.toContain('NEEDLE')
    expect(text).toMatch(/cut/i)
  })

  it('leaves a small output exactly as the command printed it', () => {
    // Program output has to stay literal: an agent diffing a test report
    // against the last one cannot be shown an elided copy of it.
    const text = formatBashResult({ output: 'line 1\nline 2\n', isError: false, durationMs: 1 })

    expect(text.split(BASH_RESULT_SEPARATOR)[1]).toBe('\nline 1\nline 2\n')
  })
})

describe('the message the output is delivered in', () => {
  it('names the request, so a turn with two of them is not ambiguous', () => {
    expect(formatBashDelivery('step3', { output: 'ok', isError: false, durationMs: 100 }))
      .toContain('step3')
  })

  it('says it is the command speaking, not the developer', () => {
    // This arrives as a user message because that is the only channel into a
    // settled turn. Unmarked, the agent reads a wall of `ls` output as
    // something the human typed and answers it as a request.
    expect(formatBashDelivery('step3', { output: 'ok', isError: false, durationMs: 100 }))
      .toMatch(/automatic|not the developer|ran on your behalf/i)
  })

  it('carries the verdict and the output the file does', () => {
    const text = formatBashDelivery('step3', {
      output: '2 passed',
      isError: false,
      durationMs: 6700,
    })

    expect(text).toContain('2 passed')
    expect(text).toContain('status: ok')
    expect(text).toContain('seconds: 6.7')
  })

  it('cuts an output too big to send, the same way the file does', () => {
    const output = 'A'.repeat(MAX_RESULT_CHARS * 3)
    const text = formatBashDelivery('step3', { output, isError: false, durationMs: 1 })

    expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 2000)
  })
})
