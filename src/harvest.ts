/**
 * Orphan harvest — salvage succeeded children of a dead owner BEFORE the
 * orphan flip abandons the run.
 *
 * WHY: child success is written back only when the awaiting worker call
 * returns (primitives.ts). When the owner process dies mid-fanout, OpenCode's
 * own session recovery may still finish the child sessions (synthetic
 * "server restarted, continue" message) — observed 2026-09-27: six verifier
 * children finished idle-succeeded with valid schema JSON and were still
 * flipped to interrupted, all six salvageable and none salvaged.
 *
 * Harvest queries each persisted `running` child's session outcome; a
 * succeeded outcome becomes a durable `succeeded` row carrying
 * data/resultText over the key/digest/schema the runner persisted at child
 * START, so a warm resume (`resumeFrom` / `/ultracode rerun --warm`) replays
 * it instead of redoing the work.
 *
 * Contract:
 * - called ONLY for runs whose owner is provably dead (dead pid / dead
 *   marker). Never on heartbeat staleness alone — a live owner's children
 *   belong to the owner.
 * - bounded: at most MAX_HARVEST_CHILDREN children per pass, one get + one
 *   context per child, no retries.
 * - NO repair rounds: there is no live model loop here. A schema mismatch is
 *   recorded as unresolvable and the row stays interrupted (the flip owns it).
 * - legacy rows without a stored schema harvest only schema-less calls
 *   (text-keyed replay); schema-mode calls cannot be validated against a
 *   contract nobody recorded, so they stay unresolvable.
 */
import type { AgentRecord, ContextMessage, Json, RunRecord, TokenUsage } from "./types.ts"
import { requestContext } from "./types.ts"
import { assistantText } from "./sessions.ts"
import { extractJson, validateJsonSchemaValue } from "./serialize.ts"

/** Narrow session surface harvest needs (SessionCtx satisfies it). */
export interface HarvestSessionCtx {
  get(input: { sessionID: string }): Promise<{ outcome?: string; tokens?: TokenUsage; error?: string }>
  context(input: { sessionID: string }): Promise<ReadonlyArray<ContextMessage>>
}

export interface HarvestDeps {
  sessions: HarvestSessionCtx
  updateAgent: (runID: string, agentID: string, patch: Partial<AgentRecord>) => void
  now?: () => number
}

export interface HarvestReport {
  /** Children salvaged into succeeded rows (warm-replayable when keyed). */
  harvested: number
  /** Children whose session outcome was terminal-failure; marked failed. */
  failed: number
  /** Children whose result could not be resolved; left for the flip. */
  unresolvable: number
}

/** Hard bound per run — a pathological record can never wedge the tick. */
export const MAX_HARVEST_CHILDREN = 20

/**
 * Last assistant message plus the most recent message-level usage that yields
 * a request context — the same tail scan the driver's readAssistantReply
 * performs, minus the throwing (harvest decides what is resolvable).
 */
function lastAssistant(messages: ReadonlyArray<ContextMessage>): {
  last: ContextMessage | undefined
  usage: ContextMessage | undefined
} {
  let last: ContextMessage | undefined
  let usage: ContextMessage | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.type !== "assistant") continue
    if (last === undefined) last = message
    if (usage === undefined && requestContext(message.tokens) !== undefined) usage = message
    if (last !== undefined && usage !== undefined) break
  }
  return { last, usage }
}

/**
 * Harvest one dead-owner run. Mutates rows through `updateAgent` only — the
 * caller then applies the orphan flip for whatever is still active. Safe to
 * call on a record whose children were already harvested (rows are terminal
 * and skipped by the `running` filter).
 */
export async function harvestOrphanedRun(run: RunRecord, deps: HarvestDeps): Promise<HarvestReport> {
  const now = deps.now ?? Date.now
  const report: HarvestReport = { harvested: 0, failed: 0, unresolvable: 0 }
  const targets = run.agents
    .filter((a) => a.status === "running" && typeof a.sessionID === "string" && a.sessionID !== "")
    .slice(0, MAX_HARVEST_CHILDREN)
  for (const agent of targets) {
    const sessionID = agent.sessionID as string
    let info: { outcome?: string; tokens?: TokenUsage; error?: string }
    try {
      info = await deps.sessions.get({ sessionID })
    } catch {
      report.unresolvable++
      continue
    }
    const outcome = info?.outcome
    if (outcome === "succeeded") {
      const salvaged = await harvestSucceeded(run, agent, sessionID, info, deps, now)
      if (salvaged) report.harvested++
      else report.unresolvable++
    } else if (typeof outcome === "string" && outcome !== "") {
      // Terminal non-success (failed/aborted/...): record the truth.
      deps.updateAgent(run.id, agent.id, {
        status: "failed",
        endedAt: now(),
        error: `harvest: session outcome "${outcome}" after owner death${typeof info.error === "string" && info.error !== "" ? `: ${info.error.slice(0, 300)}` : ""}`,
      })
      report.failed++
    } else {
      // No outcome exposed: the session is busy, unreadable, or an API shape
      // we do not understand — leave it for the flip (interrupted), never
      // guess success.
      report.unresolvable++
    }
  }
  return report
}

/** Try to salvage one succeeded session into a warm-replayable row. */
async function harvestSucceeded(
  run: RunRecord,
  agent: AgentRecord,
  sessionID: string,
  info: { tokens?: TokenUsage },
  deps: HarvestDeps,
  now: () => number,
): Promise<boolean> {
  let messages: ReadonlyArray<ContextMessage>
  try {
    messages = await deps.sessions.context({ sessionID })
  } catch {
    return false
  }
  const { last, usage } = lastAssistant(messages)
  if (last === undefined) return false
  const text = assistantText(last)
  // Schema calls must validate against the RECORDED contract — exactly what
  // the caller asked at spawn time. No live model => no repair; a mismatch is
  // unresolvable, not silently accepted.
  let data: Json | undefined
  if (agent.schema !== undefined) {
    const extracted = extractJson(text)
    if (!extracted.ok) return false
    const check = validateJsonSchemaValue(agent.schema, extracted.value)
    if (!check.ok) return false
    data = extracted.value
  } else if (agent.key !== undefined && extractJson(text).ok) {
    // Legacy keyed row (schema field predates harvest support): the text
    // parses as JSON, so this was very likely a schema call whose contract
    // was never recorded — replaying it warm would hand the caller a result
    // with no `.data`. Unresolvable; the flip owns it. Prose results of
    // genuine text-only calls fall through and harvest safely.
    return false
  }
  const contextTokens = requestContext(usage?.tokens)
  const tokens = info.tokens ?? last.tokens
  deps.updateAgent(run.id, agent.id, {
    status: "succeeded",
    endedAt: now(),
    ...(last.agent !== undefined ? { effectiveAgent: last.agent } : {}),
    ...(last.model !== undefined ? { effectiveModel: last.model } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(data !== undefined ? { data } : {}),
    // Only keyed rows persist result text (mirrors the live success path).
    ...(agent.key !== undefined ? { resultText: text } : {}),
    // Provenance: this success was salvaged after an owner death, not
    // returned by a live worker.
    harvested: true,
  })
  return true
}
