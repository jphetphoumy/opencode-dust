/**
 * A diagnostic trail for the parts opencode gives a plugin no logger for.
 *
 * opencode's background service does not surface a plugin's failures, and the
 * bridge is a chain — login, pod, hook, stream, watcher — where any link can
 * fail quietly and leave the agent without its note. One JSON line per event
 * in `$XDG_STATE_HOME/opencode-dust/debug.log` (default
 * `~/.local/state/...`) says which link it was. Never throws.
 *
 * `OPENCODE_DUST_LOG` overrides the path; `off` disables it (the test suite).
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Where the trail goes, or nothing when it is disabled. */
function logPath(): string | undefined {
  const override = process.env['OPENCODE_DUST_LOG']
  if (override === 'off') return undefined
  if (override !== undefined && override !== '') return override
  const state = process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state')
  return join(state, 'opencode-dust', 'debug.log')
}

/** Read a thrown value as something worth writing down. */
export function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Append one event to the trail.
 * @param event - what happened, in a word or two.
 * @param fields - the facts that tell one occurrence from another; never secrets.
 */
export function debug(event: string, fields: Record<string, unknown> = {}): void {
  const path = logPath()
  if (path === undefined) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`)
  } catch {
    // A diagnostic that breaks the thing it diagnoses is worse than none.
  }
}
