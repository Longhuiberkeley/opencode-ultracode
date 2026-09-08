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
