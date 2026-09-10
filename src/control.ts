/**
 * Orchestrator control (stop/pause/resume) of runs owned by this conversation.
 * Host-free mirror of steer.ts: ownership model, transition preconditions,
 * and the supervisor call — unit-testable without a server.
 */
import { resolveActiveTarget } from "./command.ts"
import { isActiveRunStatus, type RunRecord, type RunStatus } from "./types.ts"

export type ControlAction = "stop" | "pause" | "resume"

export const CONTROL_ACTIONS: readonly ControlAction[] = ["stop", "pause", "resume"]

export interface ControlImpl {
  stop(runID: string, reason: string): boolean
  pause(runID: string): boolean
  resume(runID: string): boolean
}

/** Status the run is expected to show immediately after an accepted action. */
const EXPECTED_STATUS: Record<ControlAction, RunStatus> = {
  stop: "stopping",
  pause: "paused",
  resume: "running",
}

export type ControlResult = { runID: string; action: ControlAction; status: RunStatus }

/**
 * Control one owned run. Mirrors steer's guardrails:
 * - only runs whose parentSessionID matches the requesting conversation
 *   (unknown ids and foreign runs share one message — steer parity);
 * - explicit runID wins; implicit target only when exactly one active owned run;
 * - settled runs are refused with their current status in the message;
 * - stop carries a reason string, persisted as the run's stop reason
 *   (`/ultracode show` displays it). Pause/resume are not persisted log lines.
 */
export function controlRun(
  input: {
    run?: RunRecord
    runID?: string
    parentSessionID: string
    action: ControlAction
    activeOwned: readonly RunRecord[]
  },
  impl: ControlImpl,
): ControlResult {
  const { action, parentSessionID } = input
  let run = input.run
  if (!run && !input.runID) {
    const target = resolveActiveTarget("", input.activeOwned)
    if (!target.ok) throw new Error(target.error)
    run = input.activeOwned.find((r) => r.id === target.runID)
  }
  if (!run || run.parentSessionID !== parentSessionID) {
    throw new Error("run does not belong to this conversation")
  }

  if (action === "stop") {
    if (!isActiveRunStatus(run.status) || run.status === "stopping") {
      throw new Error(`cannot stop a ${run.status} run`)
    }
    if (!impl.stop(run.id, `orchestrator stop via ultracode_control`)) {
      throw new Error(`supervisor refused to stop ${run.id} (status ${run.status})`)
    }
  } else if (action === "pause") {
    if (run.status !== "running") {
      throw new Error(`cannot pause a ${run.status} run`)
    }
    if (!impl.pause(run.id)) {
      throw new Error(`supervisor refused to pause ${run.id} (status ${run.status})`)
    }
  } else {
    if (run.status !== "paused") {
      throw new Error(`cannot resume a ${run.status} run`)
    }
    if (!impl.resume(run.id)) {
      throw new Error(`supervisor refused to resume ${run.id} (status ${run.status})`)
    }
  }
  return { runID: run.id, action, status: EXPECTED_STATUS[action] }
}

/** Dependencies for the tool executor; all injectable for unit tests. */
export interface ControlDeps {
  getRun: (runID: string) => RunRecord | undefined
  activeRuns: () => readonly RunRecord[]
  supervisor?: ControlImpl
  supervisorError?: string
  /** Boot reconciliation; awaited best-effort so persisted dead runs report their real status. */
  reconciled?: Promise<unknown>
}

/**
 * Host-free `ultracode_control` tool executor: validate (caller-side), wait for
 * boot reconciliation, refuse cleanly when the supervisor module is unavailable,
 * scope active runs to this conversation, and shape the content string.
 */
export async function controlToolContent(
  parsed: { ok: true; action: ControlAction; runID?: string } | { ok: false; error: string },
  sessionID: string,
  deps: ControlDeps,
): Promise<{ content: string }> {
  if (!parsed.ok) return { content: `error: ${parsed.error}` }
  if (deps.reconciled) {
    try {
      await deps.reconciled
    } catch {
      // best-effort: reconciliation failures must not block control
    }
  }
  if (!deps.supervisor) {
    return { content: `error: ${deps.supervisorError ?? "workflow tool unavailable"}` }
  }
  try {
    const activeOwned = deps.activeRuns().filter((r) => r.parentSessionID === sessionID)
    const result = controlRun(
      {
        run: parsed.runID ? deps.getRun(parsed.runID) : undefined,
        runID: parsed.runID,
        parentSessionID: sessionID,
        action: parsed.action,
        activeOwned,
      },
      deps.supervisor,
    )
    return { content: JSON.stringify(result) }
  } catch (err) {
    return { content: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
