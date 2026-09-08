# Spike findings — TUI / CLI plugin API

Verified against **opencode2 v0.0.0-beta-19271** (live, 2026-09-08).

Probe: `spike/scratch/.opencode/plugins/probe/tui.ts`  
Runner: `scripts/tui-probe.sh`  
Raw log: `spike/out/tui-probe.jsonl`

This is the contract for the optional inspect UI (chip + panel). Do not implement production TUI until this file matches the target OpenCode version.

## How the probe loads

- Server half: `probe/index.ts` (already used for the 19151 server spike).
- TUI half: sibling `probe/tui.ts` plus `package.json` `exports["./tui"]`.
- **`opencode2 mini` does not evaluate `tui.ts`.** Full TUI (`opencode2 --standalone`) does.
- `opencode2 run` (headless) does not load TUI plugins.
- Import `@opencode/plugin/tui` is resolved at runtime. Export keys: `Plugin`, `PluginContextProvider`, `usePlugin`.
- `Plugin.define({ id, setup(context) })` is the live shape (not the older `{ tui(api) }` default export).

## Context (verified keys)

`setup(context)` keys: `app`, `attention`, `client`, `data`, `keymap`, `location`, `markdown`, `options`, `renderer`, `storage`, `theme`, `themeMode`, `ui`.

| Group | Live keys |
| --- | --- |
| `context.ui` | `dialog`, `format`, `panel`, `router`, `slot`, `tabs`, `toast` |
| `context.keymap` | `active`, `commands`, `dispatch`, `layer`, `mode`, `pending`, `shortcuts` |
| `context.data` | `listen`, `location`, `on`, `project`, `session`, `shell` |

`context.app.version` = `0.0.0-beta-19271`, `channel` = `beta`.  
`context.keymap.mode.current()` = `"base"` at setup.

## Slots (verified)

`context.ui.slot({ append: name, render })` returned a disposer for **every** name we tried, including obsolete ones. Unknown names are **not** a throw — do not treat “ok” as “visible”.

Prefer the v2 documented names:

| Slot | Use |
| --- | --- |
| `prompt.footer.status` | Running-run chip (`ultracode · 3 running`) |
| `session.panel` | Inspect list (stays on parent; host owns size/focus) |
| `sidebar.content` | Append-only fallback; do not `replace` |

Also accepted without throw (may be no-ops): `app_bottom`, `session_prompt_right`, `prompt.footer`, `session.composer.top`, `sidebar.footer`, `app`, `home.footer`.

## Panel / dialog / tabs (verified)

- `context.ui.panel.open / close / current` exist. `current()` was `undefined` at setup (no session panel open).
- `context.ui.dialog`: `alert`, `confirm`, `prompt`, `select`, `set`, `show`, `clear`.
- `context.ui.tabs`: `open`, `focus`, `close`, `list`, `enabled`.
- `context.ui.router`: `current`, `navigate`, `register`. **Do not navigate away from the parent** for v1 inspect (no `parentID` → Up will not return).

## Keymap (verified)

- `context.keymap.commands()` returned **88** commands at setup.
- `session.tab.close` exists; `bind` on the command object was `false` (defaults live in CLI keybinds, not this field). Reviewer: **do not use `ctrl+x w` / `<leader>w`** — that is tab close.
- **No `session.child.*` ids** in the dumped command list. Native Down is not a plugin-visible command we can extend.
- `input.move.down` exists (prompt history / cursor). Stealing `down` fights the input field.
- Inspect command: palette-only or an unused bind. Namespace `ultracode.*`. No TUI slash named `ultracode`.

## Kill switch (docs + layout; disable prefix not live-tested)

TUI is an add-on. Production must **not** require it.

| Intent | Mechanism |
| --- | --- |
| Default off | Do **not** export `./tui` from the published server package if auto-load is confirmed for npm specs. For local install, omit `tui.ts` from the re-export dir until the user opts in. |
| Opt in | Sibling `tui.ts` next to `index.ts` (same layout as `~/.config/opencode/plugins/ultracode/`), **or** `cli.json` `plugins` row. |
| Opt out | Remove `tui.ts` / the `cli.json` row. Docs also allow `"plugins": ["-ultracode"]` in `cli.json` — not verified in this spike. |

Server `/ultracode` + `ultracode_run` keep working with TUI gone.

`opencode2 mini` is not a target for inspect UI.

## Implications for v1 inspect

1. Chip: `append: "prompt.footer.status"`.
2. Inspect: palette command `ultracode.inspect` → `context.ui.panel.open("ultracode.inspect")` with a `session.panel` contribution. Stay on the parent.
3. Optional: `context.ui.tabs.open(childID)` if `tabs.enabled()`.
4. Data: `context.data.session.*` + `context.data.on(...)`. Join on `metadata` (to stamp from server) with `[uc:]` title fallback.
5. Fail soft: TUI setup in try/catch; missing slots must not take down the CLI.

## Open items

- [ ] Confirm `cli.json` `"plugins": ["-id"]` actually unloads this TUI on beta-19271.
- [ ] Confirm whether exporting `./tui` from an **npm** server package auto-loads TUI (local sibling `tui.ts` did load with full TUI).
- [ ] `keymap.shortcuts("session.tab.close")` — exact default chord.
- [ ] Whether `slot({ append: "app_bottom" })` paints anything (API accepted it).

## Addendum 2026-09-08 (phase 0-server, build 0.0.0-beta-19271, plugin pkg 0.0.0-beta-19289)

Headless probe: `spike/scratch/.opencode/plugins/probe/index.ts`  
Runner: `scripts/server-probe.sh` (`opencode2 run --standalone` + `opencode2 api --standalone`, same as live-test.sh)  
Evidence: `spike/out/server-probe.jsonl`, `spike/out/server-probe-install-config.jsonl`, `spike/out/server-probe-install-autoload.jsonl`

**Version pin:** repo `package.json` dependencies and devDependencies pin `@opencode/plugin` to `0.0.0-beta-19289` (was `"beta"`). The **binary build and plugin package build differ**: `opencode2 --version` = `0.0.0-beta-19271`, installed plugin pkg = `0.0.0-beta-19289`. Types/docs from the pkg may not match the running binary.

| Item | Verdict | Evidence (jsonl `kind`) |
| --- | --- | --- |
| D12 create accepts `metadata` without throw | VERIFIED | `d12.session.create` succeeded (`id=ses_f7eaab6c2ffeU9SfOIfBCQpivy`); no `d12.session.create-error` |
| D12 metadata readable via `ctx.session.get` | REFUTED | `d12.create-shape` / `d12.get-after-create-shape` / `session-record-shape`: `metadata: null`, key absent |
| D12 metadata visible in session list | UNKNOWN | `d12.session.list-absent` — `ctx.session` has no `list` (`sessionKeys` in `setup`) |
| Session record shape after child completes | VERIFIED | `session-record-shape` keys: `agent,cost,id,location,outcome,projectID,subpath,time,title,tokens`. `model` absent at session level (lives on assistant messages). `outcome=succeeded`, `tokens` populated, `title=probe-child-meta` |
| D6 `session.tool.called` + stable part id | VERIFIED | `event` type `session.tool.called`: `data.sessionID` + `data.id` (e.g. `call_e2c856552c484427980f4fe4`) + `durable.{aggregateID,seq,version}` |
| D6 status / idle / outcome events | REFUTED (idle/status) / VERIFIED (execution) | `event-type-counts`: no `session.idle` / `session.status`. Completion = `session.execution.succeeded` (`durable.seq`) + `session.get().outcome` |
| D6 durability / replay | VERIFIED | tool events carry `durable.aggregateID` (=session id) + monotonic `seq` + `version` (called v1, success/failed v2). `session.tool.progress` has **no** `durable`. Dedupe on `data.id` per session is viable; replay risk is real (durable stream). |
| D1 `ctx.skill.reload` + editor methods | VERIFIED | `setup.skillKeys=["list","reload","transform"]`; `skill-transform-callback` methods `add,get,list,remove,update` |
| D1 late re-transform from executor (not setup) | VERIFIED | `d1.skill.late-transform` `updateThrew: null`; `d1.skill.list-after.probeContent` = updated text. **Replays other transforms:** `skill-transform-callback` `from=setup-registration` fired again on late `transform` and on `reload` (`n` 1→5). |
| D10 install shape | VERIFIED (auto-load dir) | See below |

**Install shape (D10):** scratch currently has all three: `.opencode/plugins/probe/index.ts` (dir), `.opencode/opencode.json` `plugins: ["./plugins/probe"]`, `.opencode/cli.json` `plugins: ["./plugins/probe"]`. On **this** binary, removing both config `plugins` entries **still loaded** the probe (`server-probe-install-autoload.jsonl` `kind=setup`). Config entry also loaded (`server-probe-install-config.jsonl` `kind=setup`). **Verified shape = auto-load of `.opencode/plugins/*/index.ts`.** (This differs from the 19151 finding in SPIKE-FINDINGS.md that dir auto-load did not work.) `/api/plugin` and `ctx.plugin.list` returned `data: []` even while setup ran — do not use plugin.list as a load detector.

**Plan impact:**
- **D12:** metadata stamp is not exposed on session records or `session.created` (`dataKeys` have title/agent, no metadata). TUI join must use the **title fallback** as the real contract, not a fallback. Widening `SessionCtx.create` with `metadata` stays type-correct but will not round-trip on this build.
- **D6:** proceed with `src/run-events.ts` on `session.tool.called` / `success` / `failed`, dedupe `data.id`, ignore events older than `startedAt`. Do not wait for `session.idle`/`session.status`.
- **D10:** `install.sh` can drop a re-export into `.opencode/plugins/<id>/`; `--write-config` is optional on this build, not required for load.
