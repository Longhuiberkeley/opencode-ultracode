/**
 * Per-provider concurrency: instance FIFO permits + machine-level slot dirs.
 *
 * WHY: a provider's per-minute / concurrent-session cap is shared across every
 * run this OpenCode process supervises AND across other processes on the same
 * machine. The run-level semaphore only bounds one run; without a provider
 * gate, eight runs of eight children all hammer the same account at once.
 *
 * Two layers, both applied when plugin option `providerConcurrency` caps a
 * provider (1..16). Acquire order is run-semaphore -> provider permit (never
 * the reverse, never nested provider permits). Abort rejects queued waits and
 * releases nothing partially.
 *
 * Machine slots — Node core has no flock. The portable design is atomic
 * `fs.mkdir` (EEXIST = taken) of
 *   ~/.local/share/opencode/ultracode/provider-slots/<providerID>/slot-<i>
 * plus an mtime heartbeat every 10 s while held. A slot whose mtime is older
 * than 30 s is stale and reclaimable (self-healing after crashes). Tradeoff:
 * a live holder that pauses past 30 s without heartbeat can be stolen
 * (theoretical over-admission); a reclaim that then loses the mkdir race is
 * under-admission. Heartbeat 10 s vs stale 30 s keeps a live holder well
 * inside the window, so the observed failure mode is under-admission.
 */
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { delayAbortable, Semaphore } from "./primitives.ts"
import { AgentCallError } from "./sessions.ts"

export const PROVIDER_SLOT_HEARTBEAT_MS = 10_000
export const PROVIDER_SLOT_STALE_MS = 30_000
export const PROVIDER_SLOT_WAIT_MIN_MS = 50
export const PROVIDER_SLOT_WAIT_MAX_MS = 250
export const PROVIDER_CONCURRENCY_MIN = 1
export const PROVIDER_CONCURRENCY_MAX = 16

/** Provider ids are path segments under the slot dir; keep them boring. */
const PROVIDER_ID_RE = /^[A-Za-z0-9._-]+$/

/**
 * True when `id` is a safe directory name under the slot base. Existing pin
 * charset already excludes `/`; we still reject `".."`, `\\`, and NUL so a
 * defensive caller cannot walk out of the slots tree.
 */
export function isSafeProviderID(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false
  if (id.includes("/") || id.includes("\\") || id.includes("\0") || id.includes("..")) return false
  return PROVIDER_ID_RE.test(id)
}

export function defaultProviderSlotsDir(): string {
  return path.join(os.homedir(), ".local/share/opencode/ultracode/provider-slots")
}

export function clampProviderConcurrency(value: number): number {
  const n = Number.isFinite(value) ? Math.floor(value) : PROVIDER_CONCURRENCY_MIN
  return Math.min(PROVIDER_CONCURRENCY_MAX, Math.max(PROVIDER_CONCURRENCY_MIN, n))
}

function errCode(err: unknown): string | undefined {
  if (err !== null && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code
  }
  return undefined
}

function slotWaitMs(rand: () => number): number {
  const span = PROVIDER_SLOT_WAIT_MAX_MS - PROVIDER_SLOT_WAIT_MIN_MS
  return PROVIDER_SLOT_WAIT_MIN_MS + Math.floor(rand() * (span + 1))
}

function abortError(): AgentCallError {
  return new AgentCallError("abort", "agent aborted: run stopping")
}

export interface ProviderPermit {
  /** Idempotent; releases the machine slot (if any) then the instance permit. */
  release(): Promise<void>
}

export interface ProviderLimiter {
  /**
   * Acquire one instance permit then one machine slot for `providerID`.
   * `cap` is the configured N (1..16). Abort-aware: on abort, nothing is held.
   */
  acquire(providerID: string, cap: number, signal?: AbortSignal): Promise<ProviderPermit>
}

export interface ProviderSlotPoolOptions {
  /** Slot tree root. Tests inject a temp dir; production uses defaultProviderSlotsDir(). */
  baseDir: string
  now?: () => number
  pid?: number
  heartbeatMs?: number
  staleMs?: number
  rand?: () => number
}

/**
 * One claimed slot dir. Heartbeat-touches mtime until release(); crash
 * simulation (`abandon`) stops the heartbeat and leaves the dir in place.
 */
export class ProviderSlotHold {
  readonly dir: string
  readonly providerID: string
  readonly index: number
  private readonly heartbeatMs: number
  private readonly pid: number
  private timer: ReturnType<typeof setInterval> | undefined
  private released = false

  constructor(dir: string, providerID: string, index: number, heartbeatMs: number, pid: number) {
    this.dir = dir
    this.providerID = providerID
    this.index = index
    this.heartbeatMs = heartbeatMs
    this.pid = pid
  }

  startHeartbeat(): void {
    if (this.heartbeatMs <= 0 || this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.touchIfOwned()
    }, this.heartbeatMs)
  }

  /**
   * Test helper: stop the heartbeat and forget the hold without removing the
   * dir (simulates a crash). A later `release()` is a no-op.
   */
  abandon(): void {
    this.stopHeartbeat()
    this.released = true
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.stopHeartbeat()
    // Only remove the dir when hold.json still names our pid: a stale reclaim
    // may have handed this path to another process, and deleting it would
    // drop the NEW holder's lock. Foreign pid (or unreadable metadata) → skip.
    if (!(await this.isOwned())) return
    await rm(this.dir, { recursive: true, force: true })
  }

  private async touchIfOwned(): Promise<void> {
    if (!(await this.isOwned())) return
    await utimes(this.dir, new Date(), new Date()).catch(() => {
      // Vanished dir or lost the race with a reclaim; next release checks pid.
    })
  }

  private async isOwned(): Promise<boolean> {
    try {
      const raw = await readFile(path.join(this.dir, "hold.json"), "utf8")
      const parsed = JSON.parse(raw) as { pid?: unknown }
      return parsed.pid === this.pid
    } catch {
      return false
    }
  }

  private stopHeartbeat(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }
}

/**
 * Cross-process slot pool. `claim` retries with 50–250 ms jitter until a slot
 * is mkdir'd or the abort signal fires.
 */
export class ProviderSlotPool {
  private readonly baseDir: string
  private readonly now: () => number
  private readonly pid: number
  private readonly heartbeatMs: number
  private readonly staleMs: number
  private readonly rand: () => number

  constructor(options: ProviderSlotPoolOptions) {
    this.baseDir = options.baseDir
    this.now = options.now ?? Date.now
    this.pid = options.pid ?? process.pid
    this.heartbeatMs = options.heartbeatMs ?? PROVIDER_SLOT_HEARTBEAT_MS
    this.staleMs = options.staleMs ?? PROVIDER_SLOT_STALE_MS
    this.rand = options.rand ?? Math.random
  }

  async claim(providerID: string, cap: number, signal?: AbortSignal): Promise<ProviderSlotHold> {
    if (!isSafeProviderID(providerID)) {
      throw new Error(`provider id is not a safe slot path segment: ${JSON.stringify(providerID)}`)
    }
    const n = clampProviderConcurrency(cap)
    const providerDir = path.join(this.baseDir, providerID)
    await mkdir(providerDir, { recursive: true })
    while (true) {
      if (signal?.aborted) throw abortError()
      for (let i = 0; i < n; i++) {
        if (signal?.aborted) throw abortError()
        const hold = await this.tryClaim(providerID, i)
        if (hold !== undefined) {
          if (signal?.aborted) {
            await hold.release()
            throw abortError()
          }
          return hold
        }
      }
      await delayAbortable(slotWaitMs(this.rand), signal)
    }
  }

  private async tryClaim(providerID: string, index: number): Promise<ProviderSlotHold | undefined> {
    const slotDir = path.join(this.baseDir, providerID, `slot-${index}`)
    const owned = await this.mkdirExclusive(slotDir)
    if (!owned) return undefined
    const hold = new ProviderSlotHold(slotDir, providerID, index, this.heartbeatMs, this.pid)
    try {
      await writeFile(
        path.join(slotDir, "hold.json"),
        JSON.stringify({ pid: this.pid, claimedAt: this.now() }),
      )
    } catch {
      // Metadata is informational; mkdir is the lock. Heartbeat still runs.
    }
    hold.startHeartbeat()
    return hold
  }

  /**
   * Atomic mkdir. EEXIST + stale mtime → rm and one retry. Any other EEXIST
   * (live holder, or lost the reclaim race) is "taken".
   */
  private async mkdirExclusive(slotDir: string): Promise<boolean> {
    try {
      await mkdir(slotDir)
      return true
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err
    }
    if (!(await this.isStale(slotDir))) return false
    // Re-verify immediately prior to rm: a concurrent reclaim can refresh
    // mtime in the isStale→rm window and we must not steal a live holder.
    if (!(await this.isStale(slotDir))) return false
    await rm(slotDir, { recursive: true, force: true })
    try {
      await mkdir(slotDir)
      return true
    } catch (err) {
      if (errCode(err) === "EEXIST") return false
      throw err
    }
  }

  private async isStale(slotDir: string): Promise<boolean> {
    try {
      const st = await stat(slotDir)
      return this.now() - st.mtimeMs > this.staleMs
    } catch (err) {
      if (errCode(err) === "ENOENT") return true
      return false
    }
  }
}

/**
 * Supervisor-owned limiter: one FIFO Semaphore per provider (shared across
 * every run this supervisor owns) plus the machine slot pool. First `cap`
 * observed for a provider wins as the semaphore limit (options are process-
 * level; in-flight runs keep their freezeEffective snapshot for whether to
 * acquire at all).
 */
export class ProviderConcurrencyGate implements ProviderLimiter {
  private readonly semaphores = new Map<string, Semaphore>()
  private readonly slotPool: ProviderSlotPool

  constructor(options: { slotPool: ProviderSlotPool }) {
    this.slotPool = options.slotPool
  }

  /** In-flight instance permits for a provider (0 if never acquired). */
  running(providerID: string): number {
    return this.semaphores.get(providerID)?.running ?? 0
  }

  queued(providerID: string): number {
    return this.semaphores.get(providerID)?.queued ?? 0
  }

  async acquire(providerID: string, cap: number, signal?: AbortSignal): Promise<ProviderPermit> {
    const n = clampProviderConcurrency(cap)
    let sem = this.semaphores.get(providerID)
    if (sem === undefined) {
      sem = new Semaphore(n)
      this.semaphores.set(providerID, sem)
    }
    await sem.acquire(signal)
    let hold: ProviderSlotHold | undefined
    const machine = isSafeProviderID(providerID)
    try {
      if (machine) hold = await this.slotPool.claim(providerID, n, signal)
    } catch (err) {
      sem.release()
      throw err
    }
    let released = false
    const permitSem = sem
    return {
      release: async () => {
        if (released) return
        released = true
        try {
          if (hold !== undefined) await hold.release()
        } finally {
          permitSem.release()
        }
      },
    }
  }
}
