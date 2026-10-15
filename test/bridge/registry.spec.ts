import { describe, expect, it } from 'vitest'

import { awaitNativeOutcome, markBridgedCall, settleNativeOutcome } from '../../src/bridge/registry.ts'

describe('bridged call outcomes', () => {
  it('hands an outcome reported before anyone waited to the first who asks', async () => {
    markBridgedCall('early_1', 'ses_1')
    settleNativeOutcome('early_1', { output: 'done', isError: false, durationMs: 0 })

    await expect(awaitNativeOutcome('early_1')).resolves.toMatchObject({ output: 'done' })
  })

  it('takes the first report of a call and ignores the rest', async () => {
    // Every plugin instance in the process follows the same events, so one
    // call is reported once per instance.
    markBridgedCall('twice_1', 'ses_1')
    const outcome = awaitNativeOutcome('twice_1')

    expect(settleNativeOutcome('twice_1', { output: 'first', isError: false, durationMs: 0 })).toBe(true)
    expect(settleNativeOutcome('twice_1', { output: 'second', isError: true, durationMs: 0 })).toBe(false)

    await expect(outcome).resolves.toMatchObject({ output: 'first' })
  })

  it('ignores a call that is not the bridge’s', () => {
    expect(settleNativeOutcome('never_marked', { output: '', isError: false, durationMs: 0 })).toBe(false)
  })
})
