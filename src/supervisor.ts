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
  ModelRef,
  ParentContext,
  ProviderFailureClass,
  ProviderHealth,
  ProviderQuarantineSnapshot,
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
import { modelPinString, normalizeModelRef } from "./agent-pins.ts"
import { freezeEffective, panelSettingsFrom, remainingTimeoutMs } from "./settings.ts"
import { buildEnvelope, resultFits } from "./serialize.ts"
import { createSessionDriver } from "./sessions.ts"
import type { SessionDriver } from "./sessions.ts"
import {
  AgentRunner,
  Semaphore,
  buildWarmCache,
  delayAbortable,
  getWorkflowComposer,
  storageWorkflowLoader,
} from "./primitives.ts"
import type { WarmCacheEntry, WorkflowLoader } from "./primitives.ts"
import { isReadOnlyChild, resolveFallbacks } from "./failover.ts"
import type { PinPoolEntry } from "./failover.ts"
import { defaultProviderSlotsDir, ProviderConcurrencyGate, ProviderSlotPool } from "./provider-slots.ts"
import { validateScriptSource } from "./worker-script.ts"
import { spawnWorker } from "./worker-host.ts"
import type { WorkerHandle, WorkerResult } from "./worker-host.ts"

/** Grace for in-flight bridge calls (dangling agent() promises) after the script settles. */
export const SETTLE_GRACE_MS = 15_000
/** Grace between stop() and worker termination (lets well-behaved scripts unwind). */
export const STOP_KILL_GRACE_MS = 5_000
/** Hard cap on dispose() waiting for run finalization. */
export const DISPOSE_TIMEOUT_MS = 30_000
/** Burst strikes inside this window engage the throttle; a quiet window this long lifts it. */
export const PROVIDER_BURST_WINDOW_MS = 60_000
/** Strikes within the window that engage admission throttling for a provider. */
export const PROVIDER_BURST_STRIKE_LIMIT = 3
/** Minimum gap between admissions for a throttled provider (serialize + stagger). */
export const PROVIDER_THROTTLE_STAGGER_MS = 200
/** Bounded per-provider memory of the model keys that triggered a quarantine. */
export const PROVIDER_QUARANTINE_MODELS_CAP = 4

/**
 * What the breaker reports when a provider crosses into quarantine (quota) or
 * the throttle engages (3 burst strikes in 60 s). The supervisor consumes it
 * for ask mode; the runner does not branch on events.
 */
export interface ProviderBreakerEvent {
  /** Run whose child reported the failure (ask-mode pause target). */
  runID: string
  providerID: string
  /** "quota" quarantines; "burst" fires only when the throttle first engages. */
  kind: ProviderFailureClass
  /** Parsed reset time when the classification exposed one. */
  resetAt?: number
  /** "provider/id" of the failing model (ask-report key resolution). */
  model?: string
  /** Strikes inside the window at engagement time (burst events). */
  strikes?: number
}

interface ProviderHealthState {
  /** Epoch ms; Infinity = quarantined for this supervisor's lifetime. */
  quarantinedUntil: number | undefined
  /** Model keys whose failures triggered the current quarantine (bounded). */
  quarantineModels: string[]
  /** Burst strike timestamps (pruned to PROVIDER_BURST_WINDOW_MS). */
  burstStrikes: number[]
  /** Last admission timestamp for the throttle stagger (0 = never). */
  lastAdmissionAt: number
}

/**
 * Supervisor-owned provider breaker (the run-level breaker of the failover
 * policy). ONE instance per supervisor, shared across every run it owns.
 *
 * WHY supervisor-scoped and in-memory: quota is account-level and hours long,
 * so a single strike must stop EVERY subsequent child of EVERY run this
 * instance supervises from creating a session on that provider. Persisting the
 * state would resurrect hours-old strikes after an unrelated plan reset, so
 * the knowledge is deliberately process-local — a restart re-observes.
 *
 * Two signals:
 * - QUOTA (classified account/plan quota): quarantine the provider until the
 *   parsed reset time (Infinity when unknown). No second event for the same
 *   quarantine — ask mode reports once, not per child.
 * - BURST: strikes accumulate; the 3rd within 60 s engages admission
 *   throttling (serialize + stagger). The throttle lifts after a 60 s quiet
 *   window (strike pruning) — never an abort.
 *
 * Admission waiting is abort-aware: a stopping run rejects instead of waiting.
 */
export class ProviderBreaker implements ProviderHealth {
  private readonly states = new Map<string, ProviderHealthState>()
  private readonly gates = new Map<string, Semaphore>()
  private readonly now: () => number
  private readonly staggerMs: number
  private readonly onEvent: ((event: ProviderBreakerEvent) => void) | undefined

  constructor(
    options: {
      /** Clock injection (tests). */
      now?: () => number
      /** Override the 200 ms stagger (tests). */
      staggerMs?: number
      onEvent?: (event: ProviderBreakerEvent) => void
    } = {},
  ) {
    this.now = options.now ?? Date.now
    this.staggerMs = Math.max(0, Math.floor(options.staggerMs ?? PROVIDER_THROTTLE_STAGGER_MS))
    this.onEvent = options.onEvent
  }

  isQuarantined(providerID: string): boolean {
    return this.quarantinedUntil(providerID) !== undefined
  }

  quarantinedUntil(providerID: string): number | undefined {
    const state = this.states.get(providerID)
    if (state?.quarantinedUntil === undefined) return undefined
    if (state.quarantinedUntil <= this.now()) {
      // The parsed reset passed: the provider is presumed healthy again.
      state.quarantinedUntil = undefined
      state.quarantineModels = []
      return undefined
    }
    return state.quarantinedUntil
  }

  isThrottled(providerID: string): boolean {
    const state = this.states.get(providerID)
    return state !== undefined && this.pruneStrikes(state) >= PROVIDER_BURST_STRIKE_LIMIT
  }

  async admit(providerID: string, signal?: AbortSignal): Promise<void> {
    if (!this.isThrottled(providerID)) return
    const gate = this.gateFor(providerID)
    await gate.acquire(signal)
    try {
      if (!this.isThrottled(providerID)) return // lifted while queued: no stagger needed
      const state = this.stateFor(providerID)
      const waitMs = this.staggerMs - (this.now() - state.lastAdmissionAt)
      if (waitMs > 0) await delayAbortable(waitMs, signal)
      state.lastAdmissionAt = this.now()
    } finally {
      gate.release()
    }
  }

  report(input: {
    runID: string
    providerID: string
    class: ProviderFailureClass
    resetAt?: number
    model?: string
  }): void {
    const providerID = input.providerID
    if (typeof providerID !== "string" || providerID.length === 0) return
    const now = this.now()
    const state = this.stateFor(providerID)
    if (input.class === "quota") {
      if (state.quarantinedUntil !== undefined && state.quarantinedUntil > now) {
        // Already quarantined: keep (or extend to) the later known reset and
        // remember the model. No event — ask mode must report once, not per
        // child that dies on the same dead provider.
        if (input.resetAt !== undefined && input.resetAt > state.quarantinedUntil) {
          state.quarantinedUntil = input.resetAt
        }
        this.rememberModel(state, input.model)
        return
      }
      state.quarantinedUntil = input.resetAt !== undefined ? input.resetAt : Number.POSITIVE_INFINITY
      state.quarantineModels = []
      this.rememberModel(state, input.model)
      this.emit({
        runID: input.runID,
        providerID,
        kind: "quota",
        ...(input.resetAt !== undefined ? { resetAt: input.resetAt } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      })
      return
    }
    // Burst: quota dominates — a quarantined provider needs no strike noise.
    if (state.quarantinedUntil !== undefined && state.quarantinedUntil > now) return
    const wasThrottled = this.pruneStrikes(state) >= PROVIDER_BURST_STRIKE_LIMIT
    state.burstStrikes.push(now)
    const strikes = this.pruneStrikes(state)
    if (!wasThrottled && strikes >= PROVIDER_BURST_STRIKE_LIMIT) {
      this.emit({
        runID: input.runID,
        providerID,
        kind: "burst",
        strikes,
        ...(input.model !== undefined ? { model: input.model } : {}),
      })
    }
  }

  /** Snapshot for orchestrator surfaces (read-only; prunes expired quarantines). */
  quarantines(): ProviderQuarantineSnapshot[] {
    const out: ProviderQuarantineSnapshot[] = []
    for (const providerID of [...this.states.keys()]) {
      const until = this.quarantinedUntil(providerID)
      if (until === undefined) continue
      const state = this.states.get(providerID)!
      out.push({
        providerID,
        ...(Number.isFinite(until) ? { resetAt: until } : {}),
        models: [...state.quarantineModels],
      })
    }
    return out
  }

  private emit(event: ProviderBreakerEvent): void {
    try {
      this.onEvent?.(event)
    } catch {
      // Breaker diagnostics must never break the child call that reported.
    }
  }

  private stateFor(providerID: string): ProviderHealthState {
    let state = this.states.get(providerID)
    if (state === undefined) {
      state = { quarantinedUntil: undefined, quarantineModels: [], burstStrikes: [], lastAdmissionAt: 0 }
      this.states.set(providerID, state)
    }
    return state
  }

  private gateFor(providerID: string): Semaphore {
    let gate = this.gates.get(providerID)
    if (gate === undefined) {
      gate = new Semaphore(1) // provider-level serialization while throttled
      this.gates.set(providerID, gate)
    }
    return gate
  }

  /** Drop strikes older than the window; returns the in-window count. */
  private pruneStrikes(state: ProviderHealthState): number {
    const cutoff = this.now() - PROVIDER_BURST_WINDOW_MS
    while (state.burstStrikes.length > 0 && state.burstStrikes[0]! < cutoff) state.burstStrikes.shift()
    return state.burstStrikes.length
  }

  private rememberModel(state: ProviderHealthState, model: string | undefined): void {
    if (typeof model !== "string" || model.length === 0 || state.quarantineModels.includes(model)) return
    state.quarantineModels.push(model)
    if (state.quarantineModels.length > PROVIDER_QUARANTINE_MODELS_CAP) state.quarantineModels.shift()
  }
}

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
  /**
   * Agent-config pin pool for quota failover (agent-pins.collectAgentPins):
   * every usable pin across the run's known agent ids. Called lazily per
   * failover; absent => the ladder skips its pin rung. Index wiring; optional
   * for tests.
   */
  pinPool?: (agentIDs: readonly string[]) => Promise<ReadonlyArray<PinPoolEntry>>
  /**
   * `disabled_providers` snapshot for failover filtering. Called lazily per
   * failover; absent => no exclusions. Index wiring; optional for tests.
   */
  disabledProviders?: () => Promise<ReadonlySet<string>>
  /** Clock injection for breaker tests (default Date.now). */
  now?: () => number
  /** Throttle stagger override for breaker tests (default 200 ms). */
  breakerStaggerMs?: number
  /**
   * Override the machine-level provider-slot base dir (tests inject a temp
   * dir). Production uses ~/.local/share/opencode/ultracode/provider-slots.
   */
  providerSlotsDir?: string
  /** Heartbeat interval override for slot tests (default 10 s; 0 disables). */
  providerSlotHeartbeatMs?: number
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
  /** Ask-mode fallback override (resume { model }): beats the ladder at failover time. */
  fallbackOverride: ModelRef | undefined
  /** Ask-mode auto-proceed timer (askTimeoutMs > 0); undefined = no pending timer. */
  askTimer: ReturnType<typeof setTimeout> | undefined
  /** Ask reports already emitted for this run (provider+kind coalescing keys). */
  askNotified: Set<string>
  /** Escape hatch: explicit overrides may target disabled providers. */
  allowDisabledProviders: boolean
  /** Per-run tighten-only loop iteration ceiling (run input `maxLoopIterations`). */
  runLoopIterations: number | undefined
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
  private readonly pinPool: ((agentIDs: readonly string[]) => Promise<ReadonlyArray<PinPoolEntry>>) | undefined
  private readonly disabledProviders: (() => Promise<ReadonlySet<string>>) | undefined
  private readonly settleGraceMs: number
  private readonly stopKillMs: number
  private readonly driver: Required<SessionDriver>
  private readonly workflowLoader: WorkflowLoader
  /** Run-level breaker, shared across every run this supervisor owns. */
  private readonly providerHealth: ProviderBreaker
  /**
   * Instance + machine provider slots, shared across every run this supervisor
   * owns. Acquire order is run-semaphore -> provider permit (the runner
   * enforces that); abort rejects queued waits.
   */
  private readonly providerLimiter: ProviderConcurrencyGate
  private readonly runs = new Map<string, RunState>()
  private disposed = false

  constructor(deps: SupervisorDeps) {
    this.registry = deps.registry
    this.storage = deps.storage
    this.sessions = deps.sessions
    this.options = { ...deps.options }
    this.pinForAgent = deps.pinForAgent
    this.isProviderDisabled = deps.isProviderDisabled
    this.pinPool = deps.pinPool
    this.disabledProviders = deps.disabledProviders
    this.settleGraceMs = deps.settleGraceMs ?? SETTLE_GRACE_MS
    this.stopKillMs = deps.stopKillGraceMs ?? STOP_KILL_GRACE_MS
    // Driver construction performs no session calls — safe outside executors.
    this.driver = createSessionDriver(deps.sessions)
    // Composition seam: injected fresh loader wins; else prefer
    // Storage.loadWorkflowFresh when present, else the cached loadWorkflow.
    this.workflowLoader = deps.loadWorkflowFresh ?? storageWorkflowLoader(deps.storage)
    // Run-level breaker: ONE instance shared across this supervisor's runs.
    // Quota strikes quarantine a provider; burst strikes throttle admission;
    // ask-mode events pause the affected run and report once.
    this.providerHealth = new ProviderBreaker({
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.breakerStaggerMs !== undefined ? { staggerMs: deps.breakerStaggerMs } : {}),
      onEvent: (event) => this.handleProviderEvent(event),
    })
    this.providerLimiter = new ProviderConcurrencyGate({
      slotPool: new ProviderSlotPool({
        baseDir: deps.providerSlotsDir ?? defaultProviderSlotsDir(),
        ...(deps.providerSlotHeartbeatMs !== undefined ? { heartbeatMs: deps.providerSlotHeartbeatMs } : {}),
      }),
    })
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
    // Per-run overrides from the run tool input: this run only. The
    // supervisor defaults (user overlay included) are left untouched, and each
    // override is captured on the record — record.effective for status/panel
    // display, plus the explicit *Override fields so a warm rerun reproduces
    // the run's clock and loop caps.
    const effective = freezeEffective({
      ...this.options,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxLoopDepth !== undefined ? { maxLoopDepth: input.maxLoopDepth } : {}),
    })
    if (input.timeoutMs !== undefined) record.timeoutOverrideMs = input.timeoutMs
    if (input.maxLoopDepth !== undefined) record.maxLoopDepthOverride = input.maxLoopDepth
    if (input.maxLoopIterations !== undefined) record.maxLoopIterationsOverride = input.maxLoopIterations
    // Persist the explicit model override for rerun reproduction (mirrors
    // timeoutOverrideMs; absent = pins/defaults only).
    if (input.model !== undefined) record.modelOverride = input.model
    if (input.allowDisabledProviders === true) record.allowDisabledProviders = true
    // panelSettingsFrom alone drops permissionStallMs (panel shows 4 keys),
    // but the permission stall watchdog reads it off this record — keep it.
    // Same for the loop caps: a run must always answer "what cap did this
    // run enforce?" — the nesting cap even without an override, the iteration
    // ceiling only when one was passed.
    record.effective = {
      ...panelSettingsFrom(effective),
      permissionStallMs: effective.permissionStallMs,
      maxLoopDepth: effective.maxLoopDepth,
      ...(input.maxLoopIterations !== undefined ? { maxLoopIterations: input.maxLoopIterations } : {}),
    }
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
          continueAgent: async (continueInput, hooks) => {
            // Same-session retry/failover: re-check pause (a run paused while
            // the probe was backing off must not keep prompting), and keep the
            // child in the LIVE set for the duration so a stop's delayed kill
            // still interrupts it. No new session, no new registry row.
            await this.waitIfPaused(state)
            const sessionID = continueInput.sessionID
            state.live.add(sessionID)
            state.childLastActivity.set(sessionID, Date.now())
            try {
              // Ask-mode answer: a failover continue (model switch) that was
              // resolved BEFORE the pause picks up the override the run was
              // resumed with. Same-model continues are untouched — the
              // override answers a failover, it does not reroute retries.
              const override = state.fallbackOverride
              const effective =
                override !== undefined && continueInput.model !== undefined
                  ? { ...continueInput, model: override }
                  : continueInput
              return await this.driver.continueAgent(effective, hooks)
            } finally {
              state.live.delete(sessionID)
            }
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
        // Quota failover: the frozen run's ladder + permission mode decide
        // read-only eligibility; pin pool / disabled providers are lazy
        // index-wired lookups shared across the run's children. The breaker
        // is supervisor-owned (shared across runs): quarantined providers are
        // never created on again; the ask-mode resume override is read at
        // failover time so a paused run honors the answer it is resumed with.
        modelFallbacks: state.effective.modelFallbacks,
        permissions: state.effective.permissions,
        failover: state.effective.failover,
        providerHealth: this.providerHealth,
        fallbackOverride: () => state.fallbackOverride,
        ...(this.pinPool ? { pinPool: this.pinPool } : {}),
        ...(this.disabledProviders ? { disabledProviders: this.disabledProviders } : {}),
        report: (status) => parent.report(status),
        ambientPhase: () => state.ambientPhase,
        ...(this.pinForAgent ? { pinForAgent: this.pinForAgent } : {}),
        ...(state.runModel !== undefined ? { runModel: state.runModel } : {}),
        signal: state.controller.signal,
        ...(warmCache ? { warmCache } : {}),
        providerLimiter: this.providerLimiter,
        providerConcurrency: state.effective.providerConcurrency,
      })

      // 5. Spawn the worker with bridge dispatch.
      const runDir = this.storage.runDirFor?.(runID)
      worker = spawnWorker({
        source: input.script,
        args: input.args,
        meta: input.meta,
        caps: {
          maxAgents: state.effective.maxAgents,
          maxLoopDepth: state.effective.maxLoopDepth,
          ...(state.runLoopIterations !== undefined ? { maxLoopIterations: state.runLoopIterations } : {}),
          artifactsDir: runDir ?? null,
          runDir: runDir ?? null,
        },
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
      this.clearAskTimer(state)
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
    this.clearAskTimer(state)
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

  resume(runID: string, opts?: { model?: ModelRef }): boolean {
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
    // Ask-mode answer: a resume WITH a model becomes this run's fallback
    // override — later failovers (and quarantine routing) prefer it over the
    // configured ladder. A resume without one proceeds in auto-mode policy.
    if (opts?.model !== undefined) state.fallbackOverride = opts.model
    this.clearAskTimer(state)
    this.armWatchdog(state)
    this.armStallScanner(state)
    this.resumePauseWaiters(state)
    this.safeParentReport(
      state,
      opts?.model !== undefined
        ? `resumed ${runID} — fallback override ${modelPinString(opts.model)}`
        : `resumed ${runID}`,
    )
    return true
  }

  /** Currently quarantined providers (ask-mode diagnostics + remember keying). */
  providerQuarantines(): ProviderQuarantineSnapshot[] {
    return this.providerHealth.quarantines()
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
      fallbackOverride: undefined,
      askTimer: undefined,
      askNotified: new Set<string>(),
      allowDisabledProviders: input.allowDisabledProviders === true,
      runLoopIterations: input.maxLoopIterations,
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
    if (fn === "workflow-check") {
      // loop({ unit }) preflight: load + trust-check + validate the named
      // workflow BEFORE iteration 1, WITHOUT executing it. Same loader and
      // depth rule as workflow(); the composed script is discarded.
      if (typeof args[0] !== "string" || args[0].length === 0) {
        throw new Error("workflow-check(name) — name must be a non-empty string")
      }
      const depth = typeof args[2] === "number" ? args[2] : 0
      const composed = await getWorkflowComposer(this.workflowLoader, args[0], args[1], depth)
      return {
        ok: true,
        name: args[0],
        meta: (composed as { meta?: unknown }).meta ?? null,
      } as unknown as Json
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
    // Per-call failover ladder: explicit pins are validated at admission (an
    // override the caller spelled wrong is an error, mirroring opts.model),
    // then stored as pin strings — the failover policy owns pin parsing.
    if (o.fallbacks !== undefined && o.fallbacks !== null) {
      if (!Array.isArray(o.fallbacks)) {
        throw new Error('agent(prompt, opts) — opts.fallbacks must be an array of "provider/id#variant" pin strings')
      }
      const fallbacks: string[] = []
      for (const item of o.fallbacks) {
        if (typeof item !== "string") {
          throw new Error(`agent(prompt, opts) — opts.fallbacks entries must be strings, got ${JSON.stringify(item) ?? String(item)}`)
        }
        const normalized = normalizeModelRef(item)
        if (!normalized.ok) {
          throw new Error(`agent(prompt, opts) — opts.fallbacks: ${normalized.error}`)
        }
        fallbacks.push(item.trim())
      }
      if (fallbacks.length > 0) opts.fallbacks = fallbacks
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

  // -------------------------------------------------------------------------
  // Ask mode (quarantine/throttle -> pause + one coalesced report)
  // -------------------------------------------------------------------------

  /**
   * Breaker event hook. Ask mode only: when a provider is QUOTA-quarantined
   * and an active run has pending/at-risk children that would actually fail
   * over, pause that run through the existing pause machinery (watchdog
   * suspended — paused runs do not burn timeoutMs) and emit ONE coalesced
   * report per (run, provider, kind): provider, class, reset time, affected
   * child count, proposed fallback and the exact resume invocation. Burst
   * throttle never pauses — it throttles admission only; burst children same-
   * model-retry with backoff and make progress under auto policy. Children
   * already inside a failover park in the driver's pause gate until the run is
   * resumed, so the ask really does gate the failover. "off"/"auto" modes
   * never take this path.
   */
  private handleProviderEvent(event: ProviderBreakerEvent): void {
    if (event.kind !== "quota") return // burst throttle admits; it does not pause
    for (const state of [...this.runs.values()]) {
      if (state.effective.failover !== "ask") continue
      const key = `${event.kind}:${event.providerID}`
      if (state.askNotified.has(key)) continue
      const affected = this.affectedChildCount(state, event.providerID)
      if (affected === 0) continue // no child of this run would fail over: nothing to ask
      if (!state.paused) {
        if (!this.pause(state.runID)) continue // already stopping/final: cannot hold the run
      }
      state.askNotified.add(key)
      this.emitAskReport(state, event, affected)
      this.armAskTimeout(state)
    }
  }

  /** Children of this run currently running/pending ON providerID. */
  private affectedChildCount(state: RunState, providerID: string): number {
    const run = this.registry.get(state.runID)
    if (!run) return 0
    let count = 0
    for (const agent of run.agents as AgentRecord[]) {
      if (agent.status !== "running" && agent.status !== "pending") continue
      const model = agent.effectiveModel ?? agent.spawnModel
      if (model?.providerID === providerID) count++
    }
    return count
  }

  /**
   * Requested agent id for the ask-mode proposal, matching the runner's
   * isReadOnlyChild rule (noEditTools OR the explore agent). Prefers an
   * at-risk child on `dead` that is already read-only so explore children in
   * non-noEditTools runs still unlock catalog/down-tier proposals.
   */
  private affectedRequestedAgent(state: RunState, dead: ModelRef): string {
    const fallback = state.effective.agent
    const run = this.registry.get(state.runID)
    if (!run) return fallback
    let requested = fallback
    for (const agent of run.agents as AgentRecord[]) {
      if (agent.status !== "running" && agent.status !== "pending") continue
      const model = agent.effectiveModel ?? agent.spawnModel
      if (model?.providerID !== dead.providerID || model?.id !== dead.id) continue
      requested = agent.requestedAgent ?? requested
      if (isReadOnlyChild(state.effective.permissions, requested)) return requested
    }
    return requested
  }

  /**
   * One coalesced ask report. Never throws; the fallback proposal is resolved
   * lazily through the same ladder inputs the runner uses (pin pool /
   * disabled providers / run fallback override; read-only inferred from the
   * run's permission mode).
   */
  private emitAskReport(state: RunState, event: ProviderBreakerEvent, affected: number): void {
    void (async () => {
      let proposed: ModelRef | undefined
      if (event.model !== undefined) {
        const parsed = normalizeModelRef(event.model)
        if (parsed.ok) proposed = await this.proposeFallback(state, parsed.model)
      }
      const when =
        event.kind === "burst"
          ? `${event.strikes ?? PROVIDER_BURST_STRIKE_LIMIT} burst strikes within ${Math.round(PROVIDER_BURST_WINDOW_MS / 1000)}s`
          : event.resetAt !== undefined
            ? `reset at ${new Date(event.resetAt).toISOString()}`
            : "reset time unknown — quarantined for this plugin instance"
      const modelBit = proposed !== undefined ? `, "model": "${modelPinString(proposed)}"` : ""
      const timeoutBit =
        state.effective.askTimeoutMs > 0
          ? `auto-resumes in ${state.effective.askTimeoutMs}ms`
          : "waits indefinitely (askTimeoutMs 0)"
      this.safeParentReport(
        state,
        `provider ask — ${event.kind === "quota" ? "account quota" : "burst throttle"} on ${event.providerID} (${when}); ` +
          `affected children: ${affected}; proposed fallback: ${proposed !== undefined ? modelPinString(proposed) : "none"}. ` +
          `run ${state.runID} is paused — resume with ultracode_control { "action": "resume", "runID": "${state.runID}"${modelBit} } (${timeoutBit})`,
      )
    })().catch(() => {
      // reporting must never break a run
    })
  }

  /** First eligible ladder candidate for a dead model (proposal only). */
  private async proposeFallback(state: RunState, dead: ModelRef): Promise<ModelRef | undefined> {
    let pinPool: ReadonlyArray<PinPoolEntry> = []
    if (this.pinPool) {
      try {
        pinPool = await this.pinPool(state.parent.availableAgents ?? [])
      } catch {
        pinPool = [] // pin collection must never break a run
      }
    }
    let disabledProviders: ReadonlySet<string> | undefined
    if (this.disabledProviders) {
      try {
        disabledProviders = await this.disabledProviders()
      } catch {
        disabledProviders = undefined // fail open — mirrors the runner
      }
    }
    const override = state.fallbackOverride
    const candidates = resolveFallbacks({
      dead,
      failureClass: "quota",
      ...(override !== undefined ? { runFallback: modelPinString(override) } : {}),
      modelFallbacks: state.effective.modelFallbacks,
      pinPool,
      ...(disabledProviders !== undefined ? { disabledProviders } : {}),
      readOnly: isReadOnlyChild(state.effective.permissions, this.affectedRequestedAgent(state, dead)),
    })
    return candidates.find((candidate) => !this.providerHealth.isQuarantined(candidate.model.providerID))?.model
  }

  /**
   * askTimeoutMs > 0: auto-resume in auto-mode policy after the timeout. The
   * timer is unref'd (never keeps a process alive) and only fires while the
   * run is still paused — a manual resume/stop cancels it first.
   */
  private armAskTimeout(state: RunState): void {
    if (state.askTimer !== undefined) return
    const ms = state.effective.askTimeoutMs
    if (ms <= 0) return
    const timer = setTimeout(() => {
      state.askTimer = undefined
      if (this.disposed || !state.paused) return
      const run = this.registry.get(state.runID)
      if (!run || run.status !== "paused") return
      this.safeParentReport(state, `ask timeout (${ms}ms) — resuming ${state.runID} in auto mode`)
      this.resume(state.runID)
    }, ms)
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      ;(timer as { unref: () => void }).unref()
    }
    state.askTimer = timer
  }

  private clearAskTimer(state: RunState): void {
    if (state.askTimer !== undefined) {
      clearTimeout(state.askTimer)
      state.askTimer = undefined
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
