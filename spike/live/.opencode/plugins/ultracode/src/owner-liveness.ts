/**
 * Machine-wide owner-liveness markers.
 *
 * WHY: reconcileOrphans() must distinguish two shapes of "a persisted run
 * whose owner.bootID is not this process":
 *  - the owner process is STILL RUNNING in another lane (multi-project /
 *    multi-conversation setups) — the run must be adopted as-is, or a
 *    restart in one lane would write a terminal "interrupted" record over a
 *    live run and shadow the owner's updates in every panel; and
 *  - the owner process is DEAD (crash/restart of the only process on the
 *    project) — the run must flip to interrupted, the historical
 *    "flip on restart" crash-recovery semantics.
 *
 * A heartbeat age alone cannot tell them apart seconds after a crash — and
 * neither can a marker file alone, because a SIGKILL leaves it behind. This
 * module publishes one small marker per boot into the shared ultracode data
 * dir (beside provider-quarantine), written at plugin setup, refreshed on a
 * fixed heartbeat timer AND opportunistically on run persists (throttled),
 * and REMOVED on graceful dispose. Each marker carries the boot's pid, so a
 * fresh marker belonging to a dead process reads `dead-pid` immediately
 * instead of masquerading as alive until the TTL lapses.
 *
 * Same contract style as provider-quarantine: atomic tmp+rename writes,
 * best-effort I/O that never throws into callers, markers are advice the
 * sync registry probe reads at reconcile time (startup AND periodic). A hard
 * crash leaves the marker, but the pid check flips the run on the first
 * reconcile pass after restart; pid reuse is bounded by the marker TTL.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const OWNER_LIVENESS_DIR_NAME = "owner-liveness"

/**
 * Richer verdict for one boot's marker, consumed by orphan reconciliation:
 * - `alive-pid`   — marker fresh AND its pid is running: the strongest live
 *   signal; it OVERRIDES a stale run heartbeat (an owner with one long silent
 *   child is alive, not orphaned).
 * - `alive-marker` — marker fresh but the pid is unknown/uncheckable (legacy
 *   marker without pid, EPERM): alive unless the run heartbeat also went
 *   stale beyond the registry's orphan window.
 * - `dead-pid`    — marker fresh but the pid is provably gone (ESRCH): the
 *   owner was SIGKILLed and the marker simply outlived it. Reconciliation may
 *   flip immediately — no heartbeat grace needed.
 * - `dead`        — no marker (graceful dispose / predates the feature),
 *   stale marker, malformed marker, or unsafe boot id.
 */
export type OwnerBootLiveness = "alive-pid" | "alive-marker" | "dead-pid" | "dead"

/**
 * Is a pid running? `process.kill(pid, 0)` semantics: ESRCH ⇒ not running;
 * EPERM ⇒ running but not signalable by us (still alive). Returns undefined
 * for a missing/invalid pid — callers decide their own fallback (the marker
 * stays `alive-marker`, never a false `dead`). PID REUSE is possible after the
 * original dies; the marker TTL bounds how long a recycled pid can vouch for
 * a dead boot.
 */
export function pidAlive(pid: unknown): boolean | undefined {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true
    return false // ESRCH — and anything else — reads as not running
  }
}

/**
 * A marker older than this is not evidence of a live owner. MUST exceed the
 * registry's 30-minute orphan-heartbeat window (RegistryImpl
 * ORPHAN_HEARTBEAT_MS): markers refresh on the heartbeat timer and run
 * persists, so an idle-but-live child between 10 and 30 minutes must still
 * read as alive — the heartbeat, not the marker, is the binding clock for
 * pid-less markers. A shorter TTL here would let a sibling interrupt a run
 * whose owner heartbeat is well inside the orphan window.
 */
export const OWNER_LIVENESS_TTL_MS = 35 * 60_000

/**
 * Owner heartbeat cadence: refresh this boot's marker AND every active run's
 * `owner.updatedAt` on this timer, independent of child progress. Before this
 * existed both refreshed only on run persists, so one legitimately silent
 * long-running child starved the heartbeat and live owners rendered "stale".
 */
export const OWNER_HEARTBEAT_INTERVAL_MS = 60_000

/** Refresh piggyback throttle: persist paths may fire many times a second. */
const REFRESH_THROTTLE_MS = 30_000

export function defaultOwnerLivenessDir(): string {
  return path.join(os.homedir(), ".local/share/opencode/ultracode", OWNER_LIVENESS_DIR_NAME)
}

/** boot ids are `boot_<base36>`; keep the filename surface tight. */
export function isSafeBootID(bootID: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(bootID)
}

function markerPath(dir: string, bootID: string): string {
  return path.join(dir, `${bootID}.json`)
}
export { markerPath }

let lastWriteAt = 0
let lastWriteBoot: string | undefined

/** Sequence for unique tmp filenames — concurrent fire-and-forget writes in
 * one process must never share a tmp path (rename races corrupt markers). */
let tmpSeq = 0

/** Boots whose marker was removed at dispose: a late in-flight refresh must
 * not resurrect a disposed boot's marker. */
const removedBoots = new Set<string>()

/** Write/refresh this boot's marker. Fire-and-forget safe; never throws. */
export function writeOwnerLiveness(bootID: string, dir: string = defaultOwnerLivenessDir(), now: number = Date.now()): void {
  if (!isSafeBootID(bootID) || removedBoots.has(bootID)) return
  const seq = ++tmpSeq
  void (async () => {
    try {
      await mkdir(dir, { recursive: true })
      if (removedBoots.has(bootID)) return // disposed while this write was queued
      const file = markerPath(dir, bootID)
      const tmp = `${file}.${process.pid}.${seq}.tmp`
      await writeFile(tmp, JSON.stringify({ bootID, pid: process.pid, at: now }), "utf8")
      await rename(tmp, file)
    } catch {
      // best effort — liveness markers are an optimization, never a dependency
    }
  })()
}

/**
 * Throttled refresh for persist piggyback: at most one write per
 * REFRESH_THROTTLE_MS per boot. Returns without touching the disk while
 * throttled.
 */
export function maybeRefreshOwnerLiveness(bootID: string, dir: string = defaultOwnerLivenessDir(), now: number = Date.now()): void {
  if (bootID === lastWriteBoot && now - lastWriteAt < REFRESH_THROTTLE_MS) return
  lastWriteAt = now
  lastWriteBoot = bootID
  writeOwnerLiveness(bootID, dir, now)
}

/** Remove this boot's marker (graceful dispose). Never throws. Also gates
 * future writes for the boot, so an in-flight refresh cannot resurrect the
 * marker after disposal. */
export function removeOwnerLiveness(bootID: string, dir: string = defaultOwnerLivenessDir()): void {
  if (!isSafeBootID(bootID)) return
  removedBoots.add(bootID)
  void rm(markerPath(dir, bootID), { force: true }).catch(() => {})
}

/**
 * Sync liveness probe for orphan reconciliation: reads the marker fresh (with
 * a short per-boot verdict cache) and consults the pid when the marker carries
 * one. See {@link OwnerBootLiveness} for the verdict semantics. Unsafe boot
 * ids and read failures read as dead — the legacy flip-on-restart path is the
 * safe default.
 *
 * `nowFn` advances per call (unlike the frozen number in the legacy boolean
 * probe) so ONE probe instance serves a periodic reconciler; verdicts cache
 * for at most PROBE_CACHE_MS so a boot that dies between ticks is seen.
 */
export function ownerLivenessProbe(
  dir: string = defaultOwnerLivenessDir(),
  ttlMs: number = OWNER_LIVENESS_TTL_MS,
  nowFn: () => number = Date.now,
): (bootID: string) => OwnerBootLiveness {
  const cache = new Map<string, { at: number; verdict: OwnerBootLiveness }>()
  return (bootID: string): OwnerBootLiveness => {
    if (!isSafeBootID(bootID)) return "dead"
    const now = nowFn()
    const cached = cache.get(bootID)
    if (cached !== undefined && now - cached.at <= PROBE_CACHE_MS) return cached.verdict
    let verdict: OwnerBootLiveness = "dead"
    try {
      const file = markerPath(dir, bootID)
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; at?: unknown }
        const at = raw.at
        if (typeof at === "number" && Number.isFinite(at) && now - at <= ttlMs) {
          const alive = pidAlive(raw.pid)
          verdict = alive === undefined ? "alive-marker" : alive ? "alive-pid" : "dead-pid"
        }
      }
    } catch {
      verdict = "dead"
    }
    cache.set(bootID, { at: now, verdict })
    return verdict
  }
}

/** Verdict-cache window: a dead boot must be visible within this + one tick. */
export const PROBE_CACHE_MS = 5_000

/**
 * Legacy boolean probe: true for any alive verdict. Kept for existing callers
 * and tests; delegates to {@link ownerLivenessProbe} (fresh cache included).
 */
export function ownerAliveProbe(
  dir: string = defaultOwnerLivenessDir(),
  ttlMs: number = OWNER_LIVENESS_TTL_MS,
  now: number = Date.now(),
): (bootID: string) => boolean {
  const probe = ownerLivenessProbe(dir, ttlMs, () => now)
  return (bootID: string): boolean => {
    const verdict = probe(bootID)
    return verdict === "alive-pid" || verdict === "alive-marker"
  }
}
