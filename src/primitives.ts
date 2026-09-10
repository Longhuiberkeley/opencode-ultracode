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
  SavedWorkflow,
  Storage,
  WorkflowMeta,
} from "./types.ts"
import { clampConcurrency } from "./types.ts"
import type { SessionDriver } from "./sessions.ts"
import { AgentCallError } from "./sessions.ts"
import { validateScriptSource } from "./worker-script.ts"

export const PROGRESS_THROTTLE_MS = 500

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
  /** Run-wide abort signal: rejects queued semaphore waits + aborts in-flight sessions. */
  signal?: AbortSignal
  /** Clock injection for throttle tests. */
  now?: () => number
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
  private readonly signal?: AbortSignal
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
    this.signal = options.signal
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
      let model: { providerID: string; id: string; variant?: string } | undefined
      if (this.pinForAgent) {
        try {
          model = await this.pinForAgent(requestedAgent)
        } catch {
          model = undefined // pin resolution must never break a run
        }
      }
      const result = await this.driver.runAgent(
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
      this.registry.updateAgent(this.runID, record.id, {
        status: "succeeded",
        effectiveAgent: result.agent,
        effectiveModel: result.model,
        tokens: result.tokens,
        data: result.data,
        endedAt: Date.now(),
      })
      this.maybeReport()
      return result
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
