# Design decisions

ADR-style record for opencode-ultracode. Each entry names the decision, the
evidence behind it, and what would reopen it. Decisions are recorded when they
are load-bearing for future work, not for every refactor.

---

## D1 — Subagent communication topology: script-as-bus stands; no direct child-to-child channels

**Date:** 2026-09-12 · **Status:** accepted · **Confidence:** medium

**Context.** Every `agent()` call spawns a fresh, clean-context child session;
the orchestration script merges returned structured results and feeds them into
later prompts (script-as-bus); `ultracode_steer` lets the parent user session
inject text into one running child. Children are one-shot. Question: add direct
child-to-child channels, persistent session continuation, or neither?

**Method.** Adversarial research run `run_su4ornyszw12` (d2c-topology-research,
2026-09-12): 5 research angles (Claude Code, rival frameworks, academic
topology evidence, practitioner cost data, durable-execution patterns) → 14
falsifiable claims → 3 adversarial verifiers with distinct failure modes
(evidence-support / contradiction / freshness-and-hype) → batch skeptic →
design brief. All 5 researchers had live web tools; 14/14 claims survived
verification and the skeptic (unanimity is itself a caveat — verifiers may have
been lenient; read the confidence as medium, not gospel).

**Decision.**

1. **Skip direct child-to-child channels.** The bus is code, not an LLM: it
   forwards results deterministically and verbatim. Field defaults converged on
   isolation (CrewAI disables delegation by default; Google ADK parallel
   subagents cannot see peers; OpenAI docs state code-mediated orchestration is
   more deterministic and predictable in speed/cost). AutoGen-style shared
   transcripts grow every participant's context each round. Under matched
   budgets, multi-agent debate does not reliably beat single-model strategies;
   its wins concentrate in anchor-prone settings. Reopen only if a measured
   workload shows bus round-trips dominating cost or latency.
2. **Session continuation is conditional, not standalone.** Reusing one child
   session across prompts cuts re-pasted context in iterative fix/debate loops
   (Claude Code persists resumable subagent transcripts; OpenAI handoffs pay
   re-send-full-history by default). Build it only as a checkpoint-integrated
   feature with per-agent pending-write semantics — otherwise it recreates
   Claude Code agent teams' documented failure mode where `/resume` does not
   restore in-process teammates. Tracked as the conditional second step of the
   checkpoint/keyed-resume workstream (roadmap A).
3. **Differentiation axes vs Claude Code: cost discipline, context economy,
   deterministic replay — not budgets or mesh.** Claude Code's dynamic
   workflows already ship checkpointed deterministic replay (nondeterministic
   APIs rejected at replay so cached agent results are reusable) with 16
   concurrent / 1,000 total agent caps vs our 8 / 200, plus sibling messaging
   (`SendMessage`, v2.1.206+) and experimental mesh teams. Parity on
   replay/resume is table stakes; the honest edges are per-token
   predictability, intermediates held in script variables instead of the
   parent context, and rigorously done replay.

**Evidence highlights** (from the verified claim set of the research run).

- Anthropic engineering data: multi-agent systems ≈ 15× chat tokens; token
  usage alone explained 80% of performance variance on BrowseComp.
- LangGraph checkpointer: per-super-step snapshots with per-node pending
  writes — successful nodes are not re-run on resume. This is the durability
  model the keyed-resume workstream approximates.
- τ-bench (LangChain-modified): supervisor topologies lost to direct handoffs
  via "playing telephone"; targeted message hygiene recovered ~50% — topology
  hygiene beats topology changes.
- Claude Code dynamic workflows: model-authored scripts executed outside the
  conversation, intermediates in script variables, checkpointed deterministic
  replay, 16/1000 caps.
- Debate literature: tit-for-tat debate 26.0%→37.0% vs self-reflection 27.5%
  on anchor-prone arithmetic; advantage shrinks or vanishes under matched
  budgets and is hyperparameter-sensitive.

**Consequences.**

- Roadmap A (checkpoints + keyed warm replay + pending-write semantics) is
  parity work with Claude Code, not differentiation — do it properly and fast.
- The graph authoring layer (roadmap B) carries the differentiation: authoring
  cost, pre-flight validation, QC gates.
- Never claim budget or mesh advantages over Claude Code in docs or marketing.
- If a raw channel is ever built, it must be host-mediated and recorded in the
  run record (provenance), not free-form child chatter.

**Reopens if:** a measured workload shows bus round-trips dominating; the field
consensus on isolation flips; or session-continuation demand outgrows the
checkpoint-integrated design.

---

## D2 — Restart safety: truthful refusal over forwarded control; pid-proven death over heartbeat heuristics

**Status:** accepted 2026-09-28 (incident `run_k2axipsyfq2r` 2026-09-27, follow-up
`run_3impeasawiz2` "91m 49s ext stale").

**Context.** A server `kill -9` mid-run left persisted run records frozen as
`running` forever. Reconciliation ran at startup only; the replacement process
"adopted" the dead owner's record as a mirror and its `runs.has(id) → skip`
guard then exempted it from every later pass. Control was equally dishonest:
`ultracode_control stop` answered "supervisor refused" while the record kept
saying `running`, and a steer queued into a recovered idle-succeeded child
while reporting `accepted: true`.

**Decision.**

1. **Owner identity is pid-proven, three-factor.** A fresh owner marker with a
   checkable pid wins while the pid lives; a dead pid (ESRCH) flips the record
   immediately no matter how fresh the marker or heartbeat look (SIGKILL
   leaves both behind); pid-less markers (legacy, EPERM) fall back to the
   30-minute heartbeat window. Heartbeats are progress-independent (fixed
   cadence timer), so one silent 30-minute child can no longer starve a live
   owner into looking dead.
2. **Reconcile is periodic and re-classifies adopted mirrors.** Adoption is
   not a verdict. Locally created runs stay exempt (their live supervisor is
   authoritative); everything else re-classifies every tick.
3. **Remote-owner control is truthful refusal, not forwarding (Option B).**
   A reviewer analysis of the KV-mailbox alternative (Option A2) concluded
   that a "forwarded (pending)" answer recreates the soft-lie class this work
   exists to remove: the caller cannot distinguish accepted-from-owner from
   accepted-from-nobody. The only reachable live-remote path today is another
   window's project-scoped TUI panel, where naming the owning boot/pid is
   actionable. Stop therefore returns exactly one of three truths: stopped
   locally / orphaned-marked-interrupted (with a `rerun --warm` hint) /
   refused naming the live owner. **A2 (mailbox) is deliberately deferred**;
   it may be reopened if multi-window control of the same run becomes a real
   workflow, and then only with an answer that distinguishes
   delivered-vs-acted-on.
4. **Dead work is salvaged, not discarded.** Before flipping an orphaned run,
   a bounded harvest (`MAX_HARVEST_CHILDREN = 20`, provable-death-only: schema
   validation or exact-text, never repair rounds or guesses) promotes children
   OpenCode recovery finished on their own into warm-replayable rows.
   Legacy schema-mode rows without a stored schema whose text parses as JSON
   stay unresolvable — we cannot prove the contract they ran under.
5. **Deadlines and activity are durable.** `deadlineAt` persists at every
   watchdog arm (cleared on pause, re-armed on resume) so ANY process can
   enforce a run timeout whose owner wedged with a live pid and a dead timer
   — the 91-minute zombie. Child `lastActivityAt` persists throttled so
   `stalledMs` survives restarts.
6. **Hung RPCs land terminal.** Every session RPC has a per-await deadline
   (60s control / 15min prompt-wait) producing a typed, non-retried `timeout`
   error with best-effort interrupt — a wedged transport can no longer hold
   a child until the wall-clock watchdog, or forever for adopted records.
7. **Observability is bounded and structured.** A 256-event lifecycle ring on
   the record (RPC boundaries, admission gates, schema repair, watchdog,
   harvest, reconcile) plus `waitReason` on pending rows answer "what was the
   last thing that actually happened" post-mortem.

**Guardrail:** keyed warm-cache digest semantics are unchanged — the
failover-safety skip (`src/primitives.ts`, buildWarmCache excluding rows whose
spawnModel ≠ effectiveModel) is intentional and byte-for-byte preserved;
harvest never makes unfinished or model-switched rows replayable.

**Evidence.** Two production incidents (above); deterministic in-process twin
`test/restart-sim.test.ts` (real SIGKILL'd pid, shared persistence seam);
real-SIGKILL leg `scripts/live-test.sh restart` (docs/INTEGRATION-TEST.md §7).

**Reopens if:** multi-instance control of one run becomes a real workflow
(revisit A2); OpenCode exposes richer session-busy signals (tighten the steer
pre-flight beyond "outcome defined"); harvest needs schema inference for
legacy rows (only with a way to prove the contract).
