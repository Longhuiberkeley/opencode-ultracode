# opencode-ultracode

Dynamic workflows ("ultracode") for OpenCode v2 — a plugin that lets the model *author* a small
JavaScript orchestration script, executes that script in an isolated worker, and spawns **real
opencode subagent sessions** for each step. Fan-out research, adversarial verification, per-item
pipelines, tournaments — expressed as code instead of a wall of manual delegation.

This mirrors Claude Code's dynamic-workflow capability: instead of the harness hard-coding every
multi-agent recipe, the model writes the orchestration on the fly and a runtime makes it real.

## Quickstart

**Install** (global; `npm install` in the clone first — the installer copies the dependency tree):

```bash
git clone https://github.com/Longhuiberkeley/opencode-ultracode.git
cd opencode-ultracode && npm install
scripts/install.sh --global --tui      # --tui adds the inspector UI
```

Project-local instead: `scripts/install.sh --project /path/to/your-project --tui`. Keep **one**
scope per project — a global plus project-local copy of the same plugin ID collides (`Duplicate
plugin ID: ultracode` in `/plugins`). Details and flags: [Install](#install).

**Trigger it:** put the standalone keyword `ultracode` in a normal message (no slash):

- `ultracode: audit src/auth and src/db, verify findings before reporting`
- `please ultracode this research task`
- `ultracode do an adversarial review of the api layer`

The skill attaches, the model writes a small orchestration script, and `ultracode_run` executes
it — every `agent()` call is a real subagent session with its own context window.

**Watch it run:** press **Ctrl+G** (or palette → `ultracode.inspect`):

| Key | Action |
| --- | --- |
| `[` / `]` | previous / next run (pins selection) |
| `.` | toggle follow-latest — new runs take focus automatically |
| `↑` / `↓` | move the tree / scroll the detail pane |
| `h` / `l` | switch panes: tree ↔ detail ↔ settings |
| `enter` | open the selected child session as a tab (see what it is doing) |
| `y` / `n` | review a pending child permission: allow once / reject |
| `p` / `x` / `s` | pause/resume · stop · save the workflow |
| `f` | full-screen presentation |
| `esc` / Ctrl+G | close |

**Configure:** `h`/`l` to the settings pane, `+`/`-` to edit concurrency, agent cap, timeout,
permission mode, and result size — values apply to the **next** run. Equivalent commands:
`/ultracode set <key> <value>`, or plugin `options` in `opencode.json` ([Options](#options)).

**Long runs:** workflows run in the background by default — you can keep chatting while they
run; poll `/ultracode status` or the panel, and steer a running child with `ultracode_steer`.
Ask for `background: false` if you want the result envelope inside the call.

**Uninstall:**

```bash
scripts/uninstall.sh --global          # or --project /path/to/your-project
```

The rest of this README covers security, internals, and the full command surface.

## How it works

1. Your prompt contains the standalone keyword `ultracode` (e.g. `ultracode: audit src/auth`,
   `please ultracode this`, or `ultracode do X and verify it`). The `Ultracode` skill auto-attaches
   and teaches the model the script API. Natural-language requests ("use a workflow to ...") do
   not auto-attach — the model can still choose to author one from the skill description.
2. The model invokes the **`ultracode_run`** tool with `{ graph, args? }` for a graph-authored run
   (a JSON DAG — validated and compiled server-side; preferred for standard shapes), `{ script, name?, meta?, args? }`
   for an inline run, or `{ workflow: "name", args? }` for a saved workflow.
3. The runtime validates the script (plain JS async-function body — no module syntax), preflights
   the agents declared in `meta.requires`, then executes it in a worker thread with injected
   globals: `agent`, `parallel`, `pipeline`, `phase`, `progress`, `workflow`, `sleep`, `console`,
   plus `args` and `meta` from the tool input.
4. Each `agent(prompt, opts)` call spawns a fresh subagent session (own context window, own model
   per your agent config) and waits for it. Child sessions are titled `[uc:<runID> <ord> <phase> p:<parentSessionID>] label` so
   they group visibly in your session list. Caps are enforced: concurrency, total agents, wall
   clock.
5. The script returns a small JSON value. Only that value plus a run envelope re-enters your
   session — child transcripts never pollute your context.

### Mapping to Claude Code's ultracode

| Claude Code concept | Here |
| --- | --- |
| Keyword-triggered workflow skill | Standalone `ultracode` keyword anywhere in the prompt attaches the `Ultracode` skill via a prompt hook |
| Model-authored JS orchestration | The `ultracode_run` tool takes a script (async function body) |
| Subagent execution | Every `agent()` call creates a real opencode session (spike-verified APIs) |
| Structural verification patterns | Verifier + skeptic + judge patterns; see `docs/AUTHORING.md` |
| Reusable workflows | Saved workflows by name, composable one level deep via `workflow()` |

## Security — read this first

**This is trusted-code execution.** Be deliberate about which scripts you run.

- **Exactly what executes where:** scripts run via `new Function` inside a `node:worker_threads`
  worker, with ordinary worker globals **minus shadowed network/DOM APIs** — `fetch`,
  `WebSocket`, `XMLHttpRequest`, `navigator`, and `importScripts` are shadowed with throwing
  stubs, and the module tokens `import` / `export` / `require` are rejected up front. The script
  sees the injected workflow globals (`agent`, `parallel`, `pipeline`, `phase`, `progress`,
  `workflow`, `sleep`, `console`, `args`, `meta`) plus pure JS builtins.
- **That is availability isolation, NOT a security sandbox.** The worker exists so a runaway
  loop, a hung promise, or an oversized fan-out can be terminated (`worker.terminate()` kills a
  busy loop in ~2ms, verified in the spike) without taking down the server. It is not a
  capability-isolated VM, the isolation is **enforced by omission** rather than a hard boundary,
  and **memory is not bounded**. Treat workflow scripts like any other code you would run.
- **Saved workflows are executable content, gated by the trust store.** A `.js` file under
  `.opencode/workflows/` runs with whatever permissions your agents have — and so does a
  `.graph.json` spec, which compiles to a script before it runs. Every saved workflow
  (samples included) requires a **one-time user approval** via `/ultracode trust <name>`, which
  records an approved digest of the script content that will execute (for a graph, the digest of
  the compiled output). Editing the script or the spec invalidates trust until it
  is re-approved — a changed workflow never runs silently. Review workflow diffs in code review
  like any other code; `/ultracode graph <name>` renders a spec's structure for that review.
- **Child sessions are real agents.** They inherit your config. The default permission mode
  `"ask"` keeps edit approval manual for workflow children. `autoEditsWorkflow` auto-approves
  edit-class actions for active run children scoped to the project root; `noEditTools` denies
  edit-class tools **and best-effort write-shaped shell commands** (`sed -i`, `tee`,
  redirections, `git commit`, opaque `sh -c …`) for active run children outright. See
  [Options](#options) and [Known limitations](#known-limitations).
- **Hidden prompts never hang a run.** Run children never surface a host permission dialog, so
  an unanswered "ask" would silently block until `timeoutMs`. The plugin watches
  `permission.asked` events: in `noEditTools` mode pending requests are rejected immediately;
  in other modes they are rejected after `permissionStallMs` (default 5 min; `0` disables). A
  rejection is visible in the child transcript (denied tool call) and the agent adapts — check
  `/ultracode status` for `waitingForPermission` while a run is in flight.
- **Isolation caveat for authors:** a "clean context" is NOT filesystem isolation. Two agents
  that write files concurrently will race on the same worktree. Orchestration scripts must
  serialize write agents (see `docs/AUTHORING.md`).

## Install

Keep one installation scope per project: a global copy plus a project-local copy
with the same plugin ID produces `Duplicate plugin ID: ultracode` in `/plugins`.
The installer reports a known competing copy. Backups belong outside `plugins/`
so auto-discovery cannot load them. Updates are built in a staging directory first;
copy failures preserve the previous installation. Publishing uses two directory
renames with rollback, not a zero-gap atomic directory exchange.

**Precondition:** `npm install` in this repo so the runtime dependency tree exists for the
installer to copy. The installer refuses to run until that is true.

```bash
git clone https://github.com/Longhuiberkeley/opencode-ultracode.git /path/to/opencode-ultracode
cd /path/to/opencode-ultracode
npm install
scripts/install.sh --project /path/to/your-project
# or: scripts/install.sh --global
# add --tui if you want the inspect UI (chip + panel + palette)
```

`scripts/install.sh` writes a **self-contained copy** into the plugin dir (verified on OpenCode
v2 beta-19271: `.opencode/plugins/*/index.ts` is enough; `--write-config` is optional). The
installed tree — sources, skill, generated manifest, and the `@opencode/plugin` dependency tree
— is **relocatable**: it contains no paths into your source checkout and keeps working after
the source checkout is moved or deleted (assumes a plain `npm install` tree — no `npm link`):

| Flag | Effect |
| --- | --- |
| `--project DIR` | Install into `DIR/.opencode/` (default: cwd) |
| `--global` | Install into `~/.config/opencode/` |
| `--tui` | Also write sibling `tui.tsx` (inspect UI **opt-in**; host auto-loads it next to `index.ts`) |
| `--write-config` | Merge a `plugins` entry into the target `opencode.json` only if no entry with the same package path exists |
| `--no-deps` | Skip the `node_modules` copy (tests/dev only — the plugin then needs `@opencode/plugin` from elsewhere) |
| `--repo PATH` | Plugin repo root (default: parent of the script) |

Reruns are idempotent (same files, never duplicate config). No network. An existing v1 install
(absolute-path re-export shims) is migrated automatically to the new layout. Platform status:
**macOS verified** end-to-end (live TUI); Linux runs in CI (unit + installer tests); Windows
untested.

**TUI opt-in:** omit `--tui` for server-only (`ultracode_run` + `/ultracode`). Add `--tui` when
you want the chip + inspect panel. Remove `tui.tsx` or run `scripts/uninstall.sh` to drop it;
the server half keeps working.

**Manual install (fallback if you do not want the script):** copy `src/`, `skills/`,
`package.json`, and `node_modules/@opencode/plugin` (plus its transitive deps) into
`<project>/.opencode/plugins/ultracode/`, then write these two entries — note the **relative**
paths; the OpenCode TUI client rejects absolute-path imports (verified the hard way):

```ts
// <project>/.opencode/plugins/ultracode/index.ts
export { default } from "./src/index.ts"
// optional sibling, only if you want inspect UI:
// <project>/.opencode/plugins/ultracode/tui.tsx
/** @jsxImportSource solid-js */
export { default } from "./src/tui.tsx"
```

Optionally list it in `.opencode/opencode.json` (relative path from that file):

```json
{
  "plugins": [
    { "package": "./plugins/ultracode", "options": { "concurrency": 8 } }
  ]
}
```

A bare absolute `"package": "/path/to/opencode-ultracode"` entry was **silently skipped** on
beta-19271; prefer the auto-load plugin dir. If load fails, check server logs for
`failed to load plugin` / `disabled plugin after transform failure`.

### Uninstall

```bash
scripts/uninstall.sh --project /path/to/your-project
# scripts/uninstall.sh --global
# scripts/uninstall.sh --project DIR --purge              # runs/ + matching skill mirror
# scripts/uninstall.sh --project DIR --purge-workflows --yes
```

Removes the ultracode install — every file this installer wrote (v2 copy tree or v1 shims),
identified by an install marker / layout check, **without needing the source checkout**. It
never touches other plugins or foreign files inside the plugin dir. `--purge` deletes
`<target>/.opencode/workflows/runs/` and `ultracode-skill.md` only if that file is still
byte-equal to `skills/ultracode.md`. `--purge-workflows` deletes saved `*.js`/`*.json` pairs
after confirmation (`--yes` skips the prompt). Without that flag, saved workflows are left in
place.

**Data / KV:** run, result, and trust keys in OpenCode project KV are harmless residue. No
shell can compute project KV ids; they disappear with an OpenCode data reset.

Recommended `.gitignore` entries for projects using the plugin:

```gitignore
.opencode/workflows/runs/   # per-run script artifacts — noise, don't commit
# do NOT ignore .opencode/workflows/ itself if you share saved workflows via the repo
```

## Options

All optional; defaults shown. Unknown keys are ignored (with a warning in logs), bad values fall
back to defaults.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agent` | string | `"general"` | Default agent id for `agent()` calls that omit `opts.agent`. Validated at run start — fail fast if missing. |
| `concurrency` | number | `8` | Parsed 1–64 in config; **effective max 8** at admission (local clamp to this repo default, not a host API). Extra `agent()` calls queue FIFO. |
| `maxAgents` | number | `200` | Max total `agent()` calls per run (panel `+/-` steps by 10 within 1–10000). A runaway fan-out fails the run instead of burning tokens forever. |
| `timeoutMs` | number | `3600000` | Wall-clock limit per run (60 min). Panel cycles presets `600000` / `1800000` / `3600000`. On timeout: children interrupted, worker terminated, run finalized. |
| `permissions` | string | `"ask"` | `ask` (host user prompt for children — recommended), `autoEditsWorkflow` (auto-approve edit-class actions for active run children inside the project root), `noEditTools` (deny edit-class tools **and best-effort write-shaped shell commands** — `sed -i`, `tee`, redirections, `git commit`, `sh -c …` — for active run children; `/dev/null` and `2>&1`-style redirects pass). Panel cycles these three. |
| `permissionStallMs` | number | `300000` | Auto-reject a child's pending permission request after this many ms unanswered, so runs fail visibly instead of hanging on prompts the user cannot see. `0` disables. `noEditTools` rejects immediately regardless. Not a panel setting. |
| `maxResultChars` | number | `65536` | Max serialized result returned to the session; larger results come back as a compact `preview` + `truncated: true` + `resultChars`, full value retrievable page-by-page via the `ultracode_result` tool (or `/ultracode result <runID>` for humans). |

Panel settings (`h`/`l` to the settings pane, `+/-` to edit) persist a project-scoped KV overlay and refresh next-run defaults. Changes apply to the **next** run only — in-flight runs keep the snapshot captured at `startDetached`.

**Per-run `timeoutMs` override:** every `ultracode_run` form (`script` / `workflow` / `graph`) also accepts an optional `timeoutMs` (integer ms, `10000`–`864000000` — the same bounds as `/ultracode set timeoutMs`). It applies to that one run only, never touches the persisted overlay, and is captured on the run's `effective` settings. Raising above the configured default is allowed by design — the agent-count caps still bound cost — and is always visible: echoed in the background admission ack and shown by `ultracode_status`; a warm `/ultracode rerun` reproduces an explicit override. All other knobs stay user-only.

```json
{
  "plugins": [
    {
      "package": "./plugins/ultracode",
      "options": {
        "agent": "general",
        "concurrency": 8,
        "maxAgents": 200,
        "timeoutMs": 3600000,
        "permissions": "ask",
        "permissionStallMs": 300000,
        "maxResultChars": 65536
      }
    }
  ]
}
```

## Usage

The skill auto-attaches when `ultracode` appears as a **standalone** keyword anywhere in the
prompt (whitespace-delimited, optionally followed by a colon). Before/after:

| Prompt | Auto-attach? |
| --- | --- |
| `ultracode: audit src/auth and src/db for security issues` | yes |
| `ultracode do a deep research pass on agent evals` | yes |
| `ultracode` | yes (bare keyword) |
| `please ultracode the audit` | yes — standalone keyword anywhere |
| `look at opencode-ultracode/docs` | **no** — paths and names don't attach |
| `use a workflow to fact-check this draft` | no auto-attach, but the model may still author one |

Ultracode is for **multi-agent orchestration with an isolated script and structural verify**.
Native subagents (`general` / `explore` / Task) are for **one** focused child. Ultracode
composes with those native OpenCode subagents: it spawns ordinary child sessions users already
know; it does not replace or hide them. Plan mode: author `.opencode/workflows/<name>.js` +
`/ultracode save <name>` + `/ultracode trust <name>`. Build mode: `{ workflow: name }`. Do not
mix native fan-out and a workflow in one task; children do not inherit parent skills — restate
rules inside `agent()` prompts.

Examples that work:

- `ultracode: research the state of WASM audio engines and verify every claim before reporting`
- `ultracode do an adversarial security audit of auth and db, reviewed in batches`
- `ultracode: fact-check this blog draft against these three sources`
- `run the deep-research workflow on agent evals, angles: technical, market, criticism` (plain
  language — the model resolves it to a saved workflow **after you copy and `/ultracode trust` the sample**)

The model invokes the `ultracode_run` tool, e.g.:

```json
{ "workflow": "deep-research", "args": { "topic": "agent evals" } }
```

or inline with a script it wrote itself (see `docs/AUTHORING.md` for the full script API).

By default the tool returns immediately after admission + script validation with
`{ runID, status: "running", hint }` — the run continues detached and the conversation stays
available; watch the inspect panel (`ctrl+g`) or poll status. When the run settles, the plugin
appends a one-line settle notice to this session — status, agent counts, a bounded result
brief, and the stop reason — and that notice **wakes the parent agent** (live-verified), so
long runs resume the conversation on completion instead of requiring blind polling. Pass
`background: false` when you want the full envelope in-call instead.

The blocking envelope looks like:

```json
{
  "runID": "run_ab12cd34ef56",
  "name": "deep-research",
  "status": "succeeded",
  "durationMs": 214000,
  "agents": { "total": 8, "succeeded": 8, "failed": 0, "interrupted": 0 },
  "tokens": { "input": 412000, "output": 18200, "reasoning": 9400, "cache": { "read": 98000, "write": 0 } },
  "models": ["xai/grok-4.6"],
  "result": { "report": "...", "stats": { "...": "..." } },
  "truncated": false
}
```

## Commands: `/ultracode`

`/ultracode` is the only slash command this plugin registers. There are no `/workflow` or
`/workflows` aliases — those names are left free so a future OpenCode release cannot collide.

`/ultracode` is **management only**. To *author* a run, send a normal message containing the
keyword `ultracode` (no leading slash).

**Implicit targets:** `show` / `result` / `pause` / `resume` omit runID → the single active
run (0 → "no active run", many → list IDs). `stop` requires an explicit runID unless exactly
one run is active. `rerun` omit → most recent **final** run (refuses an active source).

Panel action keys (panel-hosted inspect; same verbs via `client.session.command`) fire only
while the inspect panel is focused — they are not dialog-hosted. The Ctrl+G panel opener is
global (registered from the always-mounted chip component).

| Command | Effect | TUI key |
| --- | --- | --- |
| `/ultracode` | Dashboard: plugin/min-build line, active (including paused), recent, saved workflows. | **Ctrl+G** or palette `ultracode.inspect` opens the panel |
| `/ultracode show [runID]` | Full run report (D11 cells + sessionID): status, agents, tokens, tools, script. | — (server parity floor) |
| `/ultracode status [runID]` | Compact run state: runID, status, agents done/total, elapsed. Same implicit-target rule as `show`. | — |
| `ultracode_status` tool | Read-only `{ runID? }` → `{ runID, status, agents: { done, total, failed }, startedAt, elapsedMs, checkpoints?: [{name, at}], resumedFrom?, children: [{ agentID, sessionID?, label?, phase?, status, cached?, waitingForPermission? }] }`; settled runs carry the result inline when it fits the cap, else `resultPreview` + `resultTruncated` + `resultChars` + `resultHint`. | — |
| `ultracode_result` tool | `{ runID, offset?, maxLength? }` → one page of a settled run's FULL result: `{ source, totalChars, offset, chunk, complete, nextOffset }`. Chunks are substrings of the compact JSON — concatenate from offset 0 following `nextOffset`, then parse. | — |
| `ultracode_catalog` tool | Read-only discovery, and the only fresh source of it: `{}` → agents, live caps, every saved workflow (`kind`, description, **params (names always; JSON types only when declared — explicit params, a // Tool input: header, or a saved run's real args; graph-derived params are names only)**, phases, requires, trust, last-run stats from this conversation), graph-template summaries and script-template summaries; `{ workflow }` → one workflow's full graph spec or script head; `{ template }` / `{ templates: true }` → complete graph specs to adapt; `{ scriptTemplate }` / `{ scriptTemplates: true }` → complete script bodies to adapt (`staged-delivery`, `verify-fix`). Executes nothing; bounded (40 workflows, sliced strings). | — |
| `ultracode_control` tool | Orchestrator control of **owned** runs: `{ action: "stop" \| "pause" \| "resume", runID? }`. Implicit target only when exactly one active owned run. Stop is recorded as the run's stop reason (`/ultracode show` displays it). | same verbs via panel keys |
| `/ultracode result [runID]` | Print the **full** result of a run (artifact first, run-record fallback — serves truncated and background runs alike). | — |
| `/ultracode graph <name\|runID>` | Render a graph workflow's DAG: execution waves, a node table (kind, agent, source ref, bounds), returns, and a mermaid flowchart. **Not trust-gated** — rendering is how you review a graph before approving it. Works for a saved `<name>.graph.json` workflow or any graph-authored run. | — |
| `/ultracode stop [runID]` | Graceful stop: no new agent calls, children interrupted, worker terminated after a grace period. | `x` |
| `/ultracode pause [runID]` | Close admission of new `agent()` calls; in-flight finish; watchdog suspended. | `p` (toggles pause) |
| `/ultracode resume [runID]` | Reopen admission on a paused run. | `p` (toggles resume) |
| `/ultracode rerun [runID] [argsJSON]` | Start a new run from a finished run's script (trust/digest checks if it was a named workflow; graph runs compare the **spec**, so a newer compiler is not mistaken for an edit). Add `--warm` to warm-start: keyed succeeded agents replay from the source run's cache instead of respawning (see [Warm reruns](#warm-reruns)). | — |
| `/ultracode save <name>` | Save `.opencode/workflows/<name>.js` **or** `<name>.graph.json` as a named workflow (no prior run). An authored `<name>.json` manifest is preserved; a graph spec file is never rewritten. | — |
| `/ultracode save <runID> <name>` | Save a run as a named workflow: a graph run saves its **spec** (`.graph.json` + manifest), a script run saves its script (`.js` + manifest). | `s` (name via `dialog.prompt`) |
| `/ultracode settings [runID]` | Next-run overlay plus that run's captured snapshot. | settings pane (`h`/`l`); `r` refreshes an **active** run |
| `/ultracode set <key> <value>` | Persist overlay (`concurrency`, `maxAgents`, `timeoutMs`, `permissions`); applies to the **next** run. | `+`/`-` in settings pane |
| `/ultracode trust <name>` | One-time approval for a saved workflow (content digest). | — |
| `/ultracode untrust <name>` | Revoke trust for a saved workflow. | — |
| `/ultracode help` | Print this command list and the authoring hint. | — |
| (select / drill) | Move the inspect tree; expand/collapse; open the selected child session tab. | `↑` `↓` move · `←` `→` expand · `h` `l` pane · `enter` drill · `[` `]` run · `esc` or `ctrl+g` close |

## Inspect UI

Opt-in TUI (`scripts/install.sh --tui` / sibling `tui.tsx`). Fail-soft: every slot, keymap,
dialog, and toast call is try/caught; a missing host API never takes down the CLI. Version
gate: channel `beta` and binary `0.0.0-beta-NNNNN` with **NNNNN ≥ 19271** (`shouldEnableTui`).
Older or unknown builds skip TUI registration; `/ultracode show` remains the server-only
parity floor. The Ctrl+G opener is spike-verified on beta-19271; on builds where the host
claims Ctrl+G for its own navigation, the palette entry is the fallback once palette listing
surfaces bindless entries.

The inspect panel never auto-sends `settings` (or any other) `session.command` on open,
pane switch, or run cycle — those writes are steered inbox items. The settings pane paints
cached overlay / per-run effective values from already-received `session.synthetic` acks
and shows **unknown** when stale. Press `r` in the settings pane for **one** deliberate
refresh of an **active** run: when plugin RPC is present it calls `settings` on that
channel (no session message, no agent wake); if RPC is missing or the call fails it
falls back to `settings <runID>` via `session.command`. Pause/resume/stop stay on the
existing user-intent command path.

**Conversation-owned runs (v0.3.3):** Ctrl+G lists recent live and persisted runs for
the current conversation. The selected run has a `*`; each row shows its lifecycle
status. `[` / `]` select and pin history; `.` toggles **follow-latest** so a new run
can take focus across Plan → Build. The status chip distinguishes workflow runs,
active agents, queued agents, and requests **awaiting permission**. An authoritative
running workflow remains visible between agent stages. The default inventory is the
newest 50 runs (RPC limit up to 100); `/ultracode show <id>` remains available for older IDs.

Permissions from owned children appear in this inspector: `y` opens a full-request
confirmation for **allow once**, `n` reviews rejection, and Enter navigates to the
blocked child. No permission is automatically approved — but pending requests on
owned children may be **auto-rejected** (immediately in `noEditTools`, after
`permissionStallMs` otherwise) so an unseen prompt never hangs the run. Full
selected task labels
wrap in the detail pane; `h/l` selects panes and up/down scrolls detail text. Press
`f` for the host's full-screen presentation when supported. Stop/pause actions are
disabled for finished runs.

Launch long work normally — runs are background by default, so you can keep chatting. The orchestrator can use
`ultracode_steer { runID, agentID?, text }` to pass an adjustment to a running child
without killing the workflow or restarting finished children, and
`ultracode_control { action, runID? }` to stop / pause / resume runs it owns. Steering
acknowledges admission, not that the child has already applied the adjustment. Background
completion appends a one-line settle notice to the parent session and wakes the parent
agent (live-verified) — status, agents, result brief, and stop reason arrive in-conversation.

**Authoritative status (RPC-gated):** the server registers an optional
`ultracode` RPC (`runStatus`, `settings`) behind a capability check. `runStatus`
reads the **live** registry first, then **persisted** run records for historical
ids, including child-session references independent of the client session cache.
Chip counts and panel run status prefer that snapshot. If `ctx.rpc.register` /
`client.rpc` is missing or a call fails,
the TUI keeps the session-derived heuristics **silently** — an RPC error never
takes down the chip or panel. Heuristic children with empty outcome, no execution
observation, and no session `time.updated` (else `created`) within 15 minutes
(`FALLBACK_STALE_MS`) are not counted as running.

| Piece | Where | What |
| --- | --- | --- |
| Chip | `prompt.footer.status` | Conversation- and location-scoped; separate runs, agents and permission waits. Hides when idle. RPC is authoritative; fallback heuristics count observed running children. |
| Panel | `session.panel` contribution `ultracode.inspect` | Same conversation scope; visible run list, phase→agent tree, wrapped detail pane and permission actions. |
| Palette | command `ultracode.inspect` (bind **Ctrl+G**) | Toggles the panel via `ui.panel.current()`; stay on the parent session |
| Overlay keys | `keymap.layer` **inside** the panel component | `↑↓` move, `←→` expand, `h/l` pane, `enter` drill, `[ ]` run, `p` pause/resume, `x` stop, `s` save, `r` refresh (settings, active run), `esc` or `ctrl+g` close |
| Toast | `ui.toast.show` | Completion (envelope / quiet-window heuristic) and post-save trust hint |

**Panel keymap**

| Key | Action |
| --- | --- |
| Ctrl+G (chip, prompt owns input) | Toggle inspect panel |
| Ctrl+G / Esc (panel owns input) | Close panel (`esc` and `escape` binds; footer: esc or ctrl+g close) |
| ↑ / ↓ | Move tree (or detail scroll) |
| ← / → | W3C collapse / expand (Right is not drill) |
| h / l | Tree ↔ detail ↔ settings |
| Enter | Open selected child tab when tabs enabled |
| [ / ] | Previous / next run (tree header shows `run k of N` plus run id) |
| . / f | Toggle follow-latest/pin; toggle full-screen presentation |
| y / n | Review the first pending child permission and allow once / reject |
| p / x / s | Pause/resume, stop, save (user-intent keypresses; same command transport) |
| + / − | Edit focused settings row (next run) |
| r | Settings pane: one deliberate refresh for the **selected active** run (RPC when available, else `session.command`). Never auto-queried; settled/unknown runs are skipped. |

**Manual smoke-test checklist (physical keys; not covered by unit tests):**

1. Open the empty inspect panel (`no ultracode runs`). Press Escape. Panel closes. Focus returns to the prompt.
2. Reopen. Press Ctrl+G. Panel toggles closed. Focus returns to the prompt.
3. Repeat 1–2 with an active run (tree populated). Escape closes; Ctrl+G toggles closed; focus returns to the prompt.
4. Start a run (background by default). Confirm the tool returns `runID` immediately; `/ultracode status` / `ultracode_status` show it running; chip/panel update; on completion a one-line settle notice lands in this conversation and wakes the parent agent.
5. Change a settings pane value (`+/-`). Confirm the live strip / `/ultracode settings` overlay updates and the **next** run uses it (current run unchanged).
6. Settings pane shows cached overlay / per-run effective from already-received acks, or **unknown** when stale. Opening or cycling runs must **not** send a settings query. Press `r` on an active run to refresh once; `r` must no-op on settled/unknown runs.
7. Tree pane header shows `run k of N` plus the run id; `[` / `]` cycle runs and restore per-run tree selection.
8. With an active run, move the tree cursor onto an agent row and press Enter — the child session opens as a tab (`tabs.open` adds it when tabs are enabled; the view navigates when they are not). Pressing Enter on a run or phase row is a no-op.

**Why the two-column inspector is panel-hosted, not `ui.dialog.show`:** G1 on beta-19271 —
the host dialog owns the keymap. `keymap.layer` from a component mounted inside `dialog.show`
does not receive keys; `onKey*` props and `dialog.set` extras are presentation-only. Overlay
keys therefore live on `session.panel` (priority 90), which is the verified working layer
when no host dialog is open. `ui.dialog.prompt` is used only for the save-name flow.

### Parity vs Claude Code inspector

| Surface | Here | Notes |
| --- | --- | --- |
| Header | yes | Short run id, agent counts, elapsed (`twoColumn` / `runHeaderCells`) |
| Phases | yes (expandable phase→agent tree) | Left pane; observed first-appearance order; default expanded |
| Agents | yes | Tree children + right detail pane (status, agent, model, tokens, session, tools). Store `agent` is live; model/tools see below. |
| Tokens | yes | Per-agent from the client store (A2) |
| Model | partial | Live in `/ultracode show`. TUI: on-demand for the **selected** row via session messages; "-" on other rows until selected. |
| Tools | partial | Live in `/ultracode show` (`AgentRecord.toolCalls` reducer). TUI: on-demand for the **selected** row (tool parts); "-" elsewhere. |
| Pause | yes | Key `p` → pause/resume. TUI pause state is **intent-based** (updated only after `session.command` resolves; rejection → error toast, no toggle). `session.synthetic` ack events were **not** observed on the TUI bus during live p/x on beta-19271; `parseRunAck` is ready if they appear. Transport e2e (receipts + `stopped` envelope) is enforced by `scripts/tui-probe.sh --live` but reports `transport SKIPPED` when no real run spawns in the probe window (flaky with a coexisting global ultracode plugin — see docs/INTEGRATION-TEST.md §9b). |
| Pagination | yes | Page height 10; `N of M` / ↓ when more rows |
| Stop | yes | Key `x` → `/ultracode stop` |
| Pause | yes | Key `p` → pause/resume |
| Save | yes | Key `s` → `dialog.prompt` → `/ultracode save` |
| Select | yes | `↑` `↓` move the tree (or detail scroll when the detail pane is focused and longer than 10 lines) |
| Expand | yes | `←` `→` W3C expand/collapse (Right is not drill) |
| Pane | yes | `h` / `l` tree ↔ detail |
| Drill | yes | `enter` → `tabs.open` child when tabs enabled and the cursor is an agent |
| Close | yes | `esc` closes; **Ctrl+G** toggles (chip when the prompt owns input; panel layer while the panel owns input) |
| Dialog-hosted keys | **no** | Deliberate: host dialog steals the keymap (G1 NO-GO) |
| Mid-tool freeze | **no** | Deliberate: in-flight tool calls finish; pause only closes admission |

### Paint checklist

Reproduce against the recorded binary:

```bash
scripts/tui-probe.sh --live
```

Captures land in `spike/out/tui-live-<timestamp>.txt` (plus `.ansi` / `tui-live.jsonl`) —
local-only, git-ignored; never committed. `assert_live_paint` in the probe greps the stripped
text. Exact needles from the live captures / probe:

```bash
# chip
grep -F 'ultracode ·' spike/out/tui-live-*.txt
# panel marker (always painted, even with no runs)
grep -F 'UC-INSPECT' spike/out/tui-live-*.txt
grep -F 'ultracode inspect' spike/out/tui-live-*.txt
# two-pane footer (panel always paints these; no leftover "Phases" column)
grep -F 'h/l pane' spike/out/tui-live-*.txt
grep -F '←→ expand' spike/out/tui-live-*.txt
grep -F 'esc or ctrl+g close' spike/out/tui-live-*.txt
grep -F 'x stop' spike/out/tui-live-*.txt
grep -F 'p pause' spike/out/tui-live-*.txt
```

G1 dialog-keys (expect **NO-GO** on beta-19271): `scripts/tui-probe.sh --dialog-keys` →
`G1-DIALOG-KEYS` in the stripped dump, zero `dialog-keys-receipt` in jsonl, `G1LEAK` absent.

### Versions

| Piece | Pin |
| --- | --- |
| OpenCode **binary** (verified) | `0.0.0-beta-19271` |
| `@opencode/plugin` **package** (repo pin) | `0.0.0-beta-19289` |

Builds differ; the TUI version gate keys off the **binary** build, not the plugin package.
The `/ultracode` dashboard first line repeats the plugin version and min OpenCode beta-19271.

## Checkpoints and warm reruns

Long runs die — timeouts, restarts, stops. Two primitives make that cheap instead of fatal:

- **`checkpoint(name, value?)`** (script global): persists a named phase-boundary snapshot onto the
  run record. Visible in `/ultracode show` (name, time, value preview) and `ultracode_status`
  (`checkpoints`); newest 50 kept. Gates between phases stay one cheap reviewer child — never a
  gate fan-out (the wall clock is the binding constraint).
- **Keyed replay** (`opts.key` on `agent()` + `resumeFrom` tool input / `/ultracode rerun --warm`):
  keyed successes persist a digest (prompt + schema + resolved agent) and their final text. A warm
  rerun returns matching key+digest results from cache — no session, no concurrency slot, no
  `maxAgents` consumption; the replay is recorded as `cached: true`, the envelope carries
  `resumedFrom`, and replays contribute zero tokens to the new run. Pending-write semantics: a
  resumed run never redoes successful children; changed prompts (digest mismatch) always spawn.

Design grounding and the evidence behind "no direct child-to-child channels" live in
`docs/DESIGN-DECISIONS.md` (D1).

## Cost control

Workflows multiply tokens. Controls, in order of leverage:

1. **Route via subagents, not models.** Scripts reference *agent ids* (`general`, `explore`, your
   own specialists) and never provider/model ids. Pin which model each agent runs in your
   OpenCode agent config (`~/.config/opencode/agents/<id>.md` or
   `<project>/.opencode/agents/<id>.md`, project wins). A typical shape: cheap agent for
   extraction/search fan-out (`explore`), strong agent for judgment/synthesis (`general` or
   your `reviewer`).
   No model or provider id appears anywhere in this plugin; children run as **your** configured
   agents **on your pinned models**: the plugin reads the same documented agent config the
   client reads and applies the pin when creating each child session (OpenCode's server-side
   `session.create` does not apply global pins itself — live-verified). Unpinned agents fall
   back to the location default. Every run records the `effectiveModel` each child actually
   used and the envelope lists the distinct `models`, so drift is visible, never silent.
2. **Pins hot-reload.** Re-pinning an agent mid-run applies to the *next spawned agent* —
   already-running sessions keep their model. You can retune a long run without stopping it.
3. **Watch the tokens.** Every envelope carries summed token usage; `/ultracode show <runID>`
   breaks it down per agent, including the `effectiveModel` each child actually ran (see
   Troubleshooting for pin drift).
4. **Cap the fan-out in the script.** Good scripts bound items (`slice(0, 12)`), claims, and
   retry iterations — `maxAgents` is the backstop, not the budget.

## Saved workflows

- Two artifact kinds, one manifest: a **script** workflow is `<name>.js` (plain async body) +
  `<name>.json`; a **graph** workflow is `<name>.graph.json` (the DAG spec) + `<name>.json` with
  `kind: "graph"`. Manifest v1 fields: `version`, `name`, `description`, `phases`, `requires`,
  `hash`, `source`, `savedAt`, optional `savedFromRunID`, `kind`, `params`. A graph's script is
  **compiled fresh on every load** — the spec is the artifact, never a stale generated file.
- A name is either a script or a graph, never both: saving one kind while the other artifact
  exists is **refused** (a silent shadow would make the save a no-op). If both somehow exist on
  disk, `<name>.js` wins and the graph is ignored.
- Locations: `<project>/.opencode/workflows/` **beats** `~/.config/opencode/workflows/` on name
  collisions. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`; no path traversal.
- **Trust:** running a saved workflow requires a one-time `/ultracode trust <name>`. Trust is
  bound to the digest of the script that will actually execute — for a graph workflow that is the
  digest of the **compiled** output, so approving a graph approves the code that runs. Editing the
  script or the spec refuses the run until you re-trust, and so does upgrading the plugin when the
  compiler output changes (fail closed, by design). A spec that fails to parse, validate or compile
  can never be trusted or run: it is listed with its validator errors instead of disappearing.
- **Params are declared, not guessed.** Each manifest can carry `params` — `{ args: [{ name,
  type?, required?, description? }] }` — and it is **derived at save time** when you do not write
  it: from a `// Tool input:` header comment (which declares optional markers and example types),
  from every `args.x` reference in the code (including the `const input = args && …` alias idiom),
  from a graph spec's `{{args.x}}` templates and `$args.x` refs, and from the real `args` of the
  run being saved. An explicit `params` always wins, field by field. `ultracode_catalog` serves it,
  so a caller learns a workflow's contract without reading its code.
- **Reviewing a graph before approving it:** `/ultracode graph <name>` renders the DAG (execution
  waves, node table, mermaid) and is deliberately **not** trust-gated — seeing the structure is
  how you decide. `/ultracode graph <runID>` renders the spec a run was launched from.
- **Sharing:** commit `.opencode/workflows/` (the pairs, not `runs/`) to your repo.
  Collaborators approve each workflow once with `/ultracode trust <name>` after reviewing it.
- **Samples:** `workflows/samples/` ships `deep-research`, `code-audit`, `fact-check`, and
  `dev-loop` pairs that use stock agents (`dev-loop` review defaults to general; pass
  `args.reviewer` when you have a reviewer specialist). Copy both files into your project's
  `.opencode/workflows/`, review them, then `/ultracode trust <name>` — samples are gated by
  the same trust flow as any other saved workflow. Sample manifests carry `hash: ""` (the
  loader tolerates the empty hash for these reviewed, in-repo samples); user-saved workflows
  always get a real hash.
- **`dev-loop` usage:** `{ workflow: "dev-loop", args: { task: "…", repo?: ".", scope?: "…", fixPasses?: 3 } }`.
  Phases: explore (one explore agent, findings schema) → implement (one general writer, tests
  + typecheck until green) → verify (independent general rerun of tests/static checks) →
  review (blockers schema; general fallback) → fix (bounded loop, max 3 passes with recheck).
  Returns `{ ok, task, blockers, stats }`.
- Saved workflows can be composed one level deep from another script via `workflow(name, args)`.

## Stock installs (zero config)

A default bootstrapped opencode install has the `general` (general-purpose) and `explore` (fast
codebase exploration) subagents — every sample and the default `agent` option work out of the box
(once trusted).

Fresh **server-only** setups can report an empty agent list (built-ins materialize only after
client bootstrap — verified in the spike). In that case the run preflight fails fast with the
list of available agents and guidance instead of spawning a broken run.

## Known limitations

- **No auto-cancel of children when the parent session is interrupted.** Interrupting the parent
  prompt does not by itself stop a running workflow — use `/ultracode stop <runID>` (the
  envelope still arrives when the run finalizes).
- **Children using opencode's native subagent tool escape per-run caps and permissions.** If a
  workflow child spawns its own subagents through opencode's built-in delegation, those
  grandchildren are not counted against `concurrency` / `maxAgents` and do not pass through this
  plugin's permission scoping. Keep modifying agents serialized regardless.
- **Permission auto-modes are not policy-monotonic with other plugins.** `autoEditsWorkflow`
  allows some actions this plugin's children request, but another plugin's hooks may still deny
  or ask; combined effects are not guaranteed to be stricter-than-ask in every configuration.
  `"ask"` is the recommended default.
- **`noEditTools` shell-write detection is best-effort, not a sandbox.** Write-shaped commands
  are denied by token/redirect analysis of each parsed command string (`sed -i`, `tee`, `>`
  redirections, `rm`/`mv`/`cp`, mutating git subcommands, `sh -c …`). Constructs it cannot
  inspect fail closed, but determined code can still reach interpreters whose flags it does not
  model (`python -c`, `node -e`, package managers). Read-only guards at the agent level
  (allowlist frontmatter) remain the stronger boundary; the mode is defense-in-depth for the
  default agent.
- **Scripts are trusted code** (see Security) — the worker is an availability boundary, not a
  sandbox; memory is unbounded.

## Troubleshooting

| Symptom | What's going on / what to do |
| --- | --- |
| Plugin doesn't load, no `ultracode_run` tool | Check server logs for `disabled plugin after transform failure` — a throwing registration disables the plugin. Re-check config path and `npm install`. If the supervisor module failed to import, the tool is disabled with an explanatory message rather than half-working. |
| Skill doesn't attach | The keyword must be a standalone token (`ultracode: ...` / `please ultracode this`). Paths like `opencode-ultracode` and ids like `ultracode_run` deliberately don't trigger. |
| Saved workflow refused: "not trusted" | Expected after first copy or after any edit. Review the script, then `/ultracode trust <name>`. Trust is content-bound; re-trust after every intentional edit. |
| The model hangs on a prompt | Session-driving must never happen inside plugin `setup()` (admission deadlock — spike-verified). The plugin is built around that rule; if you still see a hang, capture logs and report. |
| `/ultracode stop` seems ignored | Stop is graceful: in-flight agent calls get a grace period, children are interrupted, then the worker terminates. The envelope arrives when the run actually finalizes. |
| Child ran the "wrong" model (pin drift) | Children apply the agent pin from `~/.config/opencode/agents/<id>.md` / project `.opencode/agents/<id>.md` (project wins) at session create; re-pinning applies to the **next** spawned child. Unpinned agents use the location default — which on some installs is a free-tier model. Runs record `effectiveModel` per agent and the envelope lists distinct `models`; check `/ultracode show` to confirm. |
| Result came back truncated | The script returned more than `maxResultChars`. The envelope carries a compact `preview`, `resultChars`, and usually a `resultArtifactKey`; page the full value with the `ultracode_result` tool (or print it with `/ultracode result <runID>`), raise the option, or return a summary instead of a dump. |
| Run status `interrupted` after restart | Persisted `running`/`stopping` runs are marked `interrupted` on plugin load. There is no auto-replay; re-run the workflow. |
| Nested `ultracode_run` tool call rejected | By design: sessions owned by a running workflow cannot start their own runs (no recursion). |
| `/ultracode can …` (or other prose) is "Unknown argument" | `/ultracode` is management only. To author a workflow, send a normal message such as `please ultracode …` without the leading slash. |
| `npm test` fails with "Cannot find module .../test" | Node 22.13 quirk with `--test <dir>`. Run `node --experimental-strip-types --test` (auto-discovery) or pass the test file(s) directly. |

## Roadmap

- **Graph authoring layer (v0.8.0 inline → v0.9.0 saved → v0.10.0 discoverable)** — a JSON DAG
  spec (agent / fanout / partition / merge / gate / checkpoint / workflow nodes) validated before
  any token is spent and compiled to the plain script runtime, with auto-keyed calls (warm rerun
  free) and automatic `parallel()` waves. v0.9.0 made graphs first-class citizens: they save as
  `<name>.graph.json` pairs (compiled fresh on load, trust bound to the compiled output), a graph
  run keeps its spec on the run record so `save`/`rerun`/`show` work from the source of truth, and
  `/ultracode graph <name|runID>` renders the DAG. v0.10.0 made them discoverable: the
  `ultracode_catalog` tool serves saved workflows with their derived `params`, plus three
  ready-to-adapt graph templates, and the authoring skill is graph-first.
- **Dialog-key overlay** — blocked on the host: `ui.dialog.show` owns the keymap (G1 NO-GO on
  beta-19271). Inspect stays panel-hosted until a host API delivers keys inside a dialog
  without leaking to the prompt.
- **Resume (partial)** — `checkpoint()` + keyed warm replay landed (v0.7.0): interrupted long runs
  rerun warm via `resumeFrom` / `/ultracode rerun --warm`. Still future: mid-flight pause/resume
  across server restarts (`/ultracode resume` today only reopens a *paused* in-process run), and
  session continuation as a checkpoint-integrated conditional (D1, `docs/DESIGN-DECISIONS.md`).
- **Worktree isolation** — give write agents separate git worktrees so they can run in parallel safely.
- **QuickJS sandbox** — replace omission-based isolation with a real capability sandbox for scripts.
- **npm publish** — local installs are self-contained copies that auto-load `tui.tsx` next to
  `index.ts` (verified); the remaining question is whether a published package
  `exports["./tui"]` auto-loads the same way.

## Development

```bash
npm install
npm test              # node --experimental-strip-types --test test/
npm run typecheck     # tsc --noEmit
```

CI runs the same three (plus `bash -n scripts/*.sh`) on every push — see
`.github/workflows/ci.yml`. Layout: `src/` (plugin code), `skills/ultracode.md` (static mirror
of the skill content — the registered skill location), `workflows/samples/` (sample workflow
pairs), `spike/` (the development harness that verified the plugin APIs — see
`spike/README.md`; opening opencode inside `spike/scratch` intentionally registers `/probe*`
test commands), `docs/CONTRACTS.md` (module ownership), `docs/SPIKE-FINDINGS.md` (verified
platform facts), `docs/AUTHORING.md` (the script authoring reference), `test/` (unit tests
with fakes — no live server needed).

## License

[MIT](LICENSE) — see the LICENSE file.
