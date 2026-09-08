/**
 * Golden-row tests for shared run-inspect cell values.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { agentCells, compactCount, compactElapsed, compactTokens, runHeaderCells } from "../src/run-format.ts"
import type { AgentRecord, RunRecord } from "../src/types.ts"

const TOKENS_42_6K = { input: 40_000, output: 2_600, reasoning: 0, cache: { read: 0, write: 0 } }

test("compactCount / compactTokens / compactElapsed", () => {
  assert.equal(compactCount(42), "42")
  assert.equal(compactCount(42_600), "42.6k")
  assert.equal(compactCount(1_500_000), "1.5M")
  assert.equal(compactTokens(TOKENS_42_6K), "42.6k")
  assert.equal(compactTokens(undefined), "-")
  assert.equal(compactElapsed(120), "120ms")
  assert.equal(compactElapsed(1_500), "1.5s")
  assert.equal(compactElapsed(184_000), "3m 4s")
})

test("agentCells golden rows", () => {
  const full: AgentRecord = {
    id: "a3",
    label: "seeker",
    phase: "extract",
    requestedAgent: "explore",
    effectiveAgent: "explore",
    effectiveModel: { providerID: "openrouter", id: "kimi" },
    status: "running",
    tokens: TOKENS_42_6K,
    toolCalls: 4,
  }
  assert.deepEqual(agentCells(full), [
    "running",
    "a3 seeker",
    "extract",
    "explore",
    "openrouter/kimi",
    "42.6k",
    "4",
  ])

  const sparse: AgentRecord = {
    id: "a1",
    status: "pending",
    requestedAgent: "general",
  }
  assert.deepEqual(agentCells(sparse), ["pending", "a1", "-", "general", "-", "-", "-"])

  const failed: AgentRecord = {
    id: "a2",
    label: "judge",
    phase: "verify",
    requestedAgent: "general",
    effectiveAgent: undefined,
    effectiveModel: null,
    status: "failed",
    toolCalls: 0,
  }
  assert.deepEqual(agentCells(failed), ["failed", "a2 judge", "verify", "general", "-", "-", "0"])
})

test("runHeaderCells golden rows", () => {
  const run: RunRecord = {
    id: "run_abc",
    parentSessionID: "ses_p",
    name: "audit",
    status: "running",
    script: "return 1",
    meta: { description: "scan modules" },
    startedAt: 1_000,
    endedAt: 2_500,
    agents: [
      { id: "a1", status: "succeeded" },
      { id: "a2", status: "failed" },
      { id: "a3", status: "running" },
    ],
  }
  assert.deepEqual(runHeaderCells(run), ["audit", "scan modules", "1/3 agents", "1.5s"])

  const unnamed: RunRecord = {
    id: "run_xyz",
    parentSessionID: "ses_p",
    status: "succeeded",
    script: "return 1",
    startedAt: 0,
    endedAt: 120,
    agents: [],
  }
  assert.deepEqual(runHeaderCells(unnamed), ["run_xyz", "0/0 agents", "120ms"])
})
