/**
 * Shared run-inspect cell values (plugin-free, no markdown). Surfaces render.
 *
 * Agent row order (D11): status, ord+label, phase, agent, model, ctx, tools.
 * `ctx` is the statusline-style CURRENT REQUEST CONTEXT (input + cache read +
 * write of the child's last completed request) — the same quantity the
 * childLimits guard caps, so the table and the cap finally speak one metric.
 * Cumulative per-child spend stays visible in detail panes / settle notices.
 */
import type { AgentRecord, RunRecord, TokenUsage } from "./types.ts"
import { countAgents } from "./types.ts"

/** Compact a non-negative count: 42, 42.6k, 1.5M. */
export function compactCount(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  const [div, suffix] = abs < 1_000_000 ? [1000, "k"] : [1_000_000, "M"]
  const v = n / div
  const digits = abs / div >= 100 ? 0 : 1
  return `${v.toFixed(digits).replace(/\.0$/, "")}${suffix}`
}

/** Sum of input+output+reasoning, compacted. Missing tokens → "-". */
export function compactTokens(tokens?: TokenUsage | null): string {
  if (!tokens) return "-"
  return compactCount(tokens.input + tokens.output + tokens.reasoning)
}

/** Wall-clock duration: 120ms, 1.5s, 3m 4s. */
export function compactElapsed(ms: number): string {
  const n = Math.max(0, ms)
  if (n < 1000) return `${Math.round(n)}ms`
  if (n < 60_000) {
    const s = n / 1000
    return `${s.toFixed(s >= 10 ? 0 : 1).replace(/\.0$/, "")}s`
  }
  const minutes = Math.floor(n / 60_000)
  const seconds = Math.round((n % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function agentCells(a: AgentRecord): string[] {
  const ordLabel = a.label ? `${a.id} ${a.label}` : a.id
  const phase = a.phase ?? "-"
  const agent = a.effectiveAgent || a.requestedAgent || "-"
  // A failed child that never ran still shows the model it targeted; when
  // something else actually ran (tier-aware failover / quarantine routing),
  // the intended spawn is named too. An explicit-model child that waited for
  // its window never drifts, so this stays quiet for it.
  const shown = a.effectiveModel ?? a.spawnModel
  let model = shown != null ? `${shown.providerID}/${shown.id}` : "-"
  if (
    a.effectiveModel != null &&
    a.spawnModel != null &&
    (a.spawnModel.providerID !== a.effectiveModel.providerID || a.spawnModel.id !== a.effectiveModel.id)
  ) {
    model += ` (spawn: ${a.spawnModel.providerID}/${a.spawnModel.id})`
  }
  const ctx = a.contextTokens !== undefined && Number.isFinite(a.contextTokens) ? compactCount(a.contextTokens) : "-"
  const tools = a.toolCalls === undefined ? "-" : String(a.toolCalls)
  return [a.status, ordLabel, phase, agent, model, ctx, tools]
}

/**
 * Run header cells: name, description (omitted when absent), "n/m agents", elapsed.
 * n = succeeded agents, m = total spawned.
 */
export function runHeaderCells(run: RunRecord, now = Date.now()): string[] {
  const name = run.name ?? run.workflowName ?? run.id
  const counts = countAgents(run)
  const elapsed = compactElapsed((run.endedAt ?? now) - run.startedAt)
  const cells = [name]
  if (run.meta?.description) cells.push(run.meta.description)
  cells.push(`${counts.succeeded}/${counts.total} agents`, elapsed)
  return cells
}
