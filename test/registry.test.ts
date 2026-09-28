/**
 * Builder A tests — src/registry.ts run lifecycle, ownership, throttled
 * persistence and orphan reconciliation.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { MAX_CHECKPOINTS, RegistryImpl } from "../src/registry.ts"
import type { AgentRecord, RunRecord, TokenUsage } from "../src/types.ts"
import { emptyTokens, isActiveRunStatus } from "../src/types.ts"

function tokens(input: number, output: number): TokenUsage {
  return { input, output, reasoning: 0, cache: { read: 0, write: 0 } }
}

function makeRegistry(overrides: {
  persist?: (r: RunRecord) => void
  loader?: () => RunRecord[]
  throttleMs?: number
  now?: () => number
  bootID?: string
  ownerAlive?: (bootID: string) => boolean
  ownerProbe?: (bootID: string) => "alive-pid" | "alive-marker" | "dead-pid" | "dead"
} = {}) {
  const persisted: RunRecord[] = []
  const persist = overrides.persist ?? ((r: RunRecord) => persisted.push(r))
  const registry = new RegistryImpl({
    persist,
    loader: overrides.loader,
    throttleMs: overrides.throttleMs,
    now: overrides.now,
    bootID: overrides.bootID,
    ownerAlive: overrides.ownerAlive,
    ownerProbe: overrides.ownerProbe,
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

test("create records graphSpec for graph-authored runs and omits it otherwise", () => {
  const { registry } = makeRegistry()
  const graph = registry.create({ parentSessionID: "ses", script: "compiled", graphSpec: { nodes: [] } })
  assert.deepEqual(graph.graphSpec, { nodes: [] })
  const plain = registry.create({ parentSessionID: "ses", script: "return 1" })
  assert.equal("graphSpec" in plain, false, "absent rather than undefined — script runs stay small")
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

test("isActiveRunStatus is running|stopping|paused only", () => {
  assert.equal(isActiveRunStatus("running"), true)
  assert.equal(isActiveRunStatus("stopping"), true)
  assert.equal(isActiveRunStatus("paused"), true)
  assert.equal(isActiveRunStatus("succeeded"), false)
  assert.equal(isActiveRunStatus("failed"), false)
  assert.equal(isActiveRunStatus("stopped"), false)
  assert.equal(isActiveRunStatus("interrupted"), false)
})

test("paused is an active status: markOwned / isOwnedActive / runForActiveSession / activeRuns", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.setStatus(run.id, "paused")
  registry.markOwned(run.id, "ses_paused_child")
  assert.equal(registry.isOwnedActive("ses_paused_child"), true)
  assert.equal(registry.runForActiveSession("ses_paused_child")?.id, run.id)
  assert.deepEqual(registry.activeRuns().map((r) => r.id), [run.id])
  registry.finish(run.id, { status: "stopped" })
  assert.equal(registry.isOwnedActive("ses_paused_child"), false)
  assert.equal(registry.runForActiveSession("ses_paused_child"), undefined)
  assert.deepEqual(registry.activeRuns(), [])
})

test("bindAgentSession survives run finalize", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(run.id, { status: "pending" })
  registry.bindAgentSession(run.id, "a1", "ses_child")
  assert.deepEqual(registry.agentForSession("ses_child"), { runID: run.id, agentID: "a1" })
  registry.finish(run.id, { status: "succeeded" })
  assert.deepEqual(registry.agentForSession("ses_child"), { runID: run.id, agentID: "a1" })
  assert.equal(registry.agentForSession("ses_unknown"), undefined)
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

test("reconcileOrphans flips running|stopping|paused runs to interrupted (server restart)", () => {
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
  const paused = persistedRun({ id: "run_p", status: "paused", startedAt: 2.5, endedAt: undefined })
  const done = persistedRun({ id: "run_c", status: "succeeded", startedAt: 3 })
  const junk = { id: "run_junk", status: 5 } as unknown as RunRecord
  const { registry, persisted } = makeRegistry({ throttleMs: 0, loader: () => [running, stopping, paused, done, junk] })

  const flipped = registry.reconcileOrphans()
  assert.equal(flipped, 3)

  const a = registry.get("run_a")
  assert.equal(a?.status, "interrupted")
  assert.match(a?.stopReason ?? "", /^server restart/)
  assert.match(a?.stopReason ?? "", new RegExp(`rerun ${a?.id} --warm`))
  assert.equal(typeof a?.endedAt, "number")
  assert.deepEqual(a?.agents.map((x) => x.status), ["succeeded", "interrupted", "interrupted"])

  const b = registry.get("run_b")
  assert.equal(b?.status, "interrupted")
  assert.match(b?.stopReason ?? "", /^server restart/)

  const p = registry.get("run_p")
  assert.equal(p?.status, "interrupted")
  assert.match(p?.stopReason ?? "", /^server restart/)

  const c = registry.get("run_c")
  assert.equal(c?.status, "succeeded") // untouched
  assert.equal(c?.stopReason, undefined)

  // Only flipped records are written back (run_c + junk contribute nothing).
  assert.deepEqual(persisted.map((r) => r.id), ["run_a", "run_b", "run_p"])
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

test("reconcileOrphans adopts a remote-owned run only with fresh heartbeat AND live marker; flips otherwise", () => {
  let clock = 10_000_000
  const alive = persistedRun({
    id: "run_alive",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_alive_elsewhere", updatedAt: clock - 60_000 },
  })
  const deadMarker = persistedRun({
    id: "run_dead_marker",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_dead_marker", updatedAt: clock - 60_000 },
  })
  const staleHeartbeat = persistedRun({
    id: "run_stale",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_alive_elsewhere", updatedAt: clock - (30 * 60_000 + 1) },
  })
  const { registry, persisted } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [alive, deadMarker, staleHeartbeat],
    ownerAlive: (bootID) => bootID === "boot_alive_elsewhere",
  })

  const flipped = registry.reconcileOrphans()
  assert.equal(flipped, 2)

  // Fresh heartbeat + live owner-liveness marker: the owner process is alive
  // in another lane — adopt as-is, no write-back.
  const a = registry.get("run_alive")
  assert.equal(a?.status, "running")
  assert.equal(a?.stopReason, undefined)
  // Fresh heartbeat but the marker says the boot is dead (or absent):
  // legacy flip-on-restart semantics.
  const d = registry.get("run_dead_marker")
  assert.equal(d?.status, "interrupted")
  assert.match(d?.stopReason ?? "", /^server restart/)
  assert.match(d?.stopReason ?? "", new RegExp(`rerun ${d?.id} --warm`))
  // Live marker cannot outvote a heartbeat stale beyond the orphan window.
  const s = registry.get("run_stale")
  assert.equal(s?.status, "interrupted")
  assert.match(s?.stopReason ?? "", /^server restart/)
  // Only flipped records are written back to storage.
  assert.deepEqual(persisted.map((r) => r.id), ["run_dead_marker", "run_stale"])
})

test("reconcileOrphans (pid-aware): a pid-verified live owner is NEVER flipped, even on a stale heartbeat", () => {
  let clock = 10_000_000
  // The 2026-09-27 wedge shape inverted: a live owner whose single child sat
  // in one long silent provider request for >30 min starved the heartbeat and
  // the old logic flipped a LIVE run. A pid-verified boot must outvote the
  // stale heartbeat.
  const silentChild = persistedRun({
    id: "run_silent_child",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_alive_pid", updatedAt: clock - (30 * 60_000 + 60_000) },
    agents: [{ id: "a1", status: "running", sessionID: "ses_child" }],
  })
  const { registry, persisted } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [silentChild],
    ownerProbe: (bootID) => (bootID === "boot_alive_pid" ? "alive-pid" : "dead"),
  })
  assert.equal(registry.reconcileOrphans(), 0)
  assert.equal(registry.get("run_silent_child")?.status, "running")
  assert.equal(persisted.length, 0, "no write-back for an adopted live run")
})

test("reconcileOrphans (pid-aware): a dead pid flips IMMEDIATELY despite fresh marker and heartbeat (the SIGKILL case)", () => {
  let clock = 10_000_000
  const killed = persistedRun({
    id: "run_killed",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_killed", updatedAt: clock - 1_000, pid: 4312 },
    agents: [
      { id: "a1", status: "running", sessionID: "ses_a" },
      { id: "a2", status: "pending" },
      { id: "a3", status: "succeeded" },
    ],
  })
  const { registry, persisted } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [killed],
    ownerProbe: () => "dead-pid",
  })
  assert.equal(registry.reconcileOrphans(), 1)
  const run = registry.get("run_killed")!
  assert.equal(run.status, "interrupted")
  assert.match(run.stopReason ?? "", /^server restart \(owner boot_killed pid 4312 gone\)/)
  assert.match(run.stopReason ?? "", new RegExp(`rerun ${run.id} --warm`))
  assert.equal(run.agents.find((a) => a.id === "a1")?.status, "interrupted")
  assert.equal(run.agents.find((a) => a.id === "a2")?.status, "interrupted")
  assert.equal(run.agents.find((a) => a.id === "a3")?.status, "succeeded", "terminal children untouched")
  assert.equal(typeof run.endedAt, "number")
  assert.deepEqual(persisted.map((r) => r.id), ["run_killed"])
})

test("reconcileOrphans (pid-aware): alive-marker still falls back to the heartbeat window", () => {
  let clock = 10_000_000
  const freshHeartbeat = persistedRun({
    id: "run_fresh",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_marker_only", updatedAt: clock - 60_000 },
  })
  const staleHeartbeat = persistedRun({
    id: "run_over",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_marker_only", updatedAt: clock - (30 * 60_000 + 1) },
  })
  const { registry } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [freshHeartbeat, staleHeartbeat],
    ownerProbe: () => "alive-marker",
  })
  assert.equal(registry.reconcileOrphans(), 1)
  assert.equal(registry.get("run_fresh")?.status, "running")
  assert.equal(registry.get("run_over")?.status, "interrupted")
})

test("persistNow stamps the full owner identity (bootID, pid, updatedAt); touchActiveOwned refreshes only active owned runs", () => {
  let clock = 5_000
  const snapshots: RunRecord[] = []
  const { registry } = makeRegistry({
    bootID: "boot_me",
    now: () => clock,
    throttleMs: 0,
    persist: (r) => snapshots.push({ ...r, owner: r.owner ? { ...r.owner } : undefined, agents: [...r.agents] }),
  })
  const active = registry.create({ parentSessionID: "ses", script: "s" })
  const finished = registry.create({ parentSessionID: "ses", script: "s" })
  registry.finish(finished.id, { status: "succeeded" })

  clock = 9_000
  const touched = registry.touchActiveOwned()
  assert.equal(touched, 1, "only the active run created by this registry")
  const last = snapshots.filter((r) => r.id === active.id).at(-1)!
  assert.equal(last.owner?.bootID, "boot_me")
  assert.equal(last.owner?.pid, process.pid)
  assert.equal(last.owner?.updatedAt, 9_000)
  // A finished run keeps its last snapshot; no new persist for it.
  const finishedSnaps = snapshots.filter((r) => r.id === finished.id)
  assert.equal(finishedSnaps.at(-1)!.owner?.updatedAt, 5_000)
})

test("ownsRun is provenance, not presence: created runs own, adopted remote runs do not", () => {
  let clock = 10_000_000
  const remote = persistedRun({
    id: "run_adopted",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_elsewhere", updatedAt: clock - 1_000 },
  })
  const { registry } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [remote],
    ownerAlive: () => true,
  })
  assert.equal(registry.reconcileOrphans(), 0)
  // Adopted: readable in this registry but owned by the other process.
  assert.equal(registry.get("run_adopted") !== undefined, true)
  assert.equal(registry.ownsRun("run_adopted"), false)

  const created = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  assert.equal(registry.ownsRun(created.id), true)
  registry.finish(created.id, { status: "succeeded" })
  // Durable past completion — the persist-vs-live freshness decisions rely on it.
  assert.equal(registry.ownsRun(created.id), true)
})

test("two-phase reconcile: classify -> harvest window -> apply keeps salvaged children as succeeded", () => {
  let clock = 10_000_000
  const orphan = persistedRun({
    id: "run_two_phase",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_dead2", updatedAt: clock - 1_000, pid: 4312 },
    agents: [
      { id: "a1", status: "running", sessionID: "ses_done" },
      { id: "a2", status: "running", sessionID: "ses_lost" },
      { id: "a3", status: "pending" },
    ],
  })
  const { registry, persisted } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [orphan],
    ownerProbe: () => "dead-pid",
  })
  const plans = registry.classifyOrphans({ recheckAdopted: true })
  assert.equal(plans.length, 1)
  assert.equal(plans[0]!.record.id, "run_two_phase")
  // Between classify and apply, the harvest pass salvages one child.
  registry.updateAgent("run_two_phase", "a1", { status: "succeeded", data: { ok: true }, endedAt: clock })
  assert.equal(registry.applyOrphanInterrupt(plans[0]!), true)
  const run = registry.get("run_two_phase")!
  assert.equal(run.status, "interrupted")
  assert.equal(run.agents.find((a) => a.id === "a1")?.status, "succeeded", "salvaged work survives the flip")
  assert.equal(run.agents.find((a) => a.id === "a2")?.status, "interrupted")
  assert.equal(run.agents.find((a) => a.id === "a3")?.status, "interrupted")
  // Two persists: the salvaged-child update, then the flip.
  assert.deepEqual(persisted.map((r) => r.id), ["run_two_phase", "run_two_phase"])
})

test("classifyOrphans recheckAdopted re-classifies a previously adopted mirror but never a locally supervised run", () => {
  let clock = 10_000_000
  let aliveOwner = true
  const remote = persistedRun({
    id: "run_remote_mirror",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_remote", updatedAt: clock - 1_000 },
  })
  const { registry } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [remote],
    ownerProbe: () => (aliveOwner ? "alive-pid" : "dead-pid"),
  })
  // Pass 1: owner alive — record adopted as running, no plan.
  assert.equal(registry.classifyOrphans({ recheckAdopted: true }).length, 0)
  assert.equal(registry.get("run_remote_mirror")?.status, "running")
  // The owner dies; the persisted view never changes. The old startup-only
  // reconcile would have frozen this record forever (the 2026-09-27 wedge).
  aliveOwner = false
  clock += 5_000
  const plans = registry.classifyOrphans({ recheckAdopted: true })
  assert.equal(plans.length, 1)
  assert.equal(registry.applyOrphanInterrupt(plans[0]!), true)
  assert.equal(registry.get("run_remote_mirror")?.status, "interrupted")

  // A run this process created is never re-classified, even with a stale
  // everything: its live supervisor state is authoritative.
  const local = registry.create({ parentSessionID: "ses", script: "s" })
  clock += 60_000
  assert.equal(registry.classifyOrphans({ recheckAdopted: true }).length, 0)
  assert.equal(registry.get(local.id)?.status, "running")
})

test("applyOrphanInterrupt is idempotent when the record finalized between classify and apply", () => {
  let clock = 10_000_000
  const orphan = persistedRun({
    id: "run_raced",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_raced", updatedAt: clock - 1_000 },
  })
  const { registry } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [orphan],
    ownerProbe: () => "dead-pid",
  })
  const plans = registry.classifyOrphans()
  // The owner finished the run between classify and apply.
  registry.setStatus("run_raced", "succeeded")
  assert.equal(registry.applyOrphanInterrupt(plans[0]!), false)
  assert.equal(registry.get("run_raced")?.status, "succeeded")
})

test("reconcileOrphans never overwrites live in-memory runs", () => {  let clock = 1000
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

test("addCheckpoint: appended in order, bounded at MAX_CHECKPOINTS (oldest dropped)", () => {
  const { registry } = makeRegistry()
  const run = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  for (let i = 0; i < 60; i++) registry.addCheckpoint(run.id, `cp${i}`, { i })
  const cps = registry.get(run.id)!.checkpoints!
  assert.equal(cps.length, MAX_CHECKPOINTS)
  assert.equal(cps[0]!.name, "cp10", "oldest dropped past the cap")
  assert.equal(cps[MAX_CHECKPOINTS - 1]!.name, "cp59")
  assert.deepEqual(cps[0]!.value, { i: 10 })
})

test("addCheckpoint: unknown run and blank names are ignored", () => {
  const { registry } = makeRegistry()
  registry.addCheckpoint("run_nope", "x")
  const run = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  registry.addCheckpoint(run.id, "   ")
  registry.addCheckpoint(run.id, "ok")
  assert.equal(registry.get(run.id)!.checkpoints!.length, 1)
})

// ---------------------------------------------------------------------------
// expiredRemoteRuns (deadline enforcement input)
// ---------------------------------------------------------------------------

test("expiredRemoteRuns: active remote records past deadline+grace only", () => {
  const now = 1_000_000
  const mk = (id: string, over: Partial<RunRecord> = {}): RunRecord =>
    persistedRun({ id, status: "running", startedAt: 1, ...over })
  const past = mk("run_past", { deadlineAt: now - 10 * 60_000 })
  const insideGrace = mk("run_grace", { deadlineAt: now - 60_000 })
  const paused = mk("run_paused", { status: "paused", deadlineAt: now - 10 * 60_000 })
  const noDeadline = mk("run_nodeadline")
  const finished = mk("run_done", { status: "succeeded", deadlineAt: now - 10 * 60_000 })
  const { registry } = makeRegistry({
    now: () => now,
    throttleMs: 0,
    loader: () => [past, insideGrace, paused, noDeadline, finished],
  })
  const expired = registry.expiredRemoteRuns(now, 5 * 60_000)
  assert.deepEqual(expired.map((e) => e.record.id), ["run_past"])
  assert.equal(expired[0]!.deadlineAt, now - 10 * 60_000)
})

test("expiredRemoteRuns skips runs this process created (its own watchdog owns them)", () => {
  const now = 1_000_000
  const other = persistedRun({ id: "run_remote2", status: "running", startedAt: 1, deadlineAt: now - 10 * 60_000 })
  const { registry } = makeRegistry({ now: () => now, throttleMs: 0, loader: () => [other] })
  const local = registry.create({ parentSessionID: "ses", script: "s" })
  registry.noteRunDeadline(local.id, now - 10 * 60_000)
  const expired = registry.expiredRemoteRuns(now, 5 * 60_000)
  assert.deepEqual(expired.map((e) => e.record.id), ["run_remote2"])
})

test("noteRunDeadline / noteAgentActivity persist onto the record", () => {
  const { registry } = makeRegistry({ throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(run.id, { status: "running", sessionID: "ses_c" })
  registry.noteRunDeadline(run.id, 42_000)
  assert.equal(registry.get(run.id)?.deadlineAt, 42_000)
  registry.noteRunDeadline(run.id, undefined)
  assert.equal(registry.get(run.id)?.deadlineAt, undefined)
  registry.noteAgentActivity(run.id, "a1", 77_000)
  assert.equal(registry.getAgent(run.id, "a1")?.lastActivityAt, 77_000)
})

test("setPendingWaitReason stamps only pending rows; clear deletes the key", () => {
  const { registry } = makeRegistry({ throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(run.id, { status: "pending", startedAt: 1 })
  registry.addAgent(run.id, { status: "running", startedAt: 1, sessionID: "ses_r" })
  registry.setPendingWaitReason(run.id, "pause gate (run paused)")
  const rows = registry.get(run.id)!.agents
  assert.equal(rows[0]!.waitReason, "pause gate (run paused)")
  assert.equal(rows[1]!.waitReason, undefined, "running rows keep their own story")
  registry.setPendingWaitReason(run.id, undefined)
  assert.equal(rows[0]!.waitReason, undefined)
})

test("appendEvent keeps a bounded ring and piggybacks the persist throttle", () => {
  const { registry, persisted } = makeRegistry({ throttleMs: 0 })
  const run = registry.create({ parentSessionID: "ses", script: "s" })
  registry.appendEvent(run.id, "first", "first detail")
  for (let i = 1; i < 300; i++) registry.appendEvent(run.id, `kind${i}`)
  const events = registry.get(run.id)!.events!
  assert.equal(events.length, 256)
  assert.equal(events[0]!.kind, "kind44", "oldest dropped")
  assert.equal(events[255]!.kind, "kind299")
  const last = events.at(-1)!
  assert.deepEqual(Object.keys(last).sort(), ["at", "kind"], "no detail key when absent")
  assert.ok(persisted.some((r) => r.id === run.id && (r.events?.length ?? 0) > 0), "events persisted")
})

// ---------------------------------------------------------------------------
// Freshness-safe reconciliation (review P1): a stale adopted mirror must
// never overwrite a run the owner COMPLETED after adoption.
// ---------------------------------------------------------------------------

test("recheckAdopted: owner finished after adoption — mirror syncs, no plan, result preserved", () => {
  let clock = 10_000_000
  // Pass 1: adopt the running mirror.
  let persistedRuns = [persistedRun({
    id: "run_finished_late",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_owner2", updatedAt: clock, pid: 4321 },
    agents: [{ id: "a1", status: "running", sessionID: "ses_c", startedAt: 1 }],
  })]
  const { registry } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => persistedRuns,
    ownerProbe: () => "dead-pid",
  })
  assert.equal(registry.classifyOrphans().length, 1, "first pass: owner dead, plan produced")
  // Decline to apply (simulating harvest time); the OWNER meanwhile finishes
  // the run and persists succeeded, then exits.
  persistedRuns = [persistedRun({
    id: "run_finished_late",
    status: "succeeded",
    startedAt: 1,
    endedAt: clock + 1,
    result: { done: true },
    owner: { bootID: "boot_owner2", updatedAt: clock + 1, pid: 4321 },
    agents: [{ id: "a1", status: "succeeded", sessionID: "ses_c", startedAt: 1, endedAt: clock + 1, resultText: "work" }],
  })]
  // Periodic pass 2 with recheckAdopted: the mirror still says running.
  assert.equal(registry.get("run_finished_late")?.status, "running", "mirror is stale")
  assert.deepEqual(registry.classifyOrphans({ recheckAdopted: true }), [], "no plan for a run finished in persistence")
  const synced = registry.get("run_finished_late")!
  assert.equal(synced.status, "succeeded", "mirror synced from the owner's final write")
  assert.deepEqual(synced.result, { done: true })
  assert.equal(synced.agents[0]?.status, "succeeded")
})

test("applyOrphanInterrupt: a final persisted status outranks a stale running mirror (no result burial)", () => {
  let clock = 10_000_000
  const running = persistedRun({
    id: "run_flip_race",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_owner3", updatedAt: clock, pid: 4322 },
    agents: [{ id: "a1", status: "running", sessionID: "ses_c", startedAt: 1 }],
  })
  const { registry, persisted } = makeRegistry({
    now: () => clock,
    throttleMs: 0,
    loader: () => [running],
    ownerProbe: () => "dead-pid",
  })
  const plans = registry.classifyOrphans()
  assert.equal(plans.length, 1)
  // The owner finishes BETWEEN classify and apply; the loader now returns it.
  running.status = "succeeded"
  running.result = { keep: "me" }
  running.agents[0]!.status = "succeeded"
  assert.equal(registry.applyOrphanInterrupt(plans[0]!), false, "final persisted status declines the flip")
  assert.equal(registry.get("run_flip_race")?.status, "succeeded", "mirror synced to the truth")
  assert.deepEqual(registry.get("run_flip_race")?.result, { keep: "me" })
  assert.equal(persisted.length, 0, "nothing written — the completed record was never touched")
})

test("expiredRemoteRuns enforces the PERSISTED deadline even when the mirror is stale", () => {
  let clock = 10_000_000
  const raw = persistedRun({
    id: "run_deadline_fresh",
    status: "running",
    startedAt: 1,
    owner: { bootID: "boot_live2", updatedAt: clock, pid: 4999 },
    deadlineAt: clock - 10 * 60_000,
    agents: [{ id: "a1", status: "running", sessionID: "ses_c", startedAt: 1 }],
  })
  const { registry } = makeRegistry({ now: () => clock, throttleMs: 0, loader: () => [raw] })
  registry.classifyOrphans() // adopts the mirror
  // The owner re-arms a LATER deadline; the persisted copy says so.
  raw.deadlineAt = clock + 60_000
  const expired = registry.expiredRemoteRuns(clock, 5 * 60_000)
  assert.deepEqual(expired, [], "persisted (not mirrored) deadline decides")
})

test("activityForSession resolves adopted mirrors' lastActivityAt (never bound locally)", () => {
  const { registry } = makeRegistry({ throttleMs: 0, loader: () => [] })
  const local = registry.create({ parentSessionID: "ses", script: "s" })
  registry.addAgent(local.id, { status: "running", sessionID: "ses_local", startedAt: 1 })
  registry.noteAgentActivity(local.id, "a1", 1_111)
  // Adopt a remote running record with persisted activity.
  const adopted = persistedRun({
    id: "run_remote_activity", status: "running", startedAt: 1,
    owner: { bootID: "boot_far", updatedAt: 9_999 },
    agents: [{ id: "a9", status: "running", sessionID: "ses_adopted", startedAt: 1, lastActivityAt: 9_777 }],
  })
  const reg2 = new RegistryImpl({
    persist: () => {}, loader: () => [adopted], throttleMs: 0,
    now: () => 10_000, ownerProbe: () => "alive-pid",
  })
  reg2.classifyOrphans() // adopts the mirror without binding sessions
  assert.equal(reg2.activityForSession("ses_adopted"), 9_777, "adopted mirror row found by scan")
  assert.equal(registry.activityForSession("ses_local"), 1_111, "bound index path intact")
  assert.equal(registry.activityForSession("ses_nope"), undefined)
})
