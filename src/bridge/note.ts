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

/** What the session offers behind opencode's code mode, when it offers anything. */
export interface CodeModeOffer {
  /**
   * The session's own catalog, as opencode wrote it into the instructions:
   * already filtered by the session's permissions, and partial when there are
   * many tools.
   */
  readonly catalog: string
}

/**
 * The part of the note about code-mode tools.
 *
 * The catalog is passed on as opencode wrote it rather than rebuilt from the
 * registry: the registry lists tools the session's permissions withhold, and
 * an agent offered those calls them and gets "Unknown tool" back.
 */
function codeModeSection(offer: CodeModeOffer): string {
  return [
    '',
    '',
    'Other tools — MCP servers, the browser, and the like — live behind opencode\'s Code Mode and are only reachable through `execute`:',
    ' `{"tool":"execute","arguments":{"code":"return await tools.<path>({...})"}}`, with the path from the catalog below.',
    ' When the catalog is partial, find a tool first with `search(...)` inside `execute` (no `await`), and call it by the path it returns; do not guess tool names.',
    '',
    '',
    offer.catalog.trim(),
  ].join('')
}

/**
 * Build the turn note.
 * @param tools - the developer's direct tools as compact signatures, from `toolSignatures`.
 * @param codeMode - what the session offers behind code mode, if anything.
 * @returns the note, to put in front of the turn's message.
 */
export function bridgeNote(tools: readonly string[], codeMode?: CodeModeOffer): string {
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
    ' Separate calls do not share a shell; when a step needs one (a persistent `cd`, a heredoc), run the helper with `--sh` after the name and send plain shell commands: they run as one script.',
    ' The request is a request for the developer\'s tools, not a prompt: anything else is refused unread.',
    '',
    '',
    'Each request costs a round-trip, whatever is in it, so put a whole step in one request: read the files you need together, make every edit and run the check in one batch.',
    ' Prefer `edit` and `write` over `sed`: they are exact where a shell rewrite is a guess.',
    ' `<name>` must be one you have never used in this conversation (`step1`, `step2`, …).',
    ` If the helper says the work is still running (after ${String(HELPER_WAIT_SECONDS)}s), end your turn at once and say you are waiting: the result is delivered to you as a message.`,
    '',
    '',
    `Your sandbox stays yours for scratch work — Python, quick computations, drafts in \`/tmp\` — which costs nothing; just remember it never holds the project's files.`,
    codeMode === undefined ? '' : codeModeSection(codeMode),
  ].join('')
}
