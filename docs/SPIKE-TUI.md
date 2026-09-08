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

## Addendum 2026-09-08 (phase 0-tui, build 0.0.0-beta-19271, plugin pkg 0.0.0-beta-19289)

Interactive PTY probe. TSX entry: `spike/scratch/.opencode/plugins/probe/tui.tsx` (`package.json` `exports["./tui"]` = `./tui.tsx`). Fallback entry (unused this run): `tui.ts`. Runner: `scripts/tui-probe.sh` (python PTY, sends keys, kills the child). Primary capture: `spike/out/tui-probe-20260908T142622Z.ansi` + `.txt`, `spike/out/tui-probe.jsonl`, `spike/out/tui-probe-server.jsonl`. Earlier paint-only capture: `spike/out/tui-probe-20260908T142439Z.*`.

### Verdict table

| Item | Verdict | Evidence | Snippet / jsonl kind |
| --- | --- | --- | --- |
| (0) D13 GATE: `.tsx` + solid JSX loads+paints | **VERIFIED** | `tui-probe.jsonl` `tui-module-evaluated` `entry=tui.tsx` `jsxImportSource=solid-js`; stripped text contains `UCPROBE-CHIP` | `{"entry":"tui.tsx","jsxImportSource":"solid-js","pragma":true}`. Dynamic `import("solid-js")` **fails** (`Cannot find package 'solid-js'`) — host bun transpiles JSX; plugin does **not** need a local `solid-js` install. |
| (1) Chip paint `prompt.footer.status` | **VERIFIED** | `tui-probe-20260908T142622Z.txt` / `.ansi`; `slot-chip-ok` | `UCPROBE-CHIP` in footer (sometimes split around other footer cells as `UCPROB…E-CHIP`) |
| (2) `session.panel` + palette command | **VERIFIED** | `keymap-probeish` label `after-navigate`; `command-run` id `ultracode.inspect` from `ctrl+g`; `panel-open` `ok:true`; stripped `UCPROBE-PANEL` | Command: `{id:"ultracode.inspect", palette:true, bind:"ctrl+g", slash:{name:"ucprobe"}, shortcuts:["ctrl+g"]}`. `panel-render` input keys: `close,focus,focused,name,presentation,sessionID,toggleFullscreen,width`. |
| (3) `dialog.show` two-col + `set` + onClose/esc | **VERIFIED** | stripped dialog frame; `dialog-show-ok`; `dialog-set-ok`; `dialog-onclose` ×2 after sent ESC | `UCPROBE-DIALOG` + `col1-status` / `col2-agent` / `col1-phase` / `col2-tokens`. `ui.dialog.set({size:"large", centered:true})` did not throw. ESC → `{"via":"callback"}`. Visual A/B of size vs default not captured. |
| (4) `keymap.layer` ownership | **VERIFIED** (semantics captured) | `layer-from-setup-error`; `layer-key` from `component-panel` only after dialog closed | **setup():** throws `Error: Keymap.Provider is missing`. **Rendered component (slot/panel):** registers; `keymap.commands()` lists layer ids. **While dialog open:** layer handlers do **not** receive keys (zero `layer-key` between `dialog-show-ok` and `dialog-onclose`; `after-dialog-show` commands drop plugin layer ids). **After close:** `z` received (`from":"component-panel"`, `dialogOpen:false`). **priority:** panel layer 90 beat chip 80 (receipts from `component-panel`). **target:** not exercised (no Renderable). **Leak:** `z` bound on the layer; three `zzz-after-esc` presses logged as `layer-key` and did not appear as prompt text. |
| (5) D4 `client.session.command` | **VERIFIED** | `client-session-command` + server `command-invoked` | TUI input `{sessionID, command:"ultracode", text:"help"}` (`threw:null`). Server execute: `{sessionID, prompt:{text:"help"}, delivery:"steer"}`. Child drill ran (`tui-child-final`). |
| (6) D8/R18 `data.on` / client store | **VERIFIED** | `data-listen` / `data-on` / `data-session-list` | See event list + client entry below. **title + outcome + tokens are client-visible. `metadata` is `null` on the client store too** (same as server `ctx.session.get`). `parentID` also `null` for a `session.create` child. |

### G0 recommendation: **GO**

(0) TSX paint, (1) chip, (2) panel + keystroke `ultracode.inspect`, (3) dialog.show two-column + onClose, (4) layer ownership all captured. Overlay (Phase 3) is unblocked on this binary. Production `keymap.layer` **must** live inside a mounted slot/panel/dialog component, never `setup()`. Dialog overlay **replaces** reachable plugin layers — overlay keys need a layer registered **inside the dialog render**, and even then `keymap.commands()` during an open host dialog did not list plugin commands (host dialog owns the keymap). v1 inspect (chip + `session.panel` + palette) does not depend on dialog-layer keys.

### JSX / toolchain recipe (what worked)

1. Plugin TUI entry is a **`.tsx` file** (`exports["./tui"]: "./tui.tsx"`).
2. File pragma: `/** @jsxImportSource solid-js */`.
3. Scratch tsconfig (next to the plugin, so bun does not inherit the repo tsconfig): `"jsx": "preserve"`, `"jsxImportSource": "solid-js"`.
4. Paint with OpenTUI intrinsics: `<text>UCPROBE-CHIP</text>`, `<box flexDirection="row">…</box>`. No `import "solid-js"` / `@opentui/solid` required for this binary — those specifiers **do not resolve** from the plugin directory (`runtime-import-fail`). The host compiler supplies the JSX runtime.
5. `.ts` + `createComponent` / `solid-js/jsx-runtime` was **not needed**. Keep `tui.ts` only as a loader-error fallback.

### Exact API shapes learned

**`ui.dialog.show`** (matches `@opencode/plugin` 19289 d.ts, live):

```ts
ui.dialog.show(render: () => JSX.Element, onClose?: () => void): void
ui.dialog.set({ size?: "medium" | "large" | "xlarge", centered?: boolean }): void
ui.dialog.clear(): void
```

`onClose` fires on ESC.

**`keymap.layer` ownership:** `keymap.layer(() => KeymapLayer)` is owned by the **calling Solid component**. `setup()` is not a component → `Keymap.Provider is missing`. Call it from `ui.slot` / panel / dialog `render`. `enabled` may be a thunk. `priority` is numeric (higher won). No push/pop (`keymap.mode` is the exclusive-mode API). Host dialog open ⇒ plugin layers are not reachable.

**`client.session.command` input** (promise client, live):

```ts
await context.client.session.command({
  sessionID: parentID,      // string
  command: "ultracode",     // registered ctx.command name
  text: "help",             // becomes invocation.prompt.text
  // optional: files, agents, skills, delivery?: "steer" | "queue" | null
})
```

Server command `execute` receives `{ sessionID, prompt: { text }, delivery }` — **not** a top-level `text` field.

**Palette open chord:** `command.palette.show` shortcuts `["ctrl+p"]`.

### Client session entry (D8)

`data.session.list()` after child completed (`kind=data-session-list` label `after-command`). Child keys:

`agent, cost, id, location, outcome, projectID, subpath, time, title, tokens`

Full child: `title="probe-tui-child"`, `outcome="succeeded"`, `tokens={input,output,reasoning,cache}`, `agent="general"`, `time={created,updated,idle}`, **`metadata` absent/`null`**, **`parentID` null**, no `model` at session level.

**`data.listen` / `data.on` types observed** while server created/prompted/completed the child:

`session.created`, `session.inbox.enqueued`, `session.inbox.delivered`, `session.execution.started`, `session.instructions.updated`, `session.step.started`, `session.reasoning.started`, `session.reasoning.delta`, `session.reasoning.ended`, `session.text.started`, `session.text.delta`, `session.text.ended`, `session.step.streamed`, `session.step.ended`, `session.usage.updated`, `session.execution.succeeded`, plus `session.tool.called` / `session.tool.input.started` / `session.tool.input.ended` / `session.tool.failed`.

No `session.idle` / `session.status` on the **client** bus either (matches phase 0-server). Completion signal = `session.execution.succeeded` + `data.session.get/list().outcome`.

**Plan impact:** D13 gate passed — Phase 2 TUI v1 may use `.tsx` + `jsxImportSource: "solid-js"` without adding `solid-js` to the plugin runtime (host provides JSX). D12 metadata is also missing from the **client** store; join on title. D4 transport shape confirmed. Overlay keys (Phase 3) must register `keymap.layer` inside the dialog component; do not expect chip-layer keys to fire while `dialog.show` is up.

## Addendum 2026-09-08 (phase 3 G1 — dialog key capture, build 0.0.0-beta-19271)

Runner: `scripts/tui-probe.sh --dialog-keys` (`PROBE_DIALOG_KEYS=1`, probe `tui.tsx` `KeysDialog`).  
Evidence: `spike/out/tui-dialog-keys.jsonl`, `spike/out/tui-dialog-keys-20260908T151921Z.ansi` + `.txt`.

Tried, in order, while `ui.dialog.show` was open (`G1-DIALOG-KEYS` painted):

| Mechanism | Result | Evidence |
| --- | --- | --- |
| (a) `keymap.layer` from a component **mounted inside** the dialog render (`priority` 200, binds `d`/`x`/`p`) | **REFUTED** | `dialog-keys-layer-ok` then zero `dialog-keys-receipt`. `keymap-probeish` label `dialog-keys-after-show` does **not** list `probe.dialogkeys.*` (host dialog owns the keymap — same as A4). |
| (b) `onKey` / `onKeyDown` / `onKeyPress` / `onKeyUp` props on `<box>` / `<text>` | **REFUTED** | `dialog-keys-onkey-props` tried those names; zero receipts. Not in `@opencode/plugin` 19289 Dialog / JSX typings. |
| (c) dialog options carrying key handlers (`dialog.set({ onKey, onKeyDown, keys, keymap, handler })`) | **REFUTED** | `dialog-keys-option-set-ok` ×5 (no throw) but options are presentation-only per d.ts (`size`, `centered`); no receipts. `ui.dialog` keys: `alert,clear,confirm,prompt,select,set,show`. |

`G1LEAK` canary was **absent** from stripped text (host dialog swallowed keystrokes) but **no plugin mechanism received them**. ESC still fired `dialog-onclose`.

### G1 verdict: **NO-GO**

No mechanism receives keys inside `dialog.show` without (or even with) leaking to the prompt. Phase 3 overlay is **panel-hosted**: two-column inspect stays in `session.panel` (component `keymap.layer` verified in Phase 2). `ui.dialog.prompt` is used only for the save-name flow.
