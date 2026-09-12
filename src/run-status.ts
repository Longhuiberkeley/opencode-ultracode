/**
 * Host-free run status: live/persisted snapshots, fallback expiry, RPC parse.
 * TUI heuristics live in tui-render; this module is the merge/lookup core.
 */
import { countAgents, isActiveRunStatus, type AgentRecord, type RunRecord, type RunStatus, type TokenUsage } from "./types.ts"
import { parsePanelSettings, type PanelSettings, type SettingsAck } from "./settings.ts"

/** Bounded staleness window for session-derived "still running" heuristics. */
export const FALLBACK_STALE_MS = 15 * 60 * 1000

export type AuthoritativeSource = "live" | "persisted"

export type AuthoritativeSnapshot = {
  runID: string
  status: RunStatus
  agents: { done: number; total: number; failed: number }
  startedAt: number
  source: AuthoritativeSource
  parentSessionID?: string
  name?: string
  workflowName?: string
  endedAt?: number
  /** Agents currently in status "running" (0 during admission / pending-only). */
  runningCount?: number
  projectID?: string
  directory?: string
  agentDetails?: Pick<
    AgentRecord,
    | "id"
    | "sessionID"
    | "status"
    | "phase"
    | "label"
    | "requestedAgent"
    | "effectiveAgent"
    | "effectiveModel"
    | "tokens"
    | "toolCalls"
  >[]
  queuedCount?: number
}

/** Default cap for the no-id inventory (newest-first). */
export const RUN_STATUS_LIST_LIMIT = 50
export const RUN_STATUS_LIST_LIMIT_MAX = 100

export type RunStateReason = "agent-finished" | "run-completed" | "run-failed"

export type RunStateEvent = {
  runID: string
  status: string
  reason: RunStateReason
}

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "stopping",
  "paused",
  "succeeded",
  "failed",
  "stopped",
  "interrupted",
])

export function sessionActivityMs(
  time: number | { created?: number; updated?: number; idle?: number } | undefined,
): number | undefined {
  if (typeof time === "number" && Number.isFinite(time)) return time
  if (time && typeof time === "object") {
    if (typeof time.updated === "number" && Number.isFinite(time.updated)) return time.updated
    if (typeof time.idle === "number" && Number.isFinite(time.idle)) return time.idle
    if (typeof time.created === "number" && Number.isFinite(time.created)) return time.created
  }
  return undefined
}

/**
 * True when a child must not keep a run counted as running: empty outcome,
 * no execution observation, and activity older than the named window.
 * Missing activity time keeps the existing heuristic (not expired).
 */
export function isFallbackExpired(
  input: {
    outcome?: string
    lastExecution?: string
    activityMs?: number
  },
  nowTs: number,
  windowMs: number = FALLBACK_STALE_MS,
): boolean {
  if (input.outcome !== undefined && input.outcome !== "") return false
  if (input.lastExecution) return false
  if (input.activityMs === undefined) return false
  return nowTs - input.activityMs > windowMs
}

export function isFinalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped" || status === "interrupted"
}

export type SnapshotScope = {
  projectID?: string
  directory?: string
}

function runningAgentCount(record: RunRecord): number {
  let n = 0
  for (const agent of record.agents) {
    if (agent.status === "running") n++
  }
  return n
}

export function authoritativeFromRecord(
  record: RunRecord,
  source: AuthoritativeSource,
  scope?: SnapshotScope,
): AuthoritativeSnapshot {
  const counts = countAgents(record)
  const snap: AuthoritativeSnapshot = {
    runID: record.id,
    status: record.status,
    agents: {
      done: counts.succeeded + counts.failed + counts.interrupted,
      total: counts.total,
      failed: counts.failed,
    },
    startedAt: record.startedAt,
    source,
    parentSessionID: record.parentSessionID,
    runningCount: runningAgentCount(record),
    queuedCount: record.agents.filter((a) => a.status === "pending").length,
    // Provenance fields ride along so warm-replayed (cached) children — which
    // have no session in THIS run for the panel's heuristic join — still
    // render agent/model/tokens/toolCalls instead of "-". Undefined-valued
    // keys drop at serialization, so unfinished children stay lean.
    agentDetails: record.agents.map(
      ({ id, sessionID, status, phase, label, requestedAgent, effectiveAgent, effectiveModel, tokens, toolCalls }) => ({
        id,
        sessionID,
        status,
        phase,
        label,
        requestedAgent,
        effectiveAgent,
        effectiveModel,
        tokens,
        toolCalls,
      }),
    ),
  }
  if (record.name) snap.name = record.name
  if (record.workflowName) snap.workflowName = record.workflowName
  if (record.endedAt !== undefined) snap.endedAt = record.endedAt
  if (record.projectID ?? scope?.projectID) snap.projectID = record.projectID ?? scope?.projectID
  if (record.directory ?? scope?.directory) snap.directory = record.directory ?? scope?.directory
  return snap
}

/** Live registry wins over persisted storage; neither → undefined (heuristic). */
export function selectAuthoritative(
  live: AuthoritativeSnapshot | undefined,
  persisted: AuthoritativeSnapshot | undefined,
): AuthoritativeSnapshot | undefined {
  return live ?? persisted
}

export function collectRunStatus(input: {
  runID?: string
  sessionID?: string
  limit?: number
  includeFinished?: boolean
  liveGet: (id: string) => RunRecord | undefined
  liveList: () => readonly RunRecord[]
  persistedList: () => readonly RunRecord[]
  projectID?: string
  directory?: string
}): AuthoritativeSnapshot[] {
  const scope: SnapshotScope = { projectID: input.projectID, directory: input.directory }
  const stamp = (record: RunRecord, source: AuthoritativeSource): AuthoritativeSnapshot =>
    authoritativeFromRecord(record, source, scope)
  const matchesSession = (snap: AuthoritativeSnapshot): boolean => {
    if (!input.sessionID) return true
    return snap.parentSessionID === input.sessionID
  }
  const matchesLocation = (snap: AuthoritativeSnapshot): boolean => {
    if (input.projectID && snap.projectID && snap.projectID !== input.projectID) return false
    if (input.directory && snap.directory && snap.directory !== input.directory) return false
    return true
  }
  const matches = (snap: AuthoritativeSnapshot): boolean => matchesSession(snap) && matchesLocation(snap)
  const persistedGet = (id: string): RunRecord | undefined => input.persistedList().find((r) => r.id === id)
  if (input.runID) {
    const live = input.liveGet(input.runID)
    if (live) {
      const snap = stamp(live, "live")
      return matches(snap) ? [snap] : []
    }
    const persisted = persistedGet(input.runID)
    if (persisted) {
      const snap = stamp(persisted, "persisted")
      return matches(snap) ? [snap] : []
    }
    return []
  }
  const byID = new Map<string, AuthoritativeSnapshot>()
  for (const record of input.persistedList()) byID.set(record.id, stamp(record, "persisted"))
  for (const record of input.liveList()) byID.set(record.id, stamp(record, "live"))
  let items = [...byID.values()].filter(matches)
  if (input.includeFinished === false) {
    items = items.filter((s) => s.status === "running" || s.status === "stopping" || s.status === "paused")
  }
  items.sort((a, b) => b.startedAt - a.startedAt || (a.runID < b.runID ? 1 : -1))
  const rawLimit = input.limit ?? RUN_STATUS_LIST_LIMIT
  const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : RUN_STATUS_LIST_LIMIT, RUN_STATUS_LIST_LIMIT_MAX))
  return items.slice(0, limit)
}

/**
 * True when a runState payload belongs to this project/cwd.
 * Missing location on the event fails closed when a scope is set (cross-location
 * RPC events must not refresh this TUI). Unscoped callers get false.
 */
export function runStateEventInScope(
  event: unknown,
  scope: { directory?: string; projectID?: string } | undefined,
): boolean {
  if (!scope || (scope.directory === undefined && scope.projectID === undefined)) return false
  if (event === null || event === undefined || typeof event !== "object" || Array.isArray(event)) return false
  const rec = event as Record<string, unknown>
  const locRaw = rec.location
  let locDir: string | undefined
  let locPid: string | undefined
  if (typeof locRaw === "string" && locRaw !== "") locDir = locRaw
  else if (locRaw && typeof locRaw === "object" && !Array.isArray(locRaw)) {
    const loc = locRaw as Record<string, unknown>
    if (typeof loc.directory === "string" && loc.directory !== "") locDir = loc.directory
    const project = loc.project
    if (project && typeof project === "object" && !Array.isArray(project)) {
      const p = project as Record<string, unknown>
      if (typeof p.directory === "string" && p.directory !== "") locDir = locDir ?? p.directory
      if (typeof p.id === "string" && p.id !== "") locPid = p.id
    }
    if (typeof loc.projectID === "string" && loc.projectID !== "") locPid = locPid ?? loc.projectID
  }
  const dataRaw = rec.payload && typeof rec.payload === "object" && !Array.isArray(rec.payload) ? rec.payload : rec
  const data = dataRaw as Record<string, unknown>
  const dir = optionalNonEmptyString(data.directory) ?? locDir
  const pid = optionalNonEmptyString(data.projectID) ?? locPid
  if (!dir && !pid) return false
  if (pid && scope.projectID && pid !== scope.projectID) return false
  if (dir && scope.directory && dir !== scope.directory) return false
  return true
}

export function agentStatusKey(agents: ReadonlyArray<{ id: string; status: string }>): string {
  return agents.map((a) => `${a.id}:${a.status}`).join(",")
}

export function runStateTransition(
  prev: { status: string; agentKey: string } | undefined,
  next: { id: string; status: string; agents: ReadonlyArray<{ id: string; status: string }> },
): RunStateEvent | undefined {
  if (!prev) return undefined
  const agentKey = agentStatusKey(next.agents)
  if (prev.status !== next.status) {
    if (next.status === "succeeded" || next.status === "stopped") {
      return { runID: next.id, status: next.status, reason: "run-completed" }
    }
    if (next.status === "failed" || next.status === "interrupted") {
      return { runID: next.id, status: next.status, reason: "run-failed" }
    }
  }
  if (prev.agentKey === agentKey) return undefined
  const prevMap = new Map<string, string>()
  for (const part of prev.agentKey.split(",")) {
    if (!part) continue
    const idx = part.indexOf(":")
    if (idx <= 0) continue
    prevMap.set(part.slice(0, idx), part.slice(idx + 1))
  }
  const finished = next.agents.some((a) => {
    const was = prevMap.get(a.id)
    const nowFinal = a.status === "succeeded" || a.status === "failed" || a.status === "interrupted"
    return nowFinal && was !== a.status
  })
  if (finished) return { runID: next.id, status: next.status, reason: "agent-finished" }
  return undefined
}

export function parseRunStatusResponse(raw: unknown): AuthoritativeSnapshot[] | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const runs = (raw as { runs?: unknown }).runs
  if (!Array.isArray(runs)) return undefined
  const out: AuthoritativeSnapshot[] = []
  for (const item of runs) {
    const snap = parseSnapshot(item)
    if (snap) out.push(snap)
  }
  return out
}

function parseSnapshot(raw: unknown): AuthoritativeSnapshot | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.runID !== "string" || rec.runID === "") return undefined
  if (typeof rec.status !== "string" || !RUN_STATUSES.has(rec.status)) return undefined
  if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) return undefined
  const source = rec.source === "persisted" ? "persisted" : rec.source === "live" ? "live" : undefined
  if (!source) return undefined
  const agentsRaw = rec.agents
  if (agentsRaw === null || agentsRaw === undefined || typeof agentsRaw !== "object" || Array.isArray(agentsRaw)) {
    return undefined
  }
  const agents = agentsRaw as Record<string, unknown>
  const done = agents.done
  const total = agents.total
  const failed = agents.failed
  if (typeof done !== "number" || typeof total !== "number" || typeof failed !== "number") return undefined
  const snap: AuthoritativeSnapshot = {
    runID: rec.runID,
    status: rec.status as RunStatus,
    startedAt: rec.startedAt,
    source,
    agents: { done, total, failed },
  }
  const parentSessionID = optionalNonEmptyString(rec.parentSessionID)
  if (parentSessionID) snap.parentSessionID = parentSessionID
  const name = optionalNonEmptyString(rec.name)
  if (name) snap.name = name
  const workflowName = optionalNonEmptyString(rec.workflowName)
  if (workflowName) snap.workflowName = workflowName
  const endedAt = optionalFiniteNumber(rec.endedAt)
  if (endedAt !== undefined) snap.endedAt = endedAt
  const runningCount = optionalFiniteNumber(rec.runningCount)
  if (runningCount !== undefined) snap.runningCount = runningCount
  const queuedCount = optionalFiniteNumber(rec.queuedCount)
  if (queuedCount !== undefined) snap.queuedCount = Math.max(0, queuedCount)
  if (Array.isArray(rec.agentDetails)) {
    snap.agentDetails = rec.agentDetails.flatMap((value) => {
      if (!value || typeof value !== "object") return []
      const a = value as Record<string, unknown>
      if (typeof a.id !== "string" || !["pending", "running", "succeeded", "failed", "interrupted"].includes(String(a.status))) return []
      return [{
        id: a.id,
        status: a.status as AgentRecord["status"],
        sessionID: optionalNonEmptyString(a.sessionID),
        phase: optionalNonEmptyString(a.phase),
        label: optionalNonEmptyString(a.label),
        requestedAgent: optionalNonEmptyString(a.requestedAgent),
        effectiveAgent: optionalNonEmptyString(a.effectiveAgent),
        effectiveModel: parseModelRef(a.effectiveModel),
        tokens: parseTokenUsage(a.tokens),
        toolCalls: optionalFiniteNumber(a.toolCalls),
      }]
    })
  }
  const projectID = optionalNonEmptyString(rec.projectID)
  if (projectID) snap.projectID = projectID
  const directory = optionalNonEmptyString(rec.directory)
  if (directory) snap.directory = directory
  return snap
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function parseModelRef(value: unknown): { providerID: string; id: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as { providerID?: unknown; id?: unknown }
  if (typeof v.providerID !== "string" || typeof v.id !== "string") return undefined
  return { providerID: v.providerID, id: v.id }
}

function parseTokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined
  const v = value as Record<string, unknown>
  const input = optionalFiniteNumber(v.input)
  const output = optionalFiniteNumber(v.output)
  if (input === undefined || output === undefined) return undefined
  const c = (v.cache && typeof v.cache === "object" ? v.cache : {}) as Record<string, unknown>
  return {
    input,
    output,
    reasoning: optionalFiniteNumber(v.reasoning) ?? 0,
    cache: { read: optionalFiniteNumber(c.read) ?? 0, write: optionalFiniteNumber(c.write) ?? 0 },
  }
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function parseSettingsResponse(raw: unknown): SettingsAck | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const overlay = parsePanelSettings(rec.overlay)
  if (!overlay) return undefined
  const ack: SettingsAck = { overlay }
  if (typeof rec.runID === "string") ack.runID = rec.runID
  const effective = parsePanelSettings(rec.effective)
  if (effective) ack.effective = effective
  return ack
}

export function settingsPayload(
  overlay: PanelSettings,
  runID: string | undefined,
  effective: PanelSettings | undefined,
): SettingsAck {
  const ack: SettingsAck = { overlay }
  if (runID) ack.runID = runID
  if (effective) ack.effective = effective
  return ack
}

/** True when ctx.rpc.register exists. Callables with .register count (SDK may assign onto a function). */
export function hasRpcRegister(rpc: unknown): boolean {
  if (rpc === null || rpc === undefined) return false
  if (typeof rpc !== "object" && typeof rpc !== "function") return false
  return typeof (rpc as { register?: unknown }).register === "function"
}

export function hasRpcClientFactory(rpc: unknown): boolean {
  return typeof rpc === "function"
}

export { isActiveRunStatus }
