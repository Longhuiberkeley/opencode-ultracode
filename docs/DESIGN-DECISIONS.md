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
