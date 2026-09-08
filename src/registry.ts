/**
 * Run registry (Builder A) — implements `Registry` from types.ts.
 *
 * In-memory `Map` of live + seeded run records, per-run agent ordinals
 * ("a1", "a2", ...) and owned-session maps. Persistence goes through an
 * injected `persist` callback (wired to Storage.saveRun in index.ts),
 * throttled per-run to ~1s (trailing) and always flushed when a run reaches
 * a final state or `finish()` is called.
 *
 * Single-threaded JS — no locks needed (CONTRACTS.md).
 */
import type { AgentRecord, Json, Registry, RunRecord, RunStatus, WorkflowMeta } from "./types.ts"
import { addTokens, emptyTokens, randomRunID } from "./types.ts"

export interface RegistryInit {
  /** Persist a run snapshot (Storage.saveRun — throw-safe). */
  persist: (record: RunRecord) => void
  /** Persisted records for reconcileOrphans() (Storage.loadRuns snapshot). */
  loader?: () => RunRecord[]
  /** Persist throttle window per run. Default 1000ms. 0 = always flush. */
  throttleMs?: number
  /** Clock seam for deterministic tests. Default Date.now. */
  now?: () => number
}

const FINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "stopped", "interrupted"])

function isFinal(status: RunStatus): boolean {
  return FINAL_STATUSES.has(status)
}

interface ThrottleState {
  lastPersist: number
  timer?: ReturnType<typeof setTimeout>
  dirty: boolean
}

export class RegistryImpl implements Registry {
  private runs = new Map<string, RunRecord>()
  /** sessionID -> runID for runs still active (released on finalize). */
  private ownedActive = new Map<string, string>()
  /** Durable provenance — survives run completion. */
  private everOwned = new Set<string>()
  private agentCounters = new Map<string, number>()
  private throttles = new Map<string, ThrottleState>()
  private readonly persist: (record: RunRecord) => void
  private readonly loader?: () => RunRecord[]
  private readonly throttleMs: number
  private readonly now: () => number

  constructor(init: RegistryInit) {
    this.persist = init.persist
    this.loader = init.loader
    this.throttleMs = init.throttleMs ?? 1000
    this.now = init.now ?? Date.now
  }

  // ------------------------------------------------------------------
  // Run lifecycle
  // ------------------------------------------------------------------

  create(init: {
    parentSessionID: string
    parentAgent?: string
    script: string
    meta?: WorkflowMeta
    args?: Json
    name?: string
    workflowName?: string
  }): RunRecord {
    let id = randomRunID()
    while (this.runs.has(id)) id = randomRunID()
    const record: RunRecord = {
      id,
      parentSessionID: init.parentSessionID,
      parentAgent: init.parentAgent,
      name: init.name,
      workflowName: init.workflowName,
      status: "running",
      script: init.script,
      meta: init.meta,
      args: init.args,
      startedAt: this.now(),
      agents: [],
    }
    this.runs.set(id, record)
    // First snapshot is durable immediately (crash visibility for /ultracode).
    this.persistNow(id)
    return record
  }

  get(runID: string): RunRecord | undefined {
    return this.runs.get(runID)
  }

  listRecent(limit: number): RunRecord[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1))
      .slice(0, Math.max(0, limit))
  }

  activeRuns(): RunRecord[] {
    return [...this.runs.values()]
      .filter((r) => r.status === "running" || r.status === "stopping")
      .sort((a, b) => b.startedAt - a.startedAt)
  }

  setStatus(runID: string, status: RunStatus, extra?: { error?: string; stopReason?: string }): boolean {
    const run = this.runs.get(runID)
    if (!run) return false
    if (isFinal(run.status)) return true // already final — never resurrect
    run.status = status
    if (extra?.error !== undefined) run.error = extra.error
    if (extra?.stopReason !== undefined) run.stopReason = extra.stopReason
    if (isFinal(status)) {
      run.endedAt = this.now()
      this.releaseOwnership(runID)
      this.persistNow(runID)
    } else {
      this.requestPersist(runID)
    }
    return true
  }

  addAgent(runID: string, init: Omit<AgentRecord, "id">): AgentRecord | undefined {
    const run = this.runs.get(runID)
    if (!run) return undefined
    const next = (this.agentCounters.get(runID) ?? 0) + 1
    this.agentCounters.set(runID, next)
    const record: AgentRecord = { ...init, id: `a${next}` }
    run.agents.push(record)
    this.requestPersist(runID)
    return record
  }

  updateAgent(runID: string, agentID: string, patch: Partial<AgentRecord>): void {
    const run = this.runs.get(runID)
    if (!run) return
    const agent = run.agents.find((a) => a.id === agentID)
    if (!agent) return
    const { id: _id, ...rest } = patch // ids are stable ordinals
    Object.assign(agent, rest)
    this.requestPersist(runID)
  }

  getAgent(runID: string, agentID: string): AgentRecord | undefined {
    return this.runs.get(runID)?.agents.find((a) => a.id === agentID)
  }

  finish(
    runID: string,
    outcome: {
      status: RunStatus
      result?: Json
      resultTruncated?: boolean
      resultArtifactKey?: string
      error?: string
      stopReason?: string
    },
  ): RunRecord | undefined {
    const run = this.runs.get(runID)
    if (!run) return undefined
    run.status = outcome.status
    if (outcome.result !== undefined) run.result = outcome.result
    if (outcome.resultTruncated !== undefined) run.resultTruncated = outcome.resultTruncated
    if (outcome.resultArtifactKey !== undefined) run.resultArtifactKey = outcome.resultArtifactKey
    if (outcome.error !== undefined) run.error = outcome.error
    if (outcome.stopReason !== undefined) run.stopReason = outcome.stopReason
    run.endedAt = this.now()
    const total = emptyTokens()
    for (const agent of run.agents) addTokens(total, agent.tokens)
    run.totalTokens = total
    this.releaseOwnership(runID)
    this.persistNow(runID)
    return run
  }

  // ------------------------------------------------------------------
  // Ownership (nested-run rejection, permission scoping)
  // ------------------------------------------------------------------

  markOwned(runID: string, sessionID: string): void {
    // Only active runs can own sessions — a finalized (or unknown) run must
    // never grant active-ownership rights (review fix: ownership leak).
    const run = this.runs.get(runID)
    if (!run || (run.status !== "running" && run.status !== "stopping")) return
    this.ownedActive.set(sessionID, runID)
    this.everOwned.add(sessionID)
  }

  isOwnedActive(sessionID: string): boolean {
    const runID = this.ownedActive.get(sessionID)
    if (runID === undefined) return false
    const run = this.runs.get(runID)
    return run !== undefined && (run.status === "running" || run.status === "stopping")
  }

  wasEverOwned(sessionID: string): boolean {
    return this.everOwned.has(sessionID)
  }

  runForActiveSession(sessionID: string): RunRecord | undefined {
    const runID = this.ownedActive.get(sessionID)
    if (runID === undefined) return undefined
    const run = this.runs.get(runID)
    return run !== undefined && (run.status === "running" || run.status === "stopping") ? run : undefined
  }

  // ------------------------------------------------------------------
  // Orphan reconciliation (plugin load after crash/restart)
  // ------------------------------------------------------------------

  /**
   * Seed the registry from persisted records and flip any `running|stopping`
   * run to `interrupted` with stopReason "server restart" (no auto-replay).
   * Returns the number of flipped runs (interface types it as void; the
   * concrete count is useful for callers/tests).
   */
  reconcileOrphans(): number {
    if (!this.loader) return 0
    let persisted: RunRecord[]
    try {
      persisted = this.loader()
    } catch {
      return 0
    }
    let flipped = 0
    for (const raw of persisted) {
      if (typeof raw?.id !== "string" || typeof raw.status !== "string") continue
      if (this.runs.has(raw.id)) continue // live state wins (not reachable at startup)
      const record: RunRecord = {
        ...raw,
        agents: Array.isArray(raw.agents) ? raw.agents.map((a) => ({ ...a })) : [],
      }
      let wasActive = false
      if (record.status === "running" || record.status === "stopping") {
        record.status = "interrupted"
        record.stopReason = "server restart"
        if (record.endedAt === undefined) record.endedAt = this.now()
        for (const agent of record.agents) {
          if (agent.status === "pending" || agent.status === "running") {
            agent.status = "interrupted"
            if (agent.endedAt === undefined) agent.endedAt = record.endedAt
          }
        }
        wasActive = true
      }
      this.runs.set(record.id, record)
      if (wasActive) {
        flipped++
        // Write the corrected record back so a second restart doesn't re-flip.
        this.persistNow(record.id)
      }
    }
    return flipped
  }

  // ------------------------------------------------------------------
  // Throttled persistence
  // ------------------------------------------------------------------

  /** Immediately persist the current record state for a run. */
  private persistNow(runID: string): void {
    let state = this.throttles.get(runID)
    if (!state) {
      state = { lastPersist: 0, dirty: false }
      this.throttles.set(runID, state)
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    state.lastPersist = this.now()
    state.dirty = false
    const record = this.runs.get(runID)
    if (record) {
      try {
        this.persist(record)
      } catch {
        // Storage.saveRun is throw-safe; belt and braces for other injectors.
      }
    }
  }

  private requestPersist(runID: string): void {
    if (this.throttleMs <= 0) {
      this.persistNow(runID)
      return
    }
    let state = this.throttles.get(runID)
    if (!state) {
      state = { lastPersist: 0, dirty: false }
      this.throttles.set(runID, state)
    }
    const elapsed = this.now() - state.lastPersist
    if (state.lastPersist === 0 || elapsed >= this.throttleMs) {
      this.persistNow(runID)
      return
    }
    state.dirty = true
    if (state.timer === undefined) {
      const delay = Math.max(0, this.throttleMs - elapsed)
      state.timer = setTimeout(() => {
        state.timer = undefined
        if (state.dirty) this.persistNow(runID)
      }, delay)
      state.timer.unref?.()
    }
  }

  /** Persist any pending (dirty/throttled) snapshots immediately. */
  flushPending(): void {
    for (const runID of [...this.throttles.keys()]) {
      const state = this.throttles.get(runID)
      if (state && (state.dirty || state.timer !== undefined)) this.persistNow(runID)
    }
  }

  /** Clear pending timers without flushing (plugin unload). */
  dispose(): void {
    for (const state of this.throttles.values()) {
      if (state.timer) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }
    this.throttles.clear()
  }

  private releaseOwnership(runID: string): void {
    for (const [sessionID, owned] of this.ownedActive) {
      if (owned === runID) this.ownedActive.delete(sessionID)
    }
  }
}
