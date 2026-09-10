/**
 * Orchestrator control (src/control.ts): ownership, transitions, implicit target.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { CONTROL_ACTIONS, controlRun, type ControlImpl } from "../src/control.ts"
import { validateControlToolInput } from "../src/tool-input.ts"
import type { RunRecord } from "../src/types.ts"

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run_test",
  parentSessionID: "ses_parent",
  status: "running",
  script: "return 1",
  startedAt: 1,
  agents: [],
  ...over,
})

const implRecording = (): { impl: ControlImpl; calls: Array<[string, string?]> } => {
  const calls: Array<[string, string?]> = []
  return {
    calls,
    impl: {
      stop: (runID, reason) => {
        calls.push(["stop", reason])
        return true
      },
      pause: (runID) => {
        calls.push(["pause"])
        return true
      },
      resume: (runID) => {
        calls.push(["resume"])
        return true
      },
    },
  }
}

test("control happy paths: stop carries an orchestrator reason, pause/resume map to expected status", () => {
  const { impl, calls } = implRecording()
  assert.deepEqual(
    controlRun({ run: run(), parentSessionID: "ses_parent", action: "stop", activeOwned: [] }, impl),
    { runID: "run_test", action: "stop", status: "stopping" },
  )
  assert.deepEqual(
    controlRun({ run: run({ status: "running" }), parentSessionID: "ses_parent", action: "pause", activeOwned: [] }, impl),
    { runID: "run_test", action: "pause", status: "paused" },
  )
  assert.deepEqual(
    controlRun({ run: run({ status: "paused" }), parentSessionID: "ses_parent", action: "resume", activeOwned: [] }, impl),
    { runID: "run_test", action: "resume", status: "running" },
  )
  assert.deepEqual(calls, [
    ["stop", "orchestrator stop via ultracode_control"],
    ["pause"],
    ["resume"],
  ])
})

test("control rejects foreign runs, unknown ids, and wrong transitions", () => {
  const { impl } = implRecording()
  assert.throws(
    () => controlRun({ run: run(), parentSessionID: "ses_other", action: "stop", activeOwned: [] }, impl),
    /belong/,
  )
  // Unknown ids and foreign runs share one message — steer parity.
  assert.throws(
    () => controlRun({ runID: "run_missing", parentSessionID: "ses_parent", action: "stop", activeOwned: [] }, impl),
    /belong/,
  )
  // Stop from paused is legal at both layers (supervisor.stop accepts paused).
  const fromPaused = implRecording()
  assert.equal(
    controlRun({ run: run({ status: "paused" }), parentSessionID: "ses_parent", action: "stop", activeOwned: [] }, fromPaused.impl).status,
    "stopping",
  )
  for (const status of ["succeeded", "failed", "stopped", "interrupted", "stopping"] as const) {
    assert.throws(
      () => controlRun({ run: run({ status }), parentSessionID: "ses_parent", action: "stop", activeOwned: [] }, impl),
      new RegExp(`cannot stop a ${status}`),
    )
  }
  assert.throws(
    () => controlRun({ run: run({ status: "paused" }), parentSessionID: "ses_parent", action: "pause", activeOwned: [] }, impl),
    /cannot pause a paused/,
  )
  assert.throws(
    () => controlRun({ run: run({ status: "running" }), parentSessionID: "ses_parent", action: "resume", activeOwned: [] }, impl),
    /cannot resume a running/,
  )
})

test("control refuses when the supervisor refuses", () => {
  const refusing: ControlImpl = {
    stop: () => false,
    pause: () => false,
    resume: () => false,
  }
  assert.throws(
    () => controlRun({ run: run(), parentSessionID: "ses_parent", action: "stop", activeOwned: [] }, refusing),
    /refused to stop/,
  )
})

test("control implicit target: exactly one active owned run resolves; zero and several error", () => {
  const { impl } = implRecording()
  const only = run()
  assert.deepEqual(
    controlRun({ parentSessionID: "ses_parent", action: "pause", activeOwned: [only] }, impl),
    { runID: "run_test", action: "pause", status: "paused" },
  )
  assert.throws(
    () => controlRun({ parentSessionID: "ses_parent", action: "pause", activeOwned: [] }, impl),
    /no active run/,
  )
  assert.throws(
    () =>
      controlRun(
        { parentSessionID: "ses_parent", action: "pause", activeOwned: [run(), run({ id: "run_two" })] },
        impl,
      ),
    /multiple active runs/,
  )
})

test("validateControlToolInput: action required, enum-checked, runID optional", () => {
  assert.deepEqual(validateControlToolInput({ action: "stop" }), { ok: true, action: "stop" })
  assert.deepEqual(validateControlToolInput({ action: "pause", runID: "run_x" }), {
    ok: true,
    action: "pause",
    runID: "run_x",
  })
  assert.equal(validateControlToolInput({}).ok, false)
  assert.equal(validateControlToolInput({ action: "destroy" }).ok, false)
  assert.equal(validateControlToolInput({ action: "stop", runID: "" }).ok, false)
  assert.equal(validateControlToolInput({ action: "stop", extra: 1 }).ok, false)
  assert.deepEqual(CONTROL_ACTIONS, ["stop", "pause", "resume"])
})

// ---------------------------------------------------------------------------
// controlToolContent: the tool executor wiring (ownership filter, supervisor
// availability, reconciliation wait) — security-critical, so pinned by fakes.
// ---------------------------------------------------------------------------

import { controlToolContent } from "../src/control.ts"

const recording = () => {
  const calls: Array<[string, string?]> = []
  return {
    calls,
    supervisor: {
      stop: (runID: string, reason: string) => {
        calls.push(["stop", reason])
        return true
      },
      pause: () => true,
      resume: () => true,
    },
  }
}

test("controlToolContent: happy path returns the control result JSON", async () => {
  const { supervisor } = recording()
  const out = await controlToolContent({ ok: true, action: "pause" }, "ses_parent", {
    getRun: () => undefined,
    activeRuns: () => [run()],
    supervisor,
  })
  assert.deepEqual(JSON.parse(out.content), { runID: "run_test", action: "pause", status: "paused" })
})

test("controlToolContent: foreign explicit runID is refused even when activeRuns is unfiltered", async () => {
  const { supervisor } = recording()
  const foreign = run({ parentSessionID: "ses_other" })
  const out = await controlToolContent({ ok: true, action: "stop", runID: "run_test" }, "ses_parent", {
    getRun: (id) => (id === "run_test" ? foreign : undefined),
    activeRuns: () => [foreign],
    supervisor,
  })
  assert.match(out.content, /belong/)
})

test("controlToolContent: missing supervisor reports supervisorError, not a fake refusal", async () => {
  const out = await controlToolContent({ ok: true, action: "stop" }, "ses_parent", {
    getRun: () => undefined,
    activeRuns: () => [run()],
    supervisorError: "workflow tool unavailable: the supervisor module failed to load",
  })
  assert.match(out.content, /supervisor module failed to load/)
})

test("controlToolContent: waits for boot reconciliation before deciding", async () => {
  const { supervisor } = recording()
  const persisted = run({ status: "running" }) // stale record from a previous boot
  const gate = new Promise<void>((resolve) => {
    setTimeout(() => {
      persisted.status = "interrupted" // reconciliation marks dead runs final
      resolve()
    }, 20)
  })
  const out = await controlToolContent({ ok: true, action: "stop" }, "ses_parent", {
    getRun: () => undefined,
    activeRuns: () => [persisted],
    supervisor,
    reconciled: gate,
  })
  assert.match(out.content, /cannot stop a interrupted/)
})

test("controlToolContent: validator failures surface as error content", async () => {
  const out = await controlToolContent({ ok: false, error: `"action" must be one of stop | pause | resume` }, "ses_parent", {
    getRun: () => undefined,
    activeRuns: () => [],
  })
  assert.match(out.content, /error: "action" must be one of/)
})
