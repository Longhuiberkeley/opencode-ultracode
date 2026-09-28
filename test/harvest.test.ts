/**
 * Orphan harvest — src/harvest.ts. Paths: succeeded (schema + text-only),
 * failed outcome, unresolvable (busy/throwing/context-less/invalid JSON),
 * bounds, and warm-cache integration (buildWarmCache replays harvested rows;
 * the failover-safety skip still excludes rows that switched models).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { harvestOrphanedRun, MAX_HARVEST_CHILDREN, type HarvestSessionCtx } from "../src/harvest.ts"
import { buildWarmCache, agentCacheDigest } from "../src/primitives.ts"
import type { AgentRecord, ContextMessage, Json, RunRecord, TokenUsage } from "../src/types.ts"
import { emptyTokens } from "../src/types.ts"

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface SessionDouble {
  outcome?: string
  error?: string
  tokens?: TokenUsage
  messages: ContextMessage[]
  getContext?: () => ContextMessage[]
}

function assistantMessage(text: string, extra: Partial<ContextMessage> = {}): ContextMessage {
  return { id: "m", type: "assistant", text, ...extra }
}

function makeSessions(doubleBySession: Record<string, SessionDouble>): {
  sessions: HarvestSessionCtx
  contextCalls: string[]
} {
  const contextCalls: string[] = []
  const sessions: HarvestSessionCtx = {
    get: async ({ sessionID }) => {
      const d = doubleBySession[sessionID]
      if (!d) throw new Error(`unknown session ${sessionID}`)
      return { outcome: d.outcome, tokens: d.tokens, error: d.error }
    },
    context: async ({ sessionID }) => {
      const d = doubleBySession[sessionID]
      if (!d) throw new Error(`unknown session ${sessionID}`)
      contextCalls.push(sessionID)
      if (d.getContext) return d.getContext()
      return d.messages
    },
  }
  return { sessions, contextCalls }
}

const SCHEMA: Json = {
  type: "object",
  required: ["claims"],
  properties: { claims: { type: "array", items: { type: "string" } } },
}

function orphanRun(agents: Array<Partial<AgentRecord> & { id: string }>): RunRecord {
  return {
    id: "run_orphan",
    parentSessionID: "ses_parent",
    status: "running",
    script: "return 1",
    startedAt: 100,
    agents: agents.map((a) => ({ status: "running", ...a })) as AgentRecord[],
  }
}

function harvestInto(run: RunRecord, sessions: HarvestSessionCtx) {
  const updates: Array<{ agentID: string; patch: Partial<AgentRecord> }> = []
  const promise = harvestOrphanedRun(run, {
    sessions,
    updateAgent: (runID, agentID, patch) => {
      assert.equal(runID, run.id)
      updates.push({ agentID, patch })
    },
    now: () => 5_000,
  })
  return { promise, updates }
}

// ---------------------------------------------------------------------------
// succeeded paths
// ---------------------------------------------------------------------------

test("harvest: succeeded schema child validates against the recorded schema and becomes warm-replayable", async () => {
  const prompt = "collect claims"
  const digest = agentCacheDigest(prompt, { schema: SCHEMA }, "general")
  const run = orphanRun([
    {
      id: "a1",
      sessionID: "ses_done",
      key: "verify:0",
      promptDigest: digest,
      schema: SCHEMA,
      requestedAgent: "general",
      spawnModel: { providerID: "openai", id: "gpt-6", source: "pin" },
    },
  ])
  const { sessions } = makeSessions({
    ses_done: {
      outcome: "succeeded",
      tokens: emptyTokens(),
      messages: [
        { id: "u1", type: "user", text: prompt },
        assistantMessage('{"claims": ["a", "b"]}', {
          id: "a1m",
          agent: "general",
          model: { providerID: "openai", id: "gpt-6" },
          tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } },
        }),
      ],
    },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.deepEqual(report, { harvested: 1, failed: 0, unresolvable: 0 })
  assert.equal(updates.length, 1)
  const patch = updates[0]!.patch
  assert.equal(patch.status, "succeeded")
  assert.deepEqual(patch.data, { claims: ["a", "b"] })
  assert.equal(patch.resultText, '{"claims": ["a", "b"]}')
  assert.equal(patch.harvested, true)
  assert.deepEqual(patch.effectiveModel, { providerID: "openai", id: "gpt-6" })
  assert.equal(patch.effectiveAgent, "general")
  assert.equal(patch.contextTokens, 110)
  assert.equal(patch.endedAt, 5_000)

  // The record now warm-replays: apply the patch like a registry would and
  // build the warm cache from the record.
  Object.assign(run.agents[0]!, patch)
  const cache = buildWarmCache(run)
  const entry = cache.get("verify:0")
  assert.ok(entry, "harvested keyed row is warm-replayable")
  assert.equal(entry!.digest, digest)
  assert.deepEqual(entry!.result.data, { claims: ["a", "b"] })
})

test("harvest: succeeded schema child that switched models mid-flight stays warm-EXCLUDED (failover-safety skip preserved)", async () => {
  const run = orphanRun([
    {
      id: "a1",
      sessionID: "ses_switched",
      key: "v",
      promptDigest: "d".repeat(64),
      schema: SCHEMA,
      spawnModel: { providerID: "openai", id: "gpt-6", source: "pin" },
    },
  ])
  const { sessions } = makeSessions({
    ses_switched: {
      outcome: "succeeded",
      messages: [
        assistantMessage('{"claims": []}', { model: { providerID: "anthropic", id: "claude-x" } }),
      ],
    },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.equal(report.harvested, 1)
  Object.assign(run.agents[0]!, updates[0]!.patch)
  const cache = buildWarmCache(run)
  assert.equal(cache.size, 0, "spawnModel != effectiveModel rows never replay (intentional skip kept)")
})

test("harvest: succeeded text-only keyed child harvests on resultText alone (legacy schema-less)", async () => {
  const run = orphanRun([{ id: "a1", sessionID: "ses_text", key: "summary", promptDigest: "e".repeat(64) }])
  const { sessions } = makeSessions({
    ses_text: { outcome: "succeeded", messages: [assistantMessage("plain summary text")] },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.equal(report.harvested, 1)
  Object.assign(run.agents[0]!, updates[0]!.patch)
  const cache = buildWarmCache(run)
  assert.equal(cache.get("summary")?.result.text, "plain summary text")
})

// ---------------------------------------------------------------------------
// failed / unresolvable paths
// ---------------------------------------------------------------------------

test("harvest: terminal failed outcome marks the child failed with the session error", async () => {
  const run = orphanRun([{ id: "a1", sessionID: "ses_bad" }])
  const { sessions } = makeSessions({
    ses_bad: { outcome: "failed", error: "provider 429", messages: [] },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.deepEqual(report, { harvested: 0, failed: 1, unresolvable: 0 })
  assert.equal(updates[0]!.patch.status, "failed")
  assert.match(updates[0]!.patch.error ?? "", /outcome "failed"/)
  assert.match(updates[0]!.patch.error ?? "", /provider 429/)
})

test("harvest: busy session (no outcome), unreadable session, empty context, and invalid JSON are unresolvable", async () => {
  const run = orphanRun([
    { id: "a1", sessionID: "ses_busy" },
    { id: "a2", sessionID: "ses_unknown" },
    { id: "a3", sessionID: "ses_empty" },
    { id: "a4", sessionID: "ses_junk", schema: SCHEMA },
  ])
  const { sessions, contextCalls } = makeSessions({
    ses_busy: { outcome: undefined, messages: [] },
    // ses_unknown: not registered -> get() throws
    ses_empty: { outcome: "succeeded", messages: [{ id: "u", type: "user", text: "hi" }] },
    ses_junk: { outcome: "succeeded", messages: [assistantMessage("not json at all")] },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.deepEqual(report, { harvested: 0, failed: 0, unresolvable: 4 })
  assert.equal(updates.length, 0, "unresolvable children get no row mutation - the flip owns them")
  assert.deepEqual(contextCalls, ["ses_empty", "ses_junk"], "outcome-missing children never read context")
})

test("harvest: schema-invalid JSON against the recorded schema is unresolvable (no repair, no guessing)", async () => {
  const run = orphanRun([{ id: "a1", sessionID: "ses_wrongshape", schema: SCHEMA }])
  const { sessions } = makeSessions({
    ses_wrongshape: { outcome: "succeeded", messages: [assistantMessage('{"wrong": true}')] },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.equal(report.unresolvable, 1)
  assert.equal(updates.length, 0)
})

test("harvest: legacy schema-mode row without a stored schema stays unresolvable; legacy PROSE row harvests", async () => {
  // A schema call whose schema was never persisted (pre-upgrade row): the
  // text parses as JSON, so a warm replay would return no `.data` for a
  // schema contract — unresolvable rather than a false replay.
  const run = orphanRun([
    { id: "a1", sessionID: "ses_legacy_json", key: "k", promptDigest: "f".repeat(64) },
    { id: "a2", sessionID: "ses_legacy_prose", key: "k2", promptDigest: "1".repeat(64) },
  ])
  const { sessions } = makeSessions({
    ses_legacy_json: { outcome: "succeeded", messages: [assistantMessage('{"claims": []}')] },
    ses_legacy_prose: { outcome: "succeeded", messages: [assistantMessage("plain prose summary")] },
  })
  const { promise, updates } = harvestInto(run, sessions)
  const report = await promise
  assert.deepEqual(report, { harvested: 1, failed: 0, unresolvable: 1 })
  assert.equal(updates.length, 1)
  assert.equal(updates[0]!.agentID, "a2")
  assert.equal(updates[0]!.patch.resultText, "plain prose summary")
})

// ---------------------------------------------------------------------------
// bounds + invariants
// ---------------------------------------------------------------------------

test("harvest: bounded at MAX_HARVEST_CHILDREN; terminal children are skipped entirely", async () => {
  const agents: Array<Partial<AgentRecord> & { id: string }> = []
  for (let i = 0; i < MAX_HARVEST_CHILDREN + 5; i++) {
    agents.push({ id: `a${i + 1}`, sessionID: `ses_${i}` })
  }
  agents.push({ id: "a_done", sessionID: "ses_terminal", status: "succeeded" })
  const run = orphanRun(agents)
  const doubles: Record<string, SessionDouble> = {}
  for (let i = 0; i < MAX_HARVEST_CHILDREN + 5; i++) {
    doubles[`ses_${i}`] = { outcome: "succeeded", messages: [assistantMessage("ok text")] }
  }
  const { sessions } = makeSessions(doubles)
  const { promise } = harvestInto(run, sessions)
  const report = await promise
  assert.equal(report.harvested, MAX_HARVEST_CHILDREN)
})

test("harvest: idempotent on already-harvested rows (running filter skips terminal rows)", async () => {
  const run = orphanRun([{ id: "a1", sessionID: "ses_done", key: "k", promptDigest: "0".repeat(64) }])
  const { sessions } = makeSessions({
    ses_done: { outcome: "succeeded", messages: [assistantMessage("text")] },
  })
  const first = await harvestOrphanedRun(run, {
    sessions,
    updateAgent: (runID, agentID, patch) => void Object.assign(run.agents.find((a) => a.id === agentID)!, patch),
    now: () => 1,
  })
  assert.equal(first.harvested, 1)
  const second = await harvestOrphanedRun(run, {
    sessions,
    updateAgent: (runID, agentID, patch) => void Object.assign(run.agents.find((a) => a.id === agentID)!, patch),
    now: () => 2,
  })
  assert.deepEqual(second, { harvested: 0, failed: 0, unresolvable: 0 })
})

// ---------------------------------------------------------------------------
// Bounded harvest (review P1): count cap bounds children, deadlines bound TIME
// ---------------------------------------------------------------------------

test("harvest: a hung session.get() times out per-RPC and reads unresolvable — the flip proceeds", async () => {
  const run = orphanRun([
    { id: "a1", sessionID: "ses_hung", key: "k", promptDigest: "9".repeat(64) },
    { id: "a2", sessionID: "ses_ok", key: "k2", promptDigest: "8".repeat(64) },
  ])
  const sessions: HarvestSessionCtx = {
    get: async ({ sessionID }) => {
      if (sessionID === "ses_hung") return new Promise(() => {}) // transport never returns
      return { outcome: "succeeded" }
    },
    context: async ({ sessionID }) => {
      if (sessionID === "ses_ok") return [assistantMessage("salvaged text")]
      throw new Error("unreachable")
    },
  }
  const report = await harvestOrphanedRun(run, {
    sessions,
    updateAgent: () => {},
    now: () => 1_000,
    rpcTimeoutMs: 40,
  })
  assert.deepEqual(report, { harvested: 1, failed: 0, unresolvable: 1 }, "hung probe bounded; sibling still salvaged")
})

test("harvest: a hung session.context() times out — succeeded child left unresolvable, not wedged", async () => {
  const run = orphanRun([{ id: "a1", sessionID: "ses_ctx_hung", key: "k", promptDigest: "7".repeat(64) }])
  const sessions: HarvestSessionCtx = {
    get: async () => ({ outcome: "succeeded" }),
    context: async () => new Promise(() => {}),
  }
  const report = await harvestOrphanedRun(run, {
    sessions,
    updateAgent: () => {},
    now: () => 1_000,
    rpcTimeoutMs: 40,
  })
  assert.deepEqual(report, { harvested: 0, failed: 0, unresolvable: 1 })
})

test("harvest: the overall budget stops the pass — remaining children counted unresolvable", async () => {
  const agents: Array<Partial<AgentRecord> & { id: string }> = []
  for (let i = 0; i < 6; i++) agents.push({ id: `a${i + 1}`, sessionID: `ses_b${i}` })
  const run = orphanRun(agents)
  let clock = 1_000
  const sessions: HarvestSessionCtx = {
    get: async () => {
      clock += 100 // each probe advances the clock past the tiny budget
      return { outcome: "succeeded" }
    },
    context: async () => [assistantMessage("x")],
  }
  const report = await harvestOrphanedRun(run, {
    sessions,
    updateAgent: () => {},
    now: () => clock,
    rpcTimeoutMs: 1_000,
    budgetMs: 150,
  })
  assert.ok(report.harvested >= 1, "at least the first child salvaged before the budget")
  assert.equal(report.harvested + report.failed + report.unresolvable, agents.length, "every child accounted for")
})
