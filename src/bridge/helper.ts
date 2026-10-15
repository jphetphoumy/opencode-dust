/**
 * The script the agent runs in its Computer sandbox to reach the developer's
 * machine, in one free `bash` call.
 *
 * The sandbox mounts the pod at `/files/pod`, and a live spike showed both
 * directions are prompt: a file this plugin PUTs is visible there at once, and
 * a file the sandbox writes is in the pod listing within about a second. So the
 * agent leaves its request and *waits for the answer inside the same call*:
 * no ended turn, no delivery message, no second model invocation per step —
 * which is what pi-dust-next's exchange cost.
 *
 * A sandbox `bash` call is capped at 120 seconds. Work that outlives the wait
 * is not lost: the helper leaves a `.detached` marker, tells the agent to end
 * its turn, and the plugin delivers the answer as a message when it lands.
 */

import { POD_BASH_DIR } from './pod-bash.ts'

/** Where the helper lives in the pod: outside the exchange the watcher polls. */
export const HELPER_PATH = 'oc-tools/oc.sh'

/** Where the sandbox mounts the conversation's pod. */
export const SANDBOX_POD_ROOT = '/files/pod'

/**
 * Seconds the helper waits for an answer.
 *
 * Under the sandbox's 120-second ceiling with room to spare: a call killed by
 * that ceiling leaves no marker, and the agent learns nothing but a timeout.
 */
export const HELPER_WAIT_SECONDS = 100

/**
 * Where one conversation's requests live.
 *
 * One pod serves every session of a project, while a request name is only
 * unique within its conversation: two sessions would otherwise both leave a
 * `step1` and one would read the other's answer.
 * @param conversationId - the Dust conversation.
 * @returns the pod-relative directory.
 */
export function exchangeDir(conversationId: string): string {
  return `${POD_BASH_DIR}/${conversationId}`
}

/**
 * The marker a timed-out wait leaves beside its request.
 * @param conversationId - the Dust conversation.
 * @param id - the request name.
 * @returns its pod-relative path.
 */
export function detachedPath(conversationId: string, id: string): string {
  return `${exchangeDir(conversationId)}/${id}.detached`
}

/**
 * The helper's source.
 *
 * The conversation is read from the sandbox's own mount, `/files/conversation`
 * → `/files/conversation-<id>`, so the agent never has to know its id.
 * `OC_POD_ROOT`, `OC_WAIT` and `OC_CONVERSATION` exist for tests; in the
 * sandbox the defaults apply. The request is staged in `/tmp` and copied in whole, so the watcher
 * never lists a request that is still being written.
 * @returns the bash script.
 */
export function helperScript(): string {
  return `#!/usr/bin/env bash
# opencode bridge: run work on the developer's machine and wait for the answer.
# Usage: bash ${SANDBOX_POD_ROOT}/${HELPER_PATH} <name> <<'EOF'
#        {"calls":[...]}      (a batch of tool calls)  or  shell commands (a script)
#        EOF
set -u
root="\${OC_POD_ROOT:-${SANDBOX_POD_ROOT}}"
wait="\${OC_WAIT:-${String(HELPER_WAIT_SECONDS)}}"
conversation="\${OC_CONVERSATION:-$(basename "$(readlink /files/conversation)" | sed 's/^conversation-//')}"
dir="$root/${POD_BASH_DIR}/$conversation"
name="\${1:-}"

if ! [[ "$conversation" =~ ^[A-Za-z0-9_-]+$ ]]; then
  echo "error: this sandbox has no conversation mount at /files/conversation." >&2
  exit 2
fi

if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  echo "error: '$name' is not a usable request name; use letters, digits, '.', '_' or '-', like step1." >&2
  exit 2
fi
if compgen -G "$dir/$name.*" > /dev/null; then
  echo "error: the name $name was already used in this conversation; pick one you have never used." >&2
  exit 2
fi

body="$(mktemp)"
cat > "$body"
if ! grep -q '[^[:space:]]' "$body"; then
  echo "error: the request is empty; pass the batch or the script on stdin." >&2
  rm -f "$body"
  exit 2
fi
case "$(tr -d '[:space:]' < "$body" | head -c 1)" in
  "{"|"[") kind=json ;;
  *) kind=sh ;;
esac

mkdir -p "$dir"
cp "$body" "$dir/$name.$kind"
rm -f "$body"

for _ in $(seq 1 "$wait"); do
  if [ -f "$dir/$name.out" ]; then
    cat "$dir/$name.out"
    exit 0
  fi
  sleep 1
done

touch "$dir/$name.detached"
echo "$name is still running on the developer's machine after \${wait}s."
echo "End your turn now and say you are waiting for it: its output will be delivered to you as a message when it finishes."
`
}
