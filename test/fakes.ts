/**
 * Fake infrastructure for unit tests. Builders EXTEND this file — do not rewrite
 * existing helpers (additive changes only, note them in your report).
 *
 * Run tests: npm test  (node --experimental-strip-types --test test/)
 */
import type {
  AgentRecord,
  ContextMessage,
  FsLike,
  Json,
  KvLike,
  Registry,
  RunRecord,
  RunStatus,
  SavedWorkflow,
  SavedWorkflowManifest,
  SessionCtx,
  SettingsOverlayLike,
  Storage,
  TokenUsage,
  WorkflowMeta,
} from "../src/types.ts"
import { createHash } from "node:crypto"
import { compileGraphSpec } from "../src/graph.ts"
import type { GraphSpec } from "../src/graph.ts"
import { emptyTokens, isActiveRunStatus } from "../src/types.ts"

// ---------------------------------------------------------------------------
// Fake KV
// ---------------------------------------------------------------------------

export class FakeKv implements KvLike {
  store = new Map<string, Json>()

  async get(key: string): Promise<Json | undefined> {
    return this.store.get(key)
  }

  async set(key: string, value: Json): Promise<void> {
    this.store.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key)
  }

  async scan(options: { prefix: string; limit?: number }): Promise<{
    entries: ReadonlyArray<{ key: string; value: Json }>
    next?: string
  }> {
    const entries = [...this.store.entries()]
      .filter(([k]) => k.startsWith(options.prefix))
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key))
    return { entries: options.limit ? entries.slice(0, options.limit) : entries }
  }
}

// ---------------------------------------------------------------------------
// Fake filesystem
// ---------------------------------------------------------------------------

export class FakeFs implements FsLike {
  files = new Map<string, string>()

  normalize(path: string): string {
    const isAbs = path.startsWith("/")
    const parts: string[] = []
    for (const part of path.split("/")) {
      if (part === "" || part === ".") continue
      if (part === "..") {
        parts.pop()
        continue
      }
      parts.push(part)
    }
    return (isAbs ? "/" : "") + parts.join("/")
  }

  dirname(path: string): string {
    const n = this.normalize(path)
    const idx = n.lastIndexOf("/")
    return idx <= 0 ? "/" : n.slice(0, idx)
  }

  async mkdir(path: string): Promise<void> {
    this.files.set(this.normalize(path + "/.keep"), "")
  }

  async writeFile(path: string, content: string): Promise<void> {
    const n = this.normalize(path)
    await this.mkdir(this.dirname(n))
    this.files.set(n, content)
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(this.normalize(path))
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(this.normalize(path))
  }

  async readdir(path: string): Promise<string[]> {
    const n = this.normalize(path)
    const out = new Set<string>()
    for (const key of this.files.keys()) {
      if (!key.startsWith(n + "/")) continue
      const rest = key.slice(n.length + 1)
      if (rest) out.add(rest.split("/")[0])
    }
    return [...out].filter((x) => x !== ".keep")
  }

  /** Symlinks this fake tracks: absolute normalized path -> target (additive, Builder A review fix). */
  symlinks = new Map<string, string>()

  private async lstatImpl(path: string): Promise<{ isSymbolicLink(): boolean } | undefined> {
    const n = this.normalize(path)
    if (this.symlinks.has(n)) return { isSymbolicLink: () => true }
    if (this.files.has(n)) return { isSymbolicLink: () => false }
    for (const key of this.files.keys()) {
      if (key.startsWith(n + "/")) return { isSymbolicLink: () => false } // implicit directory
    }
    return undefined
  }

  async lstat(path: string): Promise<{ isSymbolicLink(): boolean } | undefined> {
    return this.lstatImpl(path)
  }

  /** node-like realpath: resolves tracked symlinks per component; throws when the final path is missing. */
  async realpath(path: string): Promise<string> {
    const parts = this.normalize(path).split("/").filter((p) => p !== "")
    let cur = ""
    for (const part of parts) {
      const next = cur + "/" + part
      const link = this.symlinks.get(next)
      cur = link !== undefined ? this.normalize(link) : next
    }
    if (cur === "") cur = "/"
    if ((await this.lstatImpl(cur)) === undefined) {
      throw new Error(`ENOENT: realpath ${this.normalize(path)} -> ${cur}`)
    }
    return cur
  }
}

// ---------------------------------------------------------------------------
// Fake session context
// ---------------------------------------------------------------------------

export interface ScriptedReply {
  /** Assistant text parts (multiple => multiple text parts in one message). */
  text?: string
  model?: { providerID: string; id: string }
  agent?: string
  finish?: string
  outcome?: string
  tokens?: TokenUsage
  /** Throw from prompt/wait instead of replying. */
  error?: Error
}

let sessionCounter = 0
let messageCounter = 0

/**
 * Scriptable session driver. Each `prompt` consumes one ScriptedReply from the
 * queue (or repeats the last one when the queue is empty), then `wait` resolves
 * and `context`/`get` expose the scripted assistant message.
 */
export class FakeSessionCtx implements SessionCtx {
  replies: ScriptedReply[] = []
  sessions = new Map<
    string,
    {
      id: string
      agent?: string
      title?: string
      messages: ContextMessage[]
      outcome?: string
      tokens: TokenUsage
      interrupted: boolean
      prompts: number
      metadata?: Record<string, unknown>
    }
  >()
  /** Records interrupt calls for abort tests. */
  interrupts: string[] = []
  /** The `model` each create() received, in order (model-override tests). */
  createdModels: Array<{ providerID: string; id: string; variant?: string } | undefined> = []
  /** When true, `wait` never resolves on its own (tests must abort). */
  hangWait = false
  /** Optional delay for wait() (pause/in-flight tests). */
  waitDelayMs = 0
  private pendingWaits: Array<() => void> = []

  push(reply: ScriptedReply): this {
    this.replies.push(reply)
    return this
  }

  async create(input: {
    title?: string
    agent?: string
    model?: { providerID: string; id: string; variant?: string }
    metadata?: Record<string, unknown>
  }): Promise<{ id: string; agent?: string }> {
    const id = `ses_fake${++sessionCounter}`
    this.createdModels.push(input.model)
    this.sessions.set(id, {
      id,
      agent: input.agent,
      title: input.title,
      messages: [],
      outcome: undefined,
      tokens: emptyTokens(),
      interrupted: false,
      prompts: 0,
      metadata: input.metadata,
    })
    return { id, agent: input.agent }
  }

  async get(input: { sessionID: string }) {
    const s = this.sessions.get(input.sessionID)
    if (!s) throw new Error(`unknown session ${input.sessionID}`)
    return {
      id: s.id,
      agent: s.agent,
      outcome: s.interrupted ? "interrupted" : s.outcome,
      tokens: s.tokens,
    }
  }

  async prompt(input: { sessionID: string; text: string }): Promise<{ id: string }> {
    const s = this.sessions.get(input.sessionID)
    if (!s) throw new Error(`unknown session ${input.sessionID}`)
    const reply = this.replies.length > 1 || s.prompts === 0 ? this.replies.shift() ?? {} : this.replies[0] ?? {}
    s.prompts++
    if (reply.error) throw reply.error
    const msgID = `msg_fake${++messageCounter}`
    s.messages.push({ id: `msg_fake${++messageCounter}`, type: "user", text: input.text })
    const assistant: ContextMessage = {
      id: msgID,
      type: "assistant",
      agent: reply.agent ?? s.agent ?? "general",
      model: reply.model ?? { providerID: "fake", id: "fake-model" },
      content: [{ type: "text", text: reply.text ?? "" }],
      finish: reply.finish ?? "stop",
      tokens: reply.tokens,
    }
    s.messages.push(assistant)
    s.outcome = reply.outcome ?? "succeeded"
    if (reply.tokens) {
      s.tokens = { ...reply.tokens, cache: { ...reply.tokens.cache } }
    }
    return { id: msgID }
  }

  async wait(input: { sessionID: string }): Promise<void> {
    const s = this.sessions.get(input.sessionID)
    if (!s) throw new Error(`unknown session ${input.sessionID}`)
    if (this.hangWait) {
      await new Promise<void>((resolve) => {
        this.pendingWaits.push(resolve)
      })
      return
    }
    if (this.waitDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.waitDelayMs))
    }
  }

  /** Release hangWait waiters (does not clear hangWait). */
  releaseHangs(): void {
    const pending = this.pendingWaits.splice(0)
    for (const resolve of pending) resolve()
  }

  async context(input: { sessionID: string }): Promise<ReadonlyArray<ContextMessage>> {
    const s = this.sessions.get(input.sessionID)
    if (!s) throw new Error(`unknown session ${input.sessionID}`)
    return s.messages
  }

  async interrupt(input: { sessionID: string }): Promise<void> {
    this.interrupts.push(input.sessionID)
    const s = this.sessions.get(input.sessionID)
    if (s) s.interrupted = true
  }
}

// ---------------------------------------------------------------------------
// Fake plugin tool context (2nd arg of tool executors — verified shape)
// ---------------------------------------------------------------------------

export interface FakeToolCtx {
  sessionID: string
  agent: string
  messageID: string
  id: string
  progress: (status: unknown) => Promise<void>
}

export function makeFakeToolCtx(overrides: Partial<FakeToolCtx> = {}): FakeToolCtx {
  const statuses: unknown[] = []
  return {
    sessionID: "ses_fakeparent",
    agent: "build",
    messageID: "msg_fakeparent",
    id: "call_fake",
    progress: async (status: unknown) => {
      statuses.push(status)
    },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Aggregate fake context (subset used by most units)
// ---------------------------------------------------------------------------

export function makeFakeCtx(options: {
  agents?: Array<{ id: string; mode: string }>
  homeDir?: string
} = {}) {
  const kv = new FakeKv()
  const fs = new FakeFs()
  const sessions = new FakeSessionCtx()
  const agents = options.agents ?? [
    { id: "build", mode: "primary" },
    { id: "plan", mode: "primary" },
    { id: "general", mode: "subagent" },
    { id: "explore", mode: "subagent" },
  ]
  return {
    kv,
    fs,
    sessions,
    agents,
    projectRoot: options.homeDir ?? "/project",
    personalWorkflowDir: "/home/.config/opencode/workflows",
  }
}

export type FakeCtx = ReturnType<typeof makeFakeCtx>

export function jsonOf(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

// ---------------------------------------------------------------------------
// Fake registry (additive — Builder B; used by primitives/supervisor tests)
// ---------------------------------------------------------------------------

export class FakeRegistry implements Registry {
  runs = new Map<string, RunRecord>()
  owned = new Map<string, string>() // sessionID -> runID
  everOwned = new Set<string>()
  saveCalls: RunRecord[] = []
  private runCounter = 0
  private agentCounter = 0

  create(init: {
    parentSessionID: string
    parentAgent?: string
    script: string
    meta?: WorkflowMeta
    args?: Json
    name?: string
    workflowName?: string
    graphSpec?: Json
  }): RunRecord {
    this.runCounter += 1
    const run: RunRecord = {
      id: `run_fake${this.runCounter}`,
      parentSessionID: init.parentSessionID,
      parentAgent: init.parentAgent,
      name: init.name,
      workflowName: init.workflowName,
      status: "running",
      script: init.script,
      meta: init.meta,
      args: init.args,
      ...(init.graphSpec !== undefined ? { graphSpec: init.graphSpec } : {}),
      startedAt: Date.now(),
      agents: [],
    }
    this.runs.set(run.id, run)
    this.saveCalls.push(run)
    return run
  }

  get(runID: string): RunRecord | undefined {
    return this.runs.get(runID)
  }

  listRecent(limit: number): RunRecord[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
  }

  sessionAgents = new Map<string, { runID: string; agentID: string }>()

  activeRuns(): RunRecord[] {
    return [...this.runs.values()].filter((r) => isActiveRunStatus(r.status))
  }

  setStatus(runID: string, status: RunStatus, extra?: { error?: string; stopReason?: string }): boolean {
    const run = this.runs.get(runID)
    if (!run) return false
    run.status = status
    if (extra?.error !== undefined) run.error = extra.error
    if (extra?.stopReason !== undefined) run.stopReason = extra.stopReason
    this.saveCalls.push(run)
    return true
  }

  addAgent(runID: string, init: Omit<AgentRecord, "id">): AgentRecord | undefined {
    const run = this.runs.get(runID)
    if (!run) return undefined
    this.agentCounter += 1
    const agent: AgentRecord = { ...init, id: `a${this.agentCounter}` }
    run.agents.push(agent)
    return agent
  }

  updateAgent(runID: string, agentID: string, patch: Partial<AgentRecord>): void {
    const agent = this.getAgent(runID, agentID)
    if (!agent) return
    Object.assign(agent, patch)
  }

  getAgent(runID: string, agentID: string): AgentRecord | undefined {
    return this.runs.get(runID)?.agents.find((a) => a.id === agentID)
  }

  addCheckpoint(runID: string, name: string, value?: Json): void {
    const run = this.runs.get(runID)
    if (!run) return
    run.checkpoints = run.checkpoints ?? []
    run.checkpoints.push({ name, at: Date.now(), ...(value !== undefined ? { value } : {}) })
  }

  finish(runID: string, outcome: {
    status: RunStatus
    result?: Json
    resultTruncated?: boolean
    resultArtifactKey?: string
    error?: string
    stopReason?: string
  }): RunRecord | undefined {
    const run = this.runs.get(runID)
    if (!run) return undefined
    run.status = outcome.status
    if (outcome.result !== undefined) run.result = outcome.result
    if (outcome.resultTruncated !== undefined) run.resultTruncated = outcome.resultTruncated
    if (outcome.resultArtifactKey !== undefined) run.resultArtifactKey = outcome.resultArtifactKey
    if (outcome.error !== undefined) run.error = outcome.error
    if (outcome.stopReason !== undefined) run.stopReason = outcome.stopReason
    run.endedAt = Date.now()
    this.saveCalls.push(run)
    return run
  }

  markOwned(runID: string, sessionID: string): void {
    this.owned.set(sessionID, runID)
    this.everOwned.add(sessionID)
  }

  isOwnedActive(sessionID: string): boolean {
    const runID = this.owned.get(sessionID)
    if (!runID) return false
    const run = this.runs.get(runID)
    return run !== undefined && isActiveRunStatus(run.status)
  }

  wasEverOwned(sessionID: string): boolean {
    return this.everOwned.has(sessionID)
  }

  runForActiveSession(sessionID: string): RunRecord | undefined {
    const runID = this.owned.get(sessionID)
    if (!runID) return undefined
    const run = this.runs.get(runID)
    return run !== undefined && isActiveRunStatus(run.status) ? run : undefined
  }

  bindAgentSession(runID: string, agentID: string, sessionID: string): void {
    this.sessionAgents.set(sessionID, { runID, agentID })
  }

  agentForSession(sessionID: string): { runID: string; agentID: string } | undefined {
    return this.sessionAgents.get(sessionID)
  }

  reconcileOrphans(): void {
    for (const run of this.runs.values()) {
      if (isActiveRunStatus(run.status)) {
        run.status = "interrupted"
        run.stopReason = "server restart"
        run.endedAt = Date.now()
      }
    }
  }

  persistNow(runID: string): void {
    const run = this.runs.get(runID)
    if (run) this.saveCalls.push(run)
  }
}

/** Tiny event-feed helper for run-events tests. */
export function fakeToolEvent(
  type: string,
  sessionID: string | undefined,
  id: string | undefined,
): { type: string; data?: { sessionID?: string; id?: string } } {
  return { type, data: { sessionID, id } }
}

// ---------------------------------------------------------------------------
// Fake storage (additive — Builder B; used by primitives/supervisor tests)
// ---------------------------------------------------------------------------

export class FakeStorage implements Storage {
  runSnapshots: RunRecord[] = []
  scriptArtifacts = new Map<string, string>()
  resultArtifacts = new Map<string, Json>()
  workflows = new Map<string, SavedWorkflow>()
  failWriteScriptArtifact = false
  /** When set, saveResultArtifact simulates an unserializable value / storage failure. */
  failSaveResultArtifact = false

  saveRun(record: RunRecord): void {
    this.runSnapshots.push({ ...record, agents: record.agents.map((a) => ({ ...a })) })
  }

  loadRuns(): RunRecord[] {
    return this.runSnapshots
  }

  async writeScriptArtifact(runID: string, script: string): Promise<string | undefined> {
    if (this.failWriteScriptArtifact) throw new Error("fs unavailable")
    const path = `/project/.opencode/workflows/runs/${runID}.js`
    this.scriptArtifacts.set(path, script)
    return path
  }

  runDirFor(runID: string): string | undefined {
    if (typeof runID !== "string" || runID.length === 0 || runID.includes("/") || runID.includes("..")) return undefined
    return `/project/.opencode/workflows/runs/${runID}`
  }

  saveResultArtifact(runID: string, result: Json): string | undefined {
    if (this.failSaveResultArtifact) return undefined
    const key = `results/${runID}`
    this.resultArtifacts.set(key, result)
    return key
  }

  loadResultArtifact(key: string): Json | undefined {
    return this.resultArtifacts.get(key)
  }

  listWorkflows(): SavedWorkflow[] {
    return [...this.workflows.values()]
  }

  loadWorkflow(name: string): SavedWorkflow | undefined {
    return this.workflows.get(name)
  }

  async saveWorkflow(
    name: string,
    script: string,
    manifest: Omit<SavedWorkflowManifest, "version" | "hash" | "savedAt" | "source"> & { source: "project" | "personal" },
  ): Promise<SavedWorkflow> {
    const saved: SavedWorkflow = {
      manifest: {
        version: 1,
        name,
        description: manifest.description,
        phases: manifest.phases,
        requires: manifest.requires,
        hash: createHash("sha256").update(script).digest("hex"),
        source: manifest.source,
        savedAt: Date.now(),
      },
      script,
    }
    this.workflows.set(name, saved)
    return saved
  }

  async saveGraphWorkflow(
    name: string,
    spec: Json,
    manifest: Omit<SavedWorkflowManifest, "version" | "hash" | "savedAt" | "source" | "kind"> & {
      source: "project" | "personal"
    },
  ): Promise<SavedWorkflow> {
    // Mirrors StorageImpl: the spec is compiled fresh and the COMPILED script is
    // the digest basis, so a fake trust record hashes what would really run.
    const compiled = compileGraphSpec(spec as unknown as GraphSpec)
    const saved: SavedWorkflow = {
      manifest: {
        version: 1,
        name,
        description: manifest.description ?? compiled.meta.description,
        phases: manifest.phases ?? compiled.meta.phases,
        requires: manifest.requires ?? compiled.meta.requires,
        hash: createHash("sha256").update(compiled.script).digest("hex"),
        source: manifest.source,
        savedAt: Date.now(),
        kind: "graph",
      },
      script: compiled.script,
      graphSpec: spec,
    }
    this.workflows.set(name, saved)
    return saved
  }

  async saveWorkflowFromFile(name: string): Promise<SavedWorkflow> {
    const existing = this.workflows.get(name)
    if (!existing) throw new Error(`workflow "${name}" not found`)
    return this.saveWorkflow(name, existing.script, { name, source: "project" })
  }

  settingsOverlay: SettingsOverlayLike | undefined

  loadSettingsOverlay(): SettingsOverlayLike | undefined {
    return this.settingsOverlay
  }

  async loadSettingsOverlayAsync(): Promise<SettingsOverlayLike | undefined> {
    return this.settingsOverlay
  }

  saveSettingsOverlay(overlay: SettingsOverlayLike): void {
    this.settingsOverlay = { ...overlay }
  }
}
