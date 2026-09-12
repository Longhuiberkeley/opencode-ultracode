/**
 * Worker host — spawns and controls a node:worker_threads Worker running
 * WORKER_SOURCE (eval mode). The host NEVER evaluates user code; only the
 * worker does. Message protocol:
 *   host -> worker : {type:"init", script, args, meta} | {type:"result", ...}
 *   worker -> host : {type:"call", id, fn, args} | {type:"event", ...} | {type:"done", ...}
 *
 * Builder B module.
 */
import { Worker } from "node:worker_threads"
import type { Json, WorkflowMeta } from "./types.ts"
import { WORKER_SOURCE } from "./worker-script.ts"

export type BridgeFn = string
export type EventKind = "progress" | "phase" | "log" | "checkpoint"

export interface WorkerBridgeHandlers {
  /** Dispatch a bridge call (agent / workflow). Rejects on failure. */
  onCall(fn: BridgeFn, args: Json[]): Promise<Json>
  /** progress/phase/log/checkpoint events from the script. */
  onEvent(kind: EventKind, data: Json): void
}

export interface SpawnWorkerInput {
  /** The USER script (async function body, plain JS — validated host-side). */
  source: string
  args?: Json
  meta?: WorkflowMeta
  handlers: WorkerBridgeHandlers
}

export type WorkerResult = { ok: true; value: Json } | { ok: false; error: string }

export interface WorkerHandle {
  /** Post init and resolve on the worker's done message (never rejects). */
  start(): Promise<WorkerResult>
  /** Subsequent bridge calls from the worker are rejected with "run stopping". */
  closeGate(): void
  /** Terminate the worker; unresolved start() resolves {ok:false}. Idempotent. */
  terminate(graceMs?: number): Promise<void>
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function spawnWorker(input: SpawnWorkerInput): WorkerHandle {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  let gateClosed = false
  let settled = false
  let resolveStart!: (result: WorkerResult) => void
  const startPromise = new Promise<WorkerResult>((resolve) => {
    resolveStart = resolve
  })

  const settle = (result: WorkerResult): void => {
    if (settled) return
    settled = true
    resolveStart(result)
    // The worker stays alive after posting done — reclaim the thread.
    worker.terminate().catch(() => {})
  }

  worker.on("message", (msg: unknown) => {
    if (msg === null || typeof msg !== "object") return
    const m = msg as { type?: string; [k: string]: unknown }
    if (m.type === "call") {
      const id = Number(m.id)
      if (gateClosed) {
        worker.postMessage({ type: "result", id, ok: false, error: "run stopping" })
        return
      }
      const fn = String(m.fn ?? "")
      const args = (Array.isArray(m.args) ? m.args : []) as Json[]
      void Promise.resolve()
        .then(() => input.handlers.onCall(fn, args))
        .then(
          (value) => {
            try {
              worker.postMessage({ type: "result", id, ok: true, value: value ?? null })
            } catch {
              worker.postMessage({ type: "result", id, ok: false, error: "bridge result was not serializable" })
            }
          },
          (err: unknown) => {
            worker.postMessage({ type: "result", id, ok: false, error: errorMessage(err) })
          },
        )
      return
    }
    if (m.type === "event") {
      const kind = String(m.kind ?? "log") as EventKind
      input.handlers.onEvent(kind, (m.data ?? null) as Json)
      return
    }
    if (m.type === "done") {
      if (m.ok === true) settle({ ok: true, value: (m.value ?? null) as Json })
      else settle({ ok: false, error: typeof m.error === "string" ? m.error : "workflow script failed" })
    }
  })

  worker.on("error", (err: Error) => {
    settle({ ok: false, error: `worker crashed: ${errorMessage(err)}` })
  })
  worker.on("messageerror", (err: Error) => {
    settle({ ok: false, error: `worker message error: ${errorMessage(err)}` })
  })
  worker.on("exit", (code: number) => {
    if (!settled) settle({ ok: false, error: `worker exited unexpectedly (code ${code})` })
  })

  return {
    start(): Promise<WorkerResult> {
      if (!gateClosed) {
        worker.postMessage({ type: "init", script: input.source, args: input.args, meta: input.meta })
      } else {
        settle({ ok: false, error: "run stopping" })
      }
      return startPromise
    },
    closeGate(): void {
      gateClosed = true
    },
    async terminate(graceMs = 5000): Promise<void> {
      gateClosed = true
      try {
        const exited: Promise<unknown> = worker.terminate()
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), Math.max(0, graceMs))
          if (typeof (timer as { unref?: () => void }).unref === "function") {
            ;(timer as { unref: () => void }).unref()
          }
          void Promise.resolve(exited).then(
            () => resolve(),
            () => resolve(),
          )
        })
      } catch {
        // terminate never rejects in practice
      }
      settle({ ok: false, error: "worker terminated" })
    },
  }
}
