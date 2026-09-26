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
    contextTokens: 18_000,
    toolCalls: 4,
  }
  assert.deepEqual(agentCells(full), [
    "running",
    "a3 seeker",
    "extract",
    "explore",
    "openrouter/kimi",
    "18k",
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

  // Provenance: a failed child that never ran shows the model it targeted;
  // a drifted child names the spawn model; a literal child stays quiet.
  const targeted: AgentRecord = {
    id: "a4",
    label: "literal",
    phase: "implement",
    requestedAgent: "general",
    effectiveModel: null,
    spawnModel: { providerID: "zai-coding-plan", id: "glm-5.3" },
    status: "failed",
  }
  assert.deepEqual(agentCells(targeted), [
    "failed",
    "a4 literal",
    "implement",
    "general",
    "zai-coding-plan/glm-5.3",
    "-",
    "-",
  ])

  const drifted: AgentRecord = {
    id: "a5",
    label: "routed",
    phase: "verify",
    requestedAgent: "reviewer",
    effectiveModel: { providerID: "openai", id: "gpt-6-sol" },
    spawnModel: { providerID: "xai", id: "grok-4.7" },
    status: "succeeded",
  }
  assert.deepEqual(agentCells(drifted)[4], "openai/gpt-6-sol (spawn: xai/grok-4.7)")

  const literal: AgentRecord = {
    id: "a6",
    requestedAgent: "general",
    effectiveModel: { providerID: "zai-coding-plan", id: "glm-5.3" },
    spawnModel: { providerID: "zai-coding-plan", id: "glm-5.3" },
    status: "succeeded",
  }
  assert.deepEqual(agentCells(literal)[4], "zai-coding-plan/glm-5.3")
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
