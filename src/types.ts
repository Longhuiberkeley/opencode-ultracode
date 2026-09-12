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
  /** Max serialized result size returned to the session. Default 65_536 chars. */
  maxResultChars?: number
}

export const DEFAULT_OPTIONS: Required<UltracodeOptions> = {
  agent: "general",
  concurrency: 8,
  maxAgents: 200,
  timeoutMs: 3_600_000,
  permissions: "ask",
  maxResultChars: 65_536,
}

/** Local admission clamp (this repo default). Not a host API. */
export const CONCURRENCY_CAP = DEFAULT_OPTIONS.concurrency

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
}

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

/** Run an inline script (async function body, plain JS — no ESM exports). */
export interface InlineRunInput {
  script: string
  name?: string
  meta?: WorkflowMeta
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
}

/** Run a saved workflow by name (project dir beats personal dir). */
export interface SavedRunInput {
  workflow: string
  args?: Json
  /** Default true: return after admission. Explicit false blocks until the envelope. */
  background?: boolean
  /** Warm-start from a prior run: keyed succeeded agents replay from cache. */
  resumeFrom?: string
}

export type WorkflowToolInput = InlineRunInput | SavedRunInput

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
  sleep(ms: number): Promise<void>
  console: { log(...args: unknown[]): void }
  args: Json | undefined
  meta: WorkflowMeta
}

// ---------------------------------------------------------------------------
// Worker <-> host RPC bridge (JSON messages over postMessage)
// ---------------------------------------------------------------------------

export type BridgeCallName = "agent" | "workflow" | "stopAck"

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

export interface SavedWorkflowManifest {
  /** Format version. */
  version: 1
  name: string
  description?: string
  phases?: string[]
  requires?: string[]
  /** sha256 of the script body. Changed hash after save => trust re-confirmation. */
  hash: string
  /** Where it was loaded from. */
  source: "project" | "personal"
  savedAt: number
  savedFromRunID?: string
}

export interface SavedWorkflow {
  manifest: SavedWorkflowManifest
  script: string
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
  saveWorkflow(name: string, script: string, manifest: Omit<SavedWorkflowManifest, "version" | "hash" | "savedAt" | "source"> & { source: "project" | "personal" }): Promise<SavedWorkflow>
  /**
   * Plan-mode handoff: contained-read `<project>/.opencode/workflows/<name>.js`,
   * then write the js+json pair. Omits `savedFromRunID`. Does not auto-trust.
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

export interface Supervisor {
  /**
   * Execute a resolved run. Resolves only after all children are settled
   * (success, failure, stop, or timeout) — never while agents are live.
   */
  start(input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string; resumeFrom?: string }, parent: ParentContext): Promise<RunOutcome>
  /**
   * Same spawn path as start(), but returns the runID immediately. `done`
   * settles with the envelope (never rejects after the run is created).
   */
  startDetached(
    input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string; resumeFrom?: string },
    parent: ParentContext,
  ): { runID: string; done: Promise<RunOutcome> }
  /** Replace next-run defaults. In-flight runs keep their startDetached snapshot. */
  updateDefaults(next: Required<UltracodeOptions>): void
  /** Idempotent stop. Returns false if runID unknown or already final. */
  stop(runID: string, reason: string): boolean
  /** Close admission of new agent() calls. Returns false if not running. */
  pause(runID: string): boolean
  /** Reopen admission. Returns false if not paused. */
  resume(runID: string): boolean
  stopAll(reason: string): void
  isOwnedSession(sessionID: string): boolean
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
  }>
  prompt(input: { sessionID: string; text: string }): Promise<{ id: string }>
  wait(input: { sessionID: string }): Promise<void>
  context(input: { sessionID: string }): Promise<ReadonlyArray<ContextMessage>>
  interrupt(input: { sessionID: string; continue: boolean }): Promise<void>
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
