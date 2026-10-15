# opencode-dust

An opencode v2 plugin that adds [Dust](https://dust.tt) workspace agents as a
model provider, ported from `pi-dust-next`. The agent works on your machine
through a free bridge in its own Computer sandbox; see *The bridge*.

## Requirements

- **opencode v2** (developed against 2.0.22). This is a v2 plugin; it does not
  load in opencode 1.x.
- A **Dust account** in a workspace that:
  - has the `models_picker` feature, because every turn picks its model and
    Dust answers HTTP 403 without it;
  - keeps the **Computer** feature on (on by default), which the bridge's
    sandbox runs on.

Nothing to build: opencode runs the TypeScript sources directly, and the
plugin has no runtime dependencies.

## Install

### From GitHub

```sh
opencode plugin add git+https://github.com/jphetphoumy/opencode-dust.git
```

This installs the plugin and adds it to your global opencode configuration.
Update it later with `opencode plugin update`.

### From a local clone

Useful to hack on it, since opencode reloads a local plugin when its files
change:

```sh
git clone https://github.com/jphetphoumy/opencode-dust.git ~/src/opencode-dust
```

Then list the directory in `~/.config/opencode/opencode.json` (or a project's
`opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/home/you/src/opencode-dust"]
}
```

### Then

1. **Restart the background service** so it picks the plugin up:

   ```sh
   opencode service restart
   ```

2. **Log in to Dust:**

   ```sh
   opencode auth login        # choose Dust, then approve the code in your browser
   ```

   The login asks for a workspace (name or id). Leave it empty when you belong
   to only one. The token is refreshed by opencode on its own.

3. **Pick a model** from the `dust` provider, for example
   `dust/anthropic:claude-sonnet-5`. The list is your workspace's catalog;
   models with vision accept pasted images.

On the first Dust turn in a project, the plugin creates a private pod named
`opencode-<folder>` in your workspace. It holds only the bridge's exchange,
never your code.

### Troubleshooting

- Everything the plugin does is traced, one JSON line per event, in
  `~/.local/state/opencode-dust/debug.log`: login, pod, each request's hook,
  each Dust turn, each bridged call and delivery.
- After updating the plugin, run `opencode service restart`. opencode keeps a
  provider it already loaded in memory until its token rotates.
- Run `opencode auth login` again to switch workspaces.

## Model mapping

Models are the real models the workspace enables, read from its catalog once
logged in. Every turn mentions Dust's global `dust` agent and sends the picked
model as a `modelSelection` override:

| opencode model | Sent to Dust |
| --- | --- |
| `dust/<providerId>:<modelId>` | `mentions: [{ configurationId: "dust" }]`, `modelSelection: { providerId, modelId }` |
| same, with a variant | `modelSelection: { providerId, modelId, reasoningEffort }` |

Reasoning models offer one variant per effort Dust accepts; without one, Dust
applies the model's default effort. There is no `agent-default` entry: it
would run whatever model the agent is configured with, which Dust never
reports. A model override needs the workspace's `models_picker` feature, or
Dust answers HTTP 403.

## The bridge: working on your machine for free

The `dust` agent runs its own loop on Dust's side and is never sent opencode's
tools. Instead the agent reaches your machine
through its **Computer sandbox**, whose `bash` tool is free (`basic` +
`freeUsage`), where a client-side MCP tool would cost 3 credits a call.

```
Dust agent ── sandbox bash (free) ──▶ /files/pod/oc-bash/<conversation>/step1.json
                                                 │  pod listing, every second
                                                 ▼
                       opencode plugin ── ctx.tool.list() ──▶ read / edit / shell …
                                                 │  (opencode's own permissions)
              helper prints step1.out ◀── PUT ───┘
```

- On login the plugin creates a private pod, `opencode-<folder>`, and leaves
  `oc-tools/oc.sh` in it. Every Dust conversation is filed in that pod, so
  the sandbox mounts it at `/files/pod`. The project itself is **not**
  copied: the pod only carries the exchange.
- The agent runs `bash /files/pod/oc-tools/oc.sh step1 <<'EOF' … EOF` with
  a batch of tool calls (`{"calls":[…]}`) or a shell script. The helper drops
  the request and **waits in the same call** for the answer.
- While the Dust turn streams, each call goes out **as a tool call of that
  turn**. opencode runs it in its own loop, as for any model: its own card
  (the Edit diff, the Write preview, the Shell output), its own permission
  prompt, and the diagnostics `edit` reports once opencode has an LSP. The
  plugin reads the result from `session.tool.success` / `session.tool.failed`
  and writes it to the `.out` the helper is waiting on. Calls go out one at a
  time, because opencode starts every tool call of a step at once and a batch
  must stay in order. opencode then runs one follow-up step, which the provider
  answers empty, since the results already went back through the pod.
- A tool behind opencode's **code mode** (MCP tools, `opencode_list_mcp_resources`,
  `opencode_read_mcp_resource`…) is not a tool call of its own: it goes out
  as `execute` running `tools.<namespace>.<name>(…)`, and shows as opencode's
  execute card. If code mode is denied, so the request has no `execute`, it
  runs directly instead.
- With no Dust turn streaming (the helper gave up and the agent ended its
  turn), a call runs through the tool from `ctx.tool.list()` directly, with
  the same permission check but no card.
- opencode's tools therefore stay in the request: opencode only runs a call to
  a tool the request carried. Dust never sees them.
- Work that outlives the helper's 100 s wait is not lost. The helper leaves
  a `.detached` marker and tells the agent to end its turn, and the answer
  arrives as a queued `session.synthetic` message. Interrupting the session
  kills the running work and sends nothing.
- The sandbox's own `bash` commands are shown in the reasoning, since
  opencode never sees them as tool calls.

`npm run spike` re-checks the three facts this rests on against the live
service (billed: two messages): API writes are visible in the sandbox, sandbox
writes reach the listing within about a second, and a waiting `bash` call sees
a file written mid-wait.

## Images

A model with vision declares `image` input, so opencode lets a pasted
screenshot through, as a `file` part on the user message. Each image (and each
PDF) is uploaded under its own media type (`POST files`, then the upload URL)
and attached as a content fragment:

- **in the create body** when the turn opens a conversation;
- **with `content_fragments` before the message** when it appends, so the
  picture arrives ahead of the sentence about it.

Images are deduplicated by their bytes, because replaying a transcript into a
fresh conversation would otherwise upload and bill every screenshot again.
Only the new message's images go with an append. A remote URL is not fetched.
If Dust refuses an image, it is skipped and the words are still sent;
`debug.log` says which one and why.

## Billing: the `cli` origin

Every message is stamped `origin: "cli"` and every request is sent with
`User-Agent: Dust CLI`, under a WorkOS **user** grant. Dust bills the turn as
interactive user usage only with that combination (see
`front/lib/api/programmatic_usage/common.ts` and `isUserMessageContextValid`).
Neither can be overridden, and there is no API-key method.

## How a call works

Dust has no chat-completions endpoint, so each AI SDK call sends one user
message to a Dust conversation and streams the agent's answer back: chain of
thought as reasoning, answer as text. opencode's tools are never sent to Dust;
a `context` hook puts the bridge note in front of every turn instead, and the
agent's own server-side tool approvals are answered automatically.

An AI SDK call carries no session id, so a conversation is found again by a
digest of the history Dust already holds. When the prompt extends that
history, only the new user message is sent. Anything else (compaction, revert,
edit) opens a new conversation with the transcript replayed and the system
prompt in front.

## Layout

```
server.ts            Entry point opencode resolves.
src/plugin.ts        Integration + provider registration, catalog reload, bridge wiring.
src/provider/        AI SDK provider (sdk.ts), language model, history, login.
src/bridge/          Exchange protocol, watcher, helper, note, runner, session manager.
src/dust/            Dust API client, shared with pi-dust-next.
scripts/             Live spike (billed) for the sandbox/pod assumptions.
```

## Develop

```
npm install
npm run check        # typecheck + tests; the suite refuses any real network call
```
