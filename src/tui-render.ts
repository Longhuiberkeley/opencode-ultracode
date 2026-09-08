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
  interrupted: "■",
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
  parent?: string
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
  const buckets = new Map<string, { agents: RunAgentView[]; order: number; parent?: string }>()
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

export function runningRunCount(runs: readonly RunView[]): number {
  let n = 0
  for (const run of runs) if (!run.settled) n++
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

export type RunAckKind = "paused" | "resumed" | "stopped" | "saved" | "error"

export type RunAck = { runID?: string; kind: RunAckKind }

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

/** Run whose parsed parent matches, else most recently started. */
export function defaultRunIndex(runs: readonly RunView[], parentSessionID?: string): number {
  if (runs.length === 0) return 0
  if (parentSessionID) {
    const hit = runs.findIndex((r) => r.parent === parentSessionID)
    if (hit >= 0) return hit
  }
  let best = 0
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.startedAt > runs[best]!.startedAt) best = i
  }
  return best
}

export type InspectSel = {
  /** Undefined → defaultRunIndex(parentSessionID). */
  runIndex?: number
  /** `"all"` (default), `"-"`, or a named phase. */
  phase?: string
  offset: number
  selected: number
  parentSessionID?: string
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
}

/** Defaults for a run that has never been selected. */
export const UNSEEN_RUN_SELECTION = { phase: "all", offset: 0, selected: 0, rowInWindow: 0 } as const

export type CycleRunSelectionResult = {
  runID: string | undefined
  selection: { phase: string; offset: number; selected: number; rowInWindow: number }
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
    return {
      runID,
      selection: {
        phase: stored.phase,
        offset: stored.offset,
        selected: stored.selected,
        rowInWindow: stored.rowInWindow ?? 0,
      },
    }
  }
  return { runID, selection: { ...UNSEEN_RUN_SELECTION } }
}

export function selectionMapKey(parentSessionID: string | undefined, runID: string | undefined): string {
  return `${parentSessionID ?? ""}\0${runID ?? ""}`
}

/**
 * Opening the inspector from parent P defaults to P's run (parsed parent
 * segment) and resets to that default whenever the open-parent changes.
 * Same parent keeps the previous per-run entry when that run still exists.
 */
export function selectForOpen(
  prev: InspectSelection | undefined,
  runs: readonly RunView[],
  openParentID: string | undefined,
): InspectSelection {
  const idx = defaultRunIndex(runs, openParentID)
  const runID = runs.length === 0 ? undefined : runs[idx]?.runID
  if (prev && prev.parentSessionID === openParentID) {
    const still = prev.runID !== undefined && runs.some((r) => r.runID === prev.runID)
    if (still) return { ...prev, parentSessionID: openParentID }
  }
  return {
    parentSessionID: openParentID,
    runID,
    phase: "all",
    offset: 0,
    selected: 0,
  }
}

export function inspectSelFromSelection(sel: InspectSelection, runs: readonly RunView[]): InspectSel {
  const hit = sel.runID ? runs.findIndex((r) => r.runID === sel.runID) : -1
  return {
    runIndex: hit >= 0 ? hit : undefined,
    phase: sel.phase,
    offset: sel.offset,
    selected: sel.selected,
    parentSessionID: sel.parentSessionID,
  }
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
}

/** Visible-row session id: `rows`/`sessionIDs` index = offset + rowInWindow. */
export function selectedSessionID(model: InspectModel): string | undefined {
  return model.sessionIDs[model.offset + model.rowInWindow]
}

/**
 * All per-frame inspect derivation. Component bodies must not regroup or
 * recompute rows — they render this model.
 */
export function inspectModel(sessions: SessionView[], sel: InspectSel, nowTs: number): InspectModel {
  const runs = groupRuns(sessions)
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
    }
  }

  const phases = inspectPhaseList(run)
  const wantPhase = sel.phase ?? "all"
  const selectedPhase = phases.includes(wantPhase) ? wantPhase : "all"
  const agents = agentsForPhase(run, selectedPhase)
  const rows = agentRows(run, selectedPhase)
  const sessionIDs = agents.map((a) => a.sessionID)
  const selected = rows.length === 0 ? 0 : Math.min(Math.max(0, Math.floor(sel.selected)), rows.length - 1)
  const page = paginate(rows, sel.offset, 10)
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
  }
  model.selectedSessionID = selectedSessionID(model)
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
  if (has("p")) parts.push("p pause/resume")
  if (has("s")) parts.push("s save")
  if (has("[") || has("]")) parts.push("[ ] run")
  const enter = has("return", "enter", "enter/→")
  const right = has("right", "→", "enter/→")
  if (enter && right) parts.push("enter/→ drill")
  else if (enter) parts.push("enter drill")
  else if (right) parts.push("→ drill")
  if (has("esc")) parts.push("esc close")
  const known = new Set(["up", "down", "↑", "↓", "↑↓", "x", "p", "s", "return", "enter", "right", "→", "enter/→", "esc", "[", "]", "left", "←"])
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
