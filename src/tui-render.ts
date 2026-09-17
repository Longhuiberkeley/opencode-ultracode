/**
 * Pure TUI inspect helpers — plugin-free and JSX-free.
 *
 * Grouping uses the title contract (`parseChildTitle`). Cell values come from
 * `run-format.agentCells` (D11); this module only swaps the status cell for a
 * status dot.
 */
import { parseChildTitle } from "./sessions.ts"
import { agentCells, compactCount, compactElapsed, compactTokens } from "./run-format.ts"
import { CONCURRENCY_CAP } from "./types.ts"
import type { AgentRecord, AgentStatus, RunStatus, TokenUsage } from "./types.ts"
import {
  SETTINGS_ACK_PREFIX,
  SETTINGS_KEYS,
  panelSettingsEqual,
  parseSettingsAckPayload,
  type PanelSettings,
  type SettingsAck,
} from "./settings.ts"
import {
  isFallbackExpired,
  isFinalRunStatus,
  sessionActivityMs,
  type AuthoritativeSnapshot,
} from "./run-status.ts"

export { FALLBACK_STALE_MS } from "./run-status.ts"
export type { AuthoritativeSnapshot } from "./run-status.ts"

const VERSION_RE = /^v?0\.0\.0-beta-(\d+)$/

/** Visible rows per inspect pane (tree pagination and detail scroll). */
export const PAGE_HEIGHT = 10

/** Status dots chosen by the TUI surface (status string still lives in agentCells). */
export const STATUS_DOT: Record<AgentStatus, string> = {
  running: "●",
  succeeded: "✓",
  failed: "✗",
  pending: "○",
  interrupted: "■",
}

/** Phase-level aggregate: some children succeeded, some did not. */
export const MIXED_DOT = "◐"

/** Dot glyph for any row status, including the phase-only "mixed" aggregate. */
export function statusDot(status: AgentStatus | "mixed" | undefined): string {
  if (status === "mixed") return MIXED_DOT
  if (status === undefined) return STATUS_DOT.pending
  return STATUS_DOT[status]
}

/**
 * Aggregate outcome of a phase's children for row coloring and dots:
 * any running → running; nothing final yet → pending; all final and all
 * succeeded → succeeded; all final with zero successes → failed; otherwise
 * (successes mixed with failures/interrupts) → "mixed".
 */
export function phaseAggregateStatus(agents: readonly RunAgentView[]): AgentStatus | "mixed" | undefined {
  if (agents.length === 0) return undefined
  if (agents.some((a) => a.status === "running")) return "running"
  const finals = agents.filter((a) => isFinalStatus(a.status))
  if (finals.length === 0) return "pending"
  const ok = finals.filter((a) => a.status === "succeeded").length
  if (ok === finals.length) return "succeeded"
  if (ok === 0) return "failed"
  return "mixed"
}

export type SessionView = {
  id: string
  title: string
  outcome?: string
  tokens?: TokenUsage | null
  time?: number | { created?: number; updated?: number; idle?: number }
  /** Client-store `agent` (A2). */
  agent?: string
  /** On-demand from last assistant message; absent → run-format "-". */
  model?: { providerID: string; id: string }
  /** On-demand tool-part count; absent → run-format "-". */
  toolCalls?: number
  /** SessionInfo.projectID — used to keep the chip project-scoped. */
  projectID?: string
  /** SessionInfo.location.directory — used to keep the chip cwd-scoped. */
  locationDirectory?: string
  /** Host store `data.session.status(id)` when present. */
  hostStatus?: "idle" | "running"
  /** Last `session.execution.*` event for this id (TUI-owned). */
  lastExecution?: "started" | "succeeded" | "failed" | "interrupted"
}

export type RunAgentView = {
  sessionID: string
  ord?: string
  phase?: string
  label?: string
  status: AgentStatus
  tokens?: TokenUsage
  title: string
  agent?: string
  model?: { providerID: string; id: string }
  toolCalls?: number
}

export type RunView = {
  runID: string
  status?: RunStatus
  queuedCount?: number
  parent?: string
  agents: RunAgentView[]
  phases: string[]
  counts: { total: number; done: number; failed: number }
  startedAt: number
  settled: boolean
  /** From run/ack state — not a process-local pause map. */
  paused?: boolean
  /** When set, chip/panel prefer this over session heuristics. */
  source?: "live" | "persisted" | "heuristic"
  name?: string
  workflowName?: string
  /** Authoritative running-agent count; 0 means admitting/pending, not "1 running". */
  runningCount?: number
  projectID?: string
  directory?: string
}

export type PhaseColumn = { phase: string; done: number; total: number }

export type SettlePrev = {
  fingerprint: string
  lastChangeAt: number
  fired: boolean
}

export type Page<T> = { window: T[]; label: string; offset: number }

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

/**
 * Prefer host outcome, then a final execution event. Idle with no observed
 * execution is `pending`: it may be queued-but-not-started or an early
 * orphan — it is never counted as running and is not final, so a transient
 * child cannot flash ✗ and cannot settle a run on its own. Crashes after
 * activity surface through the terminal execution events above.
 */
export function sessionToStatus(session: SessionView, nowTs?: number): AgentStatus {
  if (session.outcome !== undefined && session.outcome !== "") {
    return outcomeToStatus(session.outcome)
  }
  if (session.lastExecution === "succeeded") return "succeeded"
  if (session.lastExecution === "failed") return "failed"
  if (session.lastExecution === "interrupted") return "interrupted"
  if (session.hostStatus === "idle") return "pending"
  if (
    nowTs !== undefined &&
    isFallbackExpired(
      {
        outcome: session.outcome,
        lastExecution: session.lastExecution,
        activityMs: sessionActivityMs(session.time),
      },
      nowTs,
    )
  ) {
    return "pending"
  }
  return "running"
}

export type ChipScope = {
  directory?: string
  projectID?: string
}

/**
 * True when the session belongs to this project/cwd.
 * Undetermined scope fails closed (no leak). Missing session fields do not leak.
 */
export function sessionInChipScope(session: SessionView, scope: ChipScope | undefined): boolean {
  if (!scope || (scope.directory === undefined && scope.projectID === undefined)) return false
  if (scope.projectID !== undefined) {
    if (session.projectID === scope.projectID) {
      if (scope.directory === undefined || session.locationDirectory === undefined) return true
      return session.locationDirectory === scope.directory
    }
    if (session.projectID !== undefined) return false
  }
  if (scope.directory !== undefined) {
    if (session.locationDirectory === scope.directory) return true
    return false
  }
  return false
}

export function filterSessionsForChip(sessions: readonly SessionView[], scope: ChipScope | undefined): SessionView[] {
  if (!scope || (scope.directory === undefined && scope.projectID === undefined)) return []
  return sessions.filter((s) => sessionInChipScope(s, scope))
}

export type ChipCounts = {
  /** Workflow runs with at least one actually-running agent. */
  running: number
  paused: number
  failed: number
  /** Sum of running agents across counted runs (distinct from workflow-run count). */
  agents?: number
  /** Pending permission requests on owned child sessions. */
  blocked?: number
  /** Pending permission requests on sessions owned by no displayed run (plain subagents). */
  subagentBlocked?: number
  queued?: number
}

/**
 * Last pause/resume/stop ack wins per runID. Survives remount when the
 * caller persists the ack list (not a process-local Map).
 */
export function pausedRunIDsFromAcks(acks: readonly RunAck[]): Set<string> {
  const paused = new Set<string>()
  for (const ack of acks) {
    if (!ack.runID) continue
    if (ack.kind === "paused") paused.add(ack.runID)
    else if (ack.kind === "resumed" || ack.kind === "stopped") paused.delete(ack.runID)
  }
  return paused
}

/**
 * Last pause/resume/stop ack per runID. Bounds the persisted array while
 * keeping last-wins semantics for pausedRunIDsFromAcks.
 */
export function compactRunAcks(acks: readonly RunAck[]): RunAck[] {
  const last = new Map<string, RunAck>()
  for (const ack of acks) {
    if (!ack.runID) continue
    if (ack.kind !== "paused" && ack.kind !== "resumed" && ack.kind !== "stopped") continue
    last.set(ack.runID, ack)
  }
  return [...last.values()]
}

/**
 * Active-run chip tallies. A run counts as running only while a child is
 * actively running; pending-only runs (queued or orphaned before start) are
 * invisible, so the chip can never stick on a phantom count. Paused comes
 * from `run.paused` or ack-derived ids and shows only while the run still
 * has unsettled work — a run that ended while paused drops off (nothing
 * would ever clear that ack). Failed is the agent-failure total on counted runs.
 */
function runHasRunningAgent(run: RunView): boolean {
  if (run.runningCount !== undefined) return run.runningCount > 0
  return run.agents.some((a) => a.status === "running")
}

function runRunningAgents(run: RunView): number {
  if (run.runningCount !== undefined) return Math.max(0, run.runningCount)
  return run.agents.filter((a) => a.status === "running").length
}

export function chipCounts(
  runs: readonly RunView[],
  pausedRunIDs?: ReadonlySet<string>,
  blocked?: number,
  subagentBlocked?: number,
): ChipCounts {
  let running = 0
  let paused = 0
  let failed = 0
  let agents = 0
  let queued = 0
  for (const run of runs) {
    const isPaused = run.paused === true || (pausedRunIDs?.has(run.runID) ?? false)
    const active = runHasRunningAgent(run)
    if (isPaused) {
      if (!run.settled || active) {
        paused++
        failed += run.counts.failed
        agents += runRunningAgents(run)
      }
      continue
    }
    if (run.settled || (!active && run.status !== "running" && run.status !== "stopping")) continue
    running++
    queued += run.queuedCount ?? 0
    failed += run.counts.failed
    agents += runRunningAgents(run)
  }
  const counts: ChipCounts = { running, paused, failed, agents }
  if (blocked !== undefined && blocked > 0) counts.blocked = blocked
  if (subagentBlocked !== undefined && subagentBlocked > 0) counts.subagentBlocked = subagentBlocked
  if (queued > 0) counts.queued = queued
  return counts
}

/** Empty when nothing is active (hide-when-zero). Units: workflow runs vs agents. */
export function formatChipText(counts: ChipCounts): string {
  const blocked = counts.blocked ?? 0
  const subBlocked = counts.subagentBlocked ?? 0
  if (counts.running === 0 && counts.paused === 0 && blocked === 0 && subBlocked === 0) return ""
  const parts = ["ultracode"]
  if (counts.running > 0) parts.push(`${counts.running} ${counts.running === 1 ? "run" : "runs"}`)
  const agents = counts.agents ?? 0
  if (agents > 0) parts.push(`${agents} ${agents === 1 ? "agent" : "agents"}`)
  if (counts.paused > 0) parts.push(`${counts.paused} paused`)
  if (counts.failed > 0) parts.push(`${counts.failed} failed`)
  if ((counts.queued ?? 0) > 0) parts.push(`${counts.queued} queued`)
  if (blocked > 0) parts.push(`${blocked} awaiting permission`)
  if (subBlocked > 0) {
    parts.push(`${subBlocked} subagent${subBlocked === 1 ? "" : "s"} awaiting permission`)
  }
  return parts.join(" · ")
}

/** Parent-session inventory. Missing parent id is unscoped (caller already location-filtered). */
export function runsForParent(runs: readonly RunView[], parentSessionID?: string): RunView[] {
  if (!parentSessionID) return [...runs]
  return runs.filter((r) => r.parent === parentSessionID)
}

/**
 * Snapshots without ownership fail closed unless they already appear in the
 * heuristic (session-derived) run set for this scope.
 */
export function snapshotInChipScope(
  snap: AuthoritativeSnapshot,
  scope: ChipScope | undefined,
  knownRunIDs?: ReadonlySet<string>,
): boolean {
  if (!scope || (scope.directory === undefined && scope.projectID === undefined)) return false
  if (snap.projectID !== undefined && scope.projectID !== undefined && snap.projectID !== scope.projectID) {
    return false
  }
  if (snap.directory !== undefined && scope.directory !== undefined) {
    return snap.directory === scope.directory
  }
  if (knownRunIDs?.has(snap.runID)) return true
  if (snap.projectID !== undefined && scope.projectID !== undefined) return snap.projectID === scope.projectID
  return false
}

export function filterSnapshotsForChip(
  snaps: readonly AuthoritativeSnapshot[],
  scope: ChipScope | undefined,
  knownRunIDs?: ReadonlySet<string>,
): AuthoritativeSnapshot[] {
  return snaps.filter((s) => snapshotInChipScope(s, scope, knownRunIDs))
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
export function groupRuns(sessions: SessionView[], nowTs?: number): RunView[] {
  const buckets = new Map<string, { agents: RunAgentView[]; order: number; parent?: string }>()
  let seen = 0
  for (const session of sessions) {
    const parsed = parseChildTitle(session.title)
    if (!parsed?.runID) continue
    const status = sessionToStatus(session, nowTs)
    const agent: RunAgentView = {
      sessionID: session.id,
      ord: parsed.ord,
      phase: parsed.phase,
      label: parsed.label,
      status,
      tokens: session.tokens ?? undefined,
      title: session.title,
      agent: session.agent,
      model: session.model,
      toolCalls: session.toolCalls,
    }
    let bucket = buckets.get(parsed.runID)
    if (!bucket) {
      bucket = { agents: [], order: seen++, parent: parsed.parent }
      buckets.set(parsed.runID, bucket)
    }
    bucket.agents.push(agent)
    if (!bucket.parent && parsed.parent) bucket.parent = parsed.parent
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
      parent: bucket.parent,
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

function snapshotAgents(snap: AuthoritativeSnapshot, cached: readonly RunAgentView[] = []): RunAgentView[] {
  if (!snap.agentDetails) return [...cached]
  return snap.agentDetails.filter((a) => !!a.sessionID).map((a) => {
    const prev = cached.find((c) => c.ord === a.id || (a.sessionID && c.sessionID === a.sessionID))
    // Record provenance fills what the session-heuristic join cannot: a
    // warm-replayed (cached) child has no session in THIS run, so without
    // this fallback its detail rows render "-".
    return {
      ...prev,
      sessionID: a.sessionID ?? "",
      ord: a.id,
      status: a.status,
      phase: a.phase,
      label: a.label,
      title: a.label ?? a.id,
      agent: a.effectiveAgent ?? a.requestedAgent ?? prev?.agent,
      model: a.effectiveModel ?? prev?.model,
      tokens: a.tokens ?? prev?.tokens,
      toolCalls: a.toolCalls ?? prev?.toolCalls,
    }
  })
}

function overlaySnapshot(run: RunView, snap: AuthoritativeSnapshot): RunView {
  const paused = snap.status === "paused"
  const running = snap.status === "running" || snap.status === "stopping"
  const settled = isFinalRunStatus(snap.status)
  let agents = snapshotAgents(snap, run.agents)
  if (settled) {
    const mapped: AgentStatus =
      snap.status === "failed" ? "failed" : snap.status === "interrupted" ? "interrupted" : "succeeded"
    agents = agents.map((a) =>
      a.status === "running" || a.status === "pending" ? { ...a, status: mapped } : a,
    )
  }
  return {
    ...run,
    status: snap.status,
    queuedCount: snap.queuedCount,
    phases: [...new Set(agents.flatMap((a) => a.phase ? [a.phase] : []))],
    parent: snap.parentSessionID ?? run.parent,
    name: snap.name ?? run.name,
    workflowName: snap.workflowName ?? run.workflowName,
    runningCount: snap.runningCount,
    projectID: snap.projectID ?? run.projectID,
    directory: snap.directory ?? run.directory,
    paused,
    settled,
    counts: { total: snap.agents.total, done: snap.agents.done, failed: snap.agents.failed },
    startedAt: snap.startedAt || run.startedAt,
    agents,
    source: snap.source,
  }
}

function runViewFromSnapshot(snap: AuthoritativeSnapshot): RunView {
  const settled = isFinalRunStatus(snap.status)
  const paused = snap.status === "paused"
  const running = snap.status === "running" || snap.status === "stopping"
  const showDummy = running && (snap.runningCount === undefined || snap.runningCount > 0)
  return {
    runID: snap.runID,
    status: snap.status,
    queuedCount: snap.queuedCount,
    parent: snap.parentSessionID,
    name: snap.name,
    workflowName: snap.workflowName,
    runningCount: snap.runningCount,
    projectID: snap.projectID,
    directory: snap.directory,
    agents: snapshotAgents(snap),
    phases: [...new Set(snapshotAgents(snap).flatMap((a) => a.phase ? [a.phase] : []))],
    counts: { total: snap.agents.total, done: snap.agents.done, failed: snap.agents.failed },
    startedAt: snap.startedAt,
    settled,
    paused,
    source: snap.source,
  }
}

/**
 * Live snapshots overlay heuristic runs; persisted fills gaps; missing
 * snapshots keep the session heuristic (including fallback expiry).
 * Empty live+persisted is the rpc-unavailable identity.
 */
export function mergeAuthoritativeRuns(
  heuristic: readonly RunView[],
  live: readonly AuthoritativeSnapshot[] = [],
  persisted: readonly AuthoritativeSnapshot[] = [],
): RunView[] {
  const liveMap = new Map(live.map((s) => [s.runID, s]))
  const persMap = new Map(persisted.map((s) => [s.runID, s]))
  const seen = new Set<string>()
  const out: RunView[] = []
  for (const run of heuristic) {
    seen.add(run.runID)
    const snap = liveMap.get(run.runID) ?? persMap.get(run.runID)
    out.push(snap ? overlaySnapshot(run, snap) : { ...run, source: run.source ?? "heuristic" })
  }
  for (const snap of live) {
    if (seen.has(snap.runID)) continue
    seen.add(snap.runID)
    out.push(runViewFromSnapshot(snap))
  }
  for (const snap of persisted) {
    if (seen.has(snap.runID)) continue
    seen.add(snap.runID)
    out.push(runViewFromSnapshot(snap))
  }
  return out
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
    effectiveAgent: a.agent,
    requestedAgent: a.agent,
    effectiveModel: a.model,
    toolCalls: a.toolCalls,
  }
}

/** Agents for a phase filter: `"all"` (default), `"-"` unphased, or a named phase. */
export function agentsForPhase(runView: RunView, phase?: string): RunAgentView[] {
  if (phase === undefined || phase === "all") return runView.agents
  if (phase === "-") return runView.agents.filter((a) => !a.phase)
  return runView.agents.filter((a) => a.phase === phase)
}

/**
 * Phase picker: `"all"`, then observed phases in first-appearance order,
 * then `"-"` when any agent is unphased (same default string as run-format).
 */
export function inspectPhaseList(runView: RunView): string[] {
  const list = ["all", ...runView.phases]
  if (runView.agents.some((a) => !a.phase) && !list.includes("-")) list.push("-")
  return list
}

/** D11 cells with status replaced by a status dot. Optional phase filter. */
export function agentRows(runView: RunView, phase?: string): string[][] {
  return agentsForPhase(runView, phase).map((a) => {
    const cells = agentCells(toAgentRecord(a))
    cells[0] = STATUS_DOT[a.status]
    return cells
  })
}

export function paginate<T>(rows: readonly T[], offset: number, height: number): Page<T> {
  const n = rows.length
  if (n === 0) return { window: [], label: "0–0 of 0", offset: 0 }
  const h = Math.max(1, Math.floor(height))
  const maxOff = Math.max(0, n - h)
  const off = Math.min(Math.max(0, Math.floor(offset)), maxOff)
  const end = Math.min(n, off + h)
  const window = rows.slice(off, end) as T[]
  return { window, label: `${off + 1}–${end} of ${n}`, offset: off }
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

/** Runs with at least one actively-running child. Pending-only (zombie/queued) runs do not count. */
export function runningRunCount(runs: readonly RunView[]): number {
  let n = 0
  for (const run of runs) if (!run.settled && runHasRunningAgent(run)) n++
  return n
}

/**
 * Quiet-window wakeup: runIDs whose lastChange + quietMs <= nowTs and not in fired.
 * Caller records lastChange only for settled runs.
 */
export function planSettleCheck(
  fired: Record<string, number>,
  lastChange: Record<string, number>,
  nowTs: number,
  quietMs: number,
): string[] {
  const due: string[] = []
  for (const runID of Object.keys(lastChange)) {
    if (Object.prototype.hasOwnProperty.call(fired, runID)) continue
    const changed = lastChange[runID]
    if (typeof changed !== "number") continue
    if (changed + quietMs <= nowTs) due.push(runID)
  }
  return due
}

export type SettleMaps = {
  lastChange: Record<string, number>
  fired: Record<string, number>
  prev: Map<string, SettlePrev>
}

function fingerprintAgentCount(fp: string): number {
  if (!fp) return 0
  return fp.split("|").filter((p) => p.length > 0).length
}

/** Cancel a pending quiet-window when the run is no longer settled or a child appeared. */
export function shouldClearSettleDeadline(run: RunView, prev: SettlePrev | undefined): boolean {
  if (!run.settled) return true
  if (!prev) return false
  return run.agents.length > fingerprintAgentCount(prev.fingerprint)
}

/**
 * Advance settle maps one tick. Returns runIDs that should toast (once-per-run).
 * Caller must re-verify settled (e.g. via inspectModel) before toasting; this
 * function already skips due IDs that are not settled at fire time.
 */
export function applySettleTick(runs: readonly RunView[], maps: SettleMaps, nowTs: number, quietMs: number): string[] {
  for (const run of runs) {
    const prev = maps.prev.get(run.runID)
    if (shouldClearSettleDeadline(run, prev)) {
      delete maps.lastChange[run.runID]
    }
    const next = nextSettlePrev(prev, run, nowTs)
    maps.prev.set(run.runID, next)
    if (run.settled && maps.lastChange[run.runID] === undefined && !Object.prototype.hasOwnProperty.call(maps.fired, run.runID)) {
      maps.lastChange[run.runID] = next.lastChangeAt
    }
  }
  const due = planSettleCheck(maps.fired, maps.lastChange, nowTs, quietMs)
  const toast: string[] = []
  for (const runID of due) {
    const run = runs.find((r) => r.runID === runID)
    if (!run?.settled) {
      delete maps.lastChange[runID]
      continue
    }
    if (Object.prototype.hasOwnProperty.call(maps.fired, runID)) continue
    toast.push(runID)
    maps.fired[runID] = nowTs
    delete maps.lastChange[runID]
    const p = maps.prev.get(runID)
    if (p) maps.prev.set(runID, { ...p, fired: true })
  }
  return toast
}

export type RunAckKind = "paused" | "resumed" | "stopped" | "saved" | "error" | "settings"

export type RunAck = { runID?: string; kind: RunAckKind; settings?: SettingsAck }

function extractAckRunID(text: string): string | undefined {
  const tickRun = /`(run_[A-Za-z0-9]+)`/.exec(text)
  if (tickRun) return tickRun[1]
  const bare = /\b(run_[A-Za-z0-9]+)\b/.exec(text)
  if (bare) return bare[1]
  const tick = /`([A-Za-z0-9._-]+)`/.exec(text)
  return tick?.[1]
}

/** Parse parent-session synthetic ack lines from pause/resume/stop/save/error. */
export function parseRunAck(text: string): RunAck | undefined {
  const t = text.trim()
  if (!t) return undefined
  if (t.startsWith(SETTINGS_ACK_PREFIX)) {
    const settings = parseSettingsAckPayload(t)
    if (!settings) return { kind: "error" }
    return { kind: "settings", runID: settings.runID, settings }
  }
  const runID = extractAckRunID(t)
  if (/^error\b/i.test(t) || /\bcannot (?:pause|resume|stop)\b/i.test(t)) {
    return { runID, kind: "error" }
  }
  if (/\bsaved\b/i.test(t) && /\bworkflow\b/i.test(t)) {
    return { runID, kind: "saved" }
  }
  if (/^resumed\b/i.test(t) || /^Resumed run\b/.test(t)) {
    return { runID, kind: "resumed" }
  }
  if (/^paused\b/i.test(t) || /^Paused run\b/.test(t) || /\bis already paused\b/i.test(t)) {
    return { runID, kind: "paused" }
  }
  if (/^Stopping run\b/.test(t) || /^stopped\b/i.test(t) || /\binterrupted\b/i.test(t) && /\brun\b/i.test(t)) {
    return { runID, kind: "stopped" }
  }
  return undefined
}

export type MessageLike = {
  type?: string
  model?: { providerID?: string; id?: string } | null
  content?: ReadonlyArray<{ type?: string }>
}

/** Last assistant model + count of tool parts (on-demand selected-row details). */
export function detailsFromMessages(messages: ReadonlyArray<MessageLike>): {
  model?: { providerID: string; id: string }
  toolCalls: number
} {
  let model: { providerID: string; id: string } | undefined
  let toolCalls = 0
  for (const msg of messages) {
    if (msg.type === "assistant" && msg.model?.providerID && msg.model.id) {
      model = { providerID: msg.model.providerID, id: msg.model.id }
    }
    const content = msg.content
    if (!content) continue
    for (const part of content) {
      if (part?.type === "tool") toolCalls++
    }
  }
  return { model, toolCalls }
}

export type DetailCacheEntry = {
  toolCalls: number
  model: { providerID: string; id: string } | null
  tentative: boolean
}

export type CacheEvent = { type?: string; sessionID?: string }

/** Tentative when we have no model and zero tool calls (empty / not-yet-fetched). */
export function detailsCacheEntry(details: { model?: { providerID: string; id: string }; toolCalls: number }): DetailCacheEntry {
  const model = details.model ?? null
  const toolCalls = details.toolCalls
  return { toolCalls, model, tentative: toolCalls === 0 && model === null }
}

/**
 * Session/message events drop tentative cache rows for that session.
 * Non-tentative entries stay. Unknown / unrelated events keep the entry.
 */
export function cacheDecision(entry: DetailCacheEntry | undefined, evt: CacheEvent): "keep" | "delete" | "skip" {
  if (!entry) return "skip"
  if (!entry.tentative) return "keep"
  const t = evt.type ?? ""
  const sessionHit = typeof evt.sessionID === "string" && evt.sessionID.length > 0
  if (sessionHit && (t.startsWith("session.") || t.includes("message"))) return "delete"
  return "keep"
}

/** Active (unsettled) parent match, else newest parent match, else newest overall. */
export function defaultRunIndex(runs: readonly RunView[], parentSessionID?: string): number {
  if (runs.length === 0) return 0
  const pool = parentSessionID ? runs.filter((r) => r.parent === parentSessionID) : [...runs]
  const search = pool.length > 0 ? pool : [...runs]
  const active = search.filter((r) => !r.settled)
  const candidates = active.length > 0 ? active : search
  let best = candidates[0]!
  for (const run of candidates) {
    if (run.startedAt > best.startedAt) best = run
  }
  const idx = runs.findIndex((r) => r.runID === best.runID)
  return idx >= 0 ? idx : 0
}

export type TreeCursor = { kind: "phase" | "agent"; id: string }

/** Dedicated tree-selection identity — not agent-row clamping. */
export type TreeSelection = {
  expanded: Readonly<Record<string, boolean>>
  cursor: TreeCursor
  detailOffset: number
}

export type InspectPane = "tree" | "detail" | "settings"

export type TreeRow = {
  kind: "phase" | "agent"
  id: string
  label: string
  phase?: string
  sessionID?: string
  /** Agent status, or the phase-level aggregate ("mixed" = successes + failures). */
  status?: AgentStatus | "mixed"
  /** Session has a pending permission request (marker + amber row). */
  blocked?: boolean
  expanded?: boolean
  depth: number
}

export type InspectSel = {
  /** Undefined → defaultRunIndex(parentSessionID). */
  runIndex?: number
  /** `"all"` (default), `"-"`, or a named phase. */
  phase?: string
  offset: number
  selected: number
  parentSessionID?: string
  treeSel?: TreeSelection
  pane?: InspectPane
  settingsRow?: number
}

/** Per-run inspector selection (map values). */
export type InspectSelection = {
  parentSessionID?: string
  runID?: string
  phase: string
  offset: number
  selected: number
  /** Visible-window row; unused runs initialize to 0. */
  rowInWindow?: number
  treeSel?: TreeSelection
  pane?: InspectPane
  settingsRow?: number
  /** Explicit `[`/`]` (or `.`) jump — sticky history until unpinned or parent change. */
  pinned?: boolean
}

/** Defaults for a run that has never been selected. */
export const UNSEEN_RUN_SELECTION = { phase: "all", offset: 0, selected: 0, rowInWindow: 0 } as const

export type CycleRunSelectionResult = {
  runID: string | undefined
  selection: {
    phase: string
    offset: number
    selected: number
    rowInWindow: number
    treeSel?: TreeSelection
    pane?: InspectPane
    settingsRow?: number
    pinned?: boolean
  }
}

function selectionForRun(
  selMap: Readonly<Record<string, InspectSelection>>,
  parentSessionID: string | undefined,
  runID: string,
): InspectSelection | undefined {
  // Exact (parent, run) key only: borrowing another parent's entry for the
  // same run would restore a selection the open parent never made.
  return selMap[selectionMapKey(parentSessionID, runID)]
}

/**
 * Cycle `[` / `]` across runs. Unseen runs do not inherit the previous run's
 * raw selected/offset — they start at all/0/0/0.
 */
export function cycleRunSelection(
  selMap: Readonly<Record<string, InspectSelection>>,
  runs: readonly RunView[],
  currentRunID: string | undefined,
  dir: number,
  openParentID?: string,
): CycleRunSelectionResult {
  const n = runs.length
  if (n === 0) return { runID: undefined, selection: { ...UNSEEN_RUN_SELECTION } }
  let idx = currentRunID ? runs.findIndex((r) => r.runID === currentRunID) : 0
  if (idx < 0) idx = 0
  const step = ((dir % n) + n) % n
  const next = runs[(idx + step) % n]!
  const runID = next.runID
  const stored = selectionForRun(selMap, openParentID, runID)
  if (stored) {
    const selection: CycleRunSelectionResult["selection"] = {
      phase: stored.phase,
      offset: stored.offset,
      selected: stored.selected,
      rowInWindow: stored.rowInWindow ?? 0,
    }
    if (stored.treeSel) selection.treeSel = stored.treeSel
    if (stored.pane) selection.pane = stored.pane
    if (stored.settingsRow !== undefined) selection.settingsRow = stored.settingsRow
    selection.pinned = true
    return { runID, selection }
  }
  return { runID, selection: { ...UNSEEN_RUN_SELECTION, pinned: true } }
}

export function selectionMapKey(parentSessionID: string | undefined, runID: string | undefined): string {
  return `${parentSessionID ?? ""}\0${runID ?? ""}`
}

/**
 * Opening the inspector from parent P defaults to P's newest active run.
 * Same parent keeps a pinned selection (deliberate `[`/`]` history) while that
 * run exists. Unpinned follow-latest selects the newest same-parent run.
 */
export function selectForOpen(
  prev: InspectSelection | undefined,
  runs: readonly RunView[],
  openParentID: string | undefined,
): InspectSelection {
  const idx = defaultRunIndex(runs, openParentID)
  const runID = runs.length === 0 ? undefined : runs[idx]?.runID
  const fresh = (): InspectSelection => ({
    parentSessionID: openParentID,
    runID,
    phase: "all",
    offset: 0,
    selected: 0,
    pinned: false,
  })
  if (prev && prev.parentSessionID === openParentID) {
    const kept = prev.runID !== undefined ? runs.find((r) => r.runID === prev.runID) : undefined
    if (kept) {
      if (prev.pinned) return { ...prev, parentSessionID: openParentID }
      const follow = defaultRunIndex(runs, openParentID)
      const nextID = runs[follow]?.runID
      if (nextID && nextID !== kept.runID) {
        return {
          parentSessionID: openParentID,
          runID: nextID,
          phase: "all",
          offset: 0,
          selected: 0,
          pinned: false,
        }
      }
      return { ...prev, parentSessionID: openParentID, pinned: false }
    }
  }
  return fresh()
}

/**
 * Selection committed by in-run navigation (tree move, detail scroll,
 * expand/collapse, pane cycle). Navigating within a run PINS it: every commit
 * carries `pinned: true` so the follow-latest effect cannot snap the view to a
 * newer active run mid-inspection. (Regression: commitTree used to rebuild the
 * selection without `pinned`; the first ↑↓ after a `[` jump dropped the pin and
 * the 1s status poll follow-latest'd to the other run.) `.` (toggleFollowPin)
 * remains the explicit unpin.
 */
export function treeNavSelection(
  run: Pick<RunView, "runID" | "agents">,
  prev: InspectSelection,
  treeSel: TreeSelection,
  pane?: InspectPane,
  pageHeight: number = PAGE_HEIGHT,
): InspectSelection {
  const agentIdx =
    treeSel.cursor.kind === "agent" ? run.agents.findIndex((a) => a.sessionID === treeSel.cursor.id) : -1
  // A phase cursor selects that phase's first agent (not a stale index
  // from wherever the cursor was before — RC3 fix).
  const phaseFirst =
    treeSel.cursor.kind === "phase"
      ? run.agents.findIndex((a) => (a.phase ?? "-") === treeSel.cursor.id)
      : -1
  const selected = agentIdx >= 0 ? agentIdx : phaseFirst >= 0 ? phaseFirst : prev.selected
  const off = prev.offset
  return {
    parentSessionID: prev.parentSessionID,
    runID: run.runID,
    phase: prev.phase,
    selected,
    offset: selected < off ? selected : selected >= off + pageHeight ? selected - pageHeight + 1 : off,
    treeSel,
    pane: pane ?? prev.pane ?? "tree",
    settingsRow: prev.settingsRow,
    pinned: true,
  }
}

export function toggleFollowPin(sel: InspectSelection): InspectSelection {
  return { ...sel, pinned: sel.pinned !== true }
}

/** Visible run chooser: mark + short id + name/status + done/total. */
export function runStripLines(
  runs: readonly RunView[],
  selectedRunID: string | undefined,
  opts?: { pinned?: boolean; limit?: number },
): string[] {
  if (runs.length === 0) return []
  const limit = Math.max(1, opts?.limit ?? 8)
  const follow = opts?.pinned ? "pinned" : "follow-latest"
  const lines = [`runs ${runs.length} · ${follow}`]
  const selected = runs.findIndex((run) => run.runID === selectedRunID)
  const start = Math.max(0, Math.min(selected - limit + 1, runs.length - limit))
  for (const run of runs.slice(start, start + limit)) {
    const mark = run.runID === selectedRunID ? "*" : " "
    const name = run.name ?? run.workflowName ?? shortRunID(run.runID)
    const dot = run.paused ? "■" : run.settled ? "○" : runHasRunningAgent(run) ? "●" : "◌"
    lines.push(`${mark} ${shortRunID(run.runID)} ${name} ${dot} ${run.status ?? (run.settled ? "finished" : "active")} ${run.counts.done}/${run.counts.total}`)
  }
  if (runs.length > limit) lines.push(`  … +${runs.length - limit} more`)
  return lines
}

export function inspectSelFromSelection(sel: InspectSelection, runs: readonly RunView[]): InspectSel {
  const hit = sel.runID ? runs.findIndex((r) => r.runID === sel.runID) : -1
  const next: InspectSel = {
    runIndex: hit >= 0 ? hit : undefined,
    phase: sel.phase,
    offset: sel.offset,
    selected: sel.selected,
    parentSessionID: sel.parentSessionID,
  }
  if (sel.treeSel) next.treeSel = sel.treeSel
  if (sel.pane) next.pane = sel.pane
  if (sel.settingsRow !== undefined) next.settingsRow = sel.settingsRow
  return next
}

function phaseTokenSum(agents: readonly RunAgentView[]): string {
  let any = false
  let sum = 0
  for (const a of agents) {
    if (!a.tokens) continue
    any = true
    sum += a.tokens.input + a.tokens.output + a.tokens.reasoning
  }
  return any ? compactCount(sum) : "-"
}

function phaseAgents(run: RunView, phaseId: string): RunAgentView[] {
  if (phaseId === "-") return run.agents.filter((a) => !a.phase)
  return run.agents.filter((a) => a.phase === phaseId)
}

function phaseLineLabel(name: string, agents: readonly RunAgentView[]): string {
  const done = agents.filter((a) => isFinalStatus(a.status)).length
  const tokens = phaseTokenSum(agents)
  const counts = `${name} ${done}/${agents.length}`
  return tokens === "-" ? counts : `${counts}  ${tokens}`
}

function agentLineLabel(a: RunAgentView): string {
  return a.label ? `${a.ord ?? a.sessionID} ${a.label}` : (a.ord ?? a.sessionID)
}

function observedPhaseIds(run: RunView): string[] {
  const ids = [...run.phases]
  if (run.agents.some((a) => !a.phase) && !ids.includes("-")) ids.push("-")
  return ids
}

/** Default: every observed phase (and "-" if unphased) expanded. Skip synthetic "all". */
export function defaultExpanded(run: RunView): Record<string, boolean> {
  const expanded: Record<string, boolean> = {}
  for (const id of observedPhaseIds(run)) expanded[id] = true
  return expanded
}

export function defaultTreeSelection(run: RunView): TreeSelection {
  const expanded = defaultExpanded(run)
  const first = run.agents[0]
  return {
    expanded,
    cursor: first ? { kind: "agent", id: first.sessionID } : { kind: "phase", id: observedPhaseIds(run)[0] ?? "-" },
    detailOffset: 0,
  }
}

export function buildInspectTree(run: RunView, expanded: Readonly<Record<string, boolean>>): TreeRow[] {
  const rows: TreeRow[] = []
  for (const phaseId of observedPhaseIds(run)) {
    const agents = phaseAgents(run, phaseId)
    const isExp = expanded[phaseId] !== false
    rows.push({
      kind: "phase",
      id: phaseId,
      label: phaseLineLabel(phaseId, agents),
      phase: phaseId,
      status: phaseAggregateStatus(agents),
      expanded: isExp,
      depth: 0,
    })
    if (!isExp) continue
    for (const a of agents) {
      rows.push({
        kind: "agent",
        id: a.sessionID,
        label: agentLineLabel(a),
        phase: phaseId,
        sessionID: a.sessionID,
        status: a.status,
        depth: 1,
      })
    }
  }
  return rows
}

function cursorInTree(tree: readonly TreeRow[], cursor: TreeCursor): TreeRow | undefined {
  return tree.find((r) => r.kind === cursor.kind && r.id === cursor.id)
}

/**
 * Resolve stored tree identity against the current run.
 * Newly arriving agents do not steal the cursor. A collapsed parent that hid
 * the selected child moves the cursor to that phase.
 */
export function resolveTreeSelection(run: RunView, sel?: TreeSelection): TreeSelection {
  const expanded: Record<string, boolean> = { ...defaultExpanded(run), ...(sel?.expanded ?? {}) }
  const tree = buildInspectTree(run, expanded)
  const fallback = defaultTreeSelection(run)
  const cursor = sel?.cursor
  if (!cursor) {
    const hit = cursorInTree(tree, fallback.cursor)
    return {
      expanded,
      cursor: hit ? fallback.cursor : tree[0] ? { kind: tree[0].kind, id: tree[0].id } : fallback.cursor,
      detailOffset: Math.max(0, Math.floor(sel?.detailOffset ?? 0)),
    }
  }
  if (cursorInTree(tree, cursor)) {
    return { expanded, cursor, detailOffset: Math.max(0, Math.floor(sel?.detailOffset ?? 0)) }
  }
  if (cursor.kind === "agent") {
    const agent = run.agents.find((a) => a.sessionID === cursor.id)
    if (agent) {
      const phaseId = agent.phase ?? "-"
      return { expanded, cursor: { kind: "phase", id: phaseId }, detailOffset: 0 }
    }
  }
  const first = tree[0]
  return {
    expanded,
    cursor: first ? { kind: first.kind, id: first.id } : fallback.cursor,
    detailOffset: 0,
  }
}

function treeSelFromAgentIndex(run: RunView, phase: string, selected: number): TreeSelection {
  const agents = agentsForPhase(run, phase)
  const idx = agents.length === 0 ? 0 : Math.min(Math.max(0, Math.floor(selected)), agents.length - 1)
  const agent = agents[idx]
  const base = defaultTreeSelection(run)
  if (!agent) return base
  return { expanded: base.expanded, cursor: { kind: "agent", id: agent.sessionID }, detailOffset: 0 }
}

/** Move the cursor among expanded-visible tree rows. */
export function moveTree(tree: readonly TreeRow[], sel: TreeSelection, delta: number): TreeSelection {
  if (tree.length === 0 || delta === 0) return sel
  const idx = tree.findIndex((r) => r.kind === sel.cursor.kind && r.id === sel.cursor.id)
  const start = idx < 0 ? 0 : idx
  const next = Math.min(Math.max(0, start + delta), tree.length - 1)
  const row = tree[next]!
  return { ...sel, cursor: { kind: row.kind, id: row.id }, detailOffset: 0 }
}

/**
 * W3C tree keys: Right expands / first child; Left collapses / parent.
 * Right is not drill.
 */
export function toggleExpand(tree: readonly TreeRow[], sel: TreeSelection, key: "left" | "right"): TreeSelection {
  const row = cursorInTree(tree, sel.cursor)
  if (!row) return sel
  if (key === "right") {
    if (row.kind !== "phase") return sel
    if (row.expanded === false) {
      return { ...sel, expanded: { ...sel.expanded, [row.id]: true } }
    }
    const idx = tree.findIndex((r) => r.kind === "phase" && r.id === row.id)
    const child = idx >= 0 ? tree[idx + 1] : undefined
    if (child?.kind === "agent" && (child.phase === row.id || row.id === "-")) {
      return { ...sel, cursor: { kind: "agent", id: child.id }, detailOffset: 0 }
    }
    return sel
  }
  if (row.kind === "phase") {
    if (row.expanded === false) return sel
    return { ...sel, expanded: { ...sel.expanded, [row.id]: false } }
  }
  const phaseId = row.phase ?? "-"
  return { ...sel, cursor: { kind: "phase", id: phaseId }, detailOffset: 0 }
}

const INSPECT_PANES: readonly InspectPane[] = ["tree", "detail", "settings"]

export function cycleInspectPane(pane: InspectPane | undefined, dir: number): InspectPane {
  const cur = pane ?? "tree"
  const idx = Math.max(0, INSPECT_PANES.indexOf(cur))
  const step = dir < 0 ? -1 : 1
  return INSPECT_PANES[(idx + step + INSPECT_PANES.length) % INSPECT_PANES.length]!
}

export function agentDetailLines(agent: RunAgentView): string[] {
  const rec = toAgentRecord(agent)
  const title = rec.label ? `${rec.id} ${rec.label}` : rec.id
  const model = rec.effectiveModel ? `${rec.effectiveModel.providerID}/${rec.effectiveModel.id}` : "-"
  return [
    title,
    `status  ${STATUS_DOT[agent.status]} ${agent.status}`,
    `agent   ${rec.effectiveAgent || rec.requestedAgent || "-"}`,
    `model   ${model}`,
    `tokens  ${compactTokens(agent.tokens)}`,
    `session ${agent.sessionID}`,
    `tools   ${agent.toolCalls === undefined ? "-" : String(agent.toolCalls)}`,
  ]
}

export function phaseDetailLines(run: RunView, phaseId: string): string[] {
  const agents = phaseAgents(run, phaseId)
  const done = agents.filter((a) => isFinalStatus(a.status)).length
  const agg = phaseAggregateStatus(agents)
  const lines = [
    phaseId,
    ...(agg ? [`status  ${statusDot(agg)} ${agg}`] : []),
    `agents  ${done}/${agents.length}`,
    `tokens  ${phaseTokenSum(agents)}`,
  ]
  // Child rows make a phase row reachable/informative on its own (the tree is
  // the only other place its agents appear).
  const shown = agents.slice(0, PAGE_HEIGHT + 4)
  for (const a of shown) {
    const dot = STATUS_DOT[a.status]
    const label = agentLineLabel(a)
    const tok = a.tokens ? compactCount(a.tokens.input + a.tokens.output + a.tokens.reasoning) : "-"
    lines.push(`${dot} ${label} · ${tok}`)
  }
  if (agents.length > shown.length) lines.push(`… +${agents.length - shown.length} more`)
  return lines
}

export const PANE_TITLE_TREE = "── tree"
export const PANE_TITLE_DETAIL = "── detail"
export const PANE_TITLE_SETTINGS = "── settings"
export const PANE_TITLE_LIVE = "── live"

/** Tree pane header: run k of N plus short run id, tied to `[` / `]` cycling. */
export function treePaneTitle(model: Pick<InspectModel, "run" | "runIndex" | "runs">): string {
  if (!model.run || model.runs.length === 0) return PANE_TITLE_TREE
  const k = model.runIndex + 1
  const n = model.runs.length
  const src = model.run.source && model.run.source !== "heuristic" ? `  ${model.run.source}` : ""
  return `${PANE_TITLE_TREE}  run ${k} of ${n}  ${shortRunID(model.run.runID)}${src}`
}

/** Explicit settings refresh is allowed only for a selected, still-active run. */
export function canRefreshRunSettings(run: RunView | undefined): boolean {
  return Boolean(run && !run.settled)
}

export function formatTreeLines(
  tree: readonly TreeRow[],
  cursor: TreeCursor,
  pane: InspectPane = "tree",
): string[] {
  void pane // focus indication lives on pane titles; the cursor mark is always shown
  return tree.map((row, i) => {
    const selected = row.kind === cursor.kind && row.id === cursor.id
    // The tree cursor is always visible — even when the detail pane is
    // focused — so selection identity never disappears (RC1 fix).
    const mark = selected ? ">" : " "
    if (row.kind === "phase") {
      const glyph = row.expanded === false ? "▸" : "▾"
      return `${mark}${glyph}${statusDot(row.status)} ${row.label}`
    }
    const dot = statusDot(row.status)
    const next = tree[i + 1]
    const last = !next || next.kind === "phase" || (next.depth ?? 0) < (row.depth ?? 1)
    const branch = last ? "└─" : "├─"
    return `${mark}${branch}${dot} ${row.label}`
  })
}

export function formatDetailLines(
  detail: readonly string[],
  pane: InspectPane = "tree",
  offset = 0,
): string[] {
  const page = paginate(detail, offset, PAGE_HEIGHT)
  return page.window.map((line, i) => {
    const mark = pane === "detail" && i === 0 ? ">" : " "
    return `${mark} ${line}`
  })
}

/** Split panel width across the two columns. */
export function splitPanelWidth(width: number): { tree: number; detail: number } {
  const w = Math.max(0, Math.floor(width))
  const tree = Math.floor(w / 2)
  return { tree, detail: w - tree }
}

export function clipPaneLines(lines: readonly string[], width: number): string[] {
  return lines.map((line) => clip(line, width))
}

/** Preserve full labels and resource paths; hard-break only words wider than the pane. */
export function wrapPaneLines(lines: readonly string[], width: number): string[] {
  const size = Math.max(1, Math.floor(width))
  return lines.flatMap((line) => {
    const chars = Array.from(line)
    if (chars.length === 0) return [""]
    const out: string[] = []
    while (chars.length > size) {
      const chunk = chars.slice(0, size)
      const space = chunk.lastIndexOf(" ")
      const end = space > size / 2 ? space + 1 : size
      out.push(chars.splice(0, end).join(""))
    }
    if (chars.length) out.push(chars.join(""))
    return out
  })
}

export type InspectPaneView = {
  pane: InspectPane
  cols: { tree: number; detail: number }
  treeLines: string[]
  /** Tree rows parallel to treeLines (1:1) — per-row coloring metadata. */
  treeWindow: TreeRow[]
  detailLines: string[]
  treePageLabel: string
  treeTitle: string
}

/**
 * Tree/detail paint from the live inspect model. Call from a Solid memo or
 * other accessor so a one-shot component body cannot freeze the panes.
 */
export function inspectPaneView(
  model: InspectModel,
  pane: InspectPane | undefined,
  width: number,
): InspectPaneView {
  const activePane = pane ?? "tree"
  const cols = splitPanelWidth(width)
  const treePage = paginate(model.tree, model.treeOffset, PAGE_HEIGHT)
  const treeLines = clipPaneLines(
    formatTreeLines(treePage.window, model.treeSel.cursor, activePane),
    cols.tree,
  )
  const detailLines = formatDetailLines(
    wrapPaneLines(model.detail, Math.max(1, cols.detail - 2)), activePane, model.treeSel.detailOffset,
  )
  const treeMore =
    treePage.window.length > 0 && treePage.offset + treePage.window.length < model.tree.length
  return {
    pane: activePane,
    cols,
    treeLines,
    treeWindow: treePage.window,
    detailLines,
    treePageLabel: treeMore ? `${treePage.label} ↓` : treePage.label,
    treeTitle: treePaneTitle(model),
  }
}

export type SettingsHydration = {
  overlay?: PanelSettings
  byRun: Readonly<Record<string, PanelSettings>>
  hydrated: boolean
}

function formatSettingValue(key: keyof PanelSettings, value: PanelSettings | undefined): string {
  if (!value) return "unknown"
  if (key === "concurrency") return `${value.concurrency} / ${CONCURRENCY_CAP}`
  if (key === "maxAgents") return String(value.maxAgents)
  if (key === "timeoutMs") return String(value.timeoutMs)
  return value.permissions
}

export function formatSettingsLines(
  overlay: PanelSettings | undefined,
  focusedRow: number,
  hydrated: boolean,
): string[] {
  const title = overlay ? "SETTINGS (next run)" : "SETTINGS"
  const lines = [title]
  const row = Math.min(Math.max(0, focusedRow), SETTINGS_KEYS.length - 1)
  for (let i = 0; i < SETTINGS_KEYS.length; i++) {
    const key = SETTINGS_KEYS[i]!
    const mark = i === row ? ">" : " "
    const shown = hydrated ? formatSettingValue(key, overlay) : "unknown"
    const label = key.padEnd(12, " ")
    lines.push(`${mark} ${label} ${shown}`)
  }
  return lines
}

export function formatLiveStrip(
  run: RunView | undefined,
  effective: PanelSettings | undefined,
  overlay: PanelSettings | undefined,
  hydrated: boolean,
): string[] {
  if (!hydrated) {
    return ["selected run unknown", run && !run.settled ? "press r to refresh" : "no cached settings"]
  }
  const lines: string[] = []
  if (effective) {
    const running = run ? run.agents.filter((a) => a.status === "running").length : 0
    const done = run?.counts.done ?? 0
    const total = run?.counts.total ?? 0
    lines.push(`conc ${effective.concurrency}/${CONCURRENCY_CAP} · running ${running} · agents ${done}/${total} · ${effective.permissions}`)
  } else {
    lines.push("selected run unknown")
  }
  if (overlay && effective && !panelSettingsEqual(overlay, effective)) {
    lines.push("next run differs — applies on next start")
  } else if (overlay) {
    lines.push("applies on next start")
  }
  return lines
}

export type SettingsPaneView = {
  settingsLines: string[]
  liveLines: string[]
  cols: { tree: number; detail: number }
}

export function settingsPaneView(
  run: RunView | undefined,
  hydration: SettingsHydration,
  focusedRow: number,
  width: number,
): SettingsPaneView {
  const cols = splitPanelWidth(width)
  const overlay = hydration.hydrated ? hydration.overlay : undefined
  const effective = run && hydration.hydrated ? hydration.byRun[run.runID] : undefined
  return {
    settingsLines: clipPaneLines(formatSettingsLines(overlay, focusedRow, hydration.hydrated), cols.tree),
    liveLines: clipPaneLines(formatLiveStrip(run, effective, overlay, hydration.hydrated), cols.detail),
    cols,
  }
}

function emptyTreeSel(): TreeSelection {
  return { expanded: {}, cursor: { kind: "phase", id: "-" }, detailOffset: 0 }
}

function treeOffsetForCursor(n: number, cursorIdx: number, height: number): number {
  const h = Math.max(1, Math.floor(height))
  const maxOff = Math.max(0, n - h)
  if (cursorIdx < h) return 0
  return Math.min(maxOff, cursorIdx - h + 1)
}

export type InspectModel = {
  runs: RunView[]
  runIndex: number
  run: RunView | undefined
  header: string
  phases: string[]
  selectedPhase: string
  left: string[]
  /** Full cell rows for the selected phase (not the window). */
  rows: string[][]
  window: string[][]
  sessionIDs: string[]
  selected: number
  rowInWindow: number
  offset: number
  pageLabel: string
  runningCount: number
  selectedSessionID: string | undefined
  tree: TreeRow[]
  detail: string[]
  treeSel: TreeSelection
  treeOffset: number
}

/** Visible-row session id: `rows`/`sessionIDs` index = offset + rowInWindow. */
export function selectedSessionID(model: InspectModel): string | undefined {
  return model.sessionIDs[model.offset + model.rowInWindow]
}

export type PendingPermissionView = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
}

function unwrapUnknownList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object") {
    const data = (raw as { data?: unknown }).data
    if (Array.isArray(data)) return data
  }
  return []
}

export function parsePermissionRequest(raw: unknown): PendingPermissionView | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.id !== "string" || rec.id === "") return undefined
  if (typeof rec.sessionID !== "string" || rec.sessionID === "") return undefined
  if (typeof rec.action !== "string" || rec.action === "") return undefined
  const resources = Array.isArray(rec.resources)
    ? rec.resources.filter((r): r is string => typeof r === "string")
    : []
  const view: PendingPermissionView = { id: rec.id, sessionID: rec.sessionID, action: rec.action, resources }
  if (typeof rec.message === "string" && rec.message !== "") view.message = rec.message
  return view
}

/** Host list payloads: a bare array or `{ data: PermissionRequest[] }`. */
export function parsePermissionList(raw: unknown): PendingPermissionView[] {
  const out: PendingPermissionView[] = []
  for (const item of unwrapUnknownList(raw)) {
    const parsed = parsePermissionRequest(item)
    if (parsed) out.push(parsed)
  }
  return out
}

export function permissionsForRun(
  run: RunView | undefined,
  items: readonly PendingPermissionView[],
): PendingPermissionView[] {
  if (!run || items.length === 0) return []
  const ids = new Set(run.agents.map((a) => a.sessionID))
  return items.filter((p) => ids.has(p.sessionID))
}

export function formatPermissionLines(items: readonly PendingPermissionView[]): string[] {
  if (items.length === 0) return []
  const lines = [`awaiting permission ${items.length}`]
  for (const item of items.slice(0, 3)) {
    const res = item.resources.join(", ") || "?"
    const child = shortRunID(item.sessionID)
    lines.push(`! ${item.action} ${child} ${res}`)
  }
  return lines
}

/** First blocked child session — inspector drill target. */
export function firstBlockedSessionID(items: readonly PendingPermissionView[]): string | undefined {
  return items[0]?.sessionID
}

/** Dedupe pending-permission views by request id (first occurrence wins). */
export function dedupePendingPermissions(items: readonly PendingPermissionView[]): PendingPermissionView[] {
  const seen = new Set<string>()
  const out: PendingPermissionView[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * Pending requests whose session belongs to none of the displayed runs —
 * plain subagent children (task tool), background sessions, and any other
 * non-run session in the location.
 */
export function standalonePendingPermissions(
  items: readonly PendingPermissionView[],
  runs: readonly RunView[],
): PendingPermissionView[] {
  if (items.length === 0) return []
  const owned = new Set(runs.flatMap((r) => r.agents.map((a) => a.sessionID)))
  return items.filter((p) => !owned.has(p.sessionID))
}

/** Session ids with at least one pending permission request. */
export function blockedSessionIDs(items: readonly PendingPermissionView[]): Set<string> {
  return new Set(items.map((p) => p.sessionID))
}

/** Clone tree rows, marking agent rows whose session has a pending ask. */
export function markBlockedTreeRows(rows: readonly TreeRow[], blocked: ReadonlySet<string>): TreeRow[] {
  return rows.map((row) => {
    if (row.kind !== "agent" || !row.sessionID || !blocked.has(row.sessionID)) return row
    return { ...row, blocked: true, label: `${row.label} ⚠` }
  })
}

/** Standalone-ask block for the inspector: header, up to 3 requests, key hints. */
export function formatStandalonePermissionLines(items: readonly PendingPermissionView[]): string[] {
  if (items.length === 0) return []
  const lines = [`subagents awaiting permission ${items.length}`]
  for (const item of items.slice(0, 3)) {
    const res = item.resources.join(", ") || "?"
    lines.push(`! ${item.action} ${shortRunID(item.sessionID)} ${res}`)
  }
  if (items.length > 3) lines.push(`… +${items.length - 3} more`)
  lines.push("y allow once · a allow always · n reject · enter open")
  return lines
}

/** Max visible chars for the first resource in the standalone-ask select title. */
const ASK_RESOURCE_MAX = 60

/**
 * One-shot select() payload for a standalone subagent permission ask.
 * Default (`current`) is allow-always. Title stays a single short line.
 */
export function buildAskSelectOptions(item: PendingPermissionView): {
  title: string
  current: "always"
  options: Array<{ title: string; value: "always" | "once" | "reject"; description: string }>
} {
  const raw = (item.resources[0] || item.message || "?").replace(/\s+/g, " ").trim() || "?"
  const resource = clip(raw, ASK_RESOURCE_MAX)
  return {
    title: `Subagent permission: ${item.action} — ${resource}`,
    current: "always",
    options: [
      {
        title: "Allow always",
        value: "always",
        description: "saves a durable project rule — no more asks like this",
      },
      {
        title: "Allow once",
        value: "once",
        description: "approve just this request",
      },
      {
        title: "Reject",
        value: "reject",
        description: "deny; the subagent sees the refusal and continues",
      },
    ],
  }
}

function firstPhaseChildSession(run: RunView, phaseId: string): string | undefined {
  return phaseAgents(run, phaseId).find((a) => a.sessionID && a.sessionID.length > 0)?.sessionID
}

/**
 * All per-frame inspect derivation. Component bodies must not regroup or
 * recompute rows — they render this model.
 */
export function inspectModel(
  sessions: SessionView[],
  sel: InspectSel,
  nowTs: number,
  auth?: { live?: readonly AuthoritativeSnapshot[]; persisted?: readonly AuthoritativeSnapshot[] },
): InspectModel {
  const merged = mergeAuthoritativeRuns(groupRuns(sessions, nowTs), auth?.live ?? [], auth?.persisted ?? [])
  const runs = runsForParent(merged, sel.parentSessionID)
  const n = runs.length
  const auto = defaultRunIndex(runs, sel.parentSessionID)
  const runIndex = n === 0 ? 0 : Math.min(Math.max(0, sel.runIndex ?? auto), n - 1)
  const run = n === 0 ? undefined : runs[runIndex]
  const runningCount = runningRunCount(runs)
  if (!run) {
    return {
      runs,
      runIndex: 0,
      run: undefined,
      header: "",
      phases: ["all"],
      selectedPhase: "all",
      left: ["Phases", "  (none)"],
      rows: [],
      window: [],
      sessionIDs: [],
      selected: 0,
      rowInWindow: 0,
      offset: 0,
      pageLabel: "0–0 of 0",
      runningCount,
      selectedSessionID: undefined,
      tree: [],
      detail: [],
      treeSel: emptyTreeSel(),
      treeOffset: 0,
    }
  }

  const phases = inspectPhaseList(run)
  const wantPhase = sel.phase ?? "all"
  const selectedPhase = phases.includes(wantPhase) ? wantPhase : "all"
  const agents = agentsForPhase(run, selectedPhase)
  const rows = agentRows(run, selectedPhase)
  const sessionIDs = agents.map((a) => a.sessionID)
  const selected = rows.length === 0 ? 0 : Math.min(Math.max(0, Math.floor(sel.selected)), rows.length - 1)
  const page = paginate(rows, sel.offset, PAGE_HEIGHT)
  const more = page.window.length > 0 && page.offset + page.window.length < rows.length
  const pageLabel = more ? `${page.label} ↓` : page.label
  const elapsed = compactElapsed(Math.max(0, nowTs - run.startedAt))
  const header = `${shortRunID(run.runID)} · run ${runIndex + 1}/${n} · ${run.counts.done}/${run.counts.total} agents · ${elapsed}`

  const left: string[] = ["Phases"]
  for (let i = 0; i < phases.length; i++) {
    const name = phases[i]!
    const inPhase = agentsForPhase(run, name)
    const done = inPhase.filter((a) => isFinalStatus(a.status)).length
    const mark = name === selectedPhase ? ">" : " "
    left.push(`${mark} ${name} ${done}/${inPhase.length}`)
  }

  const rowInWindow =
    page.window.length === 0 ? 0 : Math.min(Math.max(0, selected - page.offset), page.window.length - 1)

  const treeSel = sel.treeSel ? resolveTreeSelection(run, sel.treeSel) : treeSelFromAgentIndex(run, selectedPhase, selected)
  const tree = buildInspectTree(run, treeSel.expanded)
  const cursorIdx = tree.findIndex((r) => r.kind === treeSel.cursor.kind && r.id === treeSel.cursor.id)
  const treeOffset = treeOffsetForCursor(tree.length, cursorIdx < 0 ? 0 : cursorIdx, PAGE_HEIGHT)
  let detail: string[] = []
  if (treeSel.cursor.kind === "agent") {
    const agent = run.agents.find((a) => a.sessionID === treeSel.cursor.id)
    if (agent) detail = agentDetailLines(agent)
  } else {
    detail = phaseDetailLines(run, treeSel.cursor.id)
  }
  const maxDetailOff = Math.max(0, detail.length - PAGE_HEIGHT)
  const resolvedTreeSel: TreeSelection = {
    ...treeSel,
    detailOffset: Math.min(Math.max(0, Math.floor(treeSel.detailOffset)), maxDetailOff),
  }
  const treeSessionID =
    resolvedTreeSel.cursor.kind === "agent"
      ? resolvedTreeSel.cursor.id
      : firstPhaseChildSession(run, resolvedTreeSel.cursor.id)

  const model: InspectModel = {
    runs,
    runIndex,
    run,
    header,
    phases,
    selectedPhase,
    left,
    rows,
    window: page.window,
    sessionIDs,
    selected,
    rowInWindow,
    offset: page.offset,
    pageLabel,
    runningCount,
    selectedSessionID: undefined,
    tree,
    detail,
    treeSel: resolvedTreeSel,
    treeOffset,
  }
  model.selectedSessionID = sel.treeSel ? treeSessionID : selectedSessionID(model)
  return model
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

export function clip(s: string, width: number): string {
  if (width <= 0 || s.length <= width) return s
  if (width === 1) return s.slice(0, 1)
  return `${s.slice(0, width - 1)}…`
}

/**
 * Footer hint line listing only the keys actually bound.
 * Known chords collapse to the overlay legend (↑↓ move, ←→ expand, …).
 */
export function footerHints(bound: string[]): string {
  const set = new Set(bound.map((b) => b.trim().toLowerCase()))
  const has = (...keys: string[]): boolean => keys.some((k) => set.has(k))
  const parts: string[] = []
  if (has("up", "down", "↑", "↓", "↑↓")) parts.push("↑↓ move")
  if (has("left", "right", "←", "→", "←→")) parts.push("←→ expand")
  if (has("h") || has("l")) parts.push("h/l pane")
  if (has("+", "-", "=", "+/-")) parts.push("+/- edit")
  if (has("r")) parts.push("r refresh")
  if (has("return", "enter", "enter/→")) parts.push("enter drill")
  if (has("[") || has("]")) parts.push("[ ] run")
  if (has(".")) parts.push(". follow/pin")
  if (has("f")) parts.push("f fullscreen")
  if (has("y") || has("n")) parts.push("y/n perm")
  if (has("p")) parts.push("p pause/resume")
  if (has("x")) parts.push("x stop")
  if (has("s")) parts.push("s save")
  if (has("esc") || has("escape") || has("ctrl+g")) parts.push("esc or ctrl+g close")
  const known = new Set([
    "up",
    "down",
    "↑",
    "↓",
    "↑↓",
    "x",
    "p",
    "s",
    "r",
    "return",
    "enter",
    "right",
    "→",
    "enter/→",
    "esc",
    "escape",
    "[",
    "]",
    "y",
    "n",
    "left",
    "←",
    "←→",
    "h",
    "l",
    "f",
    "ctrl+g",
    "+",
    "-",
    "=",
    "+/-",
    ".",
  ])
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
  const more = page.window.length > 0 && page.offset + page.window.length < rows.length
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
