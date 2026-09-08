# opencode-ultracode

Dynamic workflows ("ultracode") for OpenCode v2 — a plugin that lets the model *author* a small
JavaScript orchestration script, executes that script in an isolated worker, and spawns **real
opencode subagent sessions** for each step. Fan-out research, adversarial verification, per-item
pipelines, tournaments — expressed as code instead of a wall of manual delegation.

This mirrors Claude Code's dynamic-workflow capability: instead of the harness hard-coding every
multi-agent recipe, the model writes the orchestration on the fly and a runtime makes it real.

## How it works

1. Your prompt contains the standalone keyword `ultracode` (e.g. `ultracode: audit src/auth`,
   `please ultracode this`, or `ultracode do X and verify it`). The `Ultracode` skill auto-attaches
   and teaches the model the script API. Natural-language requests ("use a workflow to ...") do
   not auto-attach — the model can still choose to author one from the skill description.
2. The model invokes the **`ultracode_run`** tool with `{ script, name?, meta?, args? }` for an
   inline run, or `{ workflow: "name", args? }` for a saved workflow.
3. The runtime validates the script (plain JS async-function body — no module syntax), preflights
   the agents declared in `meta.requires`, then executes it in a worker thread with injected
   globals: `agent`, `parallel`, `pipeline`, `phase`, `progress`, `workflow`, `sleep`, `console`,
   plus `args` and `meta` from the tool input.
4. Each `agent(prompt, opts)` call spawns a fresh subagent session (own context window, own model
   per your agent config) and waits for it. Child sessions are titled `[uc:<runID> <ord> <phase>] label` so
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
  `.opencode/workflows/` runs with whatever permissions your agents have. Every saved workflow
  (samples included) requires a **one-time user approval** via `/ultracode trust <name>`, which
  records an approved digest of the script content. Editing the script invalidates trust until it
  is re-approved — a changed workflow never runs silently. Review workflow diffs in code review
  like any other code.
- **Child sessions are real agents.** They inherit your config. The default permission mode
  `"ask"` keeps edit approval manual for workflow children. `autoEditsWorkflow` auto-approves
  edit-class actions for active run children scoped to the project root; `noEditTools` denies
  edit-class tools for active run children outright. See [Options](#options) and
  [Known limitations](#known-limitations).
- **Isolation caveat for authors:** a "clean context" is NOT filesystem isolation. Two agents
  that write files concurrently will race on the same worktree. Orchestration scripts must
  serialize write agents (see `docs/AUTHORING.md`).

## Install

**Precondition:** `npm install` in this repo so `node_modules/@opencode/plugin` resolves.
The installer refuses to run until that is true (`run npm install in <repo>`).

```bash
git clone <this-repo> /path/to/opencode-ultracode
cd /path/to/opencode-ultracode
npm install
scripts/install.sh --project /path/to/your-project
# or: scripts/install.sh --global
```

`scripts/install.sh` writes a re-export into the auto-load dir (verified on OpenCode v2
beta-19271: `.opencode/plugins/*/index.ts` is enough; `--write-config` is optional):

| Flag | Effect |
| --- | --- |
| `--project DIR` | Install into `DIR/.opencode/` (default: cwd) |
| `--global` | Install into `~/.config/opencode/` |
| `--tui` | Also write sibling `tui.tsx` (inspect UI **opt-in**; host auto-loads it next to `index.ts`) |
| `--write-config` | Merge a `plugins` entry into the target `opencode.json` only if no entry with the same package path exists |
| `--repo PATH` | Plugin repo root (default: parent of the script) |

Reruns are idempotent (same files, never duplicate config). No network.

**TUI opt-in:** omit `--tui` for server-only (`ultracode_run` + `/ultracode`). Add `--tui` when
you want the chip + inspect panel. Remove `tui.tsx` or run `scripts/uninstall.sh` to drop it;
the server half keeps working.

**Manual re-export (fallback if you do not want the script):**

```ts
// <project>/.opencode/plugins/ultracode/index.ts
export { default } from "/path/to/opencode-ultracode/src/index.ts"
// optional sibling, only if you want inspect UI:
// <project>/.opencode/plugins/ultracode/tui.tsx
export { default } from "/path/to/opencode-ultracode/src/tui.tsx"
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
beta-19271; prefer the auto-load re-export. If load fails, check server logs for
`failed to load plugin` / `disabled plugin after transform failure`.

### Uninstall

```bash
scripts/uninstall.sh --project /path/to/your-project
# scripts/uninstall.sh --global
# scripts/uninstall.sh --project DIR --purge              # runs/ + matching skill mirror
# scripts/uninstall.sh --project DIR --purge-workflows --yes
```

Removes `plugins/ultracode/index.ts` and `tui.tsx` **only** when they still re-export this
repo; never touches other plugins. `--purge` deletes `<target>/.opencode/workflows/runs/`
and `ultracode-skill.md` only if that file is still byte-equal to `skills/ultracode.md`.
`--purge-workflows` deletes saved `*.js`/`*.json` pairs after confirmation (`--yes` skips
the prompt). Without that flag, saved workflows are left in place.

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
| `concurrency` | number | `8` | Max concurrently *running* child sessions per run. Additional `agent()` calls queue FIFO. |
| `maxAgents` | number | `200` | Max total `agent()` calls per run (a runaway fan-out fails the run instead of burning tokens forever). |
| `timeoutMs` | number | `3600000` | Wall-clock limit per run (60 min). On timeout: children interrupted, worker terminated, run finalized. |
| `permissions` | string | `"ask"` | `ask` (default permission flow for children — recommended), `autoEditsWorkflow` (auto-approve edit-class actions for active run children inside the project root), `noEditTools` (deny edit-class tools for active run children). |
| `maxResultChars` | number | `65536` | Max serialized result returned to the session; larger results come back as a preview + `truncated: true`, full value retrievable via `/ultracode result <runID>`. |

```json
{
  "plugins": [
    {
      "package": "/path/to/opencode-ultracode",
      "options": {
        "agent": "general",
        "concurrency": 8,
        "maxAgents": 200,
        "timeoutMs": 3600000,
        "permissions": "ask",
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

The tool returns when the run finishes, with an envelope:

```json
{
  "runID": "run_ab12cd34ef56",
  "name": "deep-research",
  "status": "succeeded",
  "durationMs": 214000,
  "agents": { "total": 8, "succeeded": 8, "failed": 0, "interrupted": 0 },
  "tokens": { "input": 412000, "output": 18200, "reasoning": 9400, "cache": { "read": 98000, "write": 0 } },
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

TUI keys (panel-hosted inspect; same verbs via `client.session.command`) fire only while the
inspect panel is focused — they are not dialog-hosted.

| Command | Effect | TUI key |
| --- | --- | --- |
| `/ultracode` | Dashboard: plugin/min-build line, active (including paused), recent, saved workflows. | palette `ultracode.inspect` opens the panel |
| `/ultracode show [runID]` | Full run report (D11 cells + sessionID): status, agents, tokens, tools, script. | — (server parity floor) |
| `/ultracode result [runID]` | Print the **full** result of a run whose envelope came back truncated. | — |
| `/ultracode stop [runID]` | Graceful stop: no new agent calls, children interrupted, worker terminated after a grace period. | `x` |
| `/ultracode pause [runID]` | Close admission of new `agent()` calls; in-flight finish; watchdog suspended. | `p` (toggles pause) |
| `/ultracode resume [runID]` | Reopen admission on a paused run. | `p` (toggles resume) |
| `/ultracode rerun [runID] [argsJSON]` | Start a new run from a finished run's script (trust/digest checks if it was a named workflow). | — |
| `/ultracode save <runID> <name>` | Save a run's script as a named workflow (`.js` + `.json` manifest). | `s` (name via `dialog.prompt`) |
| `/ultracode trust <name>` | One-time approval for a saved workflow (content digest). | — |
| `/ultracode untrust <name>` | Revoke trust for a saved workflow. | — |
| `/ultracode help` | Print this command list and the authoring hint. | — |
| (select / drill) | Move the inspect highlight; open the selected child session tab. | `↑` `↓` select · `enter` / `→` drill |

## Inspect UI

Opt-in TUI (`scripts/install.sh --tui` / sibling `tui.tsx`). Fail-soft: every slot, keymap,
dialog, and toast call is try/caught; a missing host API never takes down the CLI. Version
gate: channel `beta` and binary `0.0.0-beta-NNNNN` with **NNNNN ≥ 19271** (`shouldEnableTui`).
Older or unknown builds skip TUI registration; `/ultracode show` remains the server-only
parity floor.

| Piece | Where | What |
| --- | --- | --- |
| Chip | `prompt.footer.status` | `ultracode · N running` while any run is active |
| Panel | `session.panel` contribution `ultracode.inspect` | Two-column inspector (phases \| agents), pagination, footer keys |
| Palette | command `ultracode.inspect` | Opens the panel; stay on the parent session |
| Overlay keys | `keymap.layer` **inside** the panel component | `↑↓` select, `x` stop, `p` pause/resume, `s` save, `enter`/`→` drill |
| Toast | `ui.toast.show` | Completion (envelope / quiet-window heuristic) and post-save trust hint |

**Why the two-column inspector is panel-hosted, not `ui.dialog.show`:** G1 on beta-19271 —
the host dialog owns the keymap. `keymap.layer` from a component mounted inside `dialog.show`
does not receive keys; `onKey*` props and `dialog.set` extras are presentation-only. Overlay
keys therefore live on `session.panel` (priority 90), which is the verified working layer
when no host dialog is open. `ui.dialog.prompt` is used only for the save-name flow.

### Parity vs Claude Code inspector

| Surface | Here | Notes |
| --- | --- | --- |
| Header | yes | Short run id, agent counts, elapsed (`twoColumn` / `runHeaderCells`) |
| Phases | yes | Left column; observed first-appearance order |
| Agents | yes | Right column; D11 cells (status, label, phase, agent, model, …) |
| Tokens | yes | Per-agent + run totals |
| Tools | yes | `AgentRecord.toolCalls` (event reducer; context fallback) |
| Pagination | yes | Page height 10; `N of M` / ↓ when more rows |
| Stop | yes | Key `x` → `/ultracode stop` |
| Pause | yes | Key `p` → pause/resume |
| Save | yes | Key `s` → `dialog.prompt` → `/ultracode save` |
| Select | yes | `↑` `↓` |
| Drill | yes | `enter` / `→` → `tabs.open` child when tabs enabled |
| Dialog-hosted keys | **no** | Deliberate: host dialog steals the keymap (G1 NO-GO) |
| Mid-tool freeze | **no** | Deliberate: in-flight tool calls finish; pause only closes admission |

### Paint checklist

Reproduce against the recorded binary:

```bash
scripts/tui-probe.sh --live
```

Captures land in `spike/out/tui-live-<timestamp>.txt` (plus `.ansi` / `tui-live.jsonl`).
`assert_live_paint` in the probe greps the stripped text. Exact needles from the live
captures / probe:

```bash
# chip
grep -F 'ultracode ·' spike/out/tui-live-*.txt
# panel marker (always painted, even with no runs)
grep -F 'UC-INSPECT' spike/out/tui-live-*.txt
grep -F 'ultracode inspect' spike/out/tui-live-*.txt
# two-column + footer (present once a run is grouped)
grep -F 'Phases' spike/out/tui-live-*.txt
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
The `/ultracode` dashboard first line repeats plugin `0.1.0` and min OpenCode beta-19271.

## Cost control

Workflows multiply tokens. Controls, in order of leverage:

1. **Route via subagents, not models.** Scripts reference *agent ids* (`general`, `explore`, your
   own specialists) and never provider/model ids. Pin which model each agent runs with
   `opencode2 subagent-config`. A typical shape: cheap agent for extraction/search fan-out
   (`explore`), strong agent for judgment/synthesis (`general` or your `reviewer`).
2. **Pins hot-reload.** Re-pinning an agent mid-run applies to the *next spawned agent* —
   already-running sessions keep their model. You can retune a long run without stopping it.
3. **Watch the tokens.** Every envelope carries summed token usage; `/ultracode show <runID>`
   breaks it down per agent, including the `effectiveModel` each child actually ran (see
   Troubleshooting for pin drift).
4. **Cap the fan-out in the script.** Good scripts bound items (`slice(0, 12)`), claims, and
   retry iterations — `maxAgents` is the backstop, not the budget.

## Saved workflows

- Stored as a pair: `<name>.js` (the script, plain async body) + `<name>.json` (manifest v1:
  `version`, `name`, `description`, `phases`, `requires`, `hash`, `source`, `savedAt`).
- Locations: `<project>/.opencode/workflows/` **beats** `~/.config/opencode/workflows/` on name
  collisions. Names match `^[a-z0-9][a-z0-9-_]{0,63}$`; no path traversal.
- **Trust:** running a saved workflow requires a one-time `/ultracode trust <name>`. Trust is
  bound to the script's *content digest* — edit the file and the run is refused until you
  re-trust. This is the trust gate for repo-shared workflows, by design.
- **Sharing:** commit `.opencode/workflows/` (the pairs, not `runs/`) to your repo.
  Collaborators approve each workflow once with `/ultracode trust <name>` after reviewing it.
- **Samples:** `workflows/samples/` ships `deep-research`, `code-audit`, and `fact-check` pairs
  that use only stock agents. Copy both files into your project's `.opencode/workflows/`, review
  them, then `/ultracode trust <name>` — samples are gated by the same trust flow as any other
  saved workflow. Sample manifests carry `hash: ""` (the loader tolerates the empty hash for
  these reviewed, in-repo samples); user-saved workflows always get a real hash.
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
| Child ran the "wrong" model (pin drift) | Agent pins may not load in standalone server contexts (spike-verified). Runs record `effectiveModel` per agent — check `/ultracode show`. Re-pin and it applies to the next spawned agent. |
| Result came back truncated | The script returned more than `maxResultChars`. The envelope carries a `preview` and a `resultArtifactKey`; print the full value with `/ultracode result <runID>`, raise the option, or return a summary instead of a dump. |
| Run status `interrupted` after restart | Persisted `running`/`stopping` runs are marked `interrupted` on plugin load. There is no auto-replay; re-run the workflow. |
| Nested `ultracode_run` tool call rejected | By design: sessions owned by a running workflow cannot start their own runs (no recursion). |
| `/ultracode can …` (or other prose) is "Unknown argument" | `/ultracode` is management only. To author a workflow, send a normal message such as `please ultracode …` without the leading slash. |
| `npm test` fails with "Cannot find module .../test" | Node 22.13 quirk with `--test <dir>`. Run `node --experimental-strip-types --test` (auto-discovery) or pass the test file(s) directly. |

## Roadmap

- **Dialog-key overlay** — blocked on the host: `ui.dialog.show` owns the keymap (G1 NO-GO on
  beta-19271). Inspect stays panel-hosted until a host API delivers keys inside a dialog
  without leaking to the prompt.
- **Resume** — checkpoint long runs and resume after interruption instead of replaying from zero.
  (`/ultracode resume` today only reopens a *paused* in-process run.)
- **Worktree isolation** — give write agents separate git worktrees so they can run in parallel safely.
- **QuickJS sandbox** — replace omission-based isolation with a real capability sandbox for scripts.
- **npm publish** — local installs load TUI via sibling `tui.tsx` auto-load (verified); the
  remaining question is whether a published package `exports["./tui"]` auto-loads the same way.
  That gate is moot for `scripts/install.sh` / dir auto-load.

## Development

```bash
npm install
npm test              # node --experimental-strip-types --test test/
npm run typecheck     # tsc --noEmit
```

Layout: `src/` (plugin code), `skills/ultracode.md` (static mirror of the skill content — the
registered skill location), `workflows/samples/` (sample workflow pairs), `docs/CONTRACTS.md`
(module ownership), `docs/SPIKE-FINDINGS.md` (verified platform facts), `docs/AUTHORING.md` (the
script authoring reference), `test/` (unit tests with fakes — no live server needed).
