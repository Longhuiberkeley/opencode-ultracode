# Spike findings — verified against opencode2 v0.0.0-beta-19151 (live, 2026-09-08)

All facts below were verified by running the probe plugin in `spike/scratch/.opencode/plugins/probe/`
under `opencode2 run --standalone`. Raw evidence: `spike/out/probe-log.jsonl`, `spike/out/server-logs.txt`.

## Plugin loading

- Local path plugins need `"plugins": ["./plugins/probe"]` in `.opencode/opencode.json` (auto-load of
  `.opencode/plugins/` alone did NOT work in this build) **and** a resolvable `@opencode/plugin`
  dependency — `npm install @opencode/plugin@beta` inside the plugin dir (281 packages).
- Install pattern for users: `npm install` at plugin root; reference by absolute path in global config.

## CRITICAL platform behaviors

1. **A throwing transform DISABLES the entire plugin.** Our skill transform threw
   (`SchemaError: Missing key ["location"]`) and the server logged
   `disabled plugin after transform failure`. Every `transform` call must be wrapped in try/catch.
2. **Never `await ctx.session.prompt` inside `setup()`.** Prompt admission waits for location plugins
   to be ready; setup awaited admission => deadlock (verified: prompt hung until our 90s timeout).
   All session driving must happen inside tool executors / commands (post-setup). Verified working.
3. `ctx.skill.transform` `editor.add` requires a `location` field (path to the skill markdown file) —
   the file should exist. Content is supplied alongside.

## Shapes (verified from live payloads)

### `ctx.agent.list()` → `{ location, data: AgentInfo[] }` (envelope, NOT a bare array)

Stock agents present on a bootstrapped install: `build` (primary), `plan` (primary), `general`
(subagent), `explore` (subagent), plus internal primaries `compaction`, `title`, `summary`.
A fresh server-only config (empty `XDG_CONFIG_HOME`) returns `data: []` — built-ins materialize
after client bootstrap. Global `~/.config/opencode/agents/*.md` pins did NOT load in a standalone
server for a scratch location (child ran on the location default model), while the shared service at
`~` DOES resolve them. => Always record `effectiveModel` from the assistant message; never assume
pins applied.

### `ctx.session.create({ title, agent })` → full `Session.Info`

Accepts `agent` (and `model`, `location`, `metadata`) directly at create time — no switchAgent call
needed. Returns `{ id, projectID, agent, tokens, cost, time, title, location, subpath }`.
`model`/`outcome` are undefined until the session actually runs.

### Tool executor 2nd arg (verified)

```json
{ "sessionID": "ses_...", "agent": "build", "messageID": "msg_...", "id": "call_...", "progress": [fn] }
```

- `sessionID` present => nested-run rejection + provenance solved at the executor.
- `progress` is a function: `await tool.progress({...})` — we call `report(status)` through it.
- **No abort signal** on the executor — parent-tool cancellation is not signal-based. Stop must go
  through our own registry + `session.interrupt`; if the parent tool promise survives interruption,
  it still resolves with the final envelope (both outcomes acceptable).

### `ctx.session.prompt({ sessionID, text })` → inbox user item (after admission)

```json
{ "id": "msg_...", "sessionID": "ses_...", "timeCreated": 0, "type": "user", "payload": { "text": "..." }, "delivery": "steer" }
```

### `ctx.session.wait({ sessionID })` → resolves when the session settles

After wait, `ctx.session.get` returns:
```json
{ "outcome": "succeeded" | "failed" | "interrupted", "tokens": { "input": 5603, "output": 5, "reasoning": 13, "cache": { "read": 256, "write": 0 } }, "cost": 0, ... }
```
`outcome` + `tokens` per child session = completion detection + accounting. (Session-level `cost` was
0 for the free model; per-message `cost` also available.)

### `ctx.session.context({ sessionID })` → session messages (NOT chat-format)

```jsonc
[
  { "id": "msg_...", "time": { "created": 0 }, "text": "Reply with exactly: PROBE_OK", "type": "user" },
  {
    "id": "msg_...", "time": { "created": 0, "streamed": 0, "completed": 0 },
    "type": "assistant",
    "agent": "general",
    "model": { "id": "inclusionai/ling-3.0-flash-sante:free", "providerID": "openrouter" },
    "content": [
      { "type": "reasoning", "text": "...", "state": {...} },
      { "type": "text", "text": "PROBE_OK" }
    ],
    "finish": "stop",
    "rawFinish": "stop",
    "cost": 0,
    "tokens": { "input": 5603, "output": 5, "reasoning": 13, "cache": { "read": 256, "write": 0 } }
  }
]
```

Extraction rule: last message with `type === "assistant"`; text = concat of `content` parts where
`part.type === "text"`; `finish` gives the stop reason; `model`/`tokens`/`agent` recorded per message.

### `ctx.session.hook("prompt", event)` — verified event shape

```jsonc
{ "prompt": { "text": "...", "files": [] }, "delivery": "steer" }
```

- `prompt.agents` / `prompt.skills` are **absent (undefined)** on plain prompts — initialize
  (`event.prompt.skills ??= []`) before pushing `{ id: "ultracode" }` (input schema requires only `id`).
- The hook fires for **every session in the location**, including workflow children — guard against
  re-attaching to owned children (check registry ownership via `event.sessionID` when present;
  the docs state session IDs are readonly-available on the event, but our probe did not log it —
  read defensively).

### Permissions (from agent records + docs)

Agent permission rules use actions like `read`, `external_directory`, `question`, `*`. Permission
evaluate hooks run for `allow`/`ask` decisions (configured `deny` is final, hooks cannot override).
`autoEditsWorkflow` must scope by active-run ownership + project root paths.

## Worker isolation

`node:worker_threads` Worker running `while(true){}` **after an await**: `worker.terminate()` kills
it in ~2ms, main thread unaffected (verified, `spike/worker-test.mjs`). Worker isolation is an
**availability** boundary only — NOT a security sandbox (documented in README).

## Known open items (verify during integration test)

- Whether `/ultracode stop` executes while the parent tool call is pending (supervisor is correct
  either way; UX-only).
- TUI inspect surface: see `docs/SPIKE-TUI.md` (beta-19271). `mini` / `run` do not load CLI plugins.
- Exact permission action names for edits (code defensively: configurable allowlist).
- Whether hook-pushed skills resolve (test live with the real plugin; fallback: append short
  instruction text to the prompt).
