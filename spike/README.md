# spike/ — development harness

Everything under `spike/` exists to **verify plugin APIs and the TUI against a real OpenCode
build**. It is dev scaffolding, not part of the shipped plugin surface (`src/`).

## What's here

| Path | What it is |
| --- | --- |
| `spike/scratch/` | A scratch OpenCode **project root** used by `scripts/tui-probe.sh`. Its `.opencode/plugins/probe/` is a throwaway probe plugin that logs undocumented API shapes to `spike/out/probe-log.jsonl`. |
| `spike/live/` | Minimal live-install harness (relative re-export config) for the real plugin. |
| `spike/out/` | Probe captures (`.jsonl`, `.ansi`, `.txt`). **Git-ignored, local-only** — they embed machine-local paths and must never be committed. |

## The `/probe*` commands are intentional (dev-only)

If you open OpenCode with `spike/scratch` as the project root, the probe plugin registers
slash commands like `probe_tui` / `ucprobe` and test tools (`probe_tool`, `probe_slow`,
`probe_stop`, `probe_server`). That is by design: it is how the spike verified command
registration, session spawning, and TUI paint against a live client. These commands **never
load** in a normal project — the plugin only lives in this scratch dir.

## Model selection for live tests (no silent fallback)

Standalone servers spawned for a scratch location may not load your global agent pins, so
child sessions would fall back to that location's default model — potentially a provider you
did not choose. To make that impossible to miss:

```bash
# Explicitly choose the model live tests run on (recommended):
UC_LIVE_MODEL='provider/model-id' scripts/tui-probe.sh --live
```

- With `UC_LIVE_MODEL` set, the harness passes it to the standalone client/server and
  **fails** the run if a child session is observed on a different model.
- Without it, the harness prints a loud warning that the location-default model will be used
  and continues.

No model id is committed anywhere in this repo.
