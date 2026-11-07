# letta-acp

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter for Letta. It exposes a stateful Letta agent as an ACP agent over stdio, so any ACP client — Zed, JetBrains, marimo, or the bundled test client — can drive it.

Built on [`@letta-ai/letta-agent-sdk`](https://github.com/letta-ai/letta-agent-sdk) (agent/session management, streaming, tool approvals) and [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) (protocol plumbing).

## Quick start

Install from npm:

```bash
npm install -g @letta-ai/letta-acp   # provides the `letta-acp` command
# or run it without installing:
npx -y @letta-ai/letta-acp
```

Or work from source:

```bash
git clone git@github.com:letta-ai/letta-acp.git
cd letta-acp
bun install

# smoke test with the bundled ACP client (spawns the agent over stdio)
bun test-client.ts
bun test-client.ts "List the files in this directory using your tools."
```

Without `LETTA_AGENT_ID`, the first session creates a visible, globally unpinned agent named **Letta** using `letta/auto`, then logs its id to stderr. Set `LETTA_AGENT_ID` to that value when future adapter processes should reuse the same persistent memory.

### Test the ACP boundary

```bash
# deterministic: acpx → adapter stdio → fake Letta app server
bun run test:acpx

# live transport: acpx → adapter stdio → Letta Cloud
LETTA_API_KEY=... LETTA_ACP_TEST_AGENT_ID=agent-... bun run test:acpx:live
```

The deterministic test uses the published `acpx` CLI and this adapter's real stdio entrypoint to verify a complete tool-call lifecycle without credentials or an LLM. It is part of the normal `bun test` suite and runs on every pull request. Trusted pushes to `main` also run the live transport check against a dedicated Letta Cloud agent. That check creates a real session but deliberately skips the model turn, so it verifies authentication and session creation without spending model tokens.

## Use from Zed

Add to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Letta": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "@letta-ai/letta-acp"],
      "env": { "LETTA_AGENT_ID": "agent-..." }
    }
  }
}
```

(From a source checkout, use `"command": "/path/to/bun"`, `"args": ["/path/to/letta-acp/src/index.ts"]` instead — use the full path to `bun`, e.g. `~/.bun/bin/bun`, since Zed may not have it on its PATH.)

Then open the Agent Panel, click the **+** button (or the dropdown arrow next to it), and choose **Letta** from the external agents list to start a thread.

To drive a **Letta Cloud** agent from Zed without putting an API key in `settings.json`, run `letta login` once and use the [`cloud-oauth`](#letta-cloud-via-oauth-cloud-oauth) backend:

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud-oauth",
  "LETTA_AGENT_ID": "agent-..."
}
```

### Thread loading and diagnostics

Loading a conversation already open in the same adapter process reuses its healthy runtime and MCP connections when the working directory, MCP settings, and editor filesystem capabilities match. Its permission choices, model variant, and reasoning tier are retained; history is fetched again so the editor receives an up-to-date transcript. Changed settings or disconnected sessions reopen the runtime. Loads for one conversation are serialized; loading during an active prompt is rejected rather than interrupting that turn.

Model/provider discovery is fetched concurrently and cached per session for 30 seconds, including in-flight requests. Failed catalog requests are retried on the next request; provider or catalog changes become visible on the next configuration request after the cache expires. The picker reads persisted agent/conversation model, reasoning, and context settings at creation/load, around model changes, and after turns (including `/model` and runtime commands). Conversation overrides take precedence. Changed selections are delivered through `config_option_update`; idle changes made elsewhere are discovered on the next load or completed turn, not continuously polled. Missing reasoning is displayed as **Unconfirmed**, not a guessed catalog default; persisted noncatalog tiers remain visible. Failed or malformed reads retain the last known state. Restoring a confirmed unchanged model does not reset reasoning or send a redundant backend update. Shared model handles are matched to saved context-window variants when known; otherwise the picker retains the handle instead of claiming a particular variant.

Configuration requests, including legacy mode changes, run in admission order per session. A prompt reserves its place before waiting for previously admitted changes, rejecting later configuration requests until the turn finishes. Failed changes do not poison the queue. Cancelling a waiting prompt does not cancel a configuration write already in flight or abort an idle model stream. Runtime replacement invalidates queued writes and stale readbacks belonging to the old session. This coordinates this adapter's requests, not writes from independent clients.

Adapter stderr (also visible in Zed's log) includes `timing:` entries for runtime initialization/reuse, history fetch/replay, model/provider discovery, and total new/load time. Cold sessions still need to start the SDK runtime and connect MCP servers. These timings distinguish that cost from transcript and picker work.

When a source-checkout launcher uses `dist/index.js`, run `bun run build` after changing source and restart the external-agent process (restarting Zed also does this). Already-running adapter processes do not reload compiled changes.

## Configuration

The adapter reaches Letta through one of four backends, selected with `LETTA_ACP_BACKEND` ([self-hosting docs](https://docs.letta.com/self-hosting)). Each subsection below shows the full `env` block for that backend.

### Letta Cloud (`cloud`)

Agents run on Letta's hosted platform; the harness executes in a cloud sandbox. Get an API key at [platform.letta.com/api-keys](https://platform.letta.com/api-keys):

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud",
  "LETTA_API_KEY": "sk-let-...",
  "LETTA_AGENT_ID": "agent-..."
}
```

### Letta Cloud via OAuth (`cloud-oauth`)

Same cloud agents as `cloud`, but authenticated with your existing `letta login` session instead of an API key — so no long-lived secret has to be pasted into your editor's settings file.

```json
"env": {
  "LETTA_ACP_BACKEND": "cloud-oauth",
  "LETTA_AGENT_ID": "agent-..."
}
```

Run `letta login` once, then start a thread. ACP clients with terminal-auth support can also launch this login flow directly from the agent setup UI. Credentials are resolved by the letta-code harness exactly as the CLI does it: OAuth tokens from your OS keychain (macOS Keychain, Windows Credential Manager, libsecret), refreshed automatically as they expire, falling back to `LETTA_API_KEY` if one is set.

Mechanically this is the `local` backend with the harness pointed at Letta Cloud (`harnessBackend: "api"`): the SDK spawns a loopback app-server on your machine, the agent and its memory live in Cloud (real `agent-*` ids, cloud-side models), and — unlike `cloud` — built-in tools such as `Read` and `Bash` execute against **your** filesystem rather than a cloud sandbox. For editor use that's usually what you want.

### Local runtime (`local`, default)

The SDK spawns a private Letta Code app-server on your machine (`letta.js --backend local app-server`); all agent state stays on-device under `~/.letta/lc-local-backend`. Requires the `@letta-ai/letta-code` CLI to be available (it ships as a dependency of this package) and model access: either `letta login`, or connect providers directly — `letta --backend local connect anthropic --api-key ...`, `connect ollama`, etc.

```json
"env": {
  "LETTA_ACP_BACKEND": "local",
  "LETTA_AGENT_ID": "agent-local-..."
}
```

Both entries are optional: `local` is the default backend, and without `LETTA_AGENT_ID` the adapter creates a visible, globally unpinned **Letta** agent on first use and logs its id to stderr. Set the logged id explicitly when later adapter processes should return to that agent's persistent memory.

### Self-hosted app server (`remote`)

Point the adapter at an app server you run (`letta server --backend local --listen ws://127.0.0.1:4500`). For non-loopback deployments enable auth (`--ws-auth capability-token --ws-token-file <path>`):

```json
"env": {
  "LETTA_ACP_BACKEND": "remote",
  "LETTA_APP_SERVER_URL": "ws://your-host:4500",
  "LETTA_APP_SERVER_TOKEN": "<capability token, if enabled>",
  "LETTA_AGENT_ID": "agent-..."
}
```

### All backends

| Variable | Effect |
|----------|--------|
| `LETTA_AGENT_ID` | reuse an existing agent instead of creating a visible, globally unpinned agent named `Letta` |
| `LETTA_ACP_MODEL` | optional model override for sessions, as a `provider/model` handle (e.g. `anthropic/claude-fable-5`, `openai/gpt-4.1`); new agents default to `letta/auto`, while reused agents keep their model when this is unset — run `/model` to list valid handles |
| `LETTA_ACP_PERMISSION_MODE` | initial session mode: `standard` (default), `acceptEdits`, `unrestricted` — switchable live via `session/set_mode` (Zed's mode dropdown) |

### Turn-lifecycle tracing

`LETTA_ACP_DEBUG=<label>` labels stderr trace lines for initialization, reader startup, and turn coordination — one JSON record per stream round, carrying the pump outcome, the round's mode and deadline, the server's active-run list, and whether the round produced output, plus a `round: N` counter that ties them to a single prompt. It exists because the coordination decisions happen inside the adapter: an ACP log shows the notifications a turn emitted, but not whether the turn ended early, or why a still-working run was or wasn't waited on.

```
[letta-acp:debug] philo {"ev":"round","round":2,"mode":"recovery","outcome":"stream_end",...}
```

Off by default. Records go to stderr, never ACP stdout. Logging can still add timing overhead; it is a diagnostic channel, not a timing-neutral instrument.

Note on tool execution: with `remote` and `cloud`, built-in tools (Read, Bash, …) run where the harness runs — the server/sandbox filesystem, not your machine. With `local` and `cloud-oauth` they run on your machine. The editor fs tools (`read_editor_buffer`, `write_via_editor`) always operate on the editor's files regardless of backend, since they execute in the adapter and delegate to the ACP client.

## What's implemented

| ACP surface | Status |
|-------------|--------|
| `initialize` (v1 negotiation) | ✅ |
| `session/new` (per-session Letta conversation, cwd) | ✅ |
| `session/prompt` (text, image, resource, resource_link) | ✅ |
| `session/update` — message/thought chunks, tool calls, tool results | ✅ |
| `session/request_permission` (allow once / always / reject) | ✅ |
| `session/cancel` → `stopReason: cancelled` | ✅ |
| `session/load` (resume threads with history replay) | ✅ |
| `session/list` (project-scoped persisted session discovery) | ✅ |
| Session modes (`session/set_mode`: standard / acceptEdits / unrestricted) | ✅ |
| Model listing and switching (`configOptions` + `session/set_config_option`) | ✅ |
| Slash commands (`available_commands_update`, ~30 commands + skills) | ✅ |
| Client fs delegation (`fs/read_text_file`, `fs/write_text_file`) | ✅ via external tools |
| MCP servers from `session/new` / `session/load` | ✅ stdio, HTTP, and SSE via Agent SDK external tools |
| Native Bash result rendering (`_meta.terminal_output`) | ✅ when supported by the client |
| Client-side command execution (`terminal/*`) | ❌ (planned) |
| Plan updates (`plan` from TodoWrite) | ❌ (planned) |

ACP session ids are Letta conversation ids, so `session/load` works across adapter restarts when the client already knows the id: the conversation is resumed via the SDK and its recent history (up to 200 messages) is replayed as `session/update` notifications. For discovery, the adapter records the working directory of successful `session/new` and `session/load` calls under `~/.letta/letta-acp/sessions/`. `session/list` combines those project-scoped records with live conversation titles and timestamps from the configured Letta agent; unrelated conversations are not assigned an inferred project. Session modes are enforced in the adapter's permission callback — the harness always runs in `standard` mode so every approval routes through the adapter, which is what makes live mode switching possible. Session bookkeeping tools (`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`, and `TodoWrite`) never require approval; `acceptEdits` additionally auto-allows file-edit tools, and `unrestricted` auto-allows everything. `/model` (empty to list, or a handle to switch) is handled in the adapter without an LLM turn.

### Slash commands

The adapter advertises the [Letta slash commands](https://docs.letta.com/platform/cli/slash-commands) that make sense over ACP, so they appear in the client's `/` menu:

- **Adapter-native**: `/model`, `/retitle [naming guidance]`, `/rename <exact title>`.
- **Harness-executed** (via the app-server `execute_command` protocol): the adapter knows `/clear`, `/compact`, `/init`, `/doctor`, `/remember`, `/reflect`, `/context-limit`, `/reload`, and `/toolset`, but filters this list against the runtime's `supported_commands` when reported. For example, current runtimes have removed `/clear`, so it is hidden there. Older runtimes that omit the list retain the legacy command set; this is compatibility behavior, not a guarantee that every command works. Commands that run a full agent turn (`/init`, `/remember`, `/doctor`) stream their tool calls and output like any prompt.
- **Custom commands**: runtime-advertised `mod_commands` appear with their descriptions and argument hints, and execute through the harness rather than as model prompts. Device-status snapshots refresh registration and removal, including after `/reload`. Adapter-native and built-in names are reserved; custom executable commands take precedence over model-interpreted shortcuts and skills. A previously discovered command that is removed is rejected explicitly rather than silently sent to the model. An immediate slash prompt waits up to 1.5 seconds for initial discovery; ordinary prompts and session creation do not wait. If discovery is unavailable, unknown slash names retain the existing model/skill fallback.
- **Manual reflection**: `/reflect` starts a background reflection pass on the current conversation without waiting for the automatic reflection threshold. The initial response confirms whether reflection started, not that memory updates have finished. Code-managed reflection accepts `/reflect --instruction <focus>`; Cloud-managed reflection accepts no arguments. Runtime status does not report which reflection argument set is supported, so the menu conservatively advertises bare `/reflect` without an argument hint. The TUI selectors `--recent`, `--conversation`, and `--auto` are not supported on the Code-managed remote command path.
- **Model-interpreted**: `/memory`, `/search`, `/skills`, `/skill-creator`, plus invokable skills reported by the executing harness — these forward as prompt text, which the harness instructs the model to treat as a skill invocation. The menu follows the runtime's effective bundled, global, agent-owned, and project skill inventory, including its source restrictions and override precedence. Remote sessions use the server's inventory, never the adapter host's filesystem. Status updates refresh the menu without another prompt. Current harnesses populate the inventory during turn setup, so skills may first appear after the first turn. If an older runtime cannot report skills, the adapter advertises only its base commands rather than guessing from local files.

The rest of the CLI's commands (`/agents`, `/resume`, `/login`, `/statusline`, `/exit`, …) are TUI dialogs or local-process controls with no protocol equivalent; use the editor's own UI for those (new thread ≈ `/new`, thread history ≈ `/resume`).

## Conversation naming

ACP can save titles on the actual Letta conversation, so they are available when resuming through other clients. Zed also receives a `session_info_update` with the saved title. Naming is independent of the agent's chat and reflection models.

Automatic naming defaults to a title derived from the first substantive user message, after three completed user/assistant exchanges. It runs in the background and only names conversations whose `summary` is empty; existing titles are preserved on resume. Model-based naming considers a bounded excerpt of the opening and recent discussion, not just the opening message. Tool output, reasoning, slash commands, task notifications, and system reminders are excluded. Model errors leave the conversation untitled and may be retried after another successful turn.

Use the **Conversation naming** session option in Zed to choose `off`, `message`, `subscription`, or `local`. Subscription mode also exposes a **Naming model** selector; a model must be explicitly selected/configured before it can run. These session selections do not change persistent defaults. For persistent settings, add these environment variables to the relevant Zed `agent_servers.<name>.env` block:

| Variable | Default | Purpose |
| --- | --- | --- |
| `LETTA_ACP_NAMING_MODE` | `message` | `off`, `message` (no inference), `subscription` (harness provider/hosted model), or `local` (native Ollama API). |
| `LETTA_ACP_NAMING_MODEL` | Qwen below for `local`; required for `subscription` | Raw Ollama model name for local mode, or an explicit runtime model handle for subscription mode. No implicit hosted/paid model is selected. |
| `LETTA_ACP_NAMING_LOCAL_MODEL` | `qwen3.5:9b-q4_K_M` | Default local model and fallback model for a free-only subscription route. |
| `LETTA_ACP_NAMING_ENDPOINT` | `http://127.0.0.1:11434` | Ollama base URL, reached from the computer running the ACP adapter—not necessarily the agent's execution host. Redirects and URL credentials are rejected. An explicitly configured remote endpoint receives the naming excerpt. |
| `LETTA_ACP_NAMING_AFTER_TURNS` | `3` | Completed substantive exchanges before automatic naming. Manual retitling does not wait for this threshold. |
| `LETTA_ACP_NAMING_TIMEOUT_MS` | `60000` | Timeout per model attempt, bounded to 1–300 seconds. |
| `LETTA_ACP_NAMING_REQUIRE_FREE` | `false` | In subscription mode, require the runtime's fresh model catalog to explicitly mark the selected model free before inference. Unverified free access or a hosted inference failure uses the configured local fallback, never another paid hosted model. |

For a local Qwen model to do the naming:

```json
"LETTA_ACP_NAMING_MODE": "local",
"LETTA_ACP_NAMING_MODEL": "qwen3.5:9b-q4_K_M"
```

Subscription naming uses a separate, tool-free, agent-free query conversation and archives it afterward. It does not inject a naming request into the original conversation or switch its model. Local naming calls `/api/chat` with thinking disabled, bounded context/output, and a short model keep-alive. Neither path needs another persistent agent or access to its memory.

Subscription naming requires an app-server backend supporting agent-free SDK queries (`local`, `remote`, or `cloud-oauth`). The direct `cloud` SDK backend needs an execution computer for such queries and is not supported for hosted naming here; choose `local`/`message` naming or use `cloud-oauth`. A free-only policy still falls back to local naming if its hosted query is unavailable.

- `/retitle` regenerates a title from the discussion so far, including when an existing title is present.
- `/retitle Focus on the command-discovery work` supplies optional guidance to a naming model. Message-based mode cannot interpret guidance; select a model mode or use `/rename`.
- `/rename ACP skill and command discovery` saves those exact words without calling a model, even when automatic naming is off. Exact titles must be a single line of 1–100 characters.

Cancellation, runtime replacement, and shutdown invalidate pending generation. Writes are serialized within a session so an older automatic request cannot overwrite a later exact rename. The adapter also rechecks the saved title before a generated update, preserving a title changed while inference was running. The backend does not expose a conditional title update, so simultaneous writes from separate clients cannot be made fully atomic by the adapter.

## How it works

The SDK is pinned to 0.8.50 with a Bun patch in `patches/`. It prevents an idle status from settling runs that the same status still lists as active (which would discard their later output), and lets abort acknowledgements settle turns before any model output arrives. Keep the patch until an SDK release includes both fixes; remove it only after the turn-completion and cancellation regressions pass against that release. Use `bun install` so the patch is applied.

`src/agent.ts` maps the two protocols:

- Each ACP session becomes a new conversation (`client.createSession`) on one underlying Letta agent, with the ACP `cwd`.
- A single session-owned reader translates SDK messages (`assistant`, `reasoning`, `tool_call`, `tool_result`) into `session/update` notifications, including background output after a prompt completes. `session/prompt` observes that reader for turn completion; it does not start a competing SDK consumer.
- Results belonging only to runs known before a prompt started cannot complete that prompt, although their late output is still delivered. A synthetic success with no stop reason and no turn activity is not treated as completion: the adapter waits up to 30 seconds for continuation, then reports an unconfirmed-completion error rather than silently succeeding. Metadata and repeated idle notifications do not extend that deadline. Explicit terminal results remain valid for empty and tool-only turns; SDK results without reliable run identity cannot be fully correlated by the adapter.
- When the client advertises `_meta.terminal_output`, Bash calls use ACP terminal content plus `terminal_info`, `terminal_output`, and `terminal_exit` updates. Zed controls whether terminal cards start expanded or collapsed; the adapter sends the complete output and retains it in `rawOutput`.
- Tool approvals: the SDK's `canUseTool` callback is forwarded as an ACP `session/request_permission` request. One Letta-specific wrinkle: the app-server transport ends the turn with a recoverable `approval_conflict` result while the approval is pending, and the resumed run streams without a second terminal result — so after such a result the adapter keeps pumping the stream (approvals resolve concurrently over the control channel) and ends the turn when the agent loop reports it is idle again.

## Editor file access (external tools)

The harness's built-in tools (`Read`, `Edit`, `Bash`, …) always execute Letta-side, directly against the filesystem — the ACP client only *renders* those tool calls. Letta's [external tools](https://docs.letta.com/platform/app-server/external-tools) add capabilities on top (they cannot replace built-ins), and the adapter uses them to close the editor-integration gap: when the client advertises `clientCapabilities.fs` during `initialize`, each session registers:

- **`read_editor_buffer`** → proxies ACP `fs/read_text_file`, so the agent can read files *as the editor sees them*, including unsaved buffer changes that disk-based `Read` would miss.
- **`write_via_editor`** → proxies ACP `fs/write_text_file`, so a write lands in the editor's buffer with diff review and undo history instead of a raw disk write.

The tool descriptions steer the model to prefer these for files the user has open and the built-ins otherwise. Both go through the normal permission flow. Clients that don't advertise fs capabilities get no extra tools and everything runs Letta-side as before. Terminal delegation (`terminal/*`) is the remaining piece.

## MCP servers

ACP clients can pass stdio, Streamable HTTP, and SSE MCP servers in `session/new` and `session/load`. The adapter maps the ACP transport shape to `@letta-ai/letta-agent-sdk`, which owns connections, tool discovery, `mcp__<server>__<tool>` namespacing, execution, failure isolation, and cleanup for the session. The adapter advertises HTTP and SSE MCP capabilities; ACP's experimental in-band MCP transport is not supported.
