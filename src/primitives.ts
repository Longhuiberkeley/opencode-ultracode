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
  Json,
  Registry,
  RunRecord,
  SavedWorkflow,
  Storage,
  WorkflowMeta,
} from "./types.ts"
import { clampConcurrency } from "./types.ts"
import type { SessionDriver } from "./sessions.ts"
import { AgentCallError, buildContinuationPrompt } from "./sessions.ts"
import type { FailureClassification } from "./failure-classify.ts"
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
          reject(new Error("run stopping"))
        },
        signal,
      }
      if (signal?.aborted) {
        reject(new Error("run stopping"))
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
  private readonly signal?: AbortSignal
  private readonly warmCache: ReadonlyMap<string, WarmCacheEntry> | undefined
  private readonly digestFn: (prompt: string, opts: AgentOpts) => string
  private readonly retryAttempts: number
  private readonly retryBackoffMs: number
  private readonly now: () => number
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
    this.signal = options.signal
    this.warmCache = options.warmCache
    this.retryAttempts = clampRetryAttempts(options.retryAttempts, 0)
    this.retryBackoffMs = clampRetryBackoffMs(options.retryBackoffMs, RETRY_BACKOFF_BASE_MS)
    this.digestFn =
      options.digest ?? ((prompt, opts) => agentCacheDigest(prompt, opts, this.defaultAgent))
    this.now = options.now ?? Date.now
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
      // backoff; quota-shaped failures are NEVER retried (same-model and
      // same-provider retries are guaranteed instant deaths), and a continue
      // that dies with 0 new work is promoted to quota. Aborts, schema errors
      // and agent-resolution errors are never retried. Retries reuse the SAME
      // registry record (one row per agent() call, not per attempt).
      const attempts = clampRetryAttempts(opts.retry?.attempts, this.retryAttempts)
      const baseBackoffMs = clampRetryBackoffMs(opts.retry?.backoffMs, this.retryBackoffMs)
      const continueFn = this.driver.continueAgent
      let result: AgentResult | undefined
      let continuedSessionID: string | undefined
      let continuationPrompt: string | undefined
      for (let attempt = 0; ; attempt++) {
        try {
          if (attempt === 0) {
            result = await this.driver.runAgent(
              {
                prompt,
                agent: opts.agent,
                ...(model !== undefined ? { model } : {}),
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
          // Quota-shaped: account-level and hours long — no same-model and no
          // same-provider retry, ever. Surface the typed error to the failover
          // policy (which owns cross-provider continuation).
          if (err.failure?.class === "quota") throw err
          // A continue that died with 0 new work is the observed 0-token
          // instant-death shape: treat it as quota and stop probing.
          if (attempt > 0 && err.noProgress === true) throw promoteQuotaFailure(err)
          // Burst-shaped failures may use the configured retry budget; without
          // a burst classification the policy allows exactly ONE same-model
          // continue probe — never a blind retry loop.
          const budget = err.failure?.class === "burst" ? attempts : Math.min(attempts, 1)
          if (attempt >= budget) throw err
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
      this.registry.updateAgent(this.runID, record.id, {
        status: "succeeded",
        effectiveAgent: agentResult.agent,
        effectiveModel: agentResult.model,
        tokens: agentResult.tokens,
        data: agentResult.data,
        endedAt: Date.now(),
        // Keyed calls persist replay identity (and the text a future warm
        // rerun needs) so resumeFrom can skip this child next time.
        ...(key && digest ? { key, promptDigest: digest, resultText: agentResult.text } : {}),
      })
      this.maybeReport()
      return agentResult
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
      this.semaphore.release()
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
