import type { RunRecord } from "./types.ts"

/**
 * Admit an adjustment to one owned, active child without restarting a
 * finished loop.
 *
 * Truthfulness contract (P1-2): `accepted` means the adjustment was durably
 * QUEUED into a child this process is actively driving — never that the child
 * consumed it (consumption is observable only from the child's next turn).
 * The live-worker pre-flight keeps that honest: an orphaned or remote-owned
 * run has nobody to drive the session, so a queued message would rot
 * unconsumed — the 2026-09-27 incident queued into an idle-succeeded
 * recovered child and reported accepted:true. That is rejected.
 *
 * A locally-live worker with an IDLE session (a previous turn finished with
 * a defined outcome) is DIFFERENT (review P2): the driver legitimately sits
 * between turns there — schema repair, retries, and continuations all re-use
 * the same session — so the worker may well take another turn and consume
 * the adjustment. Rejecting that window blocked valid steers. We deliver and
 * say exactly what is known: `idleOutcome` names the last outcome and
 * `consumed: false` stays the truth either way.
 */
export interface SteerDeps {
  /** Deliver the adjustment (session.prompt with resume: false — durable queue). */
  prompt: (input: { sessionID: string; text: string; delivery: "steer"; resume: false }) => Promise<unknown>
  /**
   * Child session state pre-flight. Returns the session's exposed outcome
   * when defined (idle between turns); undefined while busy or unreadable.
   * Absent dep ⇒ the check is skipped (legacy callers/tests).
   */
  sessionState?: (sessionID: string) => Promise<{ outcome?: string } | undefined>
  /** True when THIS process supervises the run's worker. Absent ⇒ skipped. */
  isLocallyLive?: (runID: string) => boolean
}

export async function steerRun(
  run: RunRecord | undefined,
  parentSessionID: string,
  input: { text: string; agentID?: string },
  deps: SteerDeps,
): Promise<{ sessionID: string; agentID: string; delivery: string; consumed: false; idleOutcome?: string }> {
  if (!run || run.parentSessionID !== parentSessionID) throw new Error("run does not belong to this conversation")
  if (run.status !== "running" && run.status !== "paused") throw new Error(`cannot steer a ${run.status} run`)
  if (!input.text.trim()) throw new Error("adjustment text is empty")
  if (deps.isLocallyLive !== undefined && !deps.isLocallyLive(run.id)) {
    throw new Error(
      `run ${run.id} has no live worker in this process (orphaned or owned elsewhere) — steer it from the process driving it, or rerun warm with /ultracode rerun ${run.id} --warm`,
    )
  }
  const active = run.agents.filter((a) => a.status === "running" && a.sessionID)
  const selected = input.agentID ? active.filter((a) => a.id === input.agentID || a.sessionID === input.agentID) : active
  if (selected.length !== 1) throw new Error(`select exactly one running agent with agentID; active: ${active.map((a) => a.id).join(", ") || "none"}`)
  const target = selected[0]!
  let idleOutcome: string | undefined
  if (deps.sessionState !== undefined) {
    let state: { outcome?: string } | undefined
    try {
      state = await deps.sessionState(target.sessionID!)
    } catch {
      state = undefined // unreadable: no evidence of idle — never block on a probe failure
    }
    if (state !== undefined && typeof state.outcome === "string" && state.outcome !== "") {
      // Live worker, idle session: the driver may take another turn (repair/
      // retry/continue) or may not. Deliver and disclose — see the contract
      // above. Hard rejection is reserved for runs with no live worker.
      idleOutcome = state.outcome
    }
  }
  await deps.prompt({ sessionID: target.sessionID!, text: input.text, delivery: "steer", resume: false })
  return {
    sessionID: target.sessionID!,
    agentID: target.id,
    delivery: "queued (durable)",
    consumed: false,
    ...(idleOutcome !== undefined ? { idleOutcome } : {}),
  }
}
