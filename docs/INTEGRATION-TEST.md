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

