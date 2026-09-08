/**
 * Builder A tests — src/registry.ts run lifecycle, ownership, throttled
 * persistence and orphan reconciliation.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { RegistryImpl } from "../src/registry.ts"
import type { AgentRecord, RunRecord, TokenUsage } from "../src/types.ts"
import { emptyTokens } from "../src/types.ts"

function tokens(input: number, output: number): TokenUsage {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

function makeRegistry(overrides: {
  persist?: (r: RunRecord) => void
  loader?: () => RunRecord[]
  throttleMs?: number
  now?: () => number
} = {}) {
  const persisted: RunRecord[] = []
  const persist = overrides.persist ?? ((r: RunRecord) => persisted.push(r))
  const registry = new RegistryImpl({
    persist,
    loader: overrides.loader,
    throttleMs: overrides.throttleMs,
    now: overrides.now,
  })
  return { registry, persisted }
}

function persistedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_seeded",
    parentSessionID: "ses_parent",
    status: "succeeded",
    script: "return 1",
    startedAt: 100,
    endedAt: 200,
    agents: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// create / agents
// ---------------------------------------------------------------------------

test("create initializes a running record and persists immediately", () => {
  const { registry, persisted } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses_p", parentAgent: "build", script: "return 1", name: "demo" })
  assert.match(run.id, /^run_[a-z0-9]+$/)
  assert.equal(run.status, "running")
  assert.equal(run.parentSessionID, "ses_p")
  assert.equal(run.parentAgent, "build")
  assert.equal(run.name, "demo")
  assert.equal(run.script, "return 1")
  assert.deepEqual(run.agents, [])
  assert.equal(typeof run.startedAt, "number")
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0]!.id, run.id)
})

test("addAgent assigns run-scoped ordinals a1, a2, ...", () => {
  const { registry } = makeRegistry()
  const runA = registry.create({ parentSessionID: "ses", script: "s" })
  const runB = registry.create({ parentSessionID: "ses", script: "s" })
  const a1 = registry.addAgent(runA.id, { status: "pending", requestedAgent: "explore", label: "scan" })
  const a2 = registry.addAgent(runA.id, { status: "pending", requestedAgent: "general" })
  const b1 = registry.addAgent(runB.id, { status: "pending", requestedAgent: "explore" })
  assert.equal(a1?.id, "a1")
  assert.equal(a2?.id, "a2")
  assert.equal(b1?.id, "a1") // separate run, separate counter
  assert.equal(registry.getAgent(runA.id, "a2"), a2)
  assert.deepEqual(runA.agents.map((a) => a.id), ["a1", "a2"])
})

test("addAgent/getAgent on unknown run returns undefined", () => {
  const { registry } = makeRegistry()
  assert.equal(registry.addAgent("run_missing", { status: "pending" }), undefined)
  assert.equal(registry.getAgent("run_missing", "a1"), undefined)
})

test("updateAgent patches fields but never the id; unknown targets are no-ops", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(run.id, { status: "pending", requestedAgent: "explore" })
  registry.updateAgent(run.id, "a1", { status: "succeeded", tokens: tokens(10, 5), id: "zzz" })
  const agent = registry.getAgent(run.id, "a1") as AgentRecord
  assert.equal(agent.id, "a1")
  assert.equal(agent.status, "succeeded")
  assert.deepEqual(agent.tokens, tokens(10, 5))
  registry.updateAgent(run.id, "nope", { status: "failed" }) // no throw
  registry.updateAgent("run_missing", "a1", { status: "failed" }) // no throw
})

// ---------------------------------------------------------------------------
// setStatus / finish
// ---------------------------------------------------------------------------

test("setStatus transitions and records extras; unknown run returns false", () => {
  const { registry } = makeRegistry({ throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  assert.equal(registry.setStatus("run_missing", "stopping"), false)
  assert.equal(registry.setStatus(run.id, "stopping"), true)
  assert.equal(run.status, "stopping")
  assert.equal(registry.setStatus(run.id, "failed", { error: "boom", stopReason: "watchdog" }), true)
  assert.equal(run.status, "failed")
  assert.equal(run.error, "boom")
  assert.equal(run.stopReason, "watchdog")
  assert.equal(typeof run.endedAt, "number")
})

test("setStatus on an already-final run is a no-op that still returns true", () => {
  const { registry } = makeRegistry({ throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.setStatus(run.id, "stopped")
  const endedAt = run.endedAt
  assert.equal(registry.setStatus(run.id, "running"), true)
  assert.equal(run.status, "stopped")
  assert.equal(run.endedAt, endedAt)
})

test("finish records outcome, sums agent tokens, sets endedAt and flushes", () => {
  const { registry, persisted } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  const before = persisted.length
  registry.addAgent(run.id, { status: "succeeded", requestedAgent: "explore" })
  registry.addAgent(run.id, { status: "succeeded", requestedAgent: "general" })
  registry.updateAgent(run.id, "a1", { tokens: tokens(100, 20) })
  registry.updateAgent(run.id, "a2", { tokens: tokens(1, 2) })
  registry.updateAgent(run.id, "a2", { tokens: { ...tokens(1, 2), reasoning: 7 } })
  const finished = registry.finish(run.id, {
    status: "succeeded",
    result: { answer: 42 },
    resultTruncated: false,
  })
  assert.equal(finished, run)
  assert.equal(run.status, "succeeded")
  assert.deepEqual(run.result, { answer: 42 })
  assert.equal(run.resultTruncated, false)
  assert.equal(typeof run.endedAt, "number")
  assert.deepEqual(run.totalTokens, { input: 101, output: 22, reasoning: 7, cache: { read: 0, write: 0 } })
  // finish always flushes: persisted grew beyond the throttled snapshot.
  assert.ok(persisted.length > before)
  assert.equal(persisted.at(-1)?.status, "succeeded")
  assert.equal(registry.finish("run_missing", { status: "failed" }), undefined)
})

test("finish with no agents produces zero totals", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.finish(run.id, { status: "failed", error: "no agents" })
  assert.deepEqual(run.totalTokens, emptyTokens())
  assert.equal(run.error, "no agents")
})

// ---------------------------------------------------------------------------
// Ownership maps
// ---------------------------------------------------------------------------

test("markOwned -> isOwnedActive/runForActiveSession; released on finalize", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses_parent", script: "s" })
  registry.markOwned(run.id, "ses_child1")
  assert.equal(registry.isOwnedActive("ses_child1"), true)
  assert.equal(registry.runForActiveSession("ses_child1")?.id, run.id)
  assert.equal(registry.wasEverOwned("ses_child1"), true)

  // Session can be re-marked for another active run.
  const run2 = registry.create({ parentSessionID: "ses_parent", script: "s" })
  registry.markOwned(run2.id, "ses_child1")
  assert.equal(registry.runForActiveSession("ses_child1")?.id, run2.id)

  // Finalizing run2 releases the session; provenance survives.
  registry.finish(run2.id, { status: "succeeded" })
  assert.equal(registry.isOwnedActive("ses_child1"), false)
  assert.equal(registry.runForActiveSession("ses_child1"), undefined)
  assert.equal(registry.wasEverOwned("ses_child1"), true)

  // run1 still active for a different session until it finalizes.
  registry.markOwned(run.id, "ses_child2")
  registry.setStatus(run.id, "interrupted", { stopReason: "server restart" })
  assert.equal(registry.isOwnedActive("ses_child2"), false)
  assert.equal(registry.wasEverOwned("ses_child2"), true)
})

test("markOwned for an unknown run is a no-op", () => {
  const { registry } = makeRegistry()
  registry.markOwned("run_missing", "ses_x")
  assert.equal(registry.isOwnedActive("ses_x"), false)
  assert.equal(registry.wasEverOwned("ses_x"), false)
})

test("markOwned after finish() does not grant active ownership (ownership leak fix)", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.finish(run.id, { status: "succeeded" })
  registry.markOwned(run.id, "ses_late")
  assert.equal(registry.isOwnedActive("ses_late"), false)
  assert.equal(registry.runForActiveSession("ses_late"), undefined)
  assert.equal(registry.wasEverOwned("ses_late"), false)
})

test("markOwned on a stopping run still works, but not after it finalizes", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.setStatus(run.id, "stopping")
  registry.markOwned(run.id, "ses_mid")
  assert.equal(registry.isOwnedActive("ses_mid"), true)
  registry.setStatus(run.id, "stopped")
  // Late re-marking of a finalized run must not resurrect ownership.
  registry.markOwned(run.id, "ses_mid")
  assert.equal(registry.isOwnedActive("ses_mid"), false)
  assert.equal(registry.wasEverOwned("ses_mid"), true) // provenance survives
})

// ---------------------------------------------------------------------------
// listRecent / activeRuns
// ---------------------------------------------------------------------------

test("listRecent sorts newest-first and slices; activeRuns filters", () => {
  let clock = 1000
  const { registry } = makeRegistry({ now: () => clock })
  const r1 = registry.create({ parentSessionID: "ses", script: "s" })
  clock = 2000
  const r2 = registry.create({ parentSessionID: "ses", script: "s" })
  clock = 3000
  const r3 = registry.create({ parentSessionID: "ses", script: "s" })
  registry.finish(r2.id, { status: "succeeded" })
  assert.deepEqual(registry.listRecent(2).map((r) => r.id), [r3.id, r2.id])
  assert.deepEqual(registry.listRecent(10).map((r) => r.id), [r3.id, r2.id, r1.id])
  assert.deepEqual(registry.activeRuns().map((r) => r.id), [r3.id, r1.id])
})

// ---------------------------------------------------------------------------
// Throttled persistence
// ---------------------------------------------------------------------------

test("persistence is throttled per run (~1s trailing) and flushed on finalize", () => {
  const { registry, persisted } = makeRegistry() // default throttleMs 1000
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  assert.equal(persisted.length, 1) // create persists immediately
  registry.addAgent(run.id, { status: "pending" })
  registry.addAgent(run.id, { status: "pending" })
  registry.addAgent(run.id, { status: "pending" })
  assert.equal(persisted.length, 1) // still inside the throttle window
  registry.flushPending()
  assert.equal(persisted.length, 2) // trailing flush with the latest state
  assert.equal(persisted[1]!.agents.length, 3)
  registry.dispose()
})

test("final status always flushes immediately", () => {
  const { registry, persisted } = makeRegistry() // default throttleMs 1000
  const run = registry.create({ parentSessionID: "ses", script: "s" }) // 1
  registry.addAgent(run.id, { status: "pending" }) // throttled
  registry.setStatus(run.id, "failed", { error: "x" }) // flush now
  assert.equal(persisted.length, 2)
  assert.equal(persisted[1]!.status, "failed")
  assert.equal(persisted[1]!.agents.length, 1)
  registry.dispose()
})

test("trailing timer fires without an explicit flush", async () => {
  const { registry, persisted } = makeRegistry({ throttleMs: 20 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  assert.equal(persisted.length, 1)
  registry.addAgent(run.id, { status: "pending" })
  assert.equal(persisted.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(persisted.length, 2)
  assert.equal(persisted[1]!.agents.length, 1)
  registry.dispose()
})

test("throttleMs 0 persists every change immediately", () => {
  const { registry, persisted } = makeRegistry({ throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(run.id, { status: "pending" })
  registry.addAgent(run.id, { status: "pending" })
  assert.equal(persisted.length, 3)
})

test("a throwing persist callback never escapes", () => {
  const { registry } = makeRegistry({ persist: () => { throw new Error("kv down") }, throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(run.id, { status: "pending" })
  registry.finish(run.id, { status: "failed" })
  assert.equal(run.status, "failed")
})

// ---------------------------------------------------------------------------
// reconcileOrphans
// ---------------------------------------------------------------------------

test("reconcileOrphans flips running|stopping runs to interrupted (server restart)", () => {
  const running = persistedRun({
    id: "run_a",
    status: "running",
    startedAt: 1,
    agents: [
      { id: "a1", status: "succeeded" },
      { id: "a2", status: "running" },
      { id: "a3", status: "pending" },
    ],
  })
  const stopping = persistedRun({ id: "run_b", status: "stopping", startedAt: 2, endedAt: undefined })
  const done = persistedRun({ id: "run_c", status: "succeeded", startedAt: 3 })
  const junk = { id: "run_junk", status: 5 } as unknown as RunRecord
  const { registry, persisted } = makeRegistry({ throttleMs: 0, loader: () => [running, stopping, done, junk] })

  const flipped = registry.reconcileOrphans()
  assert.equal(flipped, 2)

  const a = registry.get("run_a")
  assert.equal(a?.status, "interrupted")
  assert.equal(a?.stopReason, "server restart")
  assert.equal(typeof a?.endedAt, "number")
  assert.deepEqual(a?.agents.map((x) => x.status), ["succeeded", "interrupted", "interrupted"])

  const b = registry.get("run_b")
  assert.equal(b?.status, "interrupted")
  assert.equal(b?.stopReason, "server restart")

  const c = registry.get("run_c")
  assert.equal(c?.status, "succeeded") // untouched
  assert.equal(c?.stopReason, undefined)

  // Only flipped records are written back (run_c + junk contribute nothing).
  assert.deepEqual(persisted.map((r) => r.id), ["run_a", "run_b"])
  assert.equal(persisted[0]!.status, "interrupted")
})

test("reconcileOrphans seeds history for listRecent", () => {
  const old = persistedRun({ id: "run_old", status: "succeeded", startedAt: 5 })
  const { registry } = makeRegistry({ loader: () => [old] })
  assert.equal(registry.reconcileOrphans(), 0)
  const live = registry.create({ parentSessionID: "ses", script: "s" })
  assert.deepEqual(registry.listRecent(10).map((r) => r.id), [live.id, "run_old"])
})

test("reconcileOrphans without a loader, or with a throwing loader, is a no-op", () => {
  const noLoader = makeRegistry()
  assert.equal(noLoader.registry.reconcileOrphans(), 0)
  const throwing = makeRegistry({ loader: () => { throw new Error("storage down") } })
  assert.equal(throwing.registry.reconcileOrphans(), 0)
})

test("reconcileOrphans never overwrites live in-memory runs", () => {
  let clock = 1000
  const { registry } = makeRegistry({ now: () => clock, throttleMs: 0 })
  const live = registry.create({ parentSessionID: "ses", script: "live" })
  const stale = persistedRun({ id: live.id, status: "running", script: "stale", startedAt: 1 })
  ;(registry as unknown as { loader: () => RunRecord[] }).loader = () => [stale]
  // Reconcile with a colliding persisted id: live state must win.
  const flipped = registry.reconcileOrphans()
  assert.equal(flipped, 0)
  assert.equal(registry.get(live.id)?.script, "live")
  assert.equal(registry.get(live.id)?.status, "running")
})
