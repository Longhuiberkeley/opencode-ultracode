/**
 * Machine-wide provider quarantine markers.
 *
 * WHY: quota is account-level, and one user routinely drives SEVERAL opencode
 * processes in parallel (one per project/lane). The in-process ProviderBreaker
 * (supervisor.ts) is deliberately authoritative for its own process, but on
 * 2026-09-24 four boots each independently re-discovered the same dead xai
 * provider — every one of them spawned children onto it, burned failed turns,
 * and re-classified the same quota error. This module publishes the knowledge
 * ONE of them learned to the shared ultracode data dir, next to the provider
 * slot dirs, so siblings stop re-learning it.
 *
 * Design constraints (from the breaker's own history: persistence was
 * originally rejected because it "resurrects hours-old strikes"):
 * - Every marker carries a bounded `until` epoch-ms. Estimated quarantines
 *   (no provider-reported reset) cap at the breaker TTL (default 30 min), so
 *   a stale marker can never outlive a real window reopen by hours.
 * - Reads ignore+delete expired or malformed markers; a marker is advice, not
 *   law: the in-memory breaker stays authoritative for its own process.
 * - Writes are atomic (tmp + rename) and MERGE: the surviving marker is the
 *   LATER `until` of (existing, incoming) — a stale writer can shorten a
 *   fresh observation only when the existing marker is estimated AND the
 *   incoming `until` is a provider-REPORTED reset (mirrors the breaker's own
 *   reported-reset-beats-estimate rule).
 * - All I/O is async and fire-and-forget from report paths; failures are
 *   swallowed (markers are an optimization, never a dependency).
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isSafeProviderID } from "./provider-slots.ts"

export const PROVIDER_QUARANTINE_DIR_NAME = "provider-quarantine"

/** Cap on an ESTIMATED (no reported reset) marker, matching the breaker TTL default. */
export const PROVIDER_QUARANTINE_ESTIMATED_CAP_MS = 30 * 60_000

export interface QuarantineMarker {
  providerID: string
  /** Epoch ms after which the marker is ignored (always finite). */
  until: number
  /** True when `until` is a TTL re-probe estimate, not a provider-reported reset. */
  estimated: boolean
  /** Writing pid — diagnostics only. */
  pid: number
  /** Epoch ms of the observation that produced this marker. */
  observedAt: number
}

export function defaultProviderQuarantineDir(): string {
  return path.join(os.homedir(), ".local/share/opencode/ultracode", PROVIDER_QUARANTINE_DIR_NAME)
}

function markerPath(dir: string, providerID: string): string {
  return path.join(dir, `${providerID}.json`)
}

function parseMarker(raw: string, providerID: string): QuarantineMarker | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (typeof value.until !== "number" || !Number.isFinite(value.until)) return undefined
    return {
      providerID,
      until: value.until,
      estimated: value.estimated === true,
      pid: typeof value.pid === "number" ? value.pid : 0,
      observedAt: typeof value.observedAt === "number" ? value.observedAt : 0,
    }
  } catch {
    return undefined
  }
}

/** Read one provider's marker; undefined when absent, expired or malformed. */
export async function readQuarantineMarker(dir: string, providerID: string, now: number = Date.now()): Promise<QuarantineMarker | undefined> {
  if (!isSafeProviderID(providerID)) return undefined
  let raw: string
  try {
    raw = await readFile(markerPath(dir, providerID), "utf8")
  } catch {
    return undefined
  }
  const marker = parseMarker(raw, providerID)
  if (marker === undefined || marker.until <= now) {
    void clearQuarantineMarker(dir, providerID)
    return undefined
  }
  return marker
}

/** Read every live marker in the dir (expired/malformed entries are pruned best-effort). */
export async function readAllQuarantineMarkers(dir: string, now: number = Date.now()): Promise<Map<string, QuarantineMarker>> {
  const out = new Map<string, QuarantineMarker>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return out
  }
  await Promise.all(names
    .filter((name) => name.endsWith(".json"))
    .map(async (name) => {
      const providerID = name.slice(0, -".json".length)
      if (!isSafeProviderID(providerID)) return
      const marker = await readQuarantineMarker(dir, providerID, now)
      if (marker !== undefined) out.set(providerID, marker)
    }))
  return out
}

/**
 * Publish (or merge) a quarantine observation. Estimated observations are
 * capped so a crashed writer can never pin a provider for hours. Never
 * throws: call sites fire-and-forget.
 */
export async function writeQuarantineMarker(input: {
  dir: string
  providerID: string
  until: number
  estimated: boolean
  now?: number
}): Promise<void> {
  const now = input.now ?? Date.now()
  if (!isSafeProviderID(input.providerID)) return
  if (!Number.isFinite(input.until)) return
  let until = input.until
  let estimated = input.estimated
  if (estimated) {
    const cap = now + PROVIDER_QUARANTINE_ESTIMATED_CAP_MS
    if (!Number.isFinite(until) || until > cap) until = cap
  }
  const existing = await readQuarantineMarker(input.dir, input.providerID, now)
  if (existing !== undefined) {
    // Later deadline wins, EXCEPT a reported reset may replace an estimate
    // even when earlier (the estimate can overshoot the real reopen).
    const replace = existing.estimated && !estimated
    if (!replace && existing.until >= until) return
  }
  const marker: QuarantineMarker = { providerID: input.providerID, until, estimated, pid: process.pid, observedAt: now }
  try {
    await mkdir(input.dir, { recursive: true })
    const file = markerPath(input.dir, input.providerID)
    const tmp = `${file}.tmp-${process.pid}-${now}`
    await writeFile(tmp, JSON.stringify(marker), "utf8")
    await rename(tmp, file)
  } catch {
    // best-effort only
  }
}

/** Remove a marker (expiry, provider recovery). Never throws. */
export async function clearQuarantineMarker(dir: string, providerID: string): Promise<void> {
  if (!isSafeProviderID(providerID)) return
  try {
    await rm(markerPath(dir, providerID), { force: true })
  } catch {
    // best-effort only
  }
}
