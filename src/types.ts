/**
 * Shared types — the single source of truth for module seams.
 * Verified against OpenCode v2 (0.0.0-beta-19151) via live spike; see docs/SPIKE-FINDINGS.md.
 *
 * Code style (enforced by toolchain): erasable syntax only (no enums/namespaces),
 * imports use explicit `.ts` extensions, JSON-safe data crosses module seams.
 */

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json | undefined }

// ---------------------------------------------------------------------------
// Plugin options (opencode.json `plugins: [{ package, options }]`)
// ---------------------------------------------------------------------------

export type PermissionMode = "ask" | "autoEditsWorkflow" | "noEditTools"

/**
 * Which agents a workflow may use:
 * - "host": every agent the location's registry exposes (shipped primaries
 *   like `build` included) — the historical behavior.
 * - "configured": only agents with a definition file in
 *   `<project>/.opencode/agents/` or `~/.config/opencode/agents/` — i.e.
 *   exactly the set managed by `opencode2 subagent-config` (enable/disable/
 *   add). Shipped agents become usable only once you create their file
 *   (e.g. `subagent-config set build <model>`).
 */
export type AgentScope = "host" | "configured"

/**
 * Provider-failover policy:
 * - "auto" (default): classify failures and fail over immediately — burst with
 *   jittered same-model backoff, quota by switching the SAME session to the
 *   first eligible ladder candidate.
 * - "ask": same as auto, but when a provider is quarantined (quota) or
 *   burst-throttled in a way that would fail over pending children, the run is
 *   PAUSED and one coalesced report is emitted to the parent; the run resumes
 *   via `ultracode_control { action: "resume", model?, remember? }`.
 * - "off": no failover at all — children fail with the typed provider error,
 *   exactly the pre-failover behavior. Retry policy is unaffected.
 */
export type FailoverMode = "auto" | "ask" | "off"

export interface UltracodeOptions {
  /** Default agent id for spawned agent() calls. Validated at run start (fail fast). Default "general". */
  agent?: string
  /** Max concurrently running child sessions. Default 8. */
  concurrency?: number
  /** Max total agent() calls per run. Default 200. */
  maxAgents?: number
  /** Wall-clock limit per run in ms. Default 3_600_000 (60 min). */
  timeoutMs?: number
  /** Permission handling for child sessions. Default "ask". */
  permissions?: PermissionMode
  /**
   * Auto-reject a workflow child's pending permission request after this many
   * ms, so runs fail visibly instead of hanging on prompts the user cannot
   * see (child sessions never surface a host permission dialog). 0 disables.
   * `noEditTools` mode rejects immediately regardless of this value.
   * Default 300_000 (5 min).
   */
  permissionStallMs?: number
  /** Max serialized result size returned to the session. Default 65_536 chars. */
  maxResultChars?: number
  /** Restrict usable agents to your configured set. Default "host". */
  agentScope?: AgentScope
  /**
   * Extra attempts for a child whose session fails at the provider level
   * (outcome "failed" — outage/rate-limit shaped). Retries CONTINUE the same
   * session on the same model (a failed session that did work is never
   * replaced); quota-shaped failures are never retried (same-model and
   * same-provider retries are guaranteed instant deaths). Aborts and schema
   * errors never retry. Default 1. 0 disables.
   */
  agentRetryAttempts?: number
  /**
   * Base of the jittered exponential retry backoff: attempt n waits
   * base * 2^n with +/-50% jitter, capped at 30_000 ms. 0 retries with no
   * wait. Default 5_000 ms. A stopping run never waits out a backoff.
   */
  agentRetryBackoffMs?: number
  /**
   * Mark a running child failed when it produces no activity for this many
   * ms (frozen provider streams, orphaned sessions), so runs fail visibly
   * instead of hanging on the run-level timeout. 0 disables.
   * Default 900_000 (15 min).
   */
  childStallMs?: number
  /**
   * Hard cap on `loop()` nesting depth inside one run (engine-owned; the
   * worker preflight rejects deeper nesting before iteration 1). Budgets are
   * shared across nested loops — the cap bounds structural blowup only.
   * Default 2.
   */
  maxLoopDepth?: number
  /**
   * Per-model failover ladder for quota-shaped provider failures: keys are
   * "provider/id" pin strings (no variant), values are ordered lists of
   * "provider/id#variant" fallback pins. Precedence: per-call
   * `agent(prompt, { fallbacks })` > this map > agent-config pins on other
   * providers (read-only children may additionally infer from the model
   * catalog). Failover always CONTINUES the same session via
   * `session.switchModel` — never a fresh session. Default {} (no ladder).
   */
  modelFallbacks?: Record<string, string[]>
  /**
   * Provider-failover policy: "auto" (default), "ask" (pause + one coalesced
   * report when a quarantine would fail over pending children; resume via
   * `ultracode_control`), or "off" (children fail typed — no failover).
   */
  failover?: FailoverMode
  /**
   * Ask-mode auto-proceed timeout: 0 (default) waits indefinitely while the
   * ask pause holds (paused runs do not burn timeoutMs); >0 resumes the run in
   * auto-mode policy after that many ms, even without an answer.
   */
  askTimeoutMs?: number
  /**
   * Per-provider in-flight cap (providerID → N, each N 1..16). Adds an
   * instance-level FIFO semaphore per provider (supervisor-owned, shared
   * across every run it owns) AND machine-level slot dirs under
   * ~/.local/share/opencode/ultracode/provider-slots/<providerID>/slot-<i>
   * (atomic mkdir; stale mtime >30s is reclaimable). Unconfigured providers
   * are unchanged. Default {} (no provider slots).
   */
  providerConcurrency?: Record<string, number>
}

export const DEFAULT_OPTIONS: Required<UltracodeOptions> = {
  agent: "general",
  concurrency: 8,
  maxAgents: 200,
  timeoutMs: 3_600_000,
  permissions: "ask",
  permissionStallMs: 300_000,
  maxResultChars: 65_536,
  agentScope: "host",
  agentRetryAttempts: 1,
  agentRetryBackoffMs: 5_000,
  childStallMs: 900_000,
  maxLoopDepth: 2,
  modelFallbacks: {},
  failover: "auto",
  askTimeoutMs: 0,
  providerConcurrency: {},
}

/** Local admission clamp (this repo default). Not a host API. */
export const CONCURRENCY_CAP = DEFAULT_OPTIONS.concurrency

/**
 * Wall-clock bounds shared by every timeoutMs source (options, `/ultracode set`,
 * panel overlay, per-run run input): 10 s .. 24 h.
 */
export const MIN_RUN_TIMEOUT_MS = 10_000
export const MAX_RUN_TIMEOUT_MS = 86_400_000

/**
 * `loop()` nesting-depth bounds shared by every maxLoopDepth source (config
 * option, per-run run input, worker preflight): 1..16. The config range is the
 * runaway guard; the per-run input may set any value inside it.
 */
export const MIN_LOOP_DEPTH = 1
export const MAX_LOOP_DEPTH = 16

/**
 * Per-loop iteration bounds shared by the worker's spec clamp
 * (`budget.iterations` silently clamps here) and the per-run
 * `maxLoopIterations` run input (rejected outside the range at tool-input
 * time). The run input is tighten-only: effective = min(spec budget, input).
 */
export const MIN_LOOP_ITERATIONS = 1
export const MAX_LOOP_ITERATIONS = 200

/** Clamp concurrency at the admission point (not in loadOptions). */
export function clampConcurrency(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CONCURRENCY_CAP
  return Math.min(CONCURRENCY_CAP, Math.max(1, Math.floor(value)))
}

/** Per-run captured settings shown in the inspect pane (subset of options). */
export type CapturedSettings = {
  concurrency: number
  maxAgents: number
  timeoutMs: number
  permissions: PermissionMode
  /** Copied into the frozen snapshot for the permission stall watchdog. */
  permissionStallMs?: number
  /**
   * Loop nesting cap this run enforced (config default or per-run override).
   * Not part of the 4-key settings panel — kept on the record so a run can
   * always answer "what cap was enforced?", override or not.
   */
  maxLoopDepth?: number
  /**
   * Per-run tighten-only iteration ceiling, present ONLY when the caller
   * passed maxLoopIterations. Absent = each loop ran its authored budget.
   */
  maxLoopIterations?: number
}

/** Model reference as `session.create` expects it ({ providerID, id, variant? }). */
export type ModelRef = { providerID: string; id: string; variant?: string }

/** Where a spawned child's intended model came from — precedence provenance. */
export type ModelSpawnSource = "call" | "run" | "pin"

/**
 * Intended spawn model on an agent record. `source` distinguishes an
 * INTENTIONAL override ("call"/"run") from a config pin or server default, so
 * drift reports can tell them apart.
 */
export type SpawnModel = ModelRef & { source?: ModelSpawnSource }

// ---------------------------------------------------------------------------
// Tool input (union, validated by src/tool-input.ts)
// ---------------------------------------------------------------------------

export interface WorkflowMeta {
  name?: string
  description?: string
  /** Phase labels for progress grouping. */
  phases?: string[]
  /** Agent ids that must exist before the run starts (preflight). */
  requires?: string[]
}

/**
 * Explicit model override, shared by every run-input variant: "provider/id"
 * or "provider/id#variant". Beats the user's agent-config pins for children
 * without a per-call model. Providers the user took offline
 * (`disabled_providers`) stay a hard block unless `allowDisabledProviders`.
 */
export interface ModelOverrideInput {
  model?: string
  /** Default false: a model on a disabled provider is rejected. Explicit true unlocks ALL disabled providers for THIS run (run-wide). */
  allowDisabledProviders?: boolean
}

/**
 * Per-run loop-cap overrides (all run variants): tighten the engine-owned
 * loop safety caps for THIS run without editing the script or touching the
 * project config. Mirrors the timeoutMs/model per-run override pattern.
 */
export interface LoopControlInput {
  /**
   * Per-run `loop()` nesting-depth cap (MIN_LOOP_DEPTH..MAX_LOOP_DEPTH, i.e.
   * 1..16). This run only; the preflight error points here. The plugin option
   * stays the global default and the range stays the runaway guard.
   */
  maxLoopDepth?: number
  /**
   * Per-run per-loop iteration ceiling (MIN_LOOP_ITERATIONS..MAX_LOOP_ITERATIONS,
   * i.e. 1..200), TIGHTEN-ONLY: each loop's effective bound is
   * min(budget.iterations, this) — the caller can cap a long-running template
   * at N passes but can never raise an authored budget. Per loop, not a
   * run-wide total; also binds loops inside composed `loop({unit})` workflows.
   */
  maxLoopIterations?: number
}

/** Run an inline script (async function body, plain JS — no ESM exports). */
export interface InlineRunInput extends ModelOverrideInput, LoopControlInput {
  script: string
  name?: string
  meta?: WorkflowMeta
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
  /** Per-run wall-clock override (ms, MIN_RUN_TIMEOUT_MS..MAX_RUN_TIMEOUT_MS). This run only. */
  timeoutMs?: number
}

/** Run a saved workflow by name (project dir beats personal dir). */
export interface SavedRunInput extends ModelOverrideInput, LoopControlInput {
  workflow: string
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
  /** Per-run wall-clock override (ms, MIN_RUN_TIMEOUT_MS..MAX_RUN_TIMEOUT_MS). This run only. */
  timeoutMs?: number
}

/**
 * Run a graph-authored workflow (inline DAG spec — validated and compiled by
 * src/graph.ts into a plain async-body script). Kept as a plain object here to
 * avoid a types <-> graph import cycle; deep validation lives in graph.ts.
 */
export interface GraphRunInput extends ModelOverrideInput, LoopControlInput {
  graph: Record<string, unknown>
  name?: string
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
  /** Per-run wall-clock override (ms, MIN_RUN_TIMEOUT_MS..MAX_RUN_TIMEOUT_MS). This run only. */
  timeoutMs?: number
}

export type WorkflowToolInput = InlineRunInput | SavedRunInput | GraphRunInput | PathRunInput | TemplateRunInput

/**
 * Run a project-relative workflow file by path (e.g.
 * ".opencode/workflows/foo.js"). Kills string-embedding pain: the authoring
 * agent writes the file with its file tool, then runs it by path. Trust
 * level equals an inline { script } — the user's own agent wrote the file
 * deliberately; the file is read at call time.
 */
export interface PathRunInput extends ModelOverrideInput, LoopControlInput {
  /** Project-root-relative POSIX path; no absolute paths, no ".." segments. */
  path: string
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
  /** Per-run wall-clock override (ms, MIN_RUN_TIMEOUT_MS..MAX_RUN_TIMEOUT_MS). This run only. */
  timeoutMs?: number
}

/** Run a served script template by name (args feed its declared params). */
export interface TemplateRunInput extends ModelOverrideInput, LoopControlInput {
  /** Known script-template name (see ultracode_catalog scriptTemplates). */
  template: string
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
  /** Per-run wall-clock override (ms, MIN_RUN_TIMEOUT_MS..MAX_RUN_TIMEOUT_MS). This run only. */
  timeoutMs?: number
}

/**
 * Resolved launch payload: what the tool executor hands the supervisor after
 * validation/compilation, and what the supervisor records on the RunRecord.
 */
export interface RunLaunchInput {
  script: string
  meta?: WorkflowMeta
  args?: Json
  name?: string
  workflowName?: string
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
  /** Originating DAG spec for graph-authored runs (persisted on the RunRecord). */
  graphSpec?: Json
  /**
   * Per-run wall-clock override from the run tool input. Applied only to this
   * run's frozen effective options — never persisted into the settings overlay.
   */
  timeoutMs?: number
  /**
   * Per-run `loop()` nesting-depth cap from the run tool input (1..16).
   * Applied only to this run's frozen effective options — the worker preflight
   * enforces it; the plugin option stays the global default.
   */
  maxLoopDepth?: number
  /**
   * Per-run tighten-only iteration ceiling from the run tool input (1..200):
   * each loop's effective bound is min(budget.iterations, this). Threaded to
   * the worker caps; never persisted into any settings surface.
   */
  maxLoopIterations?: number
  /**
   * Explicit run-level model override (parsed from the tool input `model`
   * string): applies to every child without a per-call `opts.model`. Beats
   * agent-config pins; gated by `allowDisabledProviders` for offline providers.
   */
  model?: ModelRef
  /** Escape hatch for the disabled_providers hard block (this run only). */
  allowDisabledProviders?: boolean
}

// ---------------------------------------------------------------------------
// Run + agent records (registry domain)
// ---------------------------------------------------------------------------

export type RunStatus =
  | "running"
  | "stopping"
  | "paused"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"

export type ActiveRunStatus = "running" | "stopping" | "paused"

/** True while a run still owns sessions and is a valid implicit-target. */
export function isActiveRunStatus(s: RunStatus): s is ActiveRunStatus {
  return s === "running" || s === "stopping" || s === "paused"
}

export type AgentStatus = "pending" | "running" | "succeeded" | "failed" | "interrupted"

export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface AgentRecord {
  /** Ordinal id within the run: "a1", "a2", ... */
  id: string
  label?: string
  phase?: string
  /** opts.agent, or the plugin default when omitted. */
  requestedAgent?: string
  /** Agent actually used, from the assistant message. */
  effectiveAgent?: string
  /** Model actually used (differs from pins/defaults when pins don't load). */
  effectiveModel?: { providerID: string; id: string } | null
  /**
   * Model intended at spawn (the resolved pin or override, when any). Set
   * before the child runs, so FAILED rows still show which model/provider was
   * targeted — 0-token provider deaths never populate effectiveModel.
   * `source` records precedence: "call" | "run" (explicit overrides) vs "pin".
   */
  spawnModel?: SpawnModel
  sessionID?: string
  status: AgentStatus
  error?: string
  tokens?: TokenUsage
  startedAt?: number
  endedAt?: number
  /** Parsed structured output when opts.schema was provided. */
  data?: Json
  /** Unique tool-call count for this agent's session (from run-events reducer). */
  toolCalls?: number
  /** Idempotency key from opts.key (present only for keyed calls). */
  key?: string
  /** sha256 over prompt + schema + agent — warm-rerun cache identity. */
  promptDigest?: string
  /** True when this record was replayed from a prior run (no session spawned). */
  cached?: boolean
  /** Final text (stored only for keyed calls, so future warm reruns can replay it). */
  resultText?: string
}

/** Phase-boundary checkpoint persisted on the run record (checkpoint() global). */
export interface CheckpointRecord {
  name: string
  at: number
  value?: Json
}

export interface RunRecord {
  directory?: string
  projectID?: string
  /** "run_" + 12 random base32 chars. */
  id: string
  parentSessionID: string
  parentAgent?: string
  name?: string
  status: RunStatus
  script: string
  meta?: WorkflowMeta
  args?: Json
  /**
   * Originating DAG spec for graph-authored runs (inline `{ graph }`, a saved
   * graph workflow, or a rerun of either). `script` is the COMPILED artifact;
   * this is the source of truth for `/ultracode graph`, `/ultracode save` and
   * the rerun "has this workflow changed?" check.
   */
  graphSpec?: Json
  /** Absolute path of the persisted script artifact. */
  scriptPath?: string
  /** Set when launched via {workflow: "name"}. */
  workflowName?: string
  startedAt: number
  endedAt?: number
  agents: AgentRecord[]
  /** Bounded final result (envelope.result or envelope.preview comes from this). */
  result?: Json
  resultTruncated?: boolean
  /** Full result artifact key in storage, when the result was truncated. */
  resultArtifactKey?: string
  error?: string
  totalTokens?: TokenUsage
  stopReason?: string
  /** Immutable effective options captured at startDetached. */
  effective?: CapturedSettings
  /** Phase-boundary checkpoints (checkpoint() global; newest last, capped). */
  checkpoints?: CheckpointRecord[]
  /** Source runID when this run was started warm (resumeFrom / rerun --warm). */
  resumedFrom?: string
  /**
   * Explicit per-run wall-clock override from the run tool input (additive).
   * Distinct from `effective` (the frozen settings): present ONLY when the
   * caller passed timeoutMs, so a warm rerun can reproduce the run's clock
   * without overriding a user's freshly configured default.
   */
  timeoutOverrideMs?: number
  /**
   * Explicit per-run `loop()` nesting-depth override from the run tool input
   * (additive). Present ONLY when the caller passed maxLoopDepth, so a rerun
   * reproduces the cap the script was authored against.
   */
  maxLoopDepthOverride?: number
  /**
   * Explicit per-run tighten-only iteration ceiling from the run tool input
   * (additive). Present ONLY when the caller passed maxLoopIterations; reruns
   * reproduce it so a capped rerun stays capped.
   */
  maxLoopIterationsOverride?: number
  /**
   * Explicit run-level model override from the run tool input (additive).
   * Persisted so `/ultracode rerun` reproduces the override; absent when the
   * run used pins/defaults only.
   */
  modelOverride?: ModelRef
  /** Set when the run unlocked disabled providers for its overrides. */
  allowDisabledProviders?: boolean
  /**
   * Process ownership for orphan reconciliation. Optional/additive: records
   * without owner keep the legacy "flip on restart" behavior.
   */
  owner?: { bootID: string; updatedAt: number }
}

export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

export function addTokens(into: TokenUsage, add?: Partial<TokenUsage> | null): TokenUsage {
  if (!add) return into
  into.input += add.input ?? 0
  into.output += add.output ?? 0
  into.reasoning += add.reasoning ?? 0
  into.cache.read += add.cache?.read ?? 0
  into.cache.write += add.cache?.write ?? 0
  return into
}

// ---------------------------------------------------------------------------
// Result envelope returned by the workflow tool
// ---------------------------------------------------------------------------

export interface RunEnvelope {
  runID: string
  name?: string
  status: RunStatus
  durationMs: number
  agents: { total: number; succeeded: number; failed: number; interrupted: number }
  tokens?: TokenUsage
  /** Distinct effective models ("providerID/id") children actually ran — empty omitted. */
  models?: string[]
  /** Present when the result fit within maxResultChars. */
  result?: Json
  /** Present instead of `result` when truncated. */
  preview?: string
  truncated: boolean
  /** Total compact-JSON length of the result (present whenever there is a result). */
  resultChars?: number
  /** Storage key of the full result artifact (present when truncated; additive — Builder B). */
  resultArtifactKey?: string
  scriptPath?: string
  workflowName?: string
  error?: string
  stopReason?: string
  /** Source runID when this run warm-started from another (additive). */
  resumedFrom?: string
}

// ---------------------------------------------------------------------------
// Workflow-script API (what runs INSIDE the worker)
// ---------------------------------------------------------------------------

export interface AgentOpts {
  /** Agent id. Default: plugin options.agent. Missing agent => fail fast with available list. */
  agent?: string
  /**
   * Explicit per-call model override ("provider/id#variant" resolved by the
   * host): beats the run-level override and agent-config pins for THIS child.
   * Invalid shapes fail the call fast; offline providers are rejected unless
   * the run set allowDisabledProviders.
   */
  model?: ModelRef
  /** Short label for progress UI + run records. */
  label?: string
  /** Phase grouping (explicit beats ambient phase() in concurrent code). */
  phase?: string
  /** JSON Schema for structured output; agent() returns { data } parsed + validated. */
  schema?: Json
  /**
   * Stable idempotency key. On a warm rerun (resumeFrom / rerun --warm), a
   * succeeded agent with the same key AND the same prompt digest is replayed
   * from the source run's record instead of spawning — pending-write
   * semantics: a resumed run never redoes successful children.
   */
  key?: string
  /**
   * Per-call retry override for provider-shaped (outcome) failures.
   * attempts clamped 0..3, backoffMs clamped 0..120_000 (base of the jittered
   * exponential schedule, capped at 30_000). Falls back to the plugin-level
   * agentRetryAttempts / agentRetryBackoffMs. Retries continue the SAME
   * session on the same model; quota-shaped failures never retry.
   */
  retry?: { attempts?: number; backoffMs?: number }
  /**
   * Per-call failover ladder (pin strings, ordered), applied ONLY when the
   * provider fails quota-shaped (or a burst budget is exhausted): beats the
   * plugin option modelFallbacks map for THIS child. The child continues in
   * the SAME session on the first eligible candidate; invalid/misspelled pins
   * fail the call at admission instead of being skipped.
   */
  fallbacks?: string[]
}

export interface AgentResult {
  /** Concatenated text parts of the final assistant message. */
  text: string
  sessionID: string
  agent?: string
  model?: { providerID: string; id: string } | null
  tokens?: TokenUsage
  /** Parsed structured output (present when opts.schema was given and validation succeeded). */
  data?: Json
  /** Present when this result was replayed from a prior run's warm cache. */
  cachedFrom?: string
  /**
   * Present when the child finished on a DIFFERENT model than the one it was
   * spawned on (provider quota failover): the spawn model, the model that
   * actually finished, and why. Informational — the registry row keeps
   * spawnModel (intended) and effectiveModel (what ran) alongside it. `class`
   * is the triggering failure class: `"quota"` for quota/quarantine routing,
   * `"burst"` when the same-model burst budget was exhausted and the ladder ran.
   */
  failover?: {
    from: ModelRef
    to: ModelRef
    class: "quota" | "burst"
    reason: string
  }
}

/** A queue() worklist item (serializable; ids are content-hashed when absent). */
export interface QueueItem {
  id: string
  text: string
  deps?: string[]
  tags?: string[]
  meta?: Json
  status?: "open" | "active" | "blocked" | "done"
  note?: string | null
}

export interface QueueSizes {
  total: number
  open: number
  active: number
  blocked: number
  done: number
  ready: number
  /** Open items whose (present) dependencies are not all done yet. */
  unready: number
  /** Open items referencing a dep id that is not in the queue — never become ready. */
  missingDeps: number
}

/** Pure serializable worklist returned by the queue() global. */
export interface QueueHandle {
  push(item: QueueItem | QueueItem[]): string[]
  pop(): QueueItem | null
  popMany(n: number): QueueItem[]
  done(id: string, note?: string): boolean
  block(id: string, reason?: string): boolean
  unblock(id: string): boolean
  sizes(): QueueSizes
  items(): QueueItem[]
}

export type LoopStopReason = "target" | "queue-empty" | "stall" | "budget" | "blocked" | "error"

export interface LoopBudgetInput {
  /** Max iterations (default 10, engine-clamped 1..200). */
  iterations?: number
  /** Max TOTAL agent calls per iteration — iterate + verdict + skeptic (default 12, clamped 1..64). */
  agentsPerIteration?: number
  /** Max loop wall-clock ms (also bounded by the run clock). */
  wallMs?: number
  /** Max summed child tokens (input+output+reasoning) before the loop stops. */
  tokens?: number
  /** Absolute stop: epoch ms or a Date-parseable string ("til 8am"-shaped). */
  deadline?: number | string
}

export interface LoopIterationCtx {
  /** 0-based iteration index. */
  i: number
  key: string
  goal: string
  /** The current loop state (what the previous iterate returned). */
  state: Json
  /** The previous iteration's `result`, when provided. */
  lastResult: Json | null
  /** Budget remaining (agentsPerIteration is AFTER the verdict/skeptic reservation). */
  budgetLeft: { iterations: number; agentsPerIteration: number; wallMs: number; tokens: number }
  /** Per-iteration artifact directory (`<run artifacts>/it-<i>`) or null. */
  artifactsDir: string | null
  /** Stable run-level directory for cross-iteration artifacts. */
  runDir: string | null
  /** Bounded compact log of prior iterations (status/digest/error/skeptic). */
  history: Array<{ i: number; status: string; digest?: string; error?: string; skeptic?: string; skepticReason?: string }>
  /** Previous iteration's verdict data (schema-validated; null when its termination was refuted). */
  lastVerdict: Json | null
}

export type LoopIterate = (
  ctx: LoopIterationCtx,
) => Promise<{ state: Json; result?: Json }> | { state: Json; result?: Json }

export interface LoopVerdictInput {
  /** Judge agent id (default: the plugin default agent). Use a DIFFERENT agent than the workers. */
  agent?: string
  /** JSON Schema for the judge's structured output (evidence-shaped recommended). */
  schema?: Json
  /**
   * Prompt builder: a string or a function of the iteration outcome (i, goal,
   * state, result). The judge is told to cite evidence; a `done`/`target`
   * status must survive one skeptic re-derivation before the loop may stop.
   */
  prompt?: string | ((ctx: { i: number; goal: string; state: Json; result: Json | null }) => string)
  /** Default true: a terminating verdict must survive one independent skeptic re-derivation. */
  skeptic?: boolean
}

export interface LoopSpec {
  /** Stable loop id: drives auto-keys (`<key>:i<n>:a<m>`), checkpoints and phases. */
  key: string
  goal?: string
  /** Initial state (the script owns state; iterate is the sole writer). */
  state?: Json
  budget?: LoopBudgetInput
  stop?: {
    /**
     * Truthy stops the loop (a string names the stop reason). Never invoked
     * for an iteration whose terminating verdict was refuted — the claim is
     * void, so state resting on it must not stop the loop either.
     */
    predicate?: (input: {
      i: number
      state: Json
      result: Json | null
      verdict: Json | null
      goal: string
    }) => boolean | string
    /** Consecutive no-progress iterations before a stall stop (default 3, 1..10). */
    stallK?: number
  }
  verdict?: LoopVerdictInput
  /** Run a TRUSTED saved workflow each iteration instead of a local iterate fn. */
  unit?: { name: string; args?: Json | ((ctx: LoopIterationCtx) => Json) }
  /** Iteration-failure policy: retry once (default) | record and continue | stop with reason "error". */
  onIterationError?: "retry" | "record" | "abort"
}

export interface LoopSummary {
  key: string
  goal: string
  iterations: number
  stopReason: LoopStopReason | string
  state: Json
  lastVerdict: Json | null
  lastResult: Json | null
  history: Json[]
  spent: { agents: number; tokens: number; wallMs: number; errors: number }
}

/** The globals injected into the worker sandbox (see src/worker-script.ts). */
export interface WorkflowScriptGlobal {
  agent(prompt: string, opts?: AgentOpts): Promise<AgentResult>
  parallel<T>(thunks: ReadonlyArray<() => T | Promise<T>>): Promise<Array<T | null>>
  pipeline<I, O>(
    items: readonly I[],
    ...stages: Array<(item: I, index: number) => Promise<O> | O>
  ): Promise<unknown[]>
  phase(name: string): void
  progress(text: string): void
  /** Persist a named checkpoint (small JSON value) onto the run record. */
  checkpoint(name: string, value?: Json): void
  workflow(name: string, args?: Json): Promise<Json>
  /** Engine-owned iteration primitive (budgets, verdicts, stall, checkpoints). */
  loop(spec: LoopSpec, iterate?: LoopIterate): Promise<LoopSummary>
  /** Pure serializable worklist (pop/push/done/block; content-hashed ids). */
  queue(initial?: QueueItem[], opts?: { id?: string }): QueueHandle
  sleep(ms: number): Promise<void>
  console: { log(...args: unknown[]): void }
  args: Json | undefined
  meta: WorkflowMeta
}

// ---------------------------------------------------------------------------
// Worker <-> host RPC bridge (JSON messages over postMessage)
// ---------------------------------------------------------------------------

export type BridgeCallName = "agent" | "workflow" | "workflow-check" | "stopAck"

export interface BridgeCall {
  type: "call"
  id: number
  fn: BridgeCallName
  args: Json[]
}

export interface BridgeResultOk {
  type: "result"
  id: number
  ok: true
  value: Json
}

export interface BridgeResultErr {
  type: "result"
  id: number
  ok: false
  error: string
}

export interface BridgeEvent {
  type: "event"
  kind: "progress" | "phase" | "log"
  data: Json
}

/** host -> worker: launch the script (additive; sent once, before anything else). */
export interface BridgeInit {
  type: "init"
  script: string
  args?: Json
  meta?: WorkflowMeta
}

/** worker -> host: final script outcome (additive; settles the run). */
export interface BridgeDone {
  type: "done"
  ok: boolean
  value?: Json
  error?: string
}

/** worker -> host */
export type WorkerMessage = BridgeCall | BridgeEvent | BridgeDone
/** host -> worker */
export type HostMessage = BridgeResultOk | BridgeResultErr | BridgeInit

// ---------------------------------------------------------------------------
// Saved workflows (storage domain)
// ---------------------------------------------------------------------------

/** Saved-workflow artifact kind. Absent on manifests written before graphs = "script". */
export type WorkflowKind = "script" | "graph"

export interface SavedWorkflowManifest {
  /** Format version. */
  version: 1
  name: string
  description?: string
  phases?: string[]
  requires?: string[]
  /**
   * sha256 of the executable script body. For `kind: "graph"` this is the digest
   * of the COMPILED script — the thing that actually runs — so a compiler change
   * invalidates trust (fail closed). Changed hash after save => re-confirmation.
   */
  hash: string
  /** Where it was loaded from. */
  source: "project" | "personal"
  savedAt: number
  savedFromRunID?: string
  /** Artifact kind: `<name>.js` (script) or `<name>.graph.json` (graph spec). */
  kind?: WorkflowKind
  /**
   * Model ids the workflow explicitly names (trust surfacing): static scan of
   * `model:` literals in the script body and `model` fields in a graph spec.
   * Absent when the workflow routes only via agent ids / config pins.
   */
  modelsUsed?: string[]
  /** Declared `args` shape — see WorkflowParams (workstream C). */
  params?: Json
}

/**
 * What a caller may supply when saving; `version`, `hash`, `savedAt` and `kind`
 * are always computed by storage (never trusted from the caller).
 */
export type SaveWorkflowManifestInput = Omit<
  SavedWorkflowManifest,
  "version" | "hash" | "savedAt" | "source" | "kind"
> & { source: "project" | "personal" }

export interface SavedWorkflow {
  manifest: SavedWorkflowManifest
  /**
   * Executable script body. For a graph workflow this is COMPILED FRESH from the
   * spec on every load (never a stale artifact). Empty with `graphError` set when
   * the spec could not be loaded — such an entry can never be trusted or run.
   */
  script: string
  /** Parsed spec for `manifest.kind === "graph"` (absent for script workflows). */
  graphSpec?: Json
  /** Why a graph spec failed to parse, validate or compile (load-time diagnostic). */
  graphError?: string
}

// ---------------------------------------------------------------------------
// Registry interface (implemented by src/registry.ts, consumed by supervisor + commands)
// ---------------------------------------------------------------------------

export interface Registry {
  create(init: {
    directory?: string
    projectID?: string
    parentSessionID: string
    parentAgent?: string
    script: string
    meta?: WorkflowMeta
    args?: Json
    name?: string
    workflowName?: string
    graphSpec?: Json
  }): RunRecord
  get(runID: string): RunRecord | undefined
  listRecent(limit: number): RunRecord[]
  activeRuns(): RunRecord[]
  /** Mark run status (running->stopping->final). Returns false if run is gone. */
  setStatus(runID: string, status: RunStatus, extra?: { error?: string; stopReason?: string }): boolean
  /** Append a new agent record; returns it with assigned ordinal id. */
  addAgent(runID: string, init: Omit<AgentRecord, "id">): AgentRecord | undefined
  updateAgent(runID: string, agentID: string, patch: Partial<AgentRecord>): void
  getAgent(runID: string, agentID: string): AgentRecord | undefined
  /** Append a phase-boundary checkpoint (bounded — oldest dropped). */
  addCheckpoint(runID: string, name: string, value?: Json): void
  /** Record final result + totals. */
  finish(runID: string, outcome: {
    status: RunStatus
    result?: Json
    resultTruncated?: boolean
    resultArtifactKey?: string
    error?: string
    stopReason?: string
  }): RunRecord | undefined
  /** Active-run ownership (nested-run rejection, permission scoping). */
  markOwned(runID: string, sessionID: string): void
  isOwnedActive(sessionID: string): boolean
  /** Durable provenance (survives run completion). */
  wasEverOwned(sessionID: string): boolean
  runForActiveSession(sessionID: string): RunRecord | undefined
  /**
   * Bind a child session to an agent for the life of the process (survives
   * run finalize — provenance for tool-count events).
   */
  bindAgentSession(runID: string, agentID: string, sessionID: string): void
  /** Reverse lookup for event routing. Survives finalize. */
  agentForSession(sessionID: string): { runID: string; agentID: string } | undefined
  /** On plugin load: mark persisted running/stopping/paused runs as interrupted (no auto-replay). */
  reconcileOrphans(): void
  /** Persist the current in-memory record immediately (effective snapshot, etc.). */
  persistNow(runID: string): void
}

// ---------------------------------------------------------------------------
// Storage interface (implemented by src/storage.ts)
// ---------------------------------------------------------------------------

export interface RunArtifact {
  runID: string
  script: string
  /** Full result when truncated for the envelope. */
  result?: Json
}

export interface Storage {
  /** Persist run snapshot (throttle-friendly). Throw-safe. */
  saveRun(record: RunRecord): void
  loadRuns(): RunRecord[]
  /** Write the script artifact file; returns absolute path. */
  writeScriptArtifact(runID: string, script: string): Promise<string | undefined>
  /**
   * Absolute directory for a run's artifacts (loop ctx.artifactsDir/runDir)
   * — `.opencode/workflows/runs/<runID>/`. Optional: test doubles may omit;
   * the loop runtime then exposes null dirs.
   */
  runDirFor?(runID: string): string | undefined
  /**
   * Persist a large result; returns the storage key, or undefined when the
   * value could not be serialized (no key is claimed in that case — callers
   * must not mark the run as having an artifact).
   */
  saveResultArtifact(runID: string, result: Json): string | undefined
  loadResultArtifact(key: string): Json | undefined
  /** List saved workflows (project dir beats personal dir on name collision). */
  listWorkflows(): SavedWorkflow[]
  loadWorkflow(name: string): SavedWorkflow | undefined
  /** Save a run's script as a named workflow (js + json manifest). Throws on invalid name. */
  saveWorkflow(name: string, script: string, manifest: SaveWorkflowManifestInput): Promise<SavedWorkflow>
  /**
   * Save a graph spec as a named workflow (`<name>.graph.json` + json manifest).
   * Validates and compiles BEFORE writing — an invalid spec is never persisted.
   * `opts.rewriteSpec: false` writes only the manifest (the Plan→Build handoff
   * leaves the authored spec file untouched).
   */
  saveGraphWorkflow(
    name: string,
    spec: Json,
    manifest: SaveWorkflowManifestInput,
    opts?: { rewriteSpec?: boolean },
  ): Promise<SavedWorkflow>
  /**
   * Plan-mode handoff: contained-read `<project>/.opencode/workflows/<name>.js`
   * (or `<name>.graph.json` when there is no script), then write the manifest
   * pair. Omits `savedFromRunID`. Does not auto-trust.
   */
  saveWorkflowFromFile(name: string): Promise<SavedWorkflow>
  /** Project-scoped settings overlay (`settings/<pid>`). Sync cache after load/save. */
  loadSettingsOverlay(): SettingsOverlayLike | undefined
  loadSettingsOverlayAsync(): Promise<SettingsOverlayLike | undefined>
  saveSettingsOverlay(overlay: SettingsOverlayLike): void
}

/** KV overlay shape (partial panel settings). */
export type SettingsOverlayLike = {
  concurrency?: number
  maxAgents?: number
  timeoutMs?: number
  permissions?: PermissionMode
  /** Remembered failover entries (see settings.SettingsOverlay; not a panel key). */
  modelFallbacks?: Record<string, string[]>
}

// ---------------------------------------------------------------------------
// Supervisor interface (implemented by src/supervisor.ts, called from index.ts)
// ---------------------------------------------------------------------------

export interface ParentContext {
  directory?: string
  projectID?: string
  sessionID: string
  agent?: string
  messageID?: string
  /** Throttled tool.progress reporter. Never throws. */
  report(status: string): void
  /**
   * Agent ids available in this location (from ctx.agent.list().data), when
   * known. Used to fail fast on unknown agent() targets. Optional (additive):
   * when absent, agent ids are not pre-validated.
   */
  availableAgents?: string[]
}

export interface RunOutcome {
  run: RunRecord
  envelope: RunEnvelope
}

/**
 * Provider-failure class as the run-level breaker consumes it (a mirror of
 * `FailureClassification.class` values that matter to admission — "other" is
 * never reported).
 */
export type ProviderFailureClass = "quota" | "burst"

/**
 * Read-only snapshot of one quarantined provider (orchestrator surfaces: the
 * `ultracode_control` resume path keys a remembered fallback on `models`).
 */
export interface ProviderQuarantineSnapshot {
  providerID: string
  /** Parsed reset time (epoch ms) when the failure exposed one; undefined = run-lifetime. */
  resetAt?: number
  /** "provider/id" keys whose failures triggered the quarantine (bounded, deduped). */
  models: string[]
}

/**
 * Run-level provider breaker seam (implemented by src/supervisor.ts, consumed
 * by src/primitives.ts AgentRunner). ONE instance belongs to a supervisor and
 * is shared across its runs: a quota strike quarantines the provider (until
 * the parsed reset, else for the supervisor's lifetime) so later children
 * resolving to it never create a session; three burst strikes within 60 s
 * throttle admission (serialize + stagger) until a 60 s quiet window — never
 * an abort. The runner reports every classified child failure here and
 * consults it before `session.create`.
 */
export interface ProviderHealth {
  /** True while providerID is quota-quarantined (account-level, hours long). */
  isQuarantined(providerID: string): boolean
  /** Quarantine expiry (epoch ms) when the parsed reset is known; undefined = run-lifetime. */
  quarantinedUntil(providerID: string): number | undefined
  /** True while the burst throttle is engaged (>=3 strikes in the last 60 s). */
  isThrottled(providerID: string): boolean
  /**
   * Admission gate: no-op unless the provider is burst-throttled. When
   * throttled, admissions for that provider are serialized and staggered
   * (default 200 ms apart); abort-aware (rejects with an abort AgentCallError).
   */
  admit(providerID: string, signal?: AbortSignal): Promise<void>
  /** Report one classified child failure (quota quarantines; burst strikes/throttles). */
  report(input: {
    runID: string
    providerID: string
    class: ProviderFailureClass
    /** Parsed reset time from the classification, when any. */
    resetAt?: number
    /** "provider/id" of the failing model (ask-report key resolution). */
    model?: string
  }): void
}

export interface Supervisor {
  /**
   * Execute a resolved run. Resolves only after all children are settled
   * (success, failure, stop, or timeout) — never while agents are live.
   */
  start(input: RunLaunchInput, parent: ParentContext): Promise<RunOutcome>
  /**
   * Same spawn path as start(), but returns the runID immediately. `done`
   * settles with the envelope (never rejects after the run is created).
   */
  startDetached(input: RunLaunchInput, parent: ParentContext): { runID: string; done: Promise<RunOutcome> }
  /** Replace next-run defaults. In-flight runs keep their startDetached snapshot. */
  updateDefaults(next: Required<UltracodeOptions>): void
  /** Idempotent stop. Returns false if runID unknown or already final. */
  stop(runID: string, reason: string): boolean
  /** Close admission of new agent() calls. Returns false if not running. */
  pause(runID: string): boolean
  /**
   * Reopen admission. Returns false if not paused. Ask mode: the optional
   * `model` pin becomes the run-level fallback OVERRIDE — failovers (and
   * quarantine routing) for this run prefer it over the configured ladder.
   */
  resume(runID: string, opts?: { model?: ModelRef }): boolean
  stopAll(reason: string): void
  /** Currently quarantined providers (ask-mode diagnostics + remember keying). */
  providerQuarantines(): ProviderQuarantineSnapshot[]
  isOwnedSession(sessionID: string): boolean
  /**
   * Bump a child session's last-activity timestamp (called from the host
   * event subscription). Feeds the child-liveness watchdog (childStallMs):
   * a running child with no activity for that long is interrupted and its
   * record marked with a stall error — runs fail visibly, no zombie rows.
   */
  noteChildActivity(sessionID: string): void
  activeRuns(): RunRecord[]
  /** Plugin unload: stop everything, kill workers, reject pending bridge calls. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Narrow capability interfaces (implemented by the real plugin context in
// src/index.ts, by fakes in test/fakes.ts — keeps modules testable)
// ---------------------------------------------------------------------------

/** Mirror of the verified plugin session methods (see docs/SPIKE-FINDINGS.md). */
export interface SessionCtx {
  create(input: {
    title?: string
    agent?: string
    /** Pinned model applied at create time when known (SDK object shape). */
    model?: { providerID: string; id: string; variant?: string }
    metadata?: Record<string, unknown>
  }): Promise<{ id: string; agent?: string }>
  get(input: { sessionID: string }): Promise<{
    id: string
    agent?: string
    outcome?: string
    tokens?: TokenUsage
    /** Provider/host error text for failed sessions, when the server exposes it. */
    error?: string
  }>
  prompt(input: { sessionID: string; text: string }): Promise<{ id: string }>
  wait(input: { sessionID: string }): Promise<void>
  context(input: { sessionID: string }): Promise<ReadonlyArray<ContextMessage>>
  interrupt(input: { sessionID: string; continue: boolean }): Promise<void>
  /**
   * Switch a session's model IN PLACE (the verified host session domain
   * exposes it; fork/compact do not exist there). Used by same-session
   * continuations after a provider failure. Optional and feature-detected:
   * hand-built doubles may omit it, and the driver fails a requested switch
   * typed rather than silently continuing on the dead model.
   */
  switchModel?(input: {
    sessionID: string
    model: { providerID: string; id: string; variant?: string }
  }): Promise<void>
}

/**
 * Structured provider error carried on a failed assistant message. Production
 * shape observed on rate-limited turns: finish "error" plus
 * `{ type: "provider.rate-limit", message: "Rate limit reached for requests",
 * status: 429 }`. Read-only passthrough from the server's message JSON — the
 * only error signal a failed session exposes (SessionInfo has no error field).
 */
export interface ContextMessageError {
  type?: string
  message?: string
  status?: number
}

/** Verified context message shapes. */
export interface ContextMessage {
  id: string
  type: "user" | "assistant" | "synthetic" | "system" | "shell" | string
  text?: string
  agent?: string
  model?: { providerID: string; id: string } | null
  content?: ReadonlyArray<{ type: string; text?: string }>
  finish?: string
  /** Structured provider error on a failed turn (see ContextMessageError). */
  error?: ContextMessageError
  tokens?: TokenUsage
}

/** Plugin KV subset (ctx.storage). */
export interface KvLike {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  remove?(key: string): Promise<void>
  scan?(options: { prefix: string; after?: string; limit?: number }): Promise<{ entries: ReadonlyArray<{ key: string; value: Json }>; next?: string }>
}

/** Filesystem subset used by storage. */
export interface FsLike {
  mkdir(path: string, recursive?: boolean): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
  /** Resolve symlinks (node:fs realpath); throws on missing paths. */
  realpath(path: string): Promise<string>
  /**
   * lstat without following symlinks; resolves to undefined when the path does
   * not exist (ENOENT mapped), throws on other errors.
   */
  lstat(path: string): Promise<{ isSymbolicLink(): boolean } | undefined>
}

export function randomRunID(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456"
  let out = ""
  for (let i = 0; i < 12; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return `run_${out}`
}

export interface RunCounts {
  total: number
  succeeded: number
  failed: number
  interrupted: number
}

export function countAgents(run: RunRecord): RunCounts {
  const counts: RunCounts = { total: run.agents.length, succeeded: 0, failed: 0, interrupted: 0 }
  for (const a of run.agents) {
    if (a.status === "succeeded") counts.succeeded++
    else if (a.status === "failed") counts.failed++
    else if (a.status === "interrupted") counts.interrupted++
  }
  return counts
}
