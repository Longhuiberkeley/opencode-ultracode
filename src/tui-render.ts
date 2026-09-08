/**
 * Pure TUI inspect helpers — plugin-free and JSX-free.
 *
 * Grouping uses the title contract (`parseChildTitle`). Cell values come from
 * `run-format.agentCells` (D11); this module only swaps the status cell for a
 * status dot.
 */
import { parseChildTitle } from "./sessions.ts"
import { agentCells, compactElapsed } from "./run-format.ts"
import type { AgentRecord, AgentStatus, TokenUsage } from "./types.ts"

const VERSION_RE = /^v?0\.0\.0-beta-(\d+)$/

/** Status dots chosen by the TUI surface (status string still lives in agentCells). */
export const STATUS_DOT: Record<AgentStatus, string> = {
  running: "●",
  succeeded: "✓",
  failed: "✗",
  pending: "○",
  interrupted: "○",
}

export type SessionView = {
  id: string
  title: string
  outcome?: string
  tokens?: TokenUsage | null
  time?: number | { created?: number; updated?: number; idle?: number }
}

export type RunAgentView = {
  sessionID: string
  ord?: string
  phase?: string
  label?: string
  status: AgentStatus
  tokens?: TokenUsage
  title: string
}

export type RunView = {
  runID: string
  agents: RunAgentView[]
  phases: string[]
  counts: { total: number; done: number; failed: number }
  startedAt: number
  settled: boolean
}

export type PhaseColumn = { phase: string; done: number; total: number }

export type SettlePrev = {
  fingerprint: string
  lastChangeAt: number
  fired: boolean
}

export type Page<T> = { window: T[]; label: string }

/**
 * Strict gate: channel must be `beta`, version must parse as
 * `v0.0.0-beta-NNNNN` (leading `v` optional), and NNNNN >= minBuild.
 * Unknown / malformed / other channels → false.
 */
export function shouldEnableTui(version: string, channel: string | undefined, minBuild: number): boolean {
  if (channel !== "beta") return false
  const m = VERSION_RE.exec(version.trim())
  if (!m) return false
  const build = Number(m[1])
  if (!Number.isFinite(build)) return false
  return build >= minBuild
}

export function outcomeToStatus(outcome: string | undefined): AgentStatus {
  if (outcome === undefined || outcome === "") return "running"
  if (outcome === "succeeded") return "succeeded"
  if (outcome === "interrupted") return "interrupted"
  if (outcome === "pending") return "pending"
  return "failed"
}

export function isFinalStatus(status: AgentStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "interrupted"
}

function createdAt(time: SessionView["time"]): number | undefined {
  if (typeof time === "number" && Number.isFinite(time)) return time
  if (time && typeof time === "object" && typeof time.created === "number") return time.created
  return undefined
}

function ordSortKey(ord: string | undefined, index: number): [number, number, number] {
  if (ord === undefined || ord === "") return [1, index, 0]
  const m = /^a(\d+)$/i.exec(ord)
  if (m) return [0, Number(m[1]), 0]
  return [1, index, 0]
}

/**
 * Join `[uc:…]` child sessions by runID. Non-uc titles are ignored.
 * Phases are the observed first-appearance order (no declared meta.phases).
 */
export function groupRuns(sessions: SessionView[]): RunView[] {
  const buckets = new Map<string, { agents: RunAgentView[]; order: number }>()
  let seen = 0
  for (const session of sessions) {
    const parsed = parseChildTitle(session.title)
    if (!parsed?.runID) continue
    const status = outcomeToStatus(session.outcome)
    const agent: RunAgentView = {
      sessionID: session.id,
      ord: parsed.ord,
      phase: parsed.phase,
      label: parsed.label,
      status,
      tokens: session.tokens ?? undefined,
      title: session.title,
    }
    let bucket = buckets.get(parsed.runID)
    if (!bucket) {
      bucket = { agents: [], order: seen++ }
      buckets.set(parsed.runID, bucket)
    }
    bucket.agents.push(agent)
  }

  const runs: RunView[] = []
  for (const [runID, bucket] of buckets) {
    const indexed = bucket.agents.map((a, i) => ({ a, i }))
    indexed.sort((x, y) => {
      const ka = ordSortKey(x.a.ord, x.i)
      const kb = ordSortKey(y.a.ord, y.i)
      return ka[0] - kb[0] || ka[1] - kb[1] || x.i - y.i
    })
    const agents = indexed.map((x) => x.a)
    const phases: string[] = []
    for (const a of agents) {
      if (a.phase && !phases.includes(a.phase)) phases.push(a.phase)
    }
    let done = 0
    let failed = 0
    let startedAt = Number.POSITIVE_INFINITY
    for (const a of agents) {
      if (isFinalStatus(a.status)) done++
      if (a.status === "failed") failed++
    }
    for (const session of sessions) {
      const parsed = parseChildTitle(session.title)
      if (parsed?.runID !== runID) continue
      const t = createdAt(session.time)
      if (t !== undefined && t < startedAt) startedAt = t
    }
    if (!Number.isFinite(startedAt)) startedAt = 0
    const settled = agents.length > 0 && agents.every((a) => isFinalStatus(a.status))
    runs.push({
      runID,
      agents,
      phases,
      counts: { total: agents.length, done, failed },
      startedAt,
      settled,
    })
  }
  runs.sort((a, b) => {
    const oa = buckets.get(a.runID)?.order ?? 0
    const ob = buckets.get(b.runID)?.order ?? 0
    return oa - ob
  })
  return runs
}

export function phaseColumns(runView: RunView): PhaseColumn[] {
  return runView.phases.map((phase) => {
    const inPhase = runView.agents.filter((a) => a.phase === phase)
    return {
      phase,
      done: inPhase.filter((a) => isFinalStatus(a.status)).length,
      total: inPhase.length,
    }
  })
}

function toAgentRecord(a: RunAgentView): AgentRecord {
  return {
    id: a.ord ?? "?",
    label: a.label,
    phase: a.phase,
    status: a.status,
    tokens: a.tokens,
    sessionID: a.sessionID,
  }
}

/** D11 cells with status replaced by a status dot. Optional phase filter. */
export function agentRows(runView: RunView, phase?: string): string[][] {
  const agents = phase === undefined ? runView.agents : runView.agents.filter((a) => a.phase === phase)
  return agents.map((a) => {
    const cells = agentCells(toAgentRecord(a))
    cells[0] = STATUS_DOT[a.status]
    return cells
  })
}

export function paginate<T>(rows: readonly T[], offset: number, height: number): Page<T> {
  const n = rows.length
  if (n === 0) return { window: [], label: "0–0 of 0" }
  const h = Math.max(1, Math.floor(height))
  const maxOff = Math.max(0, n - h)
  const off = Math.min(Math.max(0, Math.floor(offset)), maxOff)
  const end = Math.min(n, off + h)
  const window = rows.slice(off, end) as T[]
  return { window, label: `${off + 1}–${end} of ${n}` }
}

export function runFingerprint(run: RunView): string {
  return run.agents.map((a) => `${a.sessionID}:${a.status}`).join("|")
}

/**
 * Once-per-run completion heuristic: all children final, fingerprint unchanged
 * for quietMs, and not already fired. Caller owns the prev map.
 */
export function settleCandidate(
  prev: SettlePrev | undefined,
  now: RunView,
  quietMs: number,
  nowTs: number,
): boolean {
  if (prev?.fired) return false
  if (!now.settled || now.agents.length === 0) return false
  if (!prev) return false
  if (prev.fingerprint !== runFingerprint(now)) return false
  if (nowTs - prev.lastChangeAt < quietMs) return false
  return true
}

export function nextSettlePrev(prev: SettlePrev | undefined, now: RunView, nowTs: number): SettlePrev {
  const fingerprint = runFingerprint(now)
  if (!prev || prev.fingerprint !== fingerprint) {
    return { fingerprint, lastChangeAt: nowTs, fired: prev?.fired ?? false }
  }
  return prev
}

export function runningRunCount(runs: readonly RunView[]): number {
  let n = 0
  for (const run of runs) if (!run.settled) n++
  return n
}

export function formatCounts(counts: RunView["counts"]): string {
  return `${counts.done}/${counts.total}${counts.failed ? ` failed ${counts.failed}` : ""}`
}

export function shortRunID(runID: string): string {
  if (runID.length <= 16) return runID
  return runID.slice(0, 16)
}

export type TwoColumnOpts = {
  width: number
  selectedPhase: number
  offset: number
  height: number
  now?: number
}

export type TwoColumnView = {
  header: string[]
  left: string[]
  right: string[][]
  footer: string[]
  page: string
}

function clip(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s
  if (width === 1) return s.slice(0, 1)
  return `${s.slice(0, width - 1)}…`
}

/**
 * Footer hint line listing only the keys actually bound.
 * Known chords collapse to the overlay legend (↑↓ select, x stop, …).
 */
export function footerHints(bound: string[]): string {
  const set = new Set(bound.map((b) => b.trim().toLowerCase()))
  const has = (...keys: string[]): boolean => keys.some((k) => set.has(k))
  const parts: string[] = []
  if (has("up", "down", "↑", "↓", "↑↓")) parts.push("↑↓ select")
  if (has("x")) parts.push("x stop")
  if (has("p")) parts.push("p pause")
  if (has("s")) parts.push("s save")
  const enter = has("return", "enter", "enter/→")
  const right = has("right", "→", "enter/→")
  if (enter && right) parts.push("enter/→ drill")
  else if (enter) parts.push("enter drill")
  else if (right) parts.push("→ drill")
  if (has("esc")) parts.push("esc close")
  const known = new Set(["up", "down", "↑", "↓", "↑↓", "x", "p", "s", "return", "enter", "right", "→", "enter/→", "esc"])
  for (const raw of bound) {
    const k = raw.trim()
    if (k && !known.has(k.toLowerCase())) parts.push(k)
  }
  return parts.join("  ")
}

/**
 * Two-column inspect view: left = numbered phases, right = D11 cells for the
 * selected phase. Pagination label gains " ↓" when more rows sit below.
 */
export function twoColumn(runView: RunView, opts: TwoColumnOpts): TwoColumnView {
  const now = opts.now ?? Date.now()
  const elapsed = compactElapsed(Math.max(0, now - runView.startedAt))
  const headerLine = `${shortRunID(runView.runID)} · ${runView.counts.done}/${runView.counts.total} agents · ${elapsed}`
  const cols = phaseColumns(runView)
  const phaseCount = cols.length
  const selPh = phaseCount === 0 ? 0 : Math.min(Math.max(0, Math.floor(opts.selectedPhase)), phaseCount - 1)

  const left: string[] = ["Phases"]
  if (phaseCount === 0) {
    left.push("  (none)")
  } else {
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i]!
      const mark = i === selPh ? ">" : " "
      left.push(`${mark} ${i + 1} ${col.phase} ${col.done}/${col.total}`)
    }
  }

  const phaseName = phaseCount === 0 ? undefined : cols[selPh]!.phase
  const rows = agentRows(runView, phaseName)
  const inPhase =
    phaseName === undefined ? runView.agents : runView.agents.filter((a) => a.phase === phaseName)
  const title = `${phaseName ?? "agents"} · ${inPhase.length} agents`
  const page = paginate(rows, opts.offset, opts.height)
  const more = page.window.length > 0 && opts.offset + page.window.length < rows.length
  const pageLabel = more ? `${page.label} ↓` : page.label
  const right: string[][] = [[title], ...page.window]

  const width = Math.max(0, Math.floor(opts.width))
  return {
    header: [clip(headerLine, width)],
    left: left.map((line) => clip(line, width)),
    right: right.map((cells) => cells.map((c) => clip(c, width))),
    footer: [],
    page: pageLabel,
  }
}
