/**
 * What every bridged turn tells the agent about where the project is and how
 * to work on it.
 *
 * The agent runs Dust's global `dust` agent loop and has none of opencode's
 * tools: opencode strips them from the request. Its own Computer sandbox is
 * free, and the pod mounted in it carries only the exchange — the project
 * itself stays on the developer's machine. So the note has one job: make the
 * helper the obvious way to touch the project, batched a whole step at a time.
 */

import { HELPER_PATH, HELPER_WAIT_SECONDS, SANDBOX_POD_ROOT } from './helper.ts'

/** The `bash` timeout the helper's wait needs, under the sandbox's ceiling. */
const BASH_TIMEOUT_MS = 120_000

/**
 * Build the turn note.
 * @param tools - the developer's tools as compact signatures, from `toolSignatures`.
 * @returns the note, to put in front of the turn's message.
 */
export function bridgeNote(tools: readonly string[]): string {
  const helper = `bash ${SANDBOX_POD_ROOT}/${HELPER_PATH} <name>`
  return [
    `You are working on a project that lives on the developer's machine, not in \`${SANDBOX_POD_ROOT}\` and not in your sandbox.`,
    ' To read, search, edit or run anything there, use your sandbox `bash` tool,',
    ` with \`timeoutMs: ${String(BASH_TIMEOUT_MS)}\`, to run \`${helper} <<'EOF'\` followed by the request and \`EOF\`.`,
    ' It runs on the developer\'s machine through their own tools and permissions, and prints the result in the same call.',
    '',
    '',
    'A request is a batch of tool calls, run in order and stopping at the first failure unless you add `"onError":"continue"`:',
    ' `{"calls":[{"tool":"read","arguments":{...}},{"tool":"shell","arguments":{"command":"npm test"}}]}`.',
    ` Available tools: ${tools.join(', ')}.`,
    ' Separate calls do not share a shell; when a step needs one (a persistent `cd`, a heredoc), send plain shell commands instead of JSON and they run as one script.',
    '',
    '',
    'Each request costs a round-trip, whatever is in it, so put a whole step in one request: read the files you need together, make every edit and run the check in one batch.',
    ' Prefer `edit` and `write` over `sed`: they are exact where a shell rewrite is a guess.',
    ' `<name>` must be one you have never used in this conversation (`step1`, `step2`, …).',
    ` If the helper says the work is still running (after ${String(HELPER_WAIT_SECONDS)}s), end your turn at once and say you are waiting: the result is delivered to you as a message.`,
    '',
    '',
    `Your sandbox stays yours for scratch work — Python, quick computations, drafts in \`/tmp\` — which costs nothing; just remember it never holds the project's files.`,
  ].join('')
}
