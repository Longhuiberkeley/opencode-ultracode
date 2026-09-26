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
 * A heartbeat age alone cannot tell them apart seconds after a crash. This
 * module publishes one small marker per boot into the shared ultracode data
 * dir (beside provider-quarantine), written at plugin setup, refreshed
 * opportunistically on run persists (throttled), and REMOVED on graceful
 * dispose. Reconciliation then reads: a boot with a live marker owns its
 * runs; a missing marker (graceful shutdown, or predates this feature)
 * means dead — exactly the legacy behavior.
 *
 * Same contract style as provider-quarantine: atomic tmp+rename writes,
 * best-effort I/O that never throws into callers, markers are advice the
 * sync registry probe reads at startup only. A hard crash leaves the marker
 * until its TTL lapses; such runs show "running + stale" (heartbeat badge)
 * until the 30-minute orphan heartbeat flips them.
 */
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const OWNER_LIVENESS_DIR_NAME = "owner-liveness"

/**
 * A marker older than this is not evidence of a live owner. MUST exceed the
 * registry's 30-minute orphan-heartbeat window (RegistryImpl
 * ORPHAN_HEARTBEAT_MS): markers refresh only on run persists, so an
 * idle-but-live child between 10 and 30 minutes must still read as alive —
 * the heartbeat, not the marker, is the binding clock. A shorter TTL here
 * would let a sibling interrupt a run whose owner heartbeat is well inside
 * the orphan window.
 */
export const OWNER_LIVENESS_TTL_MS = 35 * 60_000

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
 * Sync liveness probe for reconcileOrphans (startup only): true when the boot
 * has a marker younger than ttlMs. Unsafe boot ids read as not alive. Read
 * failures read as not alive — the legacy flip-on-restart path is the safe
 * default.
 */
export function ownerAliveProbe(dir: string = defaultOwnerLivenessDir(), ttlMs: number = OWNER_LIVENESS_TTL_MS, now: number = Date.now()): (bootID: string) => boolean {
  const cache = new Map<string, boolean>()
  return (bootID: string): boolean => {
    if (!isSafeBootID(bootID)) return false
    const cached = cache.get(bootID)
    if (cached !== undefined) return cached
    let alive = false
    try {
      const file = markerPath(dir, bootID)
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as { at?: unknown }
        alive = typeof raw.at === "number" && Number.isFinite(raw.at) && now - raw.at <= ttlMs
      }
    } catch {
      alive = false
    }
    cache.set(bootID, alive)
    return alive
  }
}
