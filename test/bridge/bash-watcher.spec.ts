import { describe, expect, it, vi } from 'vitest'

import type { PodFile } from '../../src/dust/pod-files.ts'
import {
  PodBashWatcher,
  type PodBashRun,
  type PodBashWatcherOptions,
} from '../../src/bridge/bash-watcher.ts'
import { POD_BASH_DIR } from '../../src/bridge/pod-bash.ts'
import type { PodToolCall } from '../../src/bridge/pod-tool-request.ts'

/** A listing entry, reduced to what the watcher reads. */
function listed(path: string, modifiedMs = 0): PodFile {
  return { path, bytes: 0, modifiedMs }
}

/** A finished command, as the tool host reports one. */
function ran(output: string, isError = false): PodBashRun {
  return { output, isError, durationMs: 1 }
}

/**
 * A script, as the watcher now asks for one.
 *
 * Both routes arrive at `run` as a tool call, so a `.sh` request reaches it as
 * opencode's `shell` tool with a `command` — one choke point, where opencode's
 * own permission check sits, rather than two the agent can choose between.
 */
function shell(command: string): PodToolCall {
  return { tool: 'shell', arguments: { command } }
}

/** Everything the watcher touches, stubbed, with sensible defaults. */
function harness(overrides: Partial<PodBashWatcherOptions> = {}): {
  readonly watcher: PodBashWatcher
  readonly options: {
    [K in keyof PodBashWatcherOptions]-?: ReturnType<typeof vi.fn>
  }
} {
  const options = {
    list: vi.fn(async () => [] as readonly PodFile[]),
    read: vi.fn(async () => 'npm test'),
    write: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    run: vi.fn(async () => ran('all good')),
    gate: vi.fn(async () => ({ allowed: true })),
    wait: vi.fn(async () => undefined),
    onRequest: vi.fn(),
    onDone: vi.fn(),
    onRan: vi.fn(),
    onWarn: vi.fn(),
    intervalMs: vi.fn(),
  }

  const watcher = new PodBashWatcher({
    list: options.list as never,
    read: options.read as never,
    write: options.write as never,
    remove: options.remove as never,
    run: options.run as never,
    gate: options.gate as never,
    wait: options.wait as never,
    onRequest: options.onRequest as never,
    onDone: options.onDone as never,
    onRan: options.onRan as never,
    onWarn: options.onWarn as never,
    ...overrides,
  })

  return { watcher, options }
}

describe('answering a batch of tool calls the agent left in the pod', () => {
  it('runs each call and writes all of their output back as one answer', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue(JSON.stringify({
      calls: [
        { tool: 'read', arguments: { path: 'src/a.ts' } },
        { tool: 'grep', arguments: { pattern: 'TODO' } },
      ],
    }))
    options.run
      .mockResolvedValueOnce(ran('the file'))
      .mockResolvedValueOnce(ran('one match'))

    await watcher.pollOnce()

    expect(options.run).toHaveBeenNthCalledWith(1, {
      tool: 'read',
      arguments: { path: 'src/a.ts' },
    })
    expect(options.run).toHaveBeenNthCalledWith(2, {
      tool: 'grep',
      arguments: { pattern: 'TODO' },
    })
    const [path, contents] = options.write.mock.calls[0] as [string, string]
    // The same `.out` the shell route uses: one convention, and the
    // stale-answer clearing already knows about it.
    expect(path).toBe(`${POD_BASH_DIR}/t1.out`)
    expect(contents).toContain('the file')
    expect(contents).toContain('one match')
  })

  it('stops at the first failed call, so a later edit cannot run on a bad read', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue(JSON.stringify({
      calls: [{ tool: 'read', arguments: {} }, { tool: 'edit', arguments: {} }],
    }))
    options.run.mockResolvedValueOnce(ran('no such file', true))

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
    const [, contents] = options.write.mock.calls[0] as [string, string]
    expect(contents).toContain('=== call 2 not run')
  })

  it('runs the whole batch when the agent asked it to continue past a failure', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue(JSON.stringify({
      onError: 'continue',
      calls: [{ tool: 'read', arguments: {} }, { tool: 'ls', arguments: {} }],
    }))
    options.run.mockResolvedValueOnce(ran('no such file', true))

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(2)
  })

  it('answers a request that will not parse with the reason, not with silence', async () => {
    // The agent has ended its turn and is waiting on a message. "call 2 has
    // `arguments` as a string" is something it can fix; nothing is not.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('{ not json')

    await watcher.pollOnce()

    expect(options.run).not.toHaveBeenCalled()
    const [, contents] = options.write.mock.calls[0] as [string, string]
    expect(contents).toContain('status: failed')
    expect(contents).toMatch(/not valid JSON/i)
    expect(options.onDone).toHaveBeenCalledWith('t1', 'batch', expect.stringContaining('failed'))
  })

  it('reports a batch as a batch, so the delivery names the right path', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"ls"}]')

    await watcher.pollOnce()

    expect(options.onDone).toHaveBeenCalledWith('t1', 'batch', expect.any(String))
  })

  it('takes the request away before the first call runs', async () => {
    // Same reason as the shell route: a batch can take minutes and the poll
    // comes round every second, so a request still in the pod is one a
    // restarted process would run again.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"ls"}]')
    options.run.mockImplementation(async () => {
      expect(options.remove).toHaveBeenCalledWith(`${POD_BASH_DIR}/t1.json`)
      return ran('done')
    })

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
  })

  it('announces the request before running any of it', async () => {
    // The agent writes the request with Dust's own file tool, so all the human
    // has been shown is `Created oc-bash/step1.json (application/json, 1 KB)`.
    // This is the only moment they can see what is queued.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"ls"}]')
    options.run.mockImplementation(async () => {
      expect(options.onRequest).toHaveBeenCalledWith('t1', 'tools', '[{"tool":"ls"}]')
      return ran('done')
    })

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
  })

  it('announces a script as a script, with its source', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockResolvedValue('npm test')

    await watcher.pollOnce()

    expect(options.onRequest).toHaveBeenCalledWith('t1', 'script', 'npm test')
  })

  it('says nothing about a request it could not read', async () => {
    // There is no plan to show, and an empty announcement would read as a
    // request that asked for nothing. The answer reports the failure instead.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockRejectedValue(new Error('403'))

    await watcher.pollOnce()

    expect(options.onRequest).not.toHaveBeenCalled()
    expect(options.onDone).toHaveBeenCalled()
  })

  it('runs the request even when the announcement throws', async () => {
    // The card is decoration; the agent is waiting on the answer.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"ls"}]')
    options.onRequest.mockImplementation(() => {
      throw new Error('no UI')
    })

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
    expect(options.onDone).toHaveBeenCalled()
  })

  it('does not run a call the hooks denied, and says so in the answer', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"read","arguments":{"path":".env"}}]')
    options.gate.mockResolvedValue({ allowed: false, reason: 'secrets are off limits' })

    await watcher.pollOnce()

    expect(options.run).not.toHaveBeenCalled()
    const [, contents] = options.write.mock.calls[0] as [string, string]
    expect(contents).toMatch(/^status: failed/)
    // The hook's own words: the agent is the one that has to choose another way.
    expect(contents).toContain('secrets are off limits')
    expect(contents).toContain('PreToolUse hook')
  })

  it('stops the rest of the batch once a call is denied', async () => {
    // A denial changes what the remaining calls would be operating on, and the
    // stop-at-first-failure default is what keeps them from running anyway.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue(
      '[{"tool":"read","arguments":{"path":".env"}},{"tool":"ls","arguments":{}}]',
    )
    options.gate.mockResolvedValueOnce({ allowed: false, reason: 'no' })

    await watcher.pollOnce()

    expect(options.run).not.toHaveBeenCalled()
    const [, contents] = options.write.mock.calls[0] as [string, string]
    expect(contents).toContain('=== call 2 not run')
  })

  it('cards a denial, so the human can tell the policy is working', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"read","arguments":{"path":".env"}}]')
    options.gate.mockResolvedValue({ allowed: false, reason: 'nope' })

    await watcher.pollOnce()

    expect(options.onRan).toHaveBeenCalledWith(
      { tool: 'read', arguments: { path: '.env' } },
      expect.objectContaining({ isError: true }),
    )
  })

  it('asks the hooks about a script too, since it reaches `run` as bash', async () => {
    // A policy that only covered the batch route could be walked around by
    // writing a script instead.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockResolvedValue('cat .env')
    options.gate.mockResolvedValue({ allowed: false, reason: 'no reading secrets' })

    await watcher.pollOnce()

    expect(options.gate).toHaveBeenCalledWith(shell('cat .env'))
    expect(options.run).not.toHaveBeenCalled()
    const [, contents] = options.write.mock.calls[0] as [string, string]
    expect(contents).toContain('no reading secrets')
  })

  it('runs the call when the gate itself breaks, rather than denying everything', async () => {
    // A guard whose own plumbing has failed must not become a session that
    // refuses every call for reasons nobody can see.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"ls"}]')
    options.gate.mockRejectedValue(new Error('settings unreadable'))

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
    expect(options.onWarn).toHaveBeenCalled()
  })

  it('cards every call in the batch, not only the batch', async () => {
    // Dust's loop never sees these, so without a card each the human watches a
    // silent minute while their machine edits their files.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('[{"tool":"ls"},{"tool":"read","arguments":{"path":"a"}}]')

    await watcher.pollOnce()

    expect(options.onRan).toHaveBeenCalledTimes(2)
    expect(options.onRan).toHaveBeenNthCalledWith(
      2,
      { tool: 'read', arguments: { path: 'a' } },
      expect.anything(),
    )
  })

  it('keeps a tool that threw inside the batch, rather than losing the answer', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.json`)])
    options.read.mockResolvedValue('{"onError":"continue","calls":[{"tool":"ls"},{"tool":"ls"}]}')
    options.run
      .mockRejectedValueOnce(new Error('no session yet'))
      .mockResolvedValueOnce(ran('listed'))

    await watcher.pollOnce()

    const [, contents] = options.write.mock.calls[0] as [string, string]
    expect(contents).toContain('no session yet')
    expect(contents).toContain('listed')
  })

  it('runs a batch and a script in the order they were asked for', async () => {
    // One queue: a batch that edits and a script that tests are two steps of
    // one plan, and running the test first tests the tree before the edit.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([
      listed(`${POD_BASH_DIR}/test.sh`, 2000),
      listed(`${POD_BASH_DIR}/edit.json`, 1000),
    ])
    options.read.mockImplementation(async (path: string) =>
      path.endsWith('.json') ? '[{"tool":"edit","arguments":{}}]' : 'npm test')

    const order: string[] = []
    options.run.mockImplementation(async (call: PodToolCall) => {
      order.push(call.tool)
      return ran('done')
    })

    await watcher.pollOnce()

    expect(order).toEqual(['edit', 'shell'])
  })
})

describe('answering a shell request the agent left in the pod', () => {
  it('runs the script and writes what it printed back beside it', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockResolvedValue('npm test')
    options.run.mockResolvedValue(ran('2 passed'))

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledWith(shell('npm test'))
    const [path, contents] = options.write.mock.calls[0] as [string, string]
    expect(path).toBe(`${POD_BASH_DIR}/t1.out`)
    expect(contents).toContain('2 passed')
    expect(contents).toContain('status: ok')
  })

  it('reads the script before it takes the request away', async () => {
    // Observed on the first live turn: the request was deleted and then read,
    // so every command came back `status: failed ... could not be read (404)`
    // — with the pod listing showing only the `.out`, which reads exactly like
    // the agent's write never landed. It had; this side had removed it.
    const order: string[] = []
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockImplementation(async () => {
      order.push('read')
      return 'ls'
    })
    options.remove.mockImplementation(async () => {
      order.push('remove')
    })

    await watcher.pollOnce()

    expect(order).toEqual(['read', 'remove'])
    expect(options.run).toHaveBeenCalledWith(shell('ls'))
  })

  it('takes the request away before the command starts', async () => {
    // A command can run for minutes and the poll comes round every second. If
    // the request is still there on the next listing, `npm test` is started a
    // second time while the first one is still running.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.run.mockImplementation(async () => {
      expect(options.remove).toHaveBeenCalledWith(`${POD_BASH_DIR}/t1.sh`)
      return ran('done')
    })

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
  })

  it('never runs one request twice, however the listing answers', async () => {
    // The delete and the listing go through Cloudflare, which serves these
    // paths from a cache. A request already run coming back in the next
    // listing must be a no-op, not a second `npm run deploy`.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])

    await watcher.pollOnce()
    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
  })

  it('clears a stale answer before running, so a reused name cannot mislead', async () => {
    // The turn note tells the agent to pick a fresh name each time, and this
    // is what happens when it does not: the previous run's output sits at that
    // path, and the agent reads it as the answer to the command it just asked
    // for — a passing test report for a test run that has not finished.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([
      listed(`${POD_BASH_DIR}/t1.sh`),
      listed(`${POD_BASH_DIR}/t1.out`),
    ])
    const removedBeforeRun: string[] = []
    options.remove.mockImplementation(async (path: string) => {
      removedBeforeRun.push(path)
    })
    options.run.mockImplementation(async () => {
      expect(removedBeforeRun).toContain(`${POD_BASH_DIR}/t1.out`)
      return ran('done')
    })

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(1)
  })

  it('does not try to delete an answer that was never written', async () => {
    // The delete route answers 404 for a path that is not there, and a warning
    // on every ordinary command would bury the ones that mean something.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])

    await watcher.pollOnce()

    expect(options.remove).not.toHaveBeenCalledWith(`${POD_BASH_DIR}/t1.out`)
  })

  it('runs one request at a time, in the order they were asked for', async () => {
    // The agent writes a script per step and expects step two to see what step
    // one did. Two shells in the same working tree do not.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([
      listed(`${POD_BASH_DIR}/second.sh`, 2000),
      listed(`${POD_BASH_DIR}/first.sh`, 1000),
    ])
    options.read.mockImplementation(async (path: string) => path)

    let running = 0
    const order: string[] = []
    options.run.mockImplementation(async (call: PodToolCall) => {
      running += 1
      expect(running).toBe(1)
      order.push(String(call.arguments.command))
      await Promise.resolve()
      running -= 1
      return ran('done')
    })

    await watcher.pollOnce()

    expect(order).toEqual([
      `${POD_BASH_DIR}/first.sh`,
      `${POD_BASH_DIR}/second.sh`,
    ])
  })

  it('tells the agent when the command could not be run at all', async () => {
    // The agent is sitting in a read loop waiting for this file. A failure
    // that writes nothing leaves it polling a path that will never appear,
    // which costs a round-trip every time it looks.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.run.mockRejectedValue(new Error('no session yet'))

    await watcher.pollOnce()

    const [path, contents] = options.write.mock.calls[0] as [string, string]
    expect(path).toBe(`${POD_BASH_DIR}/t1.out`)
    expect(contents).toContain('status: failed')
    expect(contents).toContain('no session yet')
  })

  it('answers even when the script itself could not be read', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockRejectedValue(new Error('403'))

    await watcher.pollOnce()

    expect(options.run).not.toHaveBeenCalled()
    const [path, contents] = options.write.mock.calls[0] as [string, string]
    expect(path).toBe(`${POD_BASH_DIR}/t1.out`)
    expect(contents).toContain('status: failed')
    // And delivered, not just filed. The agent has ended its turn over this
    // request; a failure it is never told about is one it waits on forever.
    expect(options.onDone).toHaveBeenCalledWith(
      't1',
      'script',
      expect.stringContaining('status: failed'),
    )
  })

  it('carries on when one request fails, rather than dropping the rest', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([
      listed(`${POD_BASH_DIR}/a.sh`, 1000),
      listed(`${POD_BASH_DIR}/b.sh`, 2000),
    ])
    options.write.mockRejectedValueOnce(new Error('write refused'))

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(2)
    expect(options.onWarn).toHaveBeenCalled()
  })

  it('survives a listing this side could not fetch', async () => {
    // An expired token fails every listing until it is refreshed. Throwing
    // here would end the loop for the rest of the session, and the agent would
    // be left with no shell and no way to say so.
    const { watcher, options } = harness()
    options.list.mockRejectedValue(new Error('401'))

    await expect(watcher.pollOnce()).resolves.toBeUndefined()
    expect(options.onWarn).toHaveBeenCalled()
  })

  it('hands the finished command to the caller to deliver', async () => {
    // Writing the `.out` is the record; this is the delivery. The agent has
    // ended its turn by now and the only channel back into a settled session
    // is a message, so a run nobody is handed is a run the agent never hears
    // about — it is sitting waiting for exactly this.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.run.mockResolvedValue(ran('2 passed'))

    await watcher.pollOnce()

    expect(options.onDone).toHaveBeenCalledWith(
      't1',
      'script',
      expect.stringContaining('2 passed'),
    )
  })

  it('delivers a command that failed, rather than only a successful one', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.run.mockRejectedValue(new Error('no session yet'))

    await watcher.pollOnce()

    expect(options.onDone).toHaveBeenCalledWith(
      't1',
      'script',
      expect.stringContaining('status: failed'),
    )
  })

  it('delivers even when the pod would not take the result file', async () => {
    // The file is the record and the message is the channel. Losing the
    // record must not lose the answer as well.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.write.mockRejectedValue(new Error('write refused'))

    await watcher.pollOnce()

    expect(options.onDone).toHaveBeenCalled()
  })

  it('shows the human what the agent ran', async () => {
    // Dust's loop never sees these calls, so Pi draws no card for them. With
    // nothing reported, a turn in this mode is a minute of silence while the
    // developer's machine runs commands they cannot see.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockResolvedValue('rm -rf build')
    options.run.mockResolvedValue(ran('gone'))

    await watcher.pollOnce()

    expect(options.onRan).toHaveBeenCalledWith(
      shell('rm -rf build'),
      expect.objectContaining({ output: 'gone', isError: false }),
    )
  })
})

describe('knowing a command is still out', () => {
  it('reports nothing outstanding before anything has been asked for', () => {
    expect(harness().watcher.outstanding()).toBe(0)
  })

  it('counts a command from the moment it is claimed until it is delivered', async () => {
    // `/goal` and `/loop` both send their next iteration when a turn settles,
    // and under this design a settled turn is usually the agent *waiting*.
    // Without this the goal prompts the agent to carry on while its command is
    // still running, and the delivery lands on top of that a minute later.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.run.mockImplementation(async () => {
      expect(watcher.outstanding()).toBe(1)
      return ran('done')
    })

    await watcher.pollOnce()

    expect(watcher.outstanding()).toBe(0)
  })

  it('stops counting a command whose delivery threw', async () => {
    // Otherwise a failed `sendUserMessage` holds the loop for the rest of the
    // session: nothing is coming, and nothing is allowed to move.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.onDone.mockImplementation(() => {
      throw new Error('no session')
    })

    await watcher.pollOnce()

    expect(watcher.outstanding()).toBe(0)
  })

  it('stops counting a command that could not be read', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    options.read.mockRejectedValue(new Error('404'))

    await watcher.pollOnce()

    expect(watcher.outstanding()).toBe(0)
  })
})

describe('claiming a request without waiting for it to run', () => {
  it('counts a request the moment it is claimed, before the command runs', async () => {
    // `/goal` decides whether to fire its next iteration the instant a turn
    // settles, and the agent writes its script and ends its turn in the same
    // breath — so at that moment the watcher's once-a-second poll has usually
    // not seen the request yet. `outstanding()` read 0, the goal fired anyway,
    // and a run burned 25 iterations on turns that were only pauses.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])
    let released = (): void => undefined
    options.run.mockImplementation(async () => {
      await new Promise<void>(resolve => { released = resolve })
      return ran('done')
    })

    expect(await watcher.claim()).toBe(1)
    expect(options.run).not.toHaveBeenCalled()

    released()
  })

  it('does not claim the same request twice across two claims', async () => {
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])

    await watcher.claim()
    expect(await watcher.claim()).toBe(1)
  })

  it('answers what it claimed without another poll', async () => {
    // The caller claims to settle a question, not to take responsibility for
    // running anything. A claim that never ran would leave the agent waiting.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([listed(`${POD_BASH_DIR}/t1.sh`)])

    await watcher.claim()
    await watcher.idle()

    expect(options.run).toHaveBeenCalledTimes(1)
    expect(options.onDone).toHaveBeenCalled()
    expect(watcher.outstanding()).toBe(0)
  })

  it('reports nothing outstanding when a claim finds no requests', async () => {
    expect(await harness().watcher.claim()).toBe(0)
  })

  it('survives a listing it could not fetch', async () => {
    const { watcher, options } = harness()
    options.list.mockRejectedValue(new Error('401'))

    expect(await watcher.claim()).toBe(0)
    expect(options.onWarn).toHaveBeenCalled()
  })
})

describe('the polling loop itself', () => {
  it('keeps polling until it is disposed', async () => {
    const { watcher, options } = harness()
    options.wait.mockImplementation(async () => {
      if (options.list.mock.calls.length >= 3) watcher.dispose()
    })

    await watcher.run()

    expect(options.list).toHaveBeenCalledTimes(3)
  })

  it('finishes the requests it already found after being disposed', async () => {
    // Disposal happens a grace period after the turn settles, which under the
    // push model is *while* the commands are running — the agent has ended
    // its turn precisely because it is waiting. Dropping the rest of the
    // batch there would leave it waiting on a message that never comes.
    const { watcher, options } = harness()
    options.list.mockResolvedValue([
      listed(`${POD_BASH_DIR}/a.sh`, 1000),
      listed(`${POD_BASH_DIR}/b.sh`, 2000),
    ])
    options.run.mockImplementation(async () => {
      watcher.dispose()
      return ran('done')
    })

    await watcher.pollOnce()

    expect(options.run).toHaveBeenCalledTimes(2)
    expect(options.onDone).toHaveBeenCalledTimes(2)
  })

  it('does not start a poll after it has been disposed', async () => {
    const { watcher, options } = harness()
    watcher.dispose()

    await watcher.run()

    expect(options.list).not.toHaveBeenCalled()
  })

  it('waits between polls rather than spinning on the listing route', async () => {
    const { watcher, options } = harness({ intervalMs: 750 })
    options.wait.mockImplementation(async () => {
      watcher.dispose()
    })

    await watcher.run()

    expect(options.wait).toHaveBeenCalledWith(750)
  })
})
