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
import { buildEnvelope, resultFits } from "./serialize.ts"
import { createSessionDriver } from "./sessions.ts"
import type { SessionDriver } from "./sessions.ts"
import { AgentRunner, getWorkflowComposer, storageWorkflowLoader } from "./primitives.ts"
import type { WorkflowLoader } from "./primitives.ts"
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
  pauseWaiters: PauseWaiter[]
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
  private readonly options: Required<UltracodeOptions>
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
    this.options = deps.options
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

  async start(
    input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string },
    parent: ParentContext,
  ): Promise<RunOutcome> {
    const { done } = this.startDetached(input, parent)
    return await done
  }

  startDetached(
    input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string },
    parent: ParentContext,
  ): { runID: string; done: Promise<RunOutcome> } {
    if (this.disposed) throw new Error("supervisor disposed")
    if (this.registry.isOwnedActive(parent.sessionID)) {
      throw new Error("nested workflow runs are not allowed")
    }

    // 1. Validate the script host-side, before any spawn.
    const check = validateScriptSource(input.script)
    if (!check.ok) throw new Error(`invalid workflow script: ${check.error}`)

    // 2. Registry record. Spawn continues on the returned `done` promise.
    const record = this.registry.create({
      parentSessionID: parent.sessionID,
      parentAgent: parent.agent,
      script: input.script,
      meta: input.meta,
      args: input.args,
      name: input.name,
      workflowName: input.workflowName,
    })
    const runID = record.id
    const state = this.makeState(runID, parent)
    this.runs.set(runID, state)
    const done = this.executeRun(record, input, parent, state)
    return { runID, done }
  }

  private async executeRun(
    record: RunRecord,
    input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string },
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

      // 3.-4. AgentRunner over a driver wrapper that tracks child sessions,
      // registry ownership (ambient phase tracked via state) and late children.
      const runner = new AgentRunner({
        driver: {
          runAgent: (agentInput, availableAgents, hooks) => {
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
        defaultAgent: this.options.agent,
        availableAgents: parent.availableAgents,
        concurrency: this.options.concurrency,
        maxAgents: this.options.maxAgents,
        report: (status) => parent.report(status),
        ambientPhase: () => state.ambientPhase,
        signal: state.controller.signal,
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

    return this.finalize(runID, final)
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

  private makeState(runID: string, parent: ParentContext): RunState {
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
      pauseWaiters: [],
    }
  }

  private async dispatch(fn: string, args: Json[], runner: AgentRunner, state: RunState): Promise<Json> {
    if (fn === "agent") {
      await this.waitIfPaused(state)
      const prompt = typeof args[0] === "string" ? args[0] : ""
      const opts = this.coerceAgentOpts(args[1])
      const result = await runner.call(prompt, opts)
      return result as unknown as Json
    }
    if (fn === "workflow") {
      const name = typeof args[0] === "string" ? args[0] : ""
      const depth = typeof args[2] === "number" ? args[2] : 0
      const composed = await getWorkflowComposer(this.workflowLoader, name, args[1], depth)
      return composed as unknown as Json
    }
    throw new Error(`unknown bridge call: ${fn}`)
  }

  private coerceAgentOpts(raw: Json | undefined): AgentOpts {
    const o = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { [key: string]: Json | undefined })
      : {}
    const opts: AgentOpts = {}
    if (typeof o.agent === "string") opts.agent = o.agent
    if (typeof o.label === "string") opts.label = o.label
    if (typeof o.phase === "string") opts.phase = o.phase
    if (o.schema !== undefined) opts.schema = o.schema
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
    const now = Date.now()
    const pausedNow = state.paused && state.pausedAt !== undefined ? now - state.pausedAt : 0
    const elapsed = now - state.startedAt - state.pausedMs - pausedNow
    return this.options.timeoutMs - elapsed
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
  }

  /** New agent() calls wait here while paused; queued semaphore waiters are unaffected. */
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

  private finalize(runID: string, final: FinalOutcome): RunOutcome {
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
    if (final.result !== undefined && !resultFits(final.result, this.options.maxResultChars)) {
      try {
        artifactKey = this.storage.saveResultArtifact(runID, final.result)
      } catch {
        artifactKey = undefined
      }
    }

    this.registry.finish(runID, {
      status: final.status,
      result: final.result,
      resultTruncated: artifactKey !== undefined,
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

    const envelope = buildEnvelope(finalRun, this.options.maxResultChars)
    return { run: finalRun, envelope }
  }
}

/** Convenience factory matching the Supervisor interface. */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  return new SupervisorImpl(deps)
}
