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
}

/** Run a saved workflow by name (project dir beats personal dir). */
export interface SavedRunInput {
  workflow: string
  args?: Json
  /**
   * Proceed despite a manifest/script hash mismatch (script changed on disk
   * since it was saved). Added additively by Builder A per CONTRACTS.md.
   */
  confirm?: boolean
}

export type WorkflowToolInput = InlineRunInput | SavedRunInput

// ---------------------------------------------------------------------------
// Run + agent records (registry domain)
// ---------------------------------------------------------------------------

export type RunStatus =
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "stopped"
  | "interrupted"

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
}

export interface RunRecord {
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
  /** Present when the result fit within maxResultChars. */
  result?: Json
  /** Present instead of `result` when truncated. */
  preview?: string
  truncated: boolean
  scriptPath?: string
  workflowName?: string
  error?: string
  stopReason?: string
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
  /** On plugin load: mark persisted running/stopping runs as interrupted (no auto-replay). */
  reconcileOrphans(): void
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
  /** Persist a large result; returns the storage key. */
  saveResultArtifact(runID: string, result: Json): string
  loadResultArtifact(key: string): Json | undefined
  /** List saved workflows (project dir beats personal dir on name collision). */
  listWorkflows(): SavedWorkflow[]
  loadWorkflow(name: string): SavedWorkflow | undefined
  /** Save a run's script as a named workflow (js + json manifest). Throws on invalid name. */
  saveWorkflow(name: string, script: string, manifest: Omit<SavedWorkflowManifest, "version" | "hash" | "savedAt" | "source"> & { source: "project" | "personal" }): Promise<SavedWorkflow>
}

// ---------------------------------------------------------------------------
// Supervisor interface (implemented by src/supervisor.ts, called from index.ts)
// ---------------------------------------------------------------------------

export interface ParentContext {
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
  start(input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string }, parent: ParentContext): Promise<RunOutcome>
  /** Idempotent stop. Returns false if runID unknown or already final. */
  stop(runID: string, reason: string): boolean
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
  create(input: { title?: string; agent?: string }): Promise<{ id: string; agent?: string }>
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
  scan?(options: { prefix: string; limit?: number }): Promise<{ entries: ReadonlyArray<{ key: string; value: Json }>; next?: string }>
}

/** Filesystem subset used by storage. */
export interface FsLike {
  mkdir(path: string, recursive?: boolean): Promise<void>
  writeFile(path: string, content: string): Promise<void>
  readFile(path: string): Promise<string>
  exists(path: string): Promise<boolean>
  readdir(path: string): Promise<string[]>
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
