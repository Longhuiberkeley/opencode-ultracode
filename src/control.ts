/**
 * Orchestrator control (stop/pause/resume) of runs owned by this conversation.
 * Host-free mirror of steer.ts: ownership model, transition preconditions,
 * and the supervisor call — unit-testable without a server.
 *
 * Ask mode: `resume` accepts an optional `model` pin (validated "provider/id"
 * or "provider/id#variant") applied as a run-level fallback override, and
 * `remember` persists the model→modelFallbacks entry through the same
 * settings path `/ultracode set` uses (never agent pin files).
 */
import { resolveActiveTarget } from "./command.ts"
import { normalizeModelRef } from "./agent-pins.ts"
import { isActiveRunStatus, type ModelRef, type PauseResumeOutcome, type RunRecord, type RunStatus, type StopOutcome } from "./types.ts"

export type ControlAction = "stop" | "pause" | "resume"

export const CONTROL_ACTIONS: readonly ControlAction[] = ["stop", "pause", "resume"]

export interface ControlImpl {
  /**
   * Truthful stop: { mode: "local" } when a live worker took it,
   * { mode: "orphan", stopReason } when the record was marked interrupted
   * (dead owner, no local worker), or a refusal — including `remote-owner`
   * naming the live owning process. Never a bare boolean for an active run.
   */
  stop(runID: string, reason: string): StopOutcome
  /**
   * Reopen a paused run. Ask mode: `opts.model` becomes the run-level fallback
   * override consulted by every later failover/quarantine route. Refusals
   * carry an actionable error (orphaned / remote-owned / wrong status).
   */
  resume(runID: string, opts?: { model?: ModelRef }): PauseResumeOutcome
  /** Pause: ok:false with an actionable error when not locally live. */
  pause(runID: string): PauseResumeOutcome
}

/** Status the run is expected to show immediately after an accepted action. */
const EXPECTED_STATUS: Record<ControlAction, RunStatus> = {
  stop: "stopping",
  pause: "paused",
  resume: "running",
}

export type ControlResult = { runID: string; action: ControlAction; status: RunStatus } & {
  /** Ask-mode resume: the applied fallback override pin, when one was given. */
  model?: string
  /** Stop only: true when the run was orphaned and marked interrupted (no local worker). */
  orphaned?: boolean
  /** Stop only, orphaned runs: the persisted stopReason (includes the resume hint). */
  stopReason?: string
}

/**
 * Ask-mode resume `remember`: persist the chosen pin through the injected
 * settings-path callback. Shared by the tool executor and the RPC handler.
 * Never throws; a missing callback degrades to a visible `rememberError`.
 */
export async function applyResumeRemember(
  result: ControlResult,
  parsed: { model?: string; remember?: boolean },
  deps: Pick<ControlDeps, "rememberFallback">,
): Promise<{ remembered?: string; rememberError?: string }> {
  if (parsed.remember !== true) return {}
  if (parsed.model === undefined) return { rememberError: "remember requires a model pin" }
  if (!deps.rememberFallback) {
    return { rememberError: "settings persistence unavailable — the fallback applies to this run only" }
  }
  try {
    const stored = await deps.rememberFallback({ runID: result.runID, pin: parsed.model })
    return stored.ok ? { remembered: stored.key } : { rememberError: stored.error }
  } catch (err) {
    return { rememberError: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Control one owned run. Mirrors steer's guardrails:
 * - only runs whose parentSessionID matches the requesting conversation
 *   (unknown ids and foreign runs share one message — steer parity);
 * - explicit runID wins; implicit target only when exactly one active owned run;
 * - settled runs are refused with their current status in the message;
 * - stop carries a reason string, persisted as the run's stop reason
 *   (`/ultracode show` displays it). Pause/resume are not persisted log lines.
 * - resume carries an optional validated fallback override (ask-mode answer).
 */
export function controlRun(
  input: {
    run?: RunRecord
    runID?: string
    parentSessionID: string
    action: ControlAction
    activeOwned: readonly RunRecord[]
    /** Ask-mode resume: validated fallback override (pin shape checked by the caller). */
    model?: ModelRef
    /**
     * Ownership scope. "conversation" (default) requires the run's
     * parentSessionID to match; "project" requires the run's projectID to
     * match `projectID` — the local RPC panel is project-scoped, not a
     * conversation.
     */
    scope?: "conversation" | "project"
    projectID?: string
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
  const owned =
    run !== undefined &&
    (input.scope === "project"
      ? run.projectID !== undefined && run.projectID === input.projectID
      : run.parentSessionID === parentSessionID)
  if (!run || !owned) {
    throw new Error(input.scope === "project" ? "run does not belong to this project" : "run does not belong to this conversation")
  }

  if (action === "stop") {
    if (!isActiveRunStatus(run.status) || run.status === "stopping") {
      throw new Error(`cannot stop a ${run.status} run`)
    }
    const outcome = impl.stop(run.id, `orchestrator stop via ultracode_control`)
    if (!outcome.ok) {
      if (outcome.reason === "remote-owner") {
        const pid = outcome.owner.pid !== undefined ? ` pid ${outcome.owner.pid}` : ""
        throw new Error(
          `run ${run.id} is owned by a live process (${outcome.owner.bootID}${pid}) — control it from that instance`,
        )
      }
      throw new Error(
        `supervisor refused to stop ${run.id} (${outcome.reason}${outcome.reason === "not-active" ? `, status ${outcome.status}` : ""})`,
      )
    }
    // Truthful status: a local stop transitions through `stopping`; an
    // orphan stop already marked the record `interrupted`.
    if (outcome.mode === "orphan") {
      const result: ControlResult = { runID: run.id, action, status: "interrupted", orphaned: true, stopReason: outcome.stopReason }
      return result
    }
  } else if (action === "pause") {
    if (run.status !== "running") {
      throw new Error(`cannot pause a ${run.status} run`)
    }
    const outcome = impl.pause(run.id)
    if (!outcome.ok) {
      throw new Error(outcome.error ?? `supervisor refused to pause ${run.id} (status ${run.status})`)
    }
  } else {
    if (run.status !== "paused") {
      throw new Error(`cannot resume a ${run.status} run`)
    }
    const outcome = impl.resume(run.id, input.model !== undefined ? { model: input.model } : undefined)
    if (!outcome.ok) {
      throw new Error(outcome.error ?? `supervisor refused to resume ${run.id} (status ${run.status})`)
    }
  }
  const result: ControlResult = { runID: run.id, action, status: EXPECTED_STATUS[action] }
  if (action === "resume" && input.model !== undefined) {
    result.model = `${input.model.providerID}/${input.model.id}${input.model.variant !== undefined ? `#${input.model.variant}` : ""}`
  }
  return result
}

/** Dependencies for the tool executor; all injectable for unit tests. */
export interface ControlDeps {
  getRun: (runID: string) => RunRecord | undefined
  activeRuns: () => readonly RunRecord[]
  supervisor?: ControlImpl
  supervisorError?: string
  /** Boot reconciliation; awaited best-effort so persisted dead runs report their real status. */
  reconciled?: Promise<unknown>
  /**
   * On-demand reconcile pass (periodic machinery, run NOW): control decisions
   * must be truthful immediately, not one interval late — a dead owner's run
   * should already read `interrupted` when controlRun evaluates it. Optional
   * and awaited best-effort, same as `reconciled`.
   */
  reconcileNow?: () => Promise<unknown>
  /**
   * `remember: true` persistence: merge the chosen model into the stored
   * modelFallbacks entry for the run's quarantined provider, through the same
   * settings path `/ultracode set` uses (never agent pin files). Returns the
   * key that was remembered.
   */
  rememberFallback?: (
    input: { runID: string; pin: string },
  ) => Promise<{ ok: true; key: string } | { ok: false; error: string }>
}

export type ControlToolInputParsed =
  | { ok: true; action: ControlAction; runID?: string; model?: string; remember?: boolean }
  | { ok: false; error: string }

/**
 * Host-free `ultracode_control` tool executor: validate (caller-side), wait for
 * boot reconciliation, refuse cleanly when the supervisor module is unavailable,
 * scope active runs to this conversation, and shape the content string.
 * Resume extras: the `model` pin becomes the run-level fallback override and
 * `remember` persists it through the injected settings-path callback.
 */
export async function controlToolContent(
  parsed: ControlToolInputParsed,
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
  if (deps.reconcileNow) {
    try {
      await deps.reconcileNow()
    } catch {
      // best-effort: a failed pass leaves the periodic tick as the backstop
    }
  }
  if (!deps.supervisor) {
    return { content: `error: ${deps.supervisorError ?? "workflow tool unavailable"}` }
  }
  // Resume override: fail closed on a bad pin (the validator already checks
  // the shape; this is the normalized form the supervisor applies).
  let model: ModelRef | undefined
  if (parsed.action === "resume" && parsed.model !== undefined) {
    const normalized = normalizeModelRef(parsed.model)
    if (!normalized.ok) return { content: `error: ${normalized.error}` }
    model = normalized.model
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
        ...(model !== undefined ? { model } : {}),
      },
      deps.supervisor,
    )
    let remembered: string | undefined
    let rememberError: string | undefined
    if (parsed.remember === true) {
      const stored = await applyResumeRemember(result, parsed, deps)
      remembered = stored.remembered
      rememberError = stored.rememberError
    }
    const payload: Record<string, unknown> = { ...result }
    if (remembered !== undefined) payload.remembered = remembered
    if (rememberError !== undefined) payload.rememberError = rememberError
    return { content: JSON.stringify(payload) }
  } catch (err) {
    return { content: `error: ${err instanceof Error ? err.message : String(err)}` }
  }
}
