import test from "node:test"
import assert from "node:assert/strict"
import { steerRun } from "../src/steer.ts"
import type { RunRecord } from "../src/types.ts"

const run = (): RunRecord => ({
  id: "run_test", parentSessionID: "ses_parent", status: "running", script: "return 1", startedAt: 1,
  agents: [{ id: "a1", sessionID: "ses_child", status: "running" }],
})

test("steer delivers to the owned running child without scheduling a new loop", async () => {
  const sent: unknown[] = []
  const target = await steerRun(run(), "ses_parent", { text: "Use the smaller layout" }, async (input) => { sent.push(input) })
  assert.deepEqual(target, { sessionID: "ses_child", agentID: "a1" })
  assert.deepEqual(sent, [{ sessionID: "ses_child", text: "Use the smaller layout", delivery: "steer", resume: false }])
})

test("steer rejects foreign, finished and ambiguous targets without prompting", async () => {
  const r = run()
  const prompt = async () => { assert.fail("must not prompt") }
  await assert.rejects(steerRun(r, "ses_other", { text: "adjust" }, prompt), /belong/)
  r.agents.push({ id: "a2", sessionID: "ses_otherChild", status: "running" })
  await assert.rejects(steerRun(r, "ses_parent", { text: "adjust" }, prompt), /exactly one/)
  r.status = "succeeded"
  await assert.rejects(steerRun(r, "ses_parent", { text: "adjust", agentID: "a1" }, prompt), /succeeded/)
})
