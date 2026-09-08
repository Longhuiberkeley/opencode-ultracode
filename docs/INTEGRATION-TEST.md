# Integration test plan (lead-owned)

Run after Builders A/B/C merge. Unit tests must be green first: `npm test`, `npx tsc --noEmit`.

## 0. Static checks
- [ ] `npx tsc --noEmit` clean
- [ ] `npm test` — all test files green
- [ ] `grep -rn "@opencode/plugin" src/` — only `src/index.ts`
- [ ] No `await ctx.session.` calls inside `setup()` (deadlock rule; grep + read index.ts)

## 1. Plugin loads in a scratch location (no global install yet)
- [ ] `scripts/live-test.sh load` — boots standalone from `spike/live/`, asserts `/api/plugin` lists `ultracode`, and the log shows no `disabled plugin after transform failure`
- [ ] skill `ultracode` appears in skill list for that location

## 2. Workflow tool end-to-end (real model, tiny caps)
- [ ] `scripts/live-test.sh run` — headless `opencode2 run` in `spike/live/` with a 2-agent workflow (concurrency 2, maxAgents 4, timeoutMs 300000 via plugin options override file)
- [ ] Envelope returns with status succeeded, agents.total === 2, tokens > 0
- [ ] Run artifact written under `spike/live/.opencode/workflows/runs/`
- [ ] `/api/session/{child}/get` shows outcome succeeded for children

## 3. Controls
- [ ] `/ultracode` (no args) via `POST /api/session/{id}/command` — synthetic summary lands in the session
- [ ] `/ultracode show <runID>` — script + agent table
- [ ] Stop path: start a workflow with `sleep` long enough, then `/ultracode stop <runID>`; verify status `stopped`, children interrupted, parent tool resolves with stopped envelope (this also answers the open "command while parent tool pending" question — record the outcome either way)
- [ ] `/ultracode save <runID> demo` then `/ultracode trust demo`, re-run via tool input `{workflow: "demo"}`; tamper the saved .js, verify hash-mismatch refusal, re-trust after review

## 4. ultracode keyword + skill
- [ ] Prompt starting with "ultracode:" attaches the skill (verify via session context message of type skill, or model behavior)
- [ ] Mid-prompt "please ultracode this" attaches the skill
- [ ] Prompt whose only hit is a path like `opencode-ultracode/docs` does not attach
- [ ] Prompt without the keyword does not attach

## 5. Nested-run rejection
- [ ] A workflow agent instructed to call the workflow tool gets the rejection error content (check child session messages)

## 6. Permission modes (spot checks)
- [ ] Default ask: child requesting a write in scratch dir triggers normal permission flow (visible as blocked/pending) — do NOT auto-approve blindly
- [ ] noEditTools: same request denied with message
- [ ] autoEditsWorkflow: write inside project root allowed; write to `~/.config/opencode/agents/x.md` NOT auto-approved

## 7. Restart reconciliation
- [ ] Kill the standalone server mid-run (SIGKILL), restart, assert the persisted run shows `interrupted` with stopReason "server restart" in `/ultracode` output; no auto-replay

## 8. Global install (user-approved)
- [ ] Backup `~/.config/opencode/opencode.json`, add plugins entry with absolute path, `opencode2 service restart`, `/api/plugin` shows ultracode in the user's home location
- [ ] Run one demo ultracode prompt in the user's real environment
- [ ] Commit final state; tag v0.1.0

## 9. TUI probe (inspect UI contract)
- [ ] `scripts/tui-probe.sh` — full TUI (`opencode2 --standalone`, not `mini` / `run`) writes `spike/out/tui-probe.jsonl`
- [ ] Events include `tui-import-ok`, `tui-setup`, `slot-append-ok` for `prompt.footer.status` and `session.panel`
- [ ] Compare dump to `docs/SPIKE-TUI.md` if OpenCode version ≠ beta-19271

## 9b. Transport e2e evidence — environment caveat

`scripts/tui-probe.sh --live` enforces paint, selection-repaint (new-marker assertion), pagination
and — when a real run spawns inside the probe window — transport receipts (`pause <runID>` /
`stop <runID>` in the server jsonl) plus the parent's `stopped` envelope. The transport leg is
FLAKY when a global ultracode plugin coexists with the scratch re-export (both register
`ultracode_run`; execution ownership alternates) or when model latency exceeds the window. Then
the runner prints `F12 transport SKIPPED: paint-only fallback` and exits 0 with
`transport_skipped=1` — a skipped leg is reported, never silent. Receipts for a real run
(`run_v3gmythjq6tr`, 2026-09-08) are in commit 4cbbde7's spike/out jsonl; re-capture in a clean
environment (no global ultracode plugin) to re-prove the stopped-outcome assertion.

## 10. TUI checklist (v1 inspect + G1)

Verified binary: **opencode2 0.0.0-beta-19271** (plugin pkg pin 0.0.0-beta-19289). Captures are
gitignored under `spike/out/`.

### Live capture (chip + panel-hosted two-column)

Procedure:

1. `npm install` in the plugin repo (so `@opencode/plugin` resolves).
2. From repo root: `scripts/tui-probe.sh --live`
3. Probe swaps `spike/scratch/.opencode/plugins/probe/{index.ts,tui.tsx}` to re-export the real
   `src/` pair, drives a PTY (`opencode2 --standalone`), sends keystrokes, writes:
   - `spike/out/tui-live.jsonl`
   - `spike/out/tui-live-server.jsonl`
   - `spike/out/tui-live-<timestamp>.ansi` + `.txt` (ANSI stripped)
4. Script runs `assert_live_paint` on the stripped `.txt` (exit 1 if chip/panel markers absent).

Grep list (stripped live capture):

```bash
grep -F 'ultracode ·' spike/out/tui-live-*.txt
grep -F 'UC-INSPECT' spike/out/tui-live-*.txt
grep -F 'ultracode inspect' spike/out/tui-live-*.txt
grep -F 'Phases' spike/out/tui-live-*.txt
grep -F 'x stop' spike/out/tui-live-*.txt
grep -F 'p pause' spike/out/tui-live-*.txt
```

- [ ] chip needle `ultracode ·` (or `ultracode` + `running`) present
- [ ] panel marker `UC-INSPECT` / `ultracode inspect` present
- [ ] two-column `Phases` present when a run is grouped
- [ ] footer `x stop` / `p pause` present when the panel has keys
- [ ] fail-soft: no `disabled plugin after transform failure` in server jsonl

### G1 dialog-keys procedure (expect NO-GO on this binary)

1. `scripts/tui-probe.sh --dialog-keys` (`PROBE_DIALOG_KEYS=1`)
2. Evidence: `spike/out/tui-dialog-keys.jsonl`, `spike/out/tui-dialog-keys-<timestamp>.ansi` + `.txt`
3. Probe opens `ui.dialog.show` (`G1-DIALOG-KEYS` painted) and tries, in order:
   - `keymap.layer` from a component mounted **inside** the dialog render
   - `onKey` / `onKeyDown` / `onKeyPress` / `onKeyUp` props
   - `dialog.set` extras (`onKey`, `keys`, `keymap`, `handler`)
4. Verdict (script `g1_verdict`): GO only if jsonl has `dialog-keys-receipt` **and** stripped
   text has no `G1LEAK`. On beta-19271 this is **NO-GO** — host dialog owns the keymap;
   production inspect stays panel-hosted.

- [ ] stripped dump contains `G1-DIALOG-KEYS`
- [ ] zero `dialog-keys-receipt` in jsonl
- [ ] `G1LEAK` absent (host swallowed keys; plugin still received none)
- [ ] ESC still closes (`dialog-onclose`)

