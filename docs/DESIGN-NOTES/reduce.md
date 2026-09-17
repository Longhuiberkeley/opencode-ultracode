# Design note — `reduce()` and cross-run campaign memory

**Date:** 2026-09-17 · **Status:** deferred (with build triggers) · **Reviewed:** reviewer second
opinion concurs (defer, not never) · **Companion decision:** D1 in `docs/DESIGN-DECISIONS.md`
(session continuation is conditional)

## The question

A single run is bounded by hard walls — the ceilings of the configurable ranges, not the defaults
(24 h wall clock, 10k agent calls, 200 iterations per loop, 64 KB args/result payloads; the
defaults are 1 h and 200 agents). Long campaigns therefore span runs. What carries "where are we"
across that boundary — a `reduce()` primitive, a summarizer agent, or nothing new?

Two things this note is NOT about: in-run state hygiene (solved — `iterate` is the sole state
writer and templates keep bounded state) and warm replay (solved — keyed succeeded agents replay
via `resumeFrom` / `/ultracode rerun --warm`).

## What exists today (verified)

- **No cross-run read path at all.** Checkpoints (capped 50) are display-only; no tool, worker
  global, or script API lets a later run read a prior run's state, result, or checkpoints. Warm
  replay reads only keyed succeeded agents. Templates start fresh from `args`.
- **Results are conversation-scoped by design.** `ultracode_result`/status/history filter on
  `parentSessionID`; a *new conversation* cannot read run A's result. This looks like a deliberate
  permission boundary, not an accident waiting for a feature.
- **The 80% solution already ships as a convention.** `kanban` returns `remaining` (unprocessed
  tickets) and `verify-fix` returns `remaining`/`open`; the main agent reads the envelope (or
  pages `ultracode_result` when truncated) and passes that value as the next run's args. Same
  script + same args → `/ultracode rerun --warm` already gives zero-token continuation.

## Options considered

| | Option | Verdict |
| --- | --- | --- |
| 1 | **Pure function `reduce(prev, result) → state`** — deterministic fold, persisted as a bounded artifact, plus an opt-in `loadState(runID)` read path | The shape to build IF a trigger fires: deterministic, warm-replay friendly (see constraints), no new trust surface (fold code is author script code, already inside the trusted-to-run domain). The artifact must be a bounded KV artifact keyed to the run — the run record is a poor bulk store (checkpoints cap at 50). |
| 2 | **Schema'd summarizer agent ("historian")** — an agent compresses prior-run state into a schema'd summary | Flexible, but it is an ordinary `agent()` call any author can make today; making it an engine role would add a trust/verification surface (evidence-shaped data needing skeptic checks) for zero new capability. Keep it author-invoked, if invoked at all. |
| 3 | **Defer — document the convention** | **Chosen.** Nothing in the current design forces the feature; the permission question a build would have to answer first ("who may read another conversation's artifacts?") is unanswered, which is itself evidence the trigger hasn't fired. |

## Who summarizes, and whose job is it?

**The author's script owns the fold; the engine owns only the carrying.** Concretely: what counts
as "where are we" is domain knowledge (a ticket board? a top-5 trial list? a metric frontier?) and
already lives in template `iterate` functions today — that code IS the fold. If we ever build
option 1, `reduce` is author-supplied deterministic code executed by the engine, exactly like
`iterate`. The historian agent (option 2) is never an engine role — at most a documented pattern
(`agent()` with an evidence-shaped schema + skeptic), and it must be treated as evidence, not
truth. The CALLING AGENT's job is deciding to continue a campaign and threading the handoff —
which the convention already gives it.

## Build triggers (any ONE, demonstrated, not anticipated)

- **T1 — cross-conversation continuation.** A user starts a new conversation and needs run A's
  campaign state (today impossible by design). Signal: real users hand-copying result JSON
  between conversations, more than once. Any `loadState` built for this must answer the
  permission question first.
- **T2 — campaigns routinely exceed a hard wall.** Wall clock > 24 h, ledger > 10k agents,
  iterations > 200 per loop, or handoff payloads > 64 KB in either direction. When
  paste-through-context stops scaling, carry it in an artifact.
- **T3 — continuation into a CHANGED script becomes routine.** Warm replay requires same script +
  same args; a campaign that must carry state into a modified script (evolving ticket board,
  changed strategy) has no mechanical path today.

**Anti-trigger (the "still don't build it" test):** all campaign runs live in one conversation AND
each handoff fits 64 KB AND the campaign fits 24 h / 10k agents. Ship slicing per run (per-run
`maxLoopIterations` makes deliberate slicing more common — more, smaller runs whose leftovers
travel via the convention) rather than memory.

## Constraints any future build must carry forward

1. Deterministic fold (option 1's function), bounded artifact store, explicit opt-in
   `loadState(runID)` — the read path is the part that answers T1 and must be permission-gated.
2. **Fold state must not participate in warm-cache keys.** Cache identity is key + prompt digest;
   state that changes deterministic-call prompts would silently diverge warm replay.
3. Historian = optional author-invoked pattern, never an engine role.
4. The convention remains the documented primary path; `reduce()` only replaces who carries the
   handoff (engine artifact vs conversation context), not what it contains.
