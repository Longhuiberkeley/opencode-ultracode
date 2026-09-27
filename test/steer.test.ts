import test from "node:test"
import assert from "node:assert/strict"
import { steerRun, type SteerDeps } from "../src/steer.ts"
import type { RunRecord } from "../src/types.ts"

const run = (): RunRecord => ({
  id: "run_test", parentSessionID: "ses_parent", status: "running", script: "return 1", startedAt: 1,
  agents: [{ id: "a1", sessionID: "ses_child", status: "running" }],
})

const deps = (overrides: Partial<SteerDeps> = {}): SteerDeps => ({
  prompt: async () => {},
  // Default world: this process drives the run, and the child session is BUSY
  // (no exposed outcome) — the only world in which steering is meaningful.
  isLocallyLive: () => true,
  sessionState: async () => ({ outcome: undefined }),
  ...overrides,
})

test("steer delivers to the owned running child without scheduling a new loop", async () => {
  const sent: unknown[] = []
  const target = await steerRun(run(), "ses_parent", { text: "Use the smaller layout" }, {
    ...deps(),
    prompt: async (input) => { sent.push(input) },
  })
  assert.deepEqual(target, { sessionID: "ses_child", agentID: "a1", delivery: "queued (durable)", consumed: false })
  assert.deepEqual(sent, [{ sessionID: "ses_child", text: "Use the smaller layout", delivery: "steer", resume: false }])
})

test("steer rejects foreign, finished and ambiguous targets without prompting", async () => {
  const r = run()
  const d = { ...deps(), prompt: async () => { assert.fail("must not prompt") } }
  await assert.rejects(steerRun(r, "ses_other", { text: "adjust" }, d), /belong/)
  r.agents.push({ id: "a2", sessionID: "ses_otherChild", status: "running" })
  await assert.rejects(steerRun(r, "ses_parent", { text: "adjust" }, d), /exactly one/)
  r.status = "succeeded"
  await assert.rejects(steerRun(r, "ses_parent", { text: "adjust", agentID: "a1" }, d), /succeeded/)
})

test("steer on a run with NO live local worker is rejected — the queue would rot unconsumed (2026-09-27 incident)", async () => {
  const d = { ...deps(), isLocallyLive: () => false, prompt: async () => { assert.fail("must not prompt") } }
  await assert.rejects(steerRun(run(), "ses_parent", { text: "adjust" }, d), /no live worker/)
  await assert.rejects(steerRun(run(), "ses_parent", { text: "adjust" }, d), /rerun run_test --warm/)
})

test("steer on an IDLE-succeeded child session is rejected as unconsumed, even while the record says running", async () => {
  // The exact incident shape: OpenCode recovered the child, it finished with
  // idle_outcome succeeded, but the record row (and the whole run) still said
  // running because the awaiting worker died.
  const d = {
    ...deps(),
    sessionState: async () => ({ outcome: "succeeded" }),
    prompt: async () => { assert.fail("must not prompt") },
  }
  await assert.rejects(steerRun(run(), "ses_parent", { text: "adjust" }, d), /idle \(outcome: succeeded\)/)
  await assert.rejects(steerRun(run(), "ses_parent", { text: "adjust" }, d), /unconsumed/)
})

test("steer treats a failed idle outcome the same — terminal is terminal", async () => {
  const d = {
    ...deps(),
    sessionState: async () => ({ outcome: "failed" }),
    prompt: async () => { assert.fail("must not prompt") },
  }
  await assert.rejects(steerRun(run(), "ses_parent", { text: "adjust" }, d), /idle \(outcome: failed\)/)
})

test("steer pre-flight probes degrade open: unreadable session or absent checks never block delivery", async () => {
  const sent: unknown[] = []
  const d = {
    prompt: async (input: { sessionID: string; text: string; delivery: "steer"; resume: false }) => { sent.push(input) },
    isLocallyLive: () => true,
    // Probe THROWS (transport hiccup): no evidence of idle — deliver.
    sessionState: async () => { throw new Error("probe down") },
  }
  const target = await steerRun(run(), "ses_parent", { text: "adjust" }, d)
  assert.equal(target.consumed, false)
  assert.equal(sent.length, 1)

  // No deps at all (legacy caller): only the record-based checks apply.
  const legacy = await steerRun(run(), "ses_parent", { text: "adjust" }, {
    prompt: async () => {},
  })
  assert.equal(legacy.agentID, "a1")
})
