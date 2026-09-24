/** Optional quota feed. The plugin works without any external command. */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { RouteObservation } from "./model-routing.ts"

const run = promisify(execFile)

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

export function commandQuotaFeed(command: readonly string[], ttlMs = 60_000, format: "check-rate" | "capacity-v1" = "check-rate"): (id: string) => Promise<RouteObservation | undefined> {
  let expires = 0
  let pending: Promise<Map<string, RouteObservation>> | undefined
  const fetch = async (): Promise<Map<string, RouteObservation>> => {
    try {
      const { stdout } = await run(command[0]!, command.slice(1), { timeout: 5_000, maxBuffer: 1_000_000 })
      const parsed = JSON.parse(stdout) as { providers?: Array<{ id?: string; kind?: string; raw?: unknown }> }
      return format === "capacity-v1" ? parseCapacitySnapshot(parsed) : parseQuotaSnapshot(parsed)
    } catch { /* missing command, expired login, malformed result: quota unknown */ }
    return new Map()
  }
  return async (id) => {
    if (!pending || Date.now() >= expires) {
      expires = Date.now() + ttlMs
      pending = fetch()
    }
    return (await pending).get(id)
  }
}

export function capacityFeed(options: {
  quotaCommand?: string[] | null
  quotaSources?: Record<string, { command: string[]; format: "capacity-v1" | "check-rate" }>
}): (id: string) => Promise<RouteObservation | undefined> {
  const legacy = options.quotaCommand ? commandQuotaFeed(options.quotaCommand) : undefined
  const sources = new Map(Object.entries(options.quotaSources ?? {}).map(([id, source]) =>
    [id, commandQuotaFeed(source.command, 60_000, source.format)] as const))
  return (id) => sources.get(id)?.(id) ?? legacy?.(id) ?? Promise.resolve(undefined)
}
