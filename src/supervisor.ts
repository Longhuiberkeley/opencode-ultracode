/**
 * Supervisor — the run state machine.
 *
 * Owns: run registry bookkeeping, the run-scoped AbortController, the child
 * session set, the in-flight bridge call counter, the worker lifecycle, the
 * timeout watchdog, and stop/stopAll/dispose. All session driving happens in
 * tool/command executors (post-setup) — never in plugin setup (deadlock rule).
 *
 * Builder B module. Constructor signature is the seam Builder A codes against:
 *   new SupervisorImpl({ registry, storage, sessions, options })
 */
import type {
  AgentOpts,
  AgentRecord,
  Json,
  ParentContext,
  Registry,
  RunLaunchInput,
  RunOutcome,
  RunRecord,
  RunStatus,
  SavedWorkflow,
  SessionCtx,
  Storage,
  Supervisor,
  UltracodeOptions,
  WorkflowMeta,
} from "./types.ts"
import { addTokens, emptyTokens, isActiveRunStatus } from "./types.ts"
import { normalizeModelRef } from "./agent-pins.ts"
import { freezeEffective, panelSettingsFrom, remainingTimeoutMs } from "./settings.ts"
import { buildEnvelope, resultFits } from "./serialize.ts"
import { createSessionDriver } from "./sessions.ts"
import type { SessionDriver } from "./sessions.ts"
import { AgentRunner, buildWarmCache, getWorkflowComposer, storageWorkflowLoader } from "./primitives.ts"
import type { WarmCacheEntry, WorkflowLoader } from "./primitives.ts"
import { validateScriptSource } from "./worker-script.ts"
import { spawnWorker } from "./worker-host.ts"
import type { WorkerHandle, WorkerResult } from "./worker-host.ts"

/** Grace for in-flight bridge calls (dangling agent() promises) after the script settles. */
export const SETTLE_GRACE_MS = 15_000
/** Grace between stop() and worker termination (lets well-behaved scripts unwind). */
export const STOP_KILL_GRACE_MS = 5_000
/** Hard cap on dispose() waiting for run finalization. */
export const DISPOSE_TIMEOUT_MS = 30_000

export interface SupervisorDeps {
  registry: Registry
  storage: Storage
  sessions: SessionCtx
  options: Required<UltracodeOptions>
  /** Optional overrides (tests). Defaults: 15s settle grace, 5s stop-kill grace. */
  settleGraceMs?: number
  stopKillGraceMs?: number
  /**
   * Async saved-workflow loader for workflow() composition (fresh-disk,
   * trust-checked; Builder A seam). Defaults to Storage.loadWorkflowFresh when
   * present, else the cached Storage.loadWorkflow. Index wiring is A's/lead's.
   */
  loadWorkflowFresh?: WorkflowLoader
  /**
   * Resolves an agent's pinned model from the user's agent config (project
   * beats global); applied at session.create so children honor agent pins.
   * Index wiring; optional for tests.
   */
  pinForAgent?: (agentId: string) => Promise<{ providerID: string; id: string; variant?: string } | undefined>
  /**
   * True when the user took a provider offline (`disabled_providers` in
   * subagent-config). Explicit model overrides (call-site or run-level) on a
   * disabled provider are REJECTED unless the run set allowDisabledProviders —
   * config pins keep their existing skip-fallback behavior. Index wiring;
   * optional for tests.
   */
  isProviderDisabled?: (providerID: string) => Promise<boolean>
}

interface PauseWaiter {
  resolve(): void
  reject(err: Error): void
  onAbort(): void
  signal: AbortSignal
}

interface RunState {
  runID: string
  controller: AbortController
  /** Every child sessionID ever created for this run (historical). */
  children: Set<string>
  /** Children whose agent() call has not settled yet (interrupt candidates). */
  live: Set<string>
  /** Still-pending, never-rejecting child cleanup promises (late-child interrupts). */
  cleanup: Set<Promise<void>>
  /** True once the run stops accepting/tracking new children (settle phase). */
  closed: boolean
  inFlight: number
  ambientPhase: string | undefined
  stopReason: string | undefined
  doneReceived: boolean
  worker: WorkerHandle | undefined
  /** Delayed stop-kill timer (worker termination + outstanding interrupts). */
  killTimer: ReturnType<typeof setTimeout> | undefined
  done: Promise<void>
  resolveDone: () => void
  parent: ParentContext
  startedAt: number
  paused: boolean
  pausedAt: number | undefined
  pausedMs: number
  watchdog: ReturnType<typeof setTimeout> | undefined
  /** Child-liveness scanner (childStallMs); undefined when disabled. */
  stallTimer: ReturnType<typeof setInterval> | undefined
  /** sessionID -> last activity timestamp (spawn time seeds it). */
  childLastActivity: Map<string, number>
  /** sessionIDs already stall-interrupted (never re-fired for one child). */
  stallNotified: Set<string>
  pauseWaiters: PauseWaiter[]
  /** Immutable copy of effective options for this run. */
  effective: Required<UltracodeOptions>
  /** Explicit run-level model override (run tool input `model`). */
  runModel: { providerID: string; id: string; variant?: string } | undefined
  /** Escape hatch: explicit overrides may target disabled providers. */
  allowDisabledProviders: boolean
}

type FinalOutcome = {
  status: RunStatus
  result?: Json
  error?: string
  stopReason?: string
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Visible marker for child cleanup still pending after the settle grace. */
function cleanupMarker(pending: number): string | undefined {
  return pending > 0 ? `(${pending} cleanup pending)` : undefined
}

function withCleanupMarker(reason: string | undefined, pending: number): string | undefined {
  const marker = cleanupMarker(pending)
  if (marker === undefined) return reason
  return reason === undefined ? marker : `${reason} ${marker}`
}

function delay(ms: number): Promise<void> {
  // REF'd timer: settle waits are actively awaited by start()/stop() callers;
  // an unref'd timer lets the event loop drain mid-wait (node:test treats the
  // pending run promise as a leak and aborts; a plugin process is unaffected).
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

export class SupervisorImpl implements Supervisor {
  private readonly registry: Registry
  private readonly storage: Storage
  private readonly sessions: SessionCtx
  private options: Required<UltracodeOptions>
  private readonly pinForAgent:
    | ((agentId: string) => Promise<{ providerID: string; id: string; variant?: string } | undefined>)
    | undefined
  private readonly isProviderDisabled: ((providerID: string) => Promise<boolean>) | undefined
  private readonly settleGraceMs: number
  private readonly stopKillMs: number
  private readonly driver: SessionDriver
  private readonly workflowLoader: WorkflowLoader
  private readonly runs = new Map<string, RunState>()
  private disposed = false

  constructor(deps: SupervisorDeps) {
    this.registry = deps.registry
    this.storage = deps.storage
    this.sessions = deps.sessions
    this.options = { ...deps.options }
    this.pinForAgent = deps.pinForAgent
    this.isProviderDisabled = deps.isProviderDisabled
    this.settleGraceMs = deps.settleGraceMs ?? SETTLE_GRACE_MS
    this.stopKillMs = deps.stopKillGraceMs ?? STOP_KILL_GRACE_MS
    // Driver construction performs no session calls — safe outside executors.
    this.driver = createSessionDriver(deps.sessions)
    // Composition seam: injected fresh loader wins; else prefer
    // Storage.loadWorkflowFresh when present, else the cached loadWorkflow.
    this.workflowLoader = deps.loadWorkflowFresh ?? storageWorkflowLoader(deps.storage)
  }

  // -------------------------------------------------------------------------
  // start / startDetached
  // -------------------------------------------------------------------------

  async start(input: RunLaunchInput, parent: ParentContext): Promise<RunOutcome> {
    const { done } = this.startDetached(input, parent)
    return await done
  }

  startDetached(input: RunLaunchInput, parent: ParentContext): { runID: string; done: Promise<RunOutcome> } {
    if (this.disposed) throw new Error("supervisor disposed")
    if (this.registry.isOwnedActive(parent.sessionID)) {
      throw new Error("nested workflow runs are not allowed")
    }

    // 1. Validate the script host-side, before any spawn.
    const check = validateScriptSource(input.script)
    if (!check.ok) throw new Error(`invalid workflow script: ${check.error}`)

    // 2. Registry record. Spawn continues on the returned `done` promise.
    const record = this.registry.create({
      directory: parent.directory,
      projectID: parent.projectID,
      parentSessionID: parent.sessionID,
      parentAgent: parent.agent,
      script: input.script,
      meta: input.meta,
      args: input.args,
      name: input.name,
      workflowName: input.workflowName,
      graphSpec: input.graphSpec,
    })
    const runID = record.id
    if (input.resumeFrom) record.resumedFrom = input.resumeFrom
    // Per-run wall-clock override from the run tool input: this run only. The
    // supervisor defaults (user overlay included) are left untouched, and the
    // override is captured in record.effective for status/panel display and
    // record.timeoutOverrideMs so a warm rerun reproduces the run's clock.
    const effective = freezeEffective(
      input.timeoutMs !== undefined ? { ...this.options, timeoutMs: input.timeoutMs } : this.options,
    )
    if (input.timeoutMs !== undefined) record.timeoutOverrideMs = input.timeoutMs
    // Persist the explicit model override for rerun reproduction (mirrors
    // timeoutOverrideMs; absent = pins/defaults only).
    if (input.model !== undefined) record.modelOverride = input.model
    if (input.allowDisabledProviders === true) record.allowDisabledProviders = true
    // panelSettingsFrom alone drops permissionStallMs (panel shows 4 keys),
    // but the permission stall watchdog reads it off this record — keep it.
    record.effective = { ...panelSettingsFrom(effective), permissionStallMs: effective.permissionStallMs }
    this.registry.persistNow(runID)
    const state = this.makeState(runID, parent, effective, input)
    this.runs.set(runID, state)
    const done = this.executeRun(record, input, parent, state)
    return { runID, done }
  }

  updateDefaults(next: Required<UltracodeOptions>): void {
    this.options = { ...next }
  }

  private async executeRun(
    record: RunRecord,
    input: RunLaunchInput,
    parent: ParentContext,
    state: RunState,
  ): Promise<RunOutcome> {
    const runID = record.id
    let worker: WorkerHandle | undefined
    let final: FinalOutcome

    try {
      try {
        const scriptPath = await this.storage.writeScriptArtifact(runID, input.script)
        if (scriptPath) record.scriptPath = scriptPath
      } catch {
        // artifact persistence is best-effort
      }

      // Warm start (resumeFrom): replay keyed succeeded agents from the
      // source run instead of respawning them.
      let warmCache: ReadonlyMap<string, WarmCacheEntry> | undefined
      if (input.resumeFrom) {
        const source =
          this.registry.get(input.resumeFrom) ??
          (() => {
            try {
              return this.storage.loadRuns().find((r) => r.id === input.resumeFrom)
            } catch {
              return undefined
            }
          })()
        warmCache = buildWarmCache(source)
        this.safeParentReport(state, `warm start from ${input.resumeFrom}: ${warmCache.size} keyed result(s) replayable`)
      }

      // Run-level model override preflight: a model on a provider the user
      // took offline fails the run BEFORE any child spawns (config pins skip
      // silently; an explicit request is an explicit error). The escape hatch
      // is the run input's allowDisabledProviders: true.
      if (input.model !== undefined && !state.allowDisabledProviders && this.isProviderDisabled) {
        let disabled = false
        try {
          disabled = await this.isProviderDisabled(input.model.providerID)
        } catch {
          disabled = false // fail open — mirrors the pin-path behavior
        }
        if (disabled) {
          throw new Error(
            `run-level model override "${input.model.providerID}/${input.model.id}" targets provider ` +
              `"${input.model.providerID}", which the user disabled (disabled_providers). ` +
              "Re-enable the provider or pass allowDisabledProviders: true on this run input.",
          )
        }
      }

      // 3.-4. AgentRunner over a driver wrapper that tracks child sessions,
      // registry ownership (ambient phase tracked via state) and late children.
      const runner = new AgentRunner({
        driver: {
          runAgent: async (agentInput, availableAgents, hooks) => {
            // Re-check pause AFTER the concurrency semaphore (queued waiters
            // released while paused must not start until resume/abort).
            await this.waitIfPaused(state)
            let created: string | undefined
            return this.driver
              .runAgent(
                {
                  ...agentInput,
                  runID,
                  parentSessionID: parent.sessionID,
                  workflowName: input.workflowName,
                },
                availableAgents,
                {
                  signal: hooks.signal,
                  onSessionID: (sessionID) => {
                    if (state.closed) {
                      // Late child of an already-settling run: refuse
                      // registration — the driver cancels that call BEFORE any
                      // prompt (RunClosedError) and interrupts best-effort; the
                      // child never gains ownership or enters the live set.
                      this.trackCleanup(state, this.interruptChild(sessionID))
                      return "rejected" as const
                    }
                    created = sessionID
                    state.children.add(sessionID)
                    state.live.add(sessionID)
                    state.childLastActivity.set(sessionID, Date.now())
                    try {
                      this.registry.markOwned(runID, sessionID)
                    } catch {
                      // registry bookkeeping must not break the call
                    }
                    hooks.onSessionID(sessionID)
                    return undefined
                  },
                },
              )
              .finally(() => {
                // Outstanding-only semantics: settled calls remove their child
                // from the live set so later interrupts never touch them.
                if (created !== undefined) state.live.delete(created)
              })
          },
        },
        registry: this.registry,
        runID,
        defaultAgent: state.effective.agent,
        availableAgents: parent.availableAgents,
        concurrency: state.effective.concurrency,
        maxAgents: state.effective.maxAgents,
        // Provider-shaped (outcome) failures retry with abort-aware backoff;
        // per-call opts.retry can override each agent() call.
        retryAttempts: state.effective.agentRetryAttempts,
        retryBackoffMs: state.effective.agentRetryBackoffMs,
        report: (status) => parent.report(status),
        ambientPhase: () => state.ambientPhase,
        ...(this.pinForAgent ? { pinForAgent: this.pinForAgent } : {}),
        ...(state.runModel !== undefined ? { runModel: state.runModel } : {}),
        signal: state.controller.signal,
        ...(warmCache ? { warmCache } : {}),
      })

      // 5. Spawn the worker with bridge dispatch.
      worker = spawnWorker({
        source: input.script,
        args: input.args,
        meta: input.meta,
        handlers: {
          onCall: (fn, args) => this.trackInFlight(state, () => this.dispatch(fn, args, runner, state)),
          onEvent: (kind, data) => this.handleEvent(state, kind, data, parent),
        },
      })
      state.worker = worker

      // 6. Watchdog -> stop(runID, "timeout"). Suspended while paused.
      this.armWatchdog(state)
      this.armStallScanner(state)

      // 7. Await the script outcome. The worker has settled by now — cancel
      // any pending delayed stop-kill (main flow handles children from here).
      let outcome: WorkerResult
      try {
        outcome = await worker.start()
      } finally {
        state.doneReceived = true
        this.cancelKillTimer(state)
      }

      // 8. Settle: close the run (no new children/ownership), wait for
      // in-flight bridge calls and tracked child cleanup within the grace,
      // then abort danglers.
      state.closed = true
      worker.closeGate()
      const pendingCleanup = await this.settle(state)

      // 9. Final status — an accepted stop always wins over the script
      // outcome (finality belongs to the run, not the worker's done message).
      if (state.stopReason !== undefined) {
        final = { status: "stopped", stopReason: withCleanupMarker(state.stopReason, pendingCleanup) }
      } else if (outcome.ok) {
        final = { status: "succeeded", result: outcome.value, stopReason: cleanupMarker(pendingCleanup) }
      } else {
        final = { status: "failed", error: outcome.error, stopReason: cleanupMarker(pendingCleanup) }
      }
    } catch (err) {
      state.closed = true
      final = { status: "failed", error: errorMessage(err) }
    } finally {
      this.clearWatchdog(state)
      this.cancelKillTimer(state)
      this.runs.delete(runID)
      state.resolveDone()
      if (worker !== undefined) void worker.terminate(this.stopKillMs).catch(() => {})
    }

    return this.finalize(runID, final, state.effective.maxResultChars)
  }

  // -------------------------------------------------------------------------
  // stop / stopAll / dispose
  // -------------------------------------------------------------------------

  stop(runID: string, reason: string): boolean {
    const state = this.runs.get(runID)
    if (!state) return false
    const run = this.registry.get(runID)
    if (!run || !isActiveRunStatus(run.status) || run.status === "stopping") return false
    if (!this.registry.setStatus(runID, "stopping", { stopReason: reason })) return false
    state.paused = false
    this.clearWatchdog(state)
    // Finality belongs to the run: record the stop reason even when the
    // worker already posted done (a stop accepted during settle must not
    // later report success).
    state.stopReason = reason
    // Reject queued semaphore waits + abort in-flight agent sessions.
    state.controller.abort()
    state.worker?.closeGate()
    // Delayed stop-kill: if the worker ignores the abort (e.g. while(true)),
    // force termination after the grace, then interrupt only OUTSTANDING
    // children (the live set — historical children are never touched). The
    // timer is canceled when the run completes (see start()).
    state.killTimer = setTimeout(() => {
      state.killTimer = undefined
      void (async () => {
        const w = state.worker
        if (w) await w.terminate(this.stopKillMs).catch(() => {})
        for (const sessionID of [...state.live]) {
          await this.interruptChild(sessionID)
        }
      })()
    }, this.stopKillMs)
    if (typeof (state.killTimer as { unref?: () => void }).unref === "function") {
      ;(state.killTimer as { unref: () => void }).unref()
    }
    return true
  }

  pause(runID: string): boolean {
    const state = this.runs.get(runID)
    if (!state) return false
    const run = this.registry.get(runID)
    if (!run || run.status !== "running") return false
    if (!this.registry.setStatus(runID, "paused")) return false
    state.paused = true
    state.pausedAt = Date.now()
    this.clearWatchdog(state)
    this.safeParentReport(state, `paused ${runID}`)
    return true
  }

  resume(runID: string): boolean {
    const state = this.runs.get(runID)
    if (!state) return false
    const run = this.registry.get(runID)
    if (!run || run.status !== "paused") return false
    if (!this.registry.setStatus(runID, "running")) return false
    if (state.pausedAt !== undefined) {
      state.pausedMs += Date.now() - state.pausedAt
      state.pausedAt = undefined
    }
    state.paused = false
    this.armWatchdog(state)
    this.armStallScanner(state)
    this.resumePauseWaiters(state)
    this.safeParentReport(state, `resumed ${runID}`)
    return true
  }

  stopAll(reason: string): void {
    for (const runID of [...this.runs.keys()]) {
      this.stop(runID, reason)
    }
  }

  isOwnedSession(sessionID: string): boolean {
    return this.registry.isOwnedActive(sessionID)
  }

  activeRuns(): RunRecord[] {
    return this.registry.activeRuns()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.stopAll("plugin unload")
    const states = [...this.runs.values()]
    await Promise.race([
      Promise.all(states.map((s) => s.done)),
      delay(DISPOSE_TIMEOUT_MS),
    ])
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private makeState(
    runID: string,
    parent: ParentContext,
    effective: Required<UltracodeOptions>,
    input: RunLaunchInput,
  ): RunState {
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve
    })
    return {
      runID,
      controller: new AbortController(),
      children: new Set<string>(),
      live: new Set<string>(),
      cleanup: new Set<Promise<void>>(),
      closed: false,
      inFlight: 0,
      ambientPhase: undefined,
      stopReason: undefined,
      doneReceived: false,
      worker: undefined,
      killTimer: undefined,
      done,
      resolveDone,
      parent,
      startedAt: Date.now(),
      paused: false,
      pausedAt: undefined,
      pausedMs: 0,
      watchdog: undefined,
      stallTimer: undefined,
      childLastActivity: new Map<string, number>(),
      stallNotified: new Set<string>(),
      pauseWaiters: [],
      effective,
      runModel: input.model,
      allowDisabledProviders: input.allowDisabledProviders === true,
    }
  }

  private async dispatch(fn: string, args: Json[], runner: AgentRunner, state: RunState): Promise<Json> {
    if (fn === "agent") {
      await this.waitIfPaused(state)
      if (typeof args[0] !== "string" || args[0].length === 0) {
        // Silent "" coercion used to spawn a no-op child (audit finding).
        throw new Error("agent(prompt, opts) — prompt must be a non-empty string")
      }
      const prompt = args[0]
      const opts = await this.coerceAgentOpts(args[1], state)
      const result = await runner.call(prompt, opts)
      return result as unknown as Json
    }
    if (fn === "workflow") {
      if (typeof args[0] !== "string" || args[0].length === 0) {
        throw new Error('workflow(name, args) — name must be a non-empty string')
      }
      const name = args[0]
      const depth = typeof args[2] === "number" ? args[2] : 0
      const composed = await getWorkflowComposer(this.workflowLoader, name, args[1], depth)
      return composed as unknown as Json
    }
    throw new Error(`unknown bridge call: ${fn}`)
  }

  /**
   * Coerce raw agent() opts from the bridge into AgentOpts. `model` accepts
   * the "provider/id#variant" string (or object form) and is GATED here: an
   * override targeting a provider the user disabled is an error (config pins
   * skip; explicit requests fail loud) unless the run set
   * allowDisabledProviders.
   */
  private async coerceAgentOpts(raw: Json | undefined, state: RunState): Promise<AgentOpts> {
    const o = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { [key: string]: Json | undefined })
      : {}
    const opts: AgentOpts = {}
    if (typeof o.agent === "string") opts.agent = o.agent
    if (typeof o.label === "string") opts.label = o.label
    if (typeof o.phase === "string") opts.phase = o.phase
    if (o.schema !== undefined) opts.schema = o.schema
    if (typeof o.key === "string") {
      const key = o.key.trim().slice(0, 128)
      if (key) opts.key = key
    }
    if (o.model !== undefined && o.model !== null) {
      const normalized = normalizeModelRef(o.model)
      if (!normalized.ok) {
        throw new Error(`agent(prompt, opts) — opts.model: ${normalized.error}`)
      }
      if (!state.allowDisabledProviders && this.isProviderDisabled) {
        let disabled = false
        try {
          disabled = await this.isProviderDisabled(normalized.model.providerID)
        } catch {
          disabled = false // fail open — mirrors the pin-path behavior
        }
        if (disabled) {
          throw new Error(
            `opts.model "${normalized.model.providerID}/${normalized.model.id}" targets provider ` +
              `"${normalized.model.providerID}", which the user disabled (disabled_providers). ` +
              "Re-enable the provider or relaunch the run with allowDisabledProviders: true.",
          )
        }
      }
      opts.model = normalized.model
    }
    if (o.retry !== null && typeof o.retry === "object" && !Array.isArray(o.retry)) {
      const r = o.retry as { attempts?: Json | undefined; backoffMs?: Json | undefined }
      const retry: { attempts?: number; backoffMs?: number } = {}
      if (typeof r.attempts === "number" && Number.isFinite(r.attempts)) retry.attempts = r.attempts
      if (typeof r.backoffMs === "number" && Number.isFinite(r.backoffMs)) retry.backoffMs = r.backoffMs
      if (retry.attempts !== undefined || retry.backoffMs !== undefined) opts.retry = retry
    }
    return opts
  }

  private trackInFlight<T>(state: RunState, run: () => Promise<T>): Promise<T> {
    state.inFlight++
    return Promise.resolve()
      .then(run)
      .then(
        (value) => {
          state.inFlight--
          return value
        },
        (err: unknown) => {
          state.inFlight--
          throw err
        },
      )
  }

  /** Track a never-rejecting cleanup promise; remove it from the set when done. */
  private trackCleanup(state: RunState, cleanup: Promise<void>): void {
    state.cleanup.add(cleanup)
    void cleanup.then(
      () => state.cleanup.delete(cleanup),
      () => state.cleanup.delete(cleanup),
    )
  }

  private handleEvent(state: RunState, kind: string, data: Json, parent: ParentContext): void {
    if (kind === "phase") {
      state.ambientPhase = typeof data === "string" ? data : String(data ?? "")
      return
    }
    if (kind === "progress") {
      try {
        parent.report(typeof data === "string" ? data : String(data ?? ""))
      } catch {
        // reporting must never break a run
      }
      return
    }
    if (kind === "checkpoint") {
      const o =
        data !== null && typeof data === "object" && !Array.isArray(data)
          ? (data as { name?: Json; value?: Json })
          : {}
      const name = typeof o.name === "string" ? o.name : ""
      if (name) {
        this.registry.addCheckpoint(state.runID, name, o.value)
        try {
          parent.report(`checkpoint: ${name}`)
        } catch {
          // reporting must never break a run
        }
      }
      return
    }
    if (kind === "log") {
      try {
        parent.report(`workflow log: ${typeof data === "string" ? data : String(data ?? "")}`)
      } catch {
        // ignore
      }
    }
  }

  /** Best-effort, never-rejecting interrupt of a child session. */
  private interruptChild(sessionID: string): Promise<void> {
    return this.sessions.interrupt({ sessionID, continue: false }).then(
      () => {},
      () => {},
    )
  }

  private cancelKillTimer(state: RunState): void {
    if (state.killTimer !== undefined) {
      clearTimeout(state.killTimer)
      state.killTimer = undefined
    }
  }

  private safeParentReport(state: RunState, status: string): void {
    try {
      state.parent.report(status)
    } catch {
      // reporting must never break a run
    }
  }

  private remainingTimeoutMs(state: RunState): number {
    return remainingTimeoutMs(
      state.effective.timeoutMs,
      state.startedAt,
      state.pausedMs,
      state.paused,
      state.pausedAt,
    )
  }

  /** Test seam: remaining watchdog budget from the frozen snapshot, not shared options. */
  remainingTimeoutFor(runID: string): number | undefined {
    const state = this.runs.get(runID)
    if (!state) return undefined
    return this.remainingTimeoutMs(state)
  }

  private armWatchdog(state: RunState): void {
    this.clearWatchdog(state)
    if (state.paused) return
    const remaining = this.remainingTimeoutMs(state)
    if (remaining <= 0) {
      this.stop(state.runID, "timeout")
      return
    }
    state.watchdog = setTimeout(() => {
      this.stop(state.runID, "timeout")
    }, remaining)
    if (typeof (state.watchdog as { unref?: () => void }).unref === "function") {
      ;(state.watchdog as { unref: () => void }).unref()
    }
  }

  private clearWatchdog(state: RunState): void {
    if (state.watchdog !== undefined) {
      clearTimeout(state.watchdog)
      state.watchdog = undefined
    }
    // The stall scanner lives and dies with the run-level watchdog: every
    // path that stops the wall-clock bound (settle, stop, pause, dispose)
    // also stops child-stall marking.
    this.clearStallScanner(state)
  }

  // -------------------------------------------------------------------------
  // Child-liveness watchdog (childStallMs)
  // -------------------------------------------------------------------------

  /**
   * Bump a child's last-activity timestamp. Called from the host event
   * subscription (message/part events per session); cheap map writes.
   */
  noteChildActivity(sessionID: string): void {
    for (const state of this.runs.values()) {
      if (state.children.has(sessionID)) state.childLastActivity.set(sessionID, Date.now())
    }
  }

  /** Arm the per-run stall scanner; no-op when childStallMs is 0/disabled. */
  private armStallScanner(state: RunState): void {
    this.clearStallScanner(state)
    const stallMs = state.effective.childStallMs
    if (stallMs <= 0) return
    const tick = Math.max(1_000, Math.min(30_000, Math.ceil(stallMs / 2)))
    state.stallTimer = setInterval(() => {
      if (state.paused || this.disposed) return
      this.scanForStalledChildren(state)
    }, tick)
    if (typeof (state.stallTimer as { unref?: () => void }).unref === "function") {
      ;(state.stallTimer as { unref: () => void }).unref()
    }
  }

  /**
   * One stall scan: live children with no activity for childStallMs get an
   * error on their record and a best-effort interrupt (the interrupt settles
   * the driver's wait; the normal failure path finalizes the record — and if
   * even that hangs, the run-level watchdog still bounds the run).
   */
  private scanForStalledChildren(state: RunState): void {
    const stallMs = state.effective.childStallMs
    if (stallMs <= 0) return
    const now = Date.now()
    for (const sessionID of state.live) {
      if (state.stallNotified.has(sessionID)) continue
      const last = state.childLastActivity.get(sessionID)
      if (last === undefined) continue
      const elapsed = now - last
      if (elapsed < stallMs) continue
      state.stallNotified.add(sessionID)
      const owned = this.registry.agentForSession(sessionID)
      if (owned) {
        this.registry.updateAgent(owned.runID, owned.agentID, {
          error: `child stalled: no activity for ${Math.round(elapsed / 1000)}s (childStallMs ${stallMs}ms) — interrupting`,
        })
      }
      this.safeParentReport(
        state,
        `child ${owned?.agentID ?? sessionID} stalled (no activity ${Math.round(elapsed / 1000)}s) — interrupting`,
      )
      this.trackCleanup(state, this.interruptChild(sessionID))
    }
  }

  private clearStallScanner(state: RunState): void {
    if (state.stallTimer !== undefined) {
      clearInterval(state.stallTimer)
      state.stallTimer = undefined
    }
  }

  /** New agent() calls wait here while paused; also re-checked after semaphore acquire. */
  private waitIfPaused(state: RunState): Promise<void> {
    if (state.controller.signal.aborted) {
      return Promise.reject(new Error("run stopping"))
    }
    if (!state.paused) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const waiter: PauseWaiter = {
        resolve: () => resolve(),
        reject,
        signal: state.controller.signal,
        onAbort: () => {
          const idx = state.pauseWaiters.indexOf(waiter)
          if (idx >= 0) state.pauseWaiters.splice(idx, 1)
          reject(new Error("run stopping"))
        },
      }
      if (state.controller.signal.aborted) {
        reject(new Error("run stopping"))
        return
      }
      state.pauseWaiters.push(waiter)
      state.controller.signal.addEventListener("abort", waiter.onAbort, { once: true })
    })
  }

  private resumePauseWaiters(state: RunState): void {
    const waiters = state.pauseWaiters.splice(0)
    for (const w of waiters) {
      w.signal.removeEventListener("abort", w.onAbort)
      w.resolve()
    }
  }

  /**
   * Wait for in-flight bridge calls AND tracked child cleanup promises within
   * the grace (exiting early once both drain); then abort danglers (their
   * driver races interrupt the child sessions) and give the abort a brief
   * soft window to land. Returns the count of STILL-PENDING cleanup work:
   * unresolved cleanup promises plus unresolved bridge/session-creation
   * work in flight at finalize — the honest "(N cleanup pending)" number.
   */
  private async settle(state: RunState): Promise<number> {
    const deadline = Date.now() + this.settleGraceMs
    while ((state.inFlight > 0 || state.cleanup.size > 0) && Date.now() < deadline) {
      await delay(25)
    }
    if (state.inFlight > 0) {
      // Dangling calls (fire-and-forget agent()): interrupt their sessions
      // via the run abort; late creates are refused by the closed flag.
      state.controller.abort()
      const softDeadline = Date.now() + 500
      while ((state.inFlight > 0 || state.cleanup.size > 0) && Date.now() + 25 <= softDeadline) {
        await delay(25)
      }
    }
    return state.cleanup.size + Math.max(0, state.inFlight)
  }

  private finalize(runID: string, final: FinalOutcome, maxResultChars = this.options.maxResultChars): RunOutcome {
    // Agents still pending/running (abort / dangling calls) -> interrupted.
    const run = this.registry.get(runID)
    if (run) {
      for (const agent of run.agents as AgentRecord[]) {
        if (agent.status === "pending" || agent.status === "running") {
          try {
            this.registry.updateAgent(runID, agent.id, { status: "interrupted", endedAt: Date.now() })
          } catch {
            // best-effort
          }
        }
      }
    }

    let artifactKey: string | undefined
    const resultOverBudget = final.result !== undefined && !resultFits(final.result, maxResultChars)
    if (resultOverBudget && final.result !== undefined) {
      try {
        // undefined return = the value could not be serialized — no key is
        // claimed (renderResult then falls back to the run record copy).
        artifactKey = this.storage.saveResultArtifact(runID, final.result)
      } catch {
        artifactKey = undefined
      }
    }

    this.registry.finish(runID, {
      status: final.status,
      result: final.result,
      // Truncated describes DELIVERY (the envelope will carry a preview),
      // independent of whether the artifact write succeeded — a swallowed
      // artifact failure previously left resultTruncated=false while the
      // envelope said truncated=true.
      resultTruncated: resultOverBudget,
      resultArtifactKey: artifactKey,
      error: final.error,
      stopReason: final.stopReason,
    })

    const finalRun = this.registry.get(runID)
    if (!finalRun) throw new Error(`run ${runID} disappeared during finalization`)
    // Token totals + artifact key land on the live record (registry.finish's
    // outcome seam does not carry them).
    const total = (finalRun.agents as AgentRecord[]).reduce(
      (acc, a) => addTokens(acc, a.tokens),
      emptyTokens(),
    )
    finalRun.totalTokens = total
    if (artifactKey !== undefined && finalRun.resultArtifactKey === undefined) {
      finalRun.resultArtifactKey = artifactKey
    }
    if (finalRun.endedAt === undefined) finalRun.endedAt = Date.now()

    const envelope = buildEnvelope(finalRun, maxResultChars)
    return { run: finalRun, envelope }
  }
}

/** Convenience factory matching the Supervisor interface. */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  return new SupervisorImpl(deps)
}
