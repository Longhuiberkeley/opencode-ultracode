/**
 * Host-side primitives: FIFO semaphore, the AgentRunner bridge wrapper
 * (registry bookkeeping + caps + throttled progress), workflow composition
 * with depth cap, and pure TS mirrors of the worker-side parallel/pipeline
 * combinators (kept behaviorally identical; see src/worker-script.ts).
 *
 * Builder B module.
 */
import type {
  AgentOpts,
  AgentRecord,
  AgentResult,
  FailoverMode,
  Json,
  ModelRef,
  PermissionMode,
  ProviderHealth,
  Registry,
  RunRecord,
  SavedWorkflow,
  Storage,
  WorkflowMeta,
} from "./types.ts"
import { clampConcurrency } from "./types.ts"
import type { SessionDriver } from "./sessions.ts"
import { AgentCallError, buildContinuationPrompt } from "./sessions.ts"
import type { ProviderLimiter, ProviderPermit } from "./provider-slots.ts"
import type { FailureClassification } from "./failure-classify.ts"
import { isReadOnlyChild, resolveFallbacks } from "./failover.ts"
import type { FallbackCandidate, PinPoolEntry } from "./failover.ts"
import { modelPinString } from "./agent-pins.ts"
import { validateScriptSource } from "./worker-script.ts"
import { createHash } from "node:crypto"

export const PROGRESS_THROTTLE_MS = 500

// ---------------------------------------------------------------------------
// Keyed warm replay (resumeFrom / rerun --warm)
// ---------------------------------------------------------------------------

/** A succeeded keyed agent result replayable on a warm rerun. */
export interface WarmCacheEntry {
  /** sha256 digest the caller's prompt+schema+agent must match to replay. */
  digest: string
  sourceRunID: string
  result: AgentResult
}

/**
 * Warm-cache identity: prompt + schema + resolved agent (+ the effective
 * explicit model override — per-call, or the run-level model folded in by the
 * runner). Everything that changes what the child would produce must change
 * the digest. The model segment is appended ONLY when set so digests of
 * pre-override runs stay valid across the upgrade (warm replays keep
 * working); an overridden call with the same key never replays a result
 * produced on a different model. Config pins are excluded by design.
 */
export function agentCacheKey(prompt: string, opts: AgentOpts, defaultAgent: string): string {
  const base = `${prompt}\u0000${JSON.stringify(opts.schema ?? null)}\u0000${opts.agent ?? defaultAgent}`
  if (opts.model === undefined) return base
  return `${base}\u0000${opts.model.providerID}/${opts.model.id}${opts.model.variant ? `#${opts.model.variant}` : ""}`
}

/** Digest used for keyed replay matching (sha256 hex). */
export function agentCacheDigest(prompt: string, opts: AgentOpts, defaultAgent: string): string {
  return createHash("sha256").update(agentCacheKey(prompt, opts, defaultAgent), "utf8").digest("hex")
}

/**
 * Build a warm cache from a source run's persisted record: every SUCCEEDED
 * keyed agent with a stored digest and a stored payload (data or text).
 * Later duplicates of the same key win (latest success). Pending-write
 * semantics: failed/interrupted children are never replayed.
 */
export function buildWarmCache(source: RunRecord | undefined): Map<string, WarmCacheEntry> {
  const cache = new Map<string, WarmCacheEntry>()
  if (!source) return cache
  for (const a of source.agents as AgentRecord[]) {
    if (a.status !== "succeeded" || !a.key || !a.promptDigest) continue
    if (a.data === undefined && a.resultText === undefined) continue
    // Failover guard: the digest describes the INTENDED pin/override, but this
    // row finished on a different model (quota failover). Replaying it under
    // the original pin would present another model's work as that pin's output,
    // so such rows are never warm-replayable. Absent metadata = legacy row.
    if (
      a.spawnModel !== undefined &&
      a.effectiveModel !== null &&
      a.effectiveModel !== undefined &&
      (a.spawnModel.providerID !== a.effectiveModel.providerID || a.spawnModel.id !== a.effectiveModel.id)
    ) {
      continue
    }
    cache.set(a.key, {
      digest: a.promptDigest,
      sourceRunID: source.id,
      result: {
        text: typeof a.resultText === "string" ? a.resultText : "",
        sessionID: typeof a.sessionID === "string" ? a.sessionID : "",
        ...(a.effectiveAgent !== undefined ? { agent: a.effectiveAgent } : {}),
        ...(a.effectiveModel !== undefined ? { model: a.effectiveModel } : {}),
        ...(a.tokens !== undefined ? { tokens: a.tokens } : {}),
        ...(a.data !== undefined ? { data: a.data } : {}),
        cachedFrom: source.id,
      },
    })
  }
  return cache
}

// ---------------------------------------------------------------------------
// FIFO semaphore (abortable)
// ---------------------------------------------------------------------------

interface SemaphoreWaiter {
  resolve(): void
  reject(err: Error): void
  onAbort(): void
  signal?: AbortSignal
}

/** Counting semaphore with a FIFO wait queue; queued waiters reject on abort. */
export class Semaphore {
  private readonly limit: number
  private active = 0
  private readonly queue: SemaphoreWaiter[] = []

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get running(): number {
    return this.active
  }

  get queued(): number {
    return this.queue.length
  }

  acquire(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = {
        resolve: () => resolve(),
        reject,
        onAbort: () => {
          const idx = this.queue.indexOf(waiter)
          if (idx >= 0) this.queue.splice(idx, 1)
          reject(new AgentCallError("abort", "agent aborted: run stopping"))
        },
        signal,
      }
      if (signal?.aborted) {
        reject(new AgentCallError("abort", "agent aborted: run stopping"))
        return
      }
      if (this.active < this.limit) {
        // Synchronous acquisition: no queue entry, so no abort listener to
        // register (the holder isn't auto-released on abort; a listener here
        // would leak — the queued path below owns listener cleanup).
        this.active++
        resolve()
        return
      }
      this.queue.push(waiter)
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true })
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (!next) {
      if (this.active > 0) this.active--
      return
    }
    if (next.signal) next.signal.removeEventListener("abort", next.onAbort)
    next.resolve() // slot transfers: active count unchanged
  }
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

const NEVER_ABORTED = new AbortController()

export interface AgentRunnerOptions {
  driver: SessionDriver
  registry: Registry
  runID: string
  defaultAgent: string
  availableAgents: string[] | undefined
  concurrency: number
  maxAgents: number
  report: (status: string) => void
  ambientPhase: () => string | undefined
  /**
   * Resolves the pinned model for an agent id from the user's agent config
   * (project beats global), in the object shape session.create expects.
   * Applied at create so children run on the model the user pinned —
   * server-side creates don't apply pins themselves.
   */
  pinForAgent?: (agentId: string) => Promise<{ providerID: string; id: string; variant?: string } | undefined>
  /**
   * Explicit run-level model override (from the run tool input `model`):
   * applies to every child WITHOUT a per-call opts.model. Precedence inside
   * the runner: opts.model > runModel > pinForAgent > server default.
   */
  runModel?: { providerID: string; id: string; variant?: string }
  /**
   * Plugin option modelFallbacks: failover ladder keyed by the dead model's
   * "provider/id". Applied only after a quota-shaped failure (or an exhausted
   * burst budget), always as a same-session model switch.
   */
  modelFallbacks?: Readonly<Record<string, ReadonlyArray<string>>>
  /**
   * Plugin option failover: "auto" (default), "ask" (supervisor pauses; the
   * runner behaves like auto — the pause gate holds failovers), or "off"
   * (no failover at all: children fail with the typed provider error).
   */
  failover?: FailoverMode
  /**
   * Supervisor-owned run-level breaker. Consulted BEFORE session.create:
   * a quota-quarantined provider is never created on again (the child routes
   * around it through the ladder, or fails typed); a burst-throttled provider
   * serializes admission (stagger) instead of aborting. Every classified
   * child failure is reported back. Absent => no breaker (tests, bare use).
   */
  providerHealth?: ProviderHealth
  /**
   * Run-level fallback override (ask-mode resume { model }): read at failover
   * time and placed after per-call fallbacks, before the option map.
   */
  fallbackOverride?: () => ModelRef | undefined
  /**
   * Run permission mode: `noEditTools` children (and the `explore` agent) are
   * read-only — they may use catalog-inference fallbacks and fail over to a
   * cheaper model. Edit-capable children may only move same-tier-or-better.
   */
  permissions?: PermissionMode
  /**
   * Agent-config pin pool lookup for failover (agent-pins.collectAgentPins),
   * called lazily with the run's known agent ids at failover time. Failures
   * degrade to "no pin candidates" and never break a run.
   */
  pinPool?: (agentIDs: readonly string[]) => Promise<ReadonlyArray<PinPoolEntry>>
  /**
   * `disabled_providers` snapshot for failover filtering; read lazily at
   * failover time. Absent/failed => no exclusions (fail open — mirrors the
   * spawn-path pin resolution; pins were already filtered at collection).
   */
  disabledProviders?: () => Promise<ReadonlySet<string>>
  /** Run-wide abort signal: rejects queued semaphore waits + aborts in-flight sessions. */
  signal?: AbortSignal
  /** Warm cache for keyed replay (resumeFrom); a hit spawns no session. */
  warmCache?: ReadonlyMap<string, WarmCacheEntry>
  /** Digest for keyed replay identity (defaults to sha256-based agentCacheDigest). */
  digest?: (prompt: string, opts: AgentOpts) => string
  /**
   * Plugin-level retry attempts for outcome (provider-shaped) failures.
   * Default 0 here (the plugin passes its own default, 1). Retries CONTINUE
   * the same session; quota-shaped failures are never retried.
   */
  retryAttempts?: number
  /**
   * Base of the jittered exponential retry backoff (attempt n waits
   * base * 2^n, ±50%, capped at RETRY_BACKOFF_CAP_MS). Default 2_000 ms.
   */
  retryBackoffMs?: number
  /** Clock injection for throttle tests. */
  now?: () => number
  /**
   * Instance+machine provider concurrency limiter (supervisor-owned, shared
   * across its runs). Acquired AFTER the run semaphore and AFTER model
   * resolution, released on settle. Absent => no provider slots.
   */
  providerLimiter?: ProviderLimiter
  /**
   * Frozen run snapshot of plugin option providerConcurrency. A provider
   * missing from the map is unconfigured — no instance permit, no slot dir.
   */
  providerConcurrency?: Readonly<Record<string, number>>
}

/** Inputs shared by the runner's failover attempts (built once per agent call). */
interface FailoverContext {
  /** Original prompt: re-anchored in the continuation instruction. */
  prompt: string
  /** Same structured-output contract as the original call (repair included). */
  schema: Json | undefined
  /** Resolved intended model; undefined = policy cannot route (fail closed). */
  dead: ModelRef | undefined
  /** Agent the child was requested as (read-only gate: "explore"). */
  requestedAgent: string
  phase: string
  label: string | undefined
  recordID: string
  /** Per-call opts.fallbacks (top ladder rung). */
  callFallbacks: ReadonlyArray<string> | undefined
}

/** Mutable provider-permit box so mid-flight failover can swap without nesting. */
interface ProviderHold {
  permit: ProviderPermit | undefined
  providerID: string | undefined
}

/** Clamp per-call/plugin retry attempts (0..3). */
export function clampRetryAttempts(value: number | undefined, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(3, Math.max(0, n))
}

/** Clamp retry backoff (0..120_000 ms). */
export function clampRetryBackoffMs(value: number | undefined, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(120_000, Math.max(0, n))
}

/** Default base of the jittered retry schedule (helper default; the plugin retry base seeds it). */
export const RETRY_BACKOFF_BASE_MS = 2_000
/**
 * Hard cap on any single retry wait. A burst clears in seconds, and the run
 * clock is 60 min — a long sleep would burn the run for a provider that may
 * not recover. Attempts, not wait length, are the retry bound.
 */
export const RETRY_BACKOFF_CAP_MS = 30_000

/**
 * Jittered exponential backoff for a same-session continue: base * 2^attempt
 * with +/-50% jitter, capped at capMs. Never negative, never above the cap;
 * an injected `rand` makes the bounds deterministic under test. Jitter matters
 * because many children hit the same provider cap at once — synchronized
 * retries would re-trigger the burst.
 */
export function jitteredDelay(
  attempt: number,
  baseMs = RETRY_BACKOFF_BASE_MS,
  capMs = RETRY_BACKOFF_CAP_MS,
  rand: () => number = Math.random,
): number {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0
  const base = Number.isFinite(baseMs) ? Math.max(0, baseMs) : RETRY_BACKOFF_BASE_MS
  const cap = Number.isFinite(capMs) ? Math.max(0, capMs) : RETRY_BACKOFF_CAP_MS
  const jitter = (rand() * 2 - 1) * 0.5 // ±50%
  return Math.round(Math.min(cap, Math.max(0, base * 2 ** step * (1 + jitter))))
}

/**
 * Abort-aware delay between retry attempts: resolves after `ms`, rejects with
 * an abort error the moment the run signal fires (a stopping run never waits
 * out a backoff).
 */
export function delayAbortable(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new AgentCallError("abort", "agent aborted: run stopping"))
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}

/**
 * Wraps the session driver for bridge calls: enforces the run-wide agent cap
 * and concurrency semaphore, maintains registry records (pending -> running ->
 * succeeded/failed/interrupted), and emits throttled progress lines shaped:
 * `phase — 3 running, 12 done, 1 failed (cap 200)`.
 */
export class AgentRunner {
  readonly runID: string
  private readonly driver: SessionDriver
  private readonly registry: Registry
  private readonly defaultAgent: string
  private readonly availableAgents: string[] | undefined
  private readonly semaphore: Semaphore
  private readonly maxAgents: number
  private readonly reportFn: (status: string) => void
  private readonly ambientPhase: () => string | undefined
  private readonly pinForAgent:
    | ((agentId: string) => Promise<{ providerID: string; id: string; variant?: string } | undefined>)
    | undefined
  private readonly runModel: { providerID: string; id: string; variant?: string } | undefined
  private readonly modelFallbacks: Readonly<Record<string, ReadonlyArray<string>>> | undefined
  private readonly permissions: PermissionMode | undefined
  private readonly failoverMode: FailoverMode
  private readonly providerHealth: ProviderHealth | undefined
  private readonly fallbackOverride: (() => ModelRef | undefined) | undefined
  private readonly pinPool: ((agentIDs: readonly string[]) => Promise<ReadonlyArray<PinPoolEntry>>) | undefined
  private readonly disabledProviders: (() => Promise<ReadonlySet<string>>) | undefined
  private readonly signal?: AbortSignal
  private readonly warmCache: ReadonlyMap<string, WarmCacheEntry> | undefined
  private readonly digestFn: (prompt: string, opts: AgentOpts) => string
  private readonly retryAttempts: number
  private readonly retryBackoffMs: number
  private readonly now: () => number
  private readonly providerLimiter: ProviderLimiter | undefined
  private readonly providerConcurrency: Readonly<Record<string, number>> | undefined
  private started = 0
  private lastReportAt = 0

  constructor(options: AgentRunnerOptions) {
    this.driver = options.driver
    this.registry = options.registry
    this.runID = options.runID
    this.defaultAgent = options.defaultAgent
    this.availableAgents = options.availableAgents
    this.semaphore = new Semaphore(clampConcurrency(options.concurrency))
    this.maxAgents = options.maxAgents
    this.reportFn = options.report
    this.ambientPhase = options.ambientPhase
    this.pinForAgent = options.pinForAgent
    this.runModel = options.runModel
    this.modelFallbacks = options.modelFallbacks
    this.permissions = options.permissions
    this.failoverMode = options.failover ?? "auto"
    this.providerHealth = options.providerHealth
    this.fallbackOverride = options.fallbackOverride
    this.pinPool = options.pinPool
    this.disabledProviders = options.disabledProviders
    this.signal = options.signal
    this.warmCache = options.warmCache
    this.retryAttempts = clampRetryAttempts(options.retryAttempts, 0)
    this.retryBackoffMs = clampRetryBackoffMs(options.retryBackoffMs, RETRY_BACKOFF_BASE_MS)
    this.digestFn =
      options.digest ?? ((prompt, opts) => agentCacheDigest(prompt, opts, this.defaultAgent))
    this.now = options.now ?? Date.now
    this.providerLimiter = options.providerLimiter
    this.providerConcurrency = options.providerConcurrency
  }

  get agentsStarted(): number {
    return this.started
  }

  get inFlight(): number {
    return this.semaphore.running
  }

  get queued(): number {
    return this.semaphore.queued
  }

  async call(prompt: string, opts: AgentOpts = {}): Promise<AgentResult> {
    const key = typeof opts.key === "string" ? opts.key.trim() : ""
    // Digest identity sees the EFFECTIVE model (per-call override, else the
    // run-level override — the runner's precedence for this child). Config
    // pins are deliberately excluded (user-config context, pre-existing
    // behavior): a warm rerun after re-pinning replays keyed results.
    const digestOpts: AgentOpts =
      opts.model === undefined && this.runModel !== undefined ? { ...opts, model: this.runModel } : opts
    const digest = key ? this.digestFn(prompt, digestOpts) : undefined

    // Keyed warm replay: a succeeded agent with the same key AND the same
    // prompt digest returns from the source run — no session spawned, no cap
    // consumed. The replay is recorded (cached: true) so this run can itself
    // be warm-restarted later.
    if (key && digest && this.warmCache) {
      const entry = this.warmCache.get(key)
      if (entry && entry.digest === digest) {
        const phase = opts.phase ?? this.ambientPhase() ?? "workflow"
        this.registry.addAgent(this.runID, {
          label: opts.label,
          phase,
          requestedAgent: opts.agent ?? this.defaultAgent,
          status: "succeeded",
          startedAt: Date.now(),
          endedAt: Date.now(),
          key,
          promptDigest: digest,
          cached: true,
          sessionID: entry.result.sessionID || undefined,
          effectiveAgent: entry.result.agent,
          effectiveModel: entry.result.model ?? undefined,
          data: entry.result.data,
          resultText: entry.result.text,
        })
        this.maybeReport()
        return { ...entry.result }
      }
    }

    if (this.started >= this.maxAgents) {
      throw new Error(`agent cap reached (${this.maxAgents})`)
    }
    this.started++
    await this.semaphore.acquire(this.signal)

    const phase = opts.phase ?? this.ambientPhase() ?? "workflow"
    const record = this.registry.addAgent(this.runID, {
      label: opts.label,
      phase,
      requestedAgent: opts.agent ?? this.defaultAgent,
      status: "pending",
      startedAt: Date.now(),
    })
    if (!record) {
      this.semaphore.release()
      throw new Error(`run ${this.runID} not found`)
    }
    this.maybeReport()

    const providerHold: ProviderHold = { permit: undefined, providerID: undefined }
    try {
      const titlePhase = opts.phase ?? this.ambientPhase()
      const requestedAgent = opts.agent ?? this.defaultAgent
      // Model precedence: per-call override > run-level override > agent-config
      // pin > server default. Explicit overrides skip pin lookup entirely (the
      // caller asked for THIS model), and carry their source so drift reports
      // can tell an intentional override from a config pin.
      let model: { providerID: string; id: string; variant?: string } | undefined
      let modelSource: "call" | "run" | "pin" | undefined
      if (opts.model !== undefined) {
        model = opts.model
        modelSource = "call"
      } else if (this.runModel !== undefined) {
        model = this.runModel
        modelSource = "run"
      } else if (this.pinForAgent) {
        try {
          model = await this.pinForAgent(requestedAgent)
          if (model === undefined && requestedAgent !== this.defaultAgent) {
            // Unpinned requested agent (e.g. shipped `build`): the server's
            // session-create fallback is the location default — observed live
            // as a free-tier model the user never chose. The default agent's
            // pin is the user's standing model choice (they rotate it via
            // subagent-config), so inherit it instead.
            model = await this.pinForAgent(this.defaultAgent)
          }
          if (model !== undefined) modelSource = "pin"
        } catch {
          model = undefined // pin resolution must never break a run
        }
      }
      // Intended-model provenance BEFORE the child runs: 0-token provider
      // deaths never populate effectiveModel, so failed rows need spawnModel
      // to show which model/provider was targeted.
      if (model !== undefined) {
        this.registry.updateAgent(this.runID, record.id, {
          spawnModel: { ...model, ...(modelSource !== undefined ? { source: modelSource } : {}) },
        })
      }
      // Provider-shaped failures (outcome "failed" — outages, rate limits) are
      // CLASSIFIED first and retried as a CONTINUE of the same session: a
      // failed session that already did work is never replaced by a fresh one.
      // Burst/unclassified failures get a same-model probe with jittered
      // backoff; quota-shaped failures are NEVER retried on the same provider —
      // they fail over to the ordered fallback ladder in the SAME session (or
      // surface the typed error when nothing eligible remains). A continue that
      // dies with 0 new work is promoted to quota. Aborts, schema errors and
      // agent-resolution errors are never retried or failed over. Retries and
      // failovers reuse the SAME registry record (one row per agent() call).
      const attempts = clampRetryAttempts(opts.retry?.attempts, this.retryAttempts)
      const baseBackoffMs = clampRetryBackoffMs(opts.retry?.backoffMs, this.retryBackoffMs)
      const continueFn = this.driver.continueAgent
      let result: AgentResult | undefined
      let continuedSessionID: string | undefined
      let continuationPrompt: string | undefined
      // Failover inputs shared by every branch. Without a resolved spawn model
      // the policy cannot prove a candidate differs from the dead one, so the
      // ladder refuses to route (fail closed).
      const failoverContext: FailoverContext = {
        prompt,
        schema: opts.schema,
        dead: model,
        requestedAgent,
        phase,
        label: opts.label,
        recordID: record.id,
        callFallbacks: opts.fallbacks,
      }
      // Breaker admission, BEFORE any session exists. A quota-quarantined
      // provider is never created on again: the child routes around it through
      // the SAME ladder (the candidate rides session.create — one row, zero
      // sessions on the dead provider) or fails with the typed quarantine error
      // when nothing eligible remains. A burst-throttled provider serializes
      // admission (stagger) instead of aborting the run. `failover: "off"`
      // skips all breaker routing: children behave exactly as before.
      const failoverOn = this.failoverMode !== "off"
      const health = this.providerHealth
      const abortSignal = this.signal ?? NEVER_ABORTED.signal
      let activeModel = model
      let routedFrom: ModelRef | undefined
      let routedReason: string | undefined
      if (failoverOn && health !== undefined && model !== undefined) {
        if (!health.isQuarantined(model.providerID)) {
          await health.admit(model.providerID, abortSignal)
        }
        if (health.isQuarantined(model.providerID)) {
          // Re-checked AFTER the admit wait: a quarantine may have landed while
          // this child queued behind the burst gate.
          const candidate = await this.routeAroundQuarantine(failoverContext)
          if (candidate === undefined) throw this.quarantineFailure(model)
          activeModel = candidate.model
          // The model actually used is B, not the original A: ladder keys,
          // dead-provider exclusion, and failover.from must follow B.
          failoverContext.dead = { ...candidate.model }
          routedFrom = model
          routedReason =
            `provider ${model.providerID} is quarantined after a quota failure — routed to ` +
            `${candidate.model.providerID}/${candidate.model.id} before any session was created`
          await health.admit(activeModel.providerID, abortSignal)
        }
      }
      // Provider concurrency: AFTER the run semaphore (already held) and AFTER
      // model resolution / quarantine routing, BEFORE sessions.create. One
      // permit per child. Mid-flight failover that switches providers releases
      // the dead permit FIRST, then acquires the fallback (never nested, never
      // two provider permits). Unconfigured providers skip both the instance
      // semaphore and the machine slot dir.
      providerHold.providerID = activeModel?.providerID
      providerHold.permit = await this.acquireConfiguredPermit(providerHold.providerID, abortSignal)
      for (let attempt = 0; ; attempt++) {
        try {
          if (attempt === 0) {
            result = await this.driver.runAgent(
              {
                prompt,
                agent: opts.agent,
                ...(activeModel !== undefined ? { model: activeModel } : {}),
                label: opts.label,
                phase: titlePhase,
                schema: opts.schema,
                defaultAgent: this.defaultAgent,
                runID: this.runID,
                ord: record.id,
              },
              this.availableAgents,
              {
                signal: this.signal ?? NEVER_ABORTED.signal,
                onSessionID: (sessionID) => {
                  continuedSessionID = sessionID
                  this.registry.updateAgent(this.runID, record.id, {
                    status: "running",
                    sessionID,
                    startedAt: Date.now(),
                  })
                  try {
                    this.registry.bindAgentSession(this.runID, record.id, sessionID)
                  } catch {
                    // provenance must not break the call
                  }
                },
              },
            )
          } else {
            result = await continueFn!.call(
              this.driver,
              {
                sessionID: continuedSessionID!,
                continuationPrompt: continuationPrompt!,
                ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
              },
              { signal: this.signal ?? NEVER_ABORTED.signal },
            )
            // One row per agent() call: a continue keeps the row's identity and
            // its original sessionID (no rebinding, no second row).
            this.registry.updateAgent(this.runID, record.id, { sessionID: continuedSessionID! })
          }
          break
        } catch (err) {
          if (!(err instanceof AgentCallError) || err.kind !== "outcome") throw err
          // Report EVERY classified failure into the run-level breaker before
          // policy branches: burst strikes accumulate (3 within 60 s engage the
          // throttle), quota quarantines the provider — which is also where ask
          // mode pauses the run, so the branch below already sees the pause.
          this.reportProviderFailure(activeModel, err.failure)
          // Quota-shaped: account-level and hours long — no same-model and no
          // same-provider retry, ever. Fail over on the SAME session instead.
          if (err.failure?.class === "quota") {
            const failedOver = failoverOn
              ? await this.tryFailover(err, "quota", failoverContext, continuedSessionID, providerHold)
              : undefined
            if (failedOver !== undefined) {
              result = failedOver
              break
            }
            throw err
          }
          // A continue that died with 0 new work is the observed 0-token
          // instant-death shape: treat it as quota and stop probing.
          if (attempt > 0 && err.noProgress === true) {
            const promoted = promoteQuotaFailure(err)
            this.reportProviderFailure(activeModel, promoted.failure)
            const failedOver = failoverOn
              ? await this.tryFailover(promoted, "quota", failoverContext, continuedSessionID, providerHold)
              : undefined
            if (failedOver !== undefined) {
              result = failedOver
              break
            }
            throw promoted
          }
          // Burst-shaped failures may use the configured retry budget; without
          // a burst classification the policy allows exactly ONE same-model
          // continue probe — never a blind retry loop.
          const budget = err.failure?.class === "burst" ? attempts : Math.min(attempts, 1)
          if (attempt >= budget) {
            // Burst budget exhausted: the provider keeps throttling this model.
            // The ordered fallback ladder is the last resort before the typed
            // error surfaces; unclassified failures stay fail-closed.
            if (err.failure?.class === "burst" && failoverOn) {
              const failedOver = await this.tryFailover(err, "burst", failoverContext, continuedSessionID, providerHold)
              if (failedOver !== undefined) {
                result = failedOver
                break
              }
            }
            throw err
          }
          // Same-session continue is the only legal retry; without a session
          // to continue (or a driver that cannot continue one) the error
          // surfaces instead of spawning a fresh session.
          if (continuedSessionID === undefined || continueFn === undefined) throw err
          this.safeReport(
            `${phase} — ${opts.label ?? record.id} retry ${attempt + 1}/${budget} (same-session continue): ${errorMessage(err).slice(0, 140)}`,
          )
          await delayAbortable(jitteredDelay(attempt, baseBackoffMs, RETRY_BACKOFF_CAP_MS), this.signal)
          continuationPrompt = buildContinuationPrompt(prompt, continuationReason(err))
        }
      }
      const agentResult = result!
      // Pre-create quarantine routing is a failover too: surface the note on
      // the result (unless a mid-flight failover already attached one) so the
      // caller and the registry tell the same story as a session switch.
      const finalResult: AgentResult =
        routedFrom !== undefined && activeModel !== undefined && agentResult.failover === undefined
          ? {
              ...agentResult,
              failover: {
                from: routedFrom,
                to: { ...activeModel },
                class: "quota",
                reason: (routedReason ?? "provider quarantined").slice(0, 300),
              },
            }
          : agentResult
      this.registry.updateAgent(this.runID, record.id, {
        status: "succeeded",
        effectiveAgent: finalResult.agent,
        effectiveModel: finalResult.model,
        tokens: finalResult.tokens,
        data: finalResult.data,
        endedAt: Date.now(),
        // Keyed calls persist replay identity (and the text a future warm
        // rerun needs) so resumeFrom can skip this child next time.
        ...(key && digest ? { key, promptDigest: digest, resultText: finalResult.text } : {}),
      })
      this.maybeReport()
      return finalResult
    } catch (err) {
      const aborted = err instanceof AgentCallError && err.kind === "abort"
      this.registry.updateAgent(this.runID, record.id, {
        status: aborted ? "interrupted" : "failed",
        error: errorMessage(err),
        endedAt: Date.now(),
      })
      this.maybeReport(true)
      throw err
    } finally {
      if (providerHold.permit !== undefined) {
        try {
          await providerHold.permit.release()
        } catch {
          // slot release is best-effort; the instance permit must still drop
        }
      }
      this.semaphore.release()
    }
  }

  /**
   * Quota (or burst-exhausted) failover: continue the SAME session on the
   * first eligible model of resolveFallbacks' ordered ladder — per-call
   * opts.fallbacks > plugin option modelFallbacks > agent-config pin pool >
   * catalog inference for read-only children — switching models in place via
   * the driver's session.switchModel (feature-detected there; absent => the
   * switch fails typed and the original quota error surfaces). Returns
   * undefined when no candidate can be attempted (no live session, no model
   * identity, no eligible rung), and the caller rethrows the typed error —
   * fail closed, never a fresh session.
   *
   * Candidates are tried in order: a fallback that ALSO dies moves to the next
   * rung (each attempt is a fresh continuation on that candidate). An abort is
   * rethrown immediately — a stopping run never keeps switching models — and
   * on success the returned result carries the informational `failover` note
   * the registry row and status text expose.
   */
  private async tryFailover(
    err: AgentCallError,
    failureClass: "quota" | "burst",
    context: FailoverContext,
    sessionID: string | undefined,
    hold: ProviderHold,
  ): Promise<AgentResult | undefined> {
    const continueFn = this.driver.continueAgent
    if (sessionID === undefined || continueFn === undefined || context.dead === undefined) return undefined
    const candidates = await this.resolveLadder(context, failureClass)
    // A quarantined candidate is skipped (a second provider may have been
    // quarantined while this child ran): the ladder only routes to providers
    // the breaker still considers healthy.
    const eligible =
      this.providerHealth !== undefined
        ? candidates.filter((candidate) => !this.providerHealth!.isQuarantined(candidate.model.providerID))
        : candidates
    if (eligible.length === 0) {
      this.safeReport(
        `${context.phase} — ${context.label ?? context.recordID} provider ${failureClass} failure on ` +
          `${context.dead.providerID}/${context.dead.id}; no eligible failover candidate`,
      )
      return undefined
    }
    const from: ModelRef = { ...context.dead }
    const signal = this.signal ?? NEVER_ABORTED.signal
    // Reason starts with the provider signal itself and is refreshed by each
    // failed candidate so the returned note describes the real last failure.
    let lastReason = err.failure?.reason ?? errorMessage(err)
    for (let index = 0; index < eligible.length; index++) {
      const candidate = eligible[index]!
      this.safeReport(
        `${context.phase} — ${context.label ?? context.recordID} failover ${index + 1}/${eligible.length} (${failureClass}): ` +
          `${from.providerID}/${from.id} → ${candidate.model.providerID}/${candidate.model.id} [${candidate.source}]`,
      )
      // Permit swap BEFORE the continuation: never hold the dead provider and
      // the fallback at once. Release-then-acquire is abort-aware; a thrown
      // abort leaves nothing held.
      await this.swapProviderPermit(hold, candidate.model.providerID, signal)
      try {
        const continued = await continueFn.call(
          this.driver,
          {
            sessionID,
            continuationPrompt: buildContinuationPrompt(context.prompt, failoverReason(from, candidate.model)),
            model: { ...candidate.model },
            ...(context.schema !== undefined ? { schema: context.schema } : {}),
          },
          { signal },
        )
        return {
          ...continued,
          failover: {
            from,
            to: { ...candidate.model },
            class: failureClass,
            reason: `provider ${failureClass} failure on ${from.providerID}/${from.id}: ${lastReason}`.slice(0, 300),
          },
        }
      } catch (retryErr) {
        if (retryErr instanceof AgentCallError && retryErr.kind === "abort") throw retryErr
        // A candidate that ALSO died is a provider signal in its own right:
        // report it so the breaker sees the second provider's health too.
        this.reportProviderFailure(
          candidate.model,
          retryErr instanceof AgentCallError ? retryErr.failure : undefined,
        )
        lastReason =
          retryErr instanceof AgentCallError && retryErr.failure !== undefined
            ? retryErr.failure.reason
            : errorMessage(retryErr)
        this.safeReport(
          `${context.phase} — ${context.label ?? context.recordID} fallback ` +
            `${candidate.model.providerID}/${candidate.model.id} failed: ${errorMessage(retryErr).slice(0, 140)}`,
        )
      }
    }
    return undefined
  }

  /** Configured providerConcurrency cap for a provider, or undefined if unconfigured. */
  private permitCap(providerID: string | undefined): number | undefined {
    if (providerID === undefined) return undefined
    const cap = this.providerConcurrency?.[providerID]
    return typeof cap === "number" && cap >= 1 ? cap : undefined
  }

  private async acquireConfiguredPermit(
    providerID: string | undefined,
    signal: AbortSignal,
  ): Promise<ProviderPermit | undefined> {
    const cap = this.permitCap(providerID)
    if (this.providerLimiter === undefined || providerID === undefined || cap === undefined) return undefined
    return await this.providerLimiter.acquire(providerID, cap, signal)
  }

  /**
   * Move a child's provider permit to `toProvider`: release the currently held
   * permit FIRST, then acquire the fallback. Never holds two provider permits
   * (deadlock-free). Same-provider continues keep the existing hold. An abort
   * during acquire leaves nothing held and surfaces as AgentCallError("abort").
   */
  private async swapProviderPermit(hold: ProviderHold, toProvider: string | undefined, signal: AbortSignal): Promise<void> {
    const toCap = this.permitCap(toProvider)
    if (hold.providerID === toProvider && (hold.permit !== undefined) === (toCap !== undefined)) return
    if (hold.permit !== undefined) {
      try {
        await hold.permit.release()
      } catch {
        // best-effort; must not keep a stale permit while acquiring the next
      }
      hold.permit = undefined
    }
    hold.providerID = toProvider
    if (toCap === undefined) return
    hold.permit = await this.acquireConfiguredPermit(toProvider, signal)
  }

  /**
   * Resolve the ordered ladder for a failover context: per-call opts.fallbacks
   * > run-level fallback override (ask-mode resume) > plugin option
   * modelFallbacks > agent-config pin pool > catalog inference for read-only
   * children. Lazy pin-pool / disabled-provider reads degrade to "no rung"
   * and never break a run.
   */
  private async resolveLadder(context: FailoverContext, failureClass: "quota" | "burst"): Promise<FallbackCandidate[]> {
    if (context.dead === undefined) return []
    let pinPool: ReadonlyArray<PinPoolEntry> = []
    if (this.pinPool) {
      try {
        pinPool = await this.pinPool(this.availableAgents ?? [])
      } catch {
        pinPool = [] // pin collection must never break a run
      }
    }
    let disabledProviders: ReadonlySet<string> | undefined
    if (this.disabledProviders) {
      try {
        disabledProviders = await this.disabledProviders()
      } catch {
        disabledProviders = undefined // fail open — mirrors spawn-path pin resolution
      }
    }
    const override = this.fallbackOverride?.()
    return resolveFallbacks({
      dead: context.dead,
      failureClass,
      ...(context.callFallbacks !== undefined ? { callFallbacks: context.callFallbacks } : {}),
      ...(override !== undefined ? { runFallback: modelPinString(override) } : {}),
      ...(this.modelFallbacks !== undefined ? { modelFallbacks: this.modelFallbacks } : {}),
      pinPool,
      ...(disabledProviders !== undefined ? { disabledProviders } : {}),
      readOnly: isReadOnlyChild(this.permissions, context.requestedAgent),
    })
  }

  /**
   * Pre-create quarantine routing: the intended provider is quarantined, so no
   * session may be created on it. Returns the first ladder candidate whose
   * provider is NOT quarantined (the caller creates the session directly on
   * it), or undefined when nothing eligible remains — fail closed.
   */
  private async routeAroundQuarantine(context: FailoverContext): Promise<FallbackCandidate | undefined> {
    if (context.dead === undefined) return undefined
    const candidates = await this.resolveLadder(context, "quota")
    const candidate = candidates.find(
      (entry) => this.providerHealth === undefined || !this.providerHealth.isQuarantined(entry.model.providerID),
    )
    if (candidate === undefined) {
      this.safeReport(
        `${context.phase} — ${context.label ?? context.recordID} provider ${context.dead.providerID} is quarantined; ` +
          `no eligible failover candidate — failing the child`,
      )
      return undefined
    }
    this.safeReport(
      `${context.phase} — ${context.label ?? context.recordID} provider ${context.dead.providerID} is quarantined; ` +
        `creating the session on ${candidate.model.providerID}/${candidate.model.id} [${candidate.source}] instead`,
    )
    return candidate
  }

  /**
   * Typed quarantine failure (no session was created): the provider is
   * account-level dead and the ladder had nothing eligible. Carries the
   * quota-shaped classification so callers and the registry see the same
   * failure type as a live quota failure.
   */
  private quarantineFailure(dead: ModelRef): AgentCallError {
    return new AgentCallError(
      "outcome",
      `provider ${dead.providerID} is quarantined after a quota failure and no eligible failover candidate remains — failing before session.create`,
      undefined,
      { class: "quota", reason: `provider ${dead.providerID} quarantined; no eligible failover candidate` },
      undefined,
    )
  }

  /**
   * Report one classified child failure into the run-level breaker. The
   * breaking model is the one that produced the failure (intended model, or a
   * routed/replaced candidate). Never throws; unclassified failures are
   * ignored.
   */
  private reportProviderFailure(model: ModelRef | undefined, failure: FailureClassification | undefined): void {
    if (this.providerHealth === undefined || model === undefined || failure === undefined) return
    if (failure.class === "quota") {
      this.providerHealth.report({
        runID: this.runID,
        providerID: model.providerID,
        class: "quota",
        ...(failure.resetAt !== undefined ? { resetAt: failure.resetAt } : {}),
        model: modelPinString(model),
      })
    } else if (failure.class === "burst") {
      this.providerHealth.report({
        runID: this.runID,
        providerID: model.providerID,
        class: "burst",
        model: modelPinString(model),
      })
    }
  }

  private maybeReport(force = false): void {
    const now = this.now()
    if (!force && now - this.lastReportAt < PROGRESS_THROTTLE_MS) return
    this.lastReportAt = now
    const run = this.registry.get(this.runID)
    if (!run) return
    let running = 0
    let done = 0
    let failed = 0
    for (const a of run.agents as AgentRecord[]) {
      if (a.status === "running") running++
      else if (a.status === "succeeded") done++
      else if (a.status === "failed" || a.status === "interrupted") failed++
    }
    const phase = this.ambientPhase() ?? "workflow"
    this.safeReport(`${phase} — ${running} running, ${done} done, ${failed} failed (cap ${this.maxAgents})`)
  }

  private safeReport(status: string): void {
    try {
      this.reportFn(status)
    } catch {
      // reporting must never break a run
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow composition (depth cap 1)
// ---------------------------------------------------------------------------

export interface ComposedWorkflow {
  script: string
  meta: WorkflowMeta
}

/**
 * Async saved-workflow loader — the composition seam. `loadWorkflowFresh`
 * (disk-direct, trust-checked; Builder A) is preferred when present on the
 * Storage; the synchronous cached `loadWorkflow` is the fallback. Fresh-disk
 * semantics per composition call.
 */
export type WorkflowLoader = (name: string) => Promise<SavedWorkflow | undefined>

export function storageWorkflowLoader(storage: Storage): WorkflowLoader {
  const fresh = (storage as {
    loadWorkflowFresh?: (name: string) => Promise<SavedWorkflow | undefined>
  }).loadWorkflowFresh
  if (typeof fresh === "function") {
    // Defensive unwrap: tolerates loaders that return either SavedWorkflow
    // directly (current shape) or wrapped as { workflow }.
    return async (name: string) => {
      const raw = (await fresh.call(storage, name)) as SavedWorkflow | { workflow: SavedWorkflow } | undefined
      if (raw === undefined || raw === null) return undefined
      const maybe = raw as { workflow?: SavedWorkflow }
      if (typeof maybe.workflow === "object" && maybe.workflow !== null) return maybe.workflow
      return raw as SavedWorkflow
    }
  }
  return (name: string) => Promise.resolve(storage.loadWorkflow(name))
}

/**
 * Bridge handler for `workflow(name, args)` calls from the worker. Loads the
 * saved workflow through the injected async loader (fresh per call) and
 * returns its script for nested execution at depth 1. A composition request
 * arriving at depth > 0 is rejected ("nested composition beyond depth 1") —
 * enforced host-side, worker-side depth is advisory only. Loader failures
 * (unknown name, trust-check rejections) surface verbatim as agent-style
 * errors to the script.
 */
export async function getWorkflowComposer(
  loader: WorkflowLoader,
  name: string,
  args?: Json,
  depth = 0,
): Promise<ComposedWorkflow> {
  void args
  if (depth > 0) {
    throw new Error("nested composition beyond depth 1")
  }
  const saved = await loader(name)
  if (!saved) {
    throw new Error(`unknown workflow "${name}" — not found in project or personal workflow directories`)
  }
  const check = validateScriptSource(saved.script)
  if (!check.ok) {
    throw new Error(`saved workflow "${name}" failed script validation: ${check.error}`)
  }
  const meta: WorkflowMeta = {
    name: saved.manifest.name,
    description: saved.manifest.description,
    phases: saved.manifest.phases,
    requires: saved.manifest.requires,
  }
  return { script: saved.script, meta }
}

// ---------------------------------------------------------------------------
// Pure TS mirrors of the worker-side combinators (for direct unit testing —
// the worker string in worker-script.ts implements the same semantics).
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Human-readable reason embedded into a same-session continuation prompt.
 * Branches on the typed class only — policy must never parse classification
 * reason strings.
 */
function continuationReason(err: AgentCallError): string {
  if (err.failure?.class === "burst") return "transient provider rate limit (burst) — retrying on the same model"
  if (err.failure?.class === "other") return "provider-side failure — retrying on the same model"
  return "provider failure — same-model probe"
}

/**
 * Human-readable reason embedded into a failover continuation prompt: names
 * the dead provider and the model the child is switching to. The surrounding
 * buildContinuationPrompt text already says the previous turn may be EMPTY and
 * re-anchors the original request; the schema instruction is appended by the
 * driver when the call had one.
 */
function failoverReason(from: ModelRef, to: ModelRef): string {
  return `provider ${from.providerID} hit a rate limit/account quota on ${from.id} — continuing on ${to.providerID}/${to.id}`
}

/**
 * Promote a no-progress continue re-failure to a quota-shaped typed error.
 * Production showed 0-token instant deaths when a throttled/quota-exhausted
 * provider was re-prompted, so failover must see `class: "quota"` even when
 * the raw signal was only rate-limit shaped. Message/status/resetAt are
 * preserved; the reason records the promotion.
 */
function promoteQuotaFailure(err: AgentCallError): AgentCallError {
  const base = err.failure
  const failure: FailureClassification = {
    class: "quota",
    ...(base?.message !== undefined ? { message: base.message } : {}),
    ...(base?.status !== undefined ? { status: base.status } : {}),
    ...(base?.resetAt !== undefined ? { resetAt: base.resetAt } : {}),
    reason: `0-token instant re-failure after a same-session continue — treated as quota (${base?.reason ?? "unclassified"})`,
  }
  return new AgentCallError(
    "outcome",
    `${err.message} [promoted to quota: the continued turn produced no progress]`,
    err.text,
    failure,
    true,
  )
}

/**
 * Mirror of the worker's `parallel`: runs thunks concurrently; a thrown error
 * becomes `null` for that slot and is logged. Never rejects.
 */
export async function parallelHelper<T>(
  thunks: ReadonlyArray<() => T | Promise<T>>,
  log: (message: string) => void = () => {},
): Promise<Array<T | null>> {
  return Promise.all(
    thunks.map((thunk) =>
      Promise.resolve()
        .then(thunk)
        .catch((err: unknown) => {
          log(`parallel thunk failed: ${errorMessage(err)}`)
          return null
        }),
    ),
  )
}

/**
 * Mirror of the worker's `pipeline`: per-item async chains through the stages
 * (each stage receives (value, index)); a stage throw nulls that item and logs.
 * Never rejects.
 */
export async function pipelineHelper<I, O>(
  items: readonly I[],
  stages: Array<(item: I, index: number) => unknown>,
  log: (message: string) => void = () => {},
): Promise<Array<unknown>> {
  return Promise.all(
    items.map((item, index) => {
      let chain: Promise<unknown> = Promise.resolve(item)
      for (const stage of stages) {
        const fn = stage
        chain = chain.then((value: unknown) => fn(value as I, index))
      }
      return chain.catch((err: unknown) => {
        log(`pipeline item ${index} failed: ${errorMessage(err)}`)
        return null
      })
    }),
  )
}
