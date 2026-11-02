/**
 * Optional capacity feed. The plugin works without any external command.
 *
 * Two command formats are supported:
 *  - `capacity-v1` (portable): `{ pools: [{ id, windows: [{ remainingPercent }], status?, expiresAt? }] }`
 *    — see docs/MODEL-ROUTING.md "Capacity feeds" for the checker contract.
 *  - `check-rate` (legacy): the author's private multi-provider usage dashboard;
 *    `parseQuotaSnapshot` knows a handful of provider payload shapes. Kept for
 *    existing configs; new setups should emit capacity-v1.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { RouteObservation } from "./model-routing.ts"

const run = promisify(execFile)

/**
 * Default wall-clock bound for one quota command invocation. `opencode2
 * check-rate --json` probes several provider consoles and takes 8–15 s cold
 * (observed 2026-10-20: a 5 s bound timed out every call, so every plans
 * candidate read "quota unknown" and fail-closed routing had nothing to run).
 */
export const DEFAULT_QUOTA_TIMEOUT_MS = 20_000

/**
 * How soon the next admission re-probes after a failed snapshot, or after a
 * timeout that reused a still-fresh last-good snapshot. Not the success TTL.
 */
const QUOTA_REPROBE_MS = 5_000

/** Why a feed reading is unknown, for operators' logs and the config CLI. */
export type QuotaFeedFailure = {
  /** spawn/exit/timeout/parse: the command did not yield a usable snapshot; missing-pool: it did, but not for this pool. */
  kind: "spawn" | "timeout" | "exit" | "parse" | "missing-pool"
  /** Pool id that was asked for (missing-pool only). */
  pool?: string
  /** Pool ids the checker did emit (missing-pool only) — the usual misconfiguration is a key/id mismatch. */
  emitted?: string[]
}
export type QuotaFeedError = (err: unknown, command: readonly string[], failure: QuotaFeedFailure) => void

function classify(err: unknown): QuotaFeedFailure["kind"] {
  const e = err as { killed?: boolean; signal?: string; code?: unknown; syscall?: string } | undefined
  if (e?.killed || e?.signal === "SIGTERM") return "timeout"
  if (e?.syscall === "spawn" || e?.code === "ENOENT" || e?.code === "EACCES") return "spawn"
  if (typeof e?.code === "number") return "exit"
  return "parse"
}

export function parseQuotaSnapshot(parsed: { providers?: Array<{ id?: string; kind?: string; raw?: unknown }> }): Map<string, RouteObservation> {
  const result = new Map<string, RouteObservation>()
  for (const provider of parsed.providers ?? []) {
    if (!provider.id || provider.kind !== "live" || !provider.raw || typeof provider.raw !== "object") continue
    const raw = provider.raw as Record<string, any>
    let used: number[] = []
    if (provider.id === "openai") {
      used = [raw.rateLimits?.primary?.usedPercent, raw.rateLimits?.secondary?.usedPercent].filter(Number.isFinite)
      if (raw.ordinaryUsageAllowed === false || raw.rateLimits?.spendControlReached === true) used.push(100)
    } else if (provider.id === "xai") {
      used = [raw.creditUsagePercent].filter(Number.isFinite)
    } else if (provider.id === "zai-coding-plan") {
      used = (raw.limits ?? []).map((x: { percentage?: number }) => x.percentage).filter(Number.isFinite)
    } else if (provider.id === "alibaba-token-plan") {
      // Console's per1MonthPercentage is normalized by check-rate to raw.monthly.pct.
      // Older plans can also carry weekly/five-hour windows. A harness-quota
      // item is not an account-wide budget.
      if (!Array.isArray(provider.raw)) used = Object.values(raw)
        .map((window: any) => window?.pct)
        .filter(Number.isFinite)
    }
    if (used.length) result.set(provider.id, { remainingPercent: Math.max(0, 100 - Math.max(...used)) })
  }
  return result
}

/** Portable command output: { pools: [{ id, windows: [{ remainingPercent }] }] }.
 * Multiple windows take the tightest remaining capacity. Stale/invalid output
 * remains unknown; it never gets interpreted as an unlimited subscription.
 */
export function parseCapacitySnapshot(raw: unknown): Map<string, RouteObservation> {
  const pools = new Map<string, RouteObservation>()
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { pools?: unknown }).pools)) return pools
  for (const pool of (raw as { pools: unknown[] }).pools) {
    if (!pool || typeof pool !== "object") continue
    const p = pool as { id?: unknown; windows?: unknown; status?: unknown; expiresAt?: unknown }
    if (typeof p.id !== "string" || !p.id || (p.status !== undefined && p.status !== "ok") || !Array.isArray(p.windows) || !p.windows.length) continue
    if (p.expiresAt !== undefined && (typeof p.expiresAt !== "string" || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.expiresAt) <= Date.now())) continue
    const values = p.windows.map((w: unknown) => w && typeof w === "object" ? (w as { remainingPercent?: unknown }).remainingPercent : undefined)
    if (values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) continue
    pools.set(p.id, { remainingPercent: Math.min(...values as number[]) })
  }
  return pools
}

export function commandQuotaFeed(
  command: readonly string[],
  ttlMs = 60_000,
  format: "check-rate" | "capacity-v1" = "check-rate",
  timeoutMs = DEFAULT_QUOTA_TIMEOUT_MS,
  onError?: QuotaFeedError,
  // Test clock. Production callers omit this; age and expiry use Date.now.
  now: () => number = Date.now,
): (id: string) => Promise<RouteObservation | undefined> {
  type Snapshot = { pools: Map<string, RouteObservation>; failed: boolean }
  let expires = 0
  let pending: Promise<Snapshot> | undefined
  let retry: Promise<Snapshot> | undefined
  let missing = new Set<string>()
  // One report per feed per TTL window: a dead checker is re-polled every 5 s
  // while unknown, and an operator needs one line, not a log flood.
  let lastReportAt = 0
  // Last successful command output, including a parsed remainingPercent of 0.
  // seq is the fetch start order so a confirmed zero is never overwritten by an older positive.
  let lastGood: { pools: Map<string, RouteObservation>; fetchedAt: number; seq: number } | undefined
  let fetchSeq = 0
  const report = (err: unknown, failure: QuotaFeedFailure): void => {
    if (!onError || now() - lastReportAt < ttlMs) return
    lastReportAt = now()
    try { onError(err, command, failure) } catch { /* reporter must never break routing */ }
  }
  const fetch = async (): Promise<Snapshot> => {
    const seq = ++fetchSeq
    try {
      const { stdout } = await run(command[0]!, command.slice(1), { timeout: timeoutMs, maxBuffer: 1_000_000 })
      const parsed = JSON.parse(stdout) as { providers?: Array<{ id?: string; kind?: string; raw?: unknown }> }
      const pools = format === "capacity-v1" ? parseCapacitySnapshot(parsed) : parseQuotaSnapshot(parsed)
      if (!lastGood || seq >= lastGood.seq) lastGood = { pools, fetchedAt: now(), seq }
      return { pools, failed: false }
    } catch (err) {
      // Missing command, non-zero exit, malformed result: quota is unknown
      // (never unlimited). A timeout may reuse a snapshot younger than ttlMs.
      // Age is measured when the timeout fires, not when the fetch started.
      // classify() treats SIGTERM/killed as timeout, so an operator kill can
      // reuse last-good within ttlMs. Accepted — do not special-case it.
      const kind = classify(err)
      report(err, { kind })
      const good = lastGood
      if (kind === "timeout" && good && now() - good.fetchedAt < ttlMs) {
        // Overwrite the ttlMs expiry armed at fetch start so the next admission
        // re-probes within 5s. Pools ride this resolved snapshot so concurrent
        // waiters share them; failed skips the missing-pool retry.
        expires = now() + QUOTA_REPROBE_MS
        return { pools: good.pools, failed: true }
      }
      return { pools: new Map(), failed: true }
    }
  }
  return async (id) => {
    if (!pending || now() >= expires) {
      expires = now() + ttlMs
      pending = fetch()
      retry = undefined
      missing = new Set()
    }
    const snapshot = await pending
    if (snapshot.pools.has(id)) return snapshot.pools.get(id)
    missing.add(id)
    if (snapshot.failed) {
      // The command itself failed: running it again right away would only cost a
      // second timeout and a second report. Unknown for this snapshot; re-poll soon.
      expires = Math.min(expires, now() + QUOTA_REPROBE_MS)
      return undefined
    }
    // A partial snapshot is unknown, not zero. Retry once per shared snapshot so
    // simultaneous children don't stampede the quota endpoint. Never use a
    // previous positive reading in place of a confirmed zero or a still-unknown result.
    if (!retry) {
      const original = pending
      retry = fetch().then((fresh) => {
        if (pending === original) {
          // Keep known readings from the first snapshot if only one pool
          // failed on the retry. Unknowns get a short TTL, not a full minute.
          pending = Promise.resolve({ pools: new Map([...snapshot.pools, ...fresh.pools]), failed: false })
          if ([...missing].some((pool) => !fresh.pools.has(pool) && !snapshot.pools.has(pool))) {
            expires = Math.min(expires, now() + QUOTA_REPROBE_MS)
          }
        }
        return fresh
      })
    }
    const fresh = await retry
    if (!fresh.pools.has(id)) {
      expires = Math.min(expires, now() + QUOTA_REPROBE_MS)
      if (!fresh.failed) {
        const emitted = [...new Set([...snapshot.pools.keys(), ...fresh.pools.keys()])]
        report(new Error(`capacity checker ran but emitted no pool "${id}" (emitted: ${emitted.length ? emitted.join(", ") : "none"})`), { kind: "missing-pool", pool: id, emitted })
      }
    }
    return fresh.pools.get(id) ?? snapshot.pools.get(id)
  }
}

export function capacityFeed(options: {
  quotaCommand?: string[] | null
  quotaSources?: Record<string, { command: string[]; format: "capacity-v1" | "check-rate" }>
  quotaTimeoutMs?: number
}, onError?: QuotaFeedError): (id: string) => Promise<RouteObservation | undefined> {
  const timeoutMs = options.quotaTimeoutMs ?? DEFAULT_QUOTA_TIMEOUT_MS
  const legacy = options.quotaCommand ? commandQuotaFeed(options.quotaCommand, 60_000, "check-rate", timeoutMs, onError) : undefined
  // One checker process per distinct (format, command), however many pool ids it
  // serves: a checker emitting five pools under five quotaSources keys runs once
  // per TTL, not five times.
  const shared = new Map<string, (id: string) => Promise<RouteObservation | undefined>>()
  const sources = new Map(Object.entries(options.quotaSources ?? {}).map(([id, source]) => {
    const key = JSON.stringify([source.format, source.command])
    let feed = shared.get(key)
    if (!feed) { feed = commandQuotaFeed(source.command, 60_000, source.format, timeoutMs, onError); shared.set(key, feed) }
    return [id, feed] as const
  }))
  return (id) => sources.get(id)?.(id) ?? legacy?.(id) ?? Promise.resolve(undefined)
}
