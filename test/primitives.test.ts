/**
 * Builder B tests — primitives: semaphore FIFO + abort, agent cap, registry
 * bookkeeping, progress throttle, phase labeling, workflow composer depth cap,
 * and the pure-TS mirrors of the worker combinators (no real workers here).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { AgentRunner, Semaphore, getWorkflowComposer, parallelHelper, pipelineHelper, storageWorkflowLoader, buildWarmCache, agentCacheDigest } from "../src/primitives.ts"
import { compileGraphSpec } from "../src/graph.ts"
import type { GraphSpec } from "../src/graph.ts"
import type { AgentRunnerOptions } from "../src/primitives.ts"
import type { AgentResult } from "../src/types.ts"
import type { Json, SavedWorkflow, Storage } from "../src/types.ts"
import type { AgentRunHooks, AgentRunInput, SessionDriver } from "../src/sessions.ts"
import { AgentCallError } from "../src/sessions.ts"
import { FakeRegistry, FakeStorage } from "./fakes.ts"

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Scriptable fake driver
// ---------------------------------------------------------------------------

interface DriverCall {
  input: AgentRunInput
  hooks: AgentRunHooks
  resolve(result: AgentResult): void
  reject(err: unknown): void
}

function makeFakeDriver(): { driver: SessionDriver; calls: DriverCall[] } {
  const calls: DriverCall[] = []
  const driver: SessionDriver = {
    runAgent(input, _availableAgents, hooks) {
      return new Promise<AgentResult>((resolve, reject) => {
        calls.push({ input, hooks, resolve, reject })
      })
    },
  }
  return { driver, calls }
}

function okResult(sessionID: string): AgentResult {
  return { text: "done", sessionID, agent: "general", model: null, tokens: undefined }
}

function makeRunner(overrides: Partial<AgentRunnerOptions> = {}) {
  const registry = new FakeRegistry()
  const run = registry.create({ parentSessionID: "ses_parent", script: "return 1" })
  const reports: string[] = []
  const { driver, calls } = makeFakeDriver()
  const runner = new AgentRunner({
    driver,
    registry,
    runID: run.id,
    defaultAgent: "general",
    availableAgents: ["general", "explore"],
    concurrency: 8,
    maxAgents: 200,
    report: (s) => reports.push(s),
    ambientPhase: () => undefined,
    ...overrides,
  })
  return { registry, run, reports, driver, calls, runner }
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

test("semaphore: FIFO admission under limit 1", async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  const order: string[] = []
  const b = sem.acquire().then(() => order.push("b"))
  const c = sem.acquire().then(() => order.push("c"))
  await tick()
  assert.deepEqual(order, [])
  sem.release()
  await tick()
  assert.deepEqual(order, ["b"])
  sem.release()
  await tick()
  assert.deepEqual(order, ["b", "c"])
  sem.release() // no waiters: must not throw / underflow
  assert.equal(sem.running, 0)
})

test("semaphore: limit greater than 1 admits in bulk", async () => {
  const sem = new Semaphore(3)
  await sem.acquire()
  await sem.acquire()
  await sem.acquire()
  const queued = sem.acquire()
  let admitted = false
  void queued.then(() => {
    admitted = true
  })
  await tick()
  assert.equal(admitted, false)
  sem.release()
  await queued
  assert.equal(admitted, true)
})

test("semaphore: queued waiter rejects on abort", async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  const ctrl = new AbortController()
  const p = assert.rejects(sem.acquire(ctrl.signal), /run stopping/)
  await tick()
  assert.equal(sem.queued, 1)
  ctrl.abort()
  await p
  assert.equal(sem.queued, 0)
  // A later release must not resolve the aborted waiter (nor crash).
  sem.release()
  await tick()
})

test("semaphore: pre-aborted signal rejects immediately", async () => {
  const sem = new Semaphore(1)
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(sem.acquire(ctrl.signal), /run stopping/)
})

test("semaphore: abort AFTER synchronous acquire is a no-op (no listener leak)", async () => {
  const sem = new Semaphore(1)
  const ctrl = new AbortController()
  await sem.acquire(ctrl.signal) // acquired synchronously — no abort listener registered
  ctrl.abort() // fires later: must not affect the permit holder
  assert.equal(sem.running, 1)
  assert.equal(sem.queued, 0)
  sem.release()
  assert.equal(sem.running, 0)
  // Fully functional afterwards; no stray side effects from the late abort:
  const ctrl2 = new AbortController()
  await sem.acquire(ctrl2.signal)
  assert.equal(sem.running, 1)
  sem.release()
  await sem.acquire()
  sem.release()
})

// ---------------------------------------------------------------------------
// AgentRunner: cap + concurrency + registry bookkeeping
// ---------------------------------------------------------------------------

test("agent runner: maxAgents cap rejects with cap message", async () => {
  const { runner, calls, registry, run } = makeRunner({ maxAgents: 1 })
  const first = runner.call("p1")
  await tick()
  assert.equal(calls.length, 1)
  await assert.rejects(runner.call("p2"), /agent cap reached \(1\)/)
  // The rejected call must not create an agent record.
  assert.equal(run.agents.length, 1)
  assert.equal(runner.agentsStarted, 1)
  calls[0].resolve(okResult("ses_a"))
  const res = await first
  assert.equal(res.text, "done")
  void registry
})

test("agent runner: ninth call stays queued at configured concurrency 8", async () => {
  const { runner, calls } = makeRunner({ concurrency: 8 })
  const promises = Array.from({ length: 9 }, (_, i) => runner.call(`p${i}`))
  await tick()
  assert.equal(calls.length, 8)
  assert.equal(runner.inFlight, 8)
  assert.equal(runner.queued, 1)
  calls[0]!.resolve(okResult("ses_0"))
  await promises[0]
  await tick()
  assert.equal(calls.length, 9)
  assert.equal(runner.queued, 0)
  for (let i = 1; i < 9; i++) calls[i]!.resolve(okResult(`ses_${i}`))
  await Promise.all(promises)
})

test("agent runner: concurrency 64 clamps to semaphore 8 (ninth queued)", async () => {
  const { runner, calls } = makeRunner({ concurrency: 64 })
  const promises = Array.from({ length: 9 }, (_, i) => runner.call(`p${i}`))
  await tick()
  assert.equal(calls.length, 8)
  assert.equal(runner.inFlight, 8)
  assert.equal(runner.queued, 1)
  calls[0]!.resolve(okResult("ses_0"))
  await promises[0]
  await tick()
  assert.equal(calls.length, 9)
  assert.equal(runner.queued, 0)
  for (let i = 1; i < 9; i++) calls[i]!.resolve(okResult(`ses_${i}`))
  await Promise.all(promises)
})

test("agent runner: concurrency limits in-flight, queue drains FIFO", async () => {
  const { runner, calls } = makeRunner({ concurrency: 1 })
  const p1 = runner.call("one")
  const p2 = runner.call("two")
  await tick()
  assert.equal(calls.length, 1) // second call queued behind the semaphore
  assert.equal(runner.queued, 1)
  calls[0].resolve(okResult("ses_1"))
  await p1
  await tick()
  assert.equal(calls.length, 2)
  calls[1].resolve(okResult("ses_2"))
  await p2
  assert.equal(runner.inFlight, 0)
})

test("agent runner: registry lifecycle pending -> running -> succeeded", async () => {
  const { runner, calls, registry, run } = makeRunner()
  const p = runner.call("do it", { label: "worker", phase: "extract", agent: "explore" })
  await tick()
  // Before session creation: pending.
  assert.equal(run.agents[0].status, "pending")
  assert.equal(run.agents[0].requestedAgent, "explore")
  assert.equal(run.agents[0].label, "worker")
  // Session registered -> running.
  calls[0].hooks.onSessionID("ses_new")
  assert.equal(run.agents[0].status, "running")
  assert.equal(run.agents[0].sessionID, "ses_new")
  assert.equal(registry.isOwnedActive("ses_new"), false) // ownership marked by the supervisor wrapper, not the runner
  assert.deepEqual(registry.agentForSession("ses_new"), { runID: run.id, agentID: run.agents[0].id })
  const tokens = { input: 5, output: 6, reasoning: 0, cache: { read: 1, write: 0 } }
  calls[0].resolve({ text: "out", sessionID: "ses_new", agent: "explore", model: { providerID: "p", id: "m" }, tokens })
  const res = await p
  assert.equal(res.text, "out")
  assert.equal(run.agents[0].status, "succeeded")
  assert.deepEqual(run.agents[0].tokens, tokens)
  assert.equal(run.agents[0].effectiveModel?.id, "m")
  assert.equal(run.agents[0].endedAt !== undefined, true)
})

test("agent runner: failure marks failed and rethrows; abort marks interrupted", async () => {
  const { runner, calls, run } = makeRunner()
  const pFail = assert.rejects(runner.call("boom"), /driver exploded/)
  await tick()
  calls[0].reject(new Error("driver exploded"))
  await pFail
  assert.equal(run.agents[0].status, "failed")
  assert.equal(run.agents[0].error, "driver exploded")

  const pAbort = assert.rejects(
    runner.call("slow"),
    (err: unknown) => err instanceof AgentCallError && err.kind === "abort",
  )
  await tick()
  calls[1].reject(new AgentCallError("abort", "agent aborted: run stopping"))
  await pAbort
  assert.equal(run.agents[1].status, "interrupted")
})

test("agent runner: abort while queued rejects the call with 'run stopping'", async () => {
  const ctrl = new AbortController()
  const { runner, calls } = makeRunner({ concurrency: 1, signal: ctrl.signal })
  const first = runner.call("held")
  const queued = assert.rejects(runner.call("queued"), /run stopping/)
  await tick()
  assert.equal(calls.length, 1)
  ctrl.abort()
  await queued
  // First call's driver promise is still pending; release the semaphore by
  // rejecting it with the abort error (mirrors the real driver abort race).
  calls[0].reject(new AgentCallError("abort", "agent aborted: run stopping"))
  await assert.rejects(first)
})

// ---------------------------------------------------------------------------
// Progress throttle + phase labeling
// ---------------------------------------------------------------------------

test("progress: throttled to one line per 500ms, forced on failure", async () => {
  let clock = 1_000
  const { runner, calls, reports } = makeRunner({ now: () => clock })
  const p1 = runner.call("a")
  await tick()
  assert.equal(reports.length, 1) // first report always emitted
  clock = 1_100
  calls[0].resolve(okResult("ses_1"))
  await p1
  assert.equal(reports.length, 1) // within throttle window: suppressed
  clock = 1_600
  const p2 = runner.call("b")
  await tick()
  assert.equal(reports.length, 2)
  clock = 1_650
  const pFail = assert.rejects(runner.call("c"), /kaput/)
  await tick()
  calls[2].reject(new Error("kaput"))
  await pFail
  assert.equal(reports.length, 3) // failure forces a report
  calls[1].resolve(okResult("ses_2"))
  await p2
  assert.match(reports[0], /^workflow — 0 running, 0 done, 0 failed \(cap 200\)$/)
  assert.match(reports[2], /1 failed \(cap 200\)$/)
})

test("progress: line reflects running/done/failed counts and cap", async () => {
  let clock = 1_000
  const { runner, calls, reports } = makeRunner({ now: () => clock, maxAgents: 50 })
  const p1 = runner.call("a")
  await tick()
  calls[0].hooks.onSessionID("ses_1")
  clock = 2_000
  const p2 = runner.call("b")
  await tick()
  // second report: agent 1 running, agent 2 pending
  assert.equal(reports.length, 2)
  assert.match(reports[1], /^workflow — 1 running, 0 done, 0 failed \(cap 50\)$/)
  calls[0].resolve(okResult("ses_1"))
  await p1
  calls[1].resolve(okResult("ses_2"))
  await p2
})

test("phase labeling: explicit opts.phase wins over ambient phase", async () => {
  const { runner, calls, run } = makeRunner({ ambientPhase: () => "ambient-phase" })
  const p1 = runner.call("a", { phase: "explicit-phase" })
  const p2 = runner.call("b")
  await tick()
  assert.equal(run.agents[0].phase, "explicit-phase")
  assert.equal(run.agents[1].phase, "ambient-phase")
  calls[0].resolve(okResult("s1"))
  calls[1].resolve(okResult("s2"))
  await p1
  await p2
})

test("phase labeling: falls back to 'workflow' when no phase known", async () => {
  const { runner, calls, run } = makeRunner({ ambientPhase: () => undefined })
  const p = runner.call("a")
  await tick()
  assert.equal(run.agents[0].phase, "workflow")
  calls[0].resolve(okResult("s1"))
  await p
})

// ---------------------------------------------------------------------------
// Workflow composer (depth cap + async loader seam)
// ---------------------------------------------------------------------------

test("composer: loads saved workflow at depth 0 (storage fallback loader)", async () => {
  const storage = new FakeStorage()
  await storage.saveWorkflow("helper", "return 41 + 1", { name: "helper", source: "project", description: "d" })
  const composed = await getWorkflowComposer(storageWorkflowLoader(storage), "helper", { x: 1 }, 0)
  assert.equal(composed.script, "return 41 + 1")
  assert.equal(composed.meta.name, "helper")
  assert.equal(composed.meta.description, "d")
})

test("composer: graph-kind save returns the compiled script, not the spec", async () => {
  const storage = new FakeStorage()
  const spec: GraphSpec = {
    nodes: [{ id: "say", kind: "agent", prompt: "Say hi about {{args.topic}}." }],
  }
  await storage.saveGraphWorkflow("helper-g", spec as unknown as Json, {
    name: "helper-g",
    source: "project",
    description: "graph helper",
  })
  const composed = await getWorkflowComposer(storageWorkflowLoader(storage), "helper-g", { topic: "x" }, 0)
  const compiled = compileGraphSpec(spec)
  assert.equal(composed.script, compiled.script, "composition must run the compiled body, not the JSON spec")
  assert.notEqual(composed.script, JSON.stringify(spec))
  assert.match(composed.script, /compiled from a graph spec/)
  assert.equal("graphSpec" in composed, false)
  assert.equal(composed.meta.name, "helper-g")
  assert.equal(composed.meta.description, "graph helper")
  assert.deepEqual(composed.meta.phases, compiled.meta.phases)
})

test("composer: depth > 0 rejected with nested-composition error", async () => {
  const storage = new FakeStorage()
  await storage.saveWorkflow("helper", "return 1", { name: "helper", source: "project" })
  const loader = storageWorkflowLoader(storage)
  await assert.rejects(getWorkflowComposer(loader, "helper", undefined, 1), /nested composition beyond depth 1/)
  // Depth cap fires BEFORE the loader is even consulted:
  await assert.rejects(getWorkflowComposer(async () => {
    throw new Error("loader must not run")
  }, "helper", undefined, 2), /nested composition beyond depth 1/)
})

test("composer: unknown workflow rejected", async () => {
  const storage = new FakeStorage()
  const loader = storageWorkflowLoader(storage)
  await assert.rejects(getWorkflowComposer(loader, "nope", undefined, 0), /unknown workflow "nope"/)
})

test("composer: injected async loader — fresh value used per call", async () => {
  let loads = 0
  const loader = async (name: string): Promise<SavedWorkflow | undefined> => {
    loads++
    return {
      manifest: { version: 1, name, hash: "", source: "project", savedAt: 0 },
      script: `return ${loads};`,
    }
  }
  const first = await getWorkflowComposer(loader, "w")
  const second = await getWorkflowComposer(loader, "w")
  assert.equal(first.script, "return 1;")
  assert.equal(second.script, "return 2;") // fresh per composition call
  assert.equal(loads, 2)
})

test("composer: loader rejection surfaces verbatim (script-visible error)", async () => {
  const loader = async (): Promise<SavedWorkflow | undefined> => {
    throw new Error("trust check failed: script hash mismatch")
  }
  await assert.rejects(getWorkflowComposer(loader, "w", undefined, 0), /trust check failed: script hash mismatch/)
})

test("storageWorkflowLoader: prefers loadWorkflowFresh when present, cached fallback otherwise", async () => {
  const storage = new FakeStorage()
  await storage.saveWorkflow("cached", "return 'cached';", { name: "cached", source: "project" })
  const fallback = storageWorkflowLoader(storage)
  assert.equal((await fallback("cached"))?.script, "return 'cached';")

  const withFresh = Object.assign(storage, {
    loadWorkflowFresh: async (name: string): Promise<SavedWorkflow | undefined> => ({
      manifest: { version: 1, name, hash: "", source: "project", savedAt: 0 },
      script: `return 'fresh:${name}';`,
    }),
  }) as Storage
  const fresh = storageWorkflowLoader(withFresh)
  assert.equal((await fresh("cached"))?.script, "return 'fresh:cached';")
})

// ---------------------------------------------------------------------------
// parallelHelper / pipelineHelper (TS mirrors of the worker combinators)
// ---------------------------------------------------------------------------

test("parallelHelper: failures become null and are logged", async () => {
  const logs: string[] = []
  const out = await parallelHelper<number | string>(
    [
      () => 1,
      () => Promise.reject(new Error("thunk blew up")),
      async () => "three",
    ],
    (m) => logs.push(m),
  )
  assert.deepEqual(out, [1, null, "three"])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /parallel thunk failed: thunk blew up/)
})

test("pipelineHelper: stage throw nulls only that item and is logged", async () => {
  const logs: string[] = []
  const out = await pipelineHelper(
    [1, 2, 3],
    [
      (x: number) => x * 2,
      async (x: number, i: number) => {
        if (x === 4) throw new Error(`no fours (index ${i})`)
        return x + 1
      },
    ],
    (m) => logs.push(m),
  )
  assert.deepEqual(out, [3, null, 7])
  assert.equal(logs.length, 1)
  assert.match(logs[0], /pipeline item 1 failed: no fours \(index 1\)/)
})

test("pipelineHelper: stages receive (value, index)", async () => {
  const seen: Array<[unknown, number]> = []
  await pipelineHelper(
    ["a"],
    [
      (v: string, i: number) => {
        seen.push([v, i])
        return v.toUpperCase()
      },
    ],
  )
  assert.deepEqual(seen, [["a", 0]])
})

// ---------------------------------------------------------------------------
// Keyed warm replay (resumeFrom / rerun --warm)
// ---------------------------------------------------------------------------

function makeSourceRun() {
  const registry = new FakeRegistry()
  const run = registry.create({ parentSessionID: "ses_old", script: "return 1" })
  registry.addAgent(run.id, {
    status: "succeeded",
    requestedAgent: "general",
    key: "scout",
    promptDigest: agentCacheDigest("scout the repo", {}, "general"),
    sessionID: "ses_old_scout",
    effectiveAgent: "general",
    resultText: "scout findings",
    data: { files: 3 },
  })
  registry.addAgent(run.id, {
    status: "failed", // failed children are NEVER replayed
    requestedAgent: "general",
    key: "broken",
    promptDigest: agentCacheDigest("broken step", {}, "general"),
  })
  registry.addAgent(run.id, {
    status: "succeeded", // unkeyed: not replayable
    requestedAgent: "general",
  })
  return run
}

test("buildWarmCache: only succeeded keyed agents with payloads are replayable", () => {
  const cache = buildWarmCache(makeSourceRun())
  assert.equal(cache.size, 1)
  const entry = cache.get("scout")!
  assert.equal(entry.sourceRunID, "run_fake1")
  assert.equal(entry.result.text, "scout findings")
  assert.equal(entry.result.cachedFrom, "run_fake1")
  assert.deepEqual(entry.result.data, { files: 3 })
  assert.equal(buildWarmCache(undefined).size, 0)
})

test("AgentRunner warm cache: digest-matched key replays without spawning", async () => {
  const source = makeSourceRun()
  const { registry, run, calls, runner } = makeRunner({ warmCache: buildWarmCache(source) })
  const res = await runner.call("scout the repo", { key: "scout", phase: "scout" })
  assert.equal(calls.length, 0, "no session spawned on a warm hit")
  assert.equal(res.text, "scout findings")
  assert.equal(res.cachedFrom, source.id)
  const rec = registry.getAgent(run.id, "a1")!
  assert.equal(rec.status, "succeeded")
  assert.equal(rec.cached, true)
  assert.equal(rec.key, "scout")
  assert.equal(rec.phase, "scout")
  assert.equal(rec.sessionID, "ses_old_scout")
})

test("AgentRunner warm cache: same key + different prompt (digest mismatch) spawns", async () => {
  const source = makeSourceRun()
  const { registry, run, calls, runner } = makeRunner({ warmCache: buildWarmCache(source) })
  const pending = runner.call("a DIFFERENT prompt", { key: "scout" })
  await tick()
  assert.equal(calls.length, 1, "digest mismatch falls through to a real spawn")
  calls[0]!.resolve(okResult("ses_new"))
  const res = await pending
  assert.equal(res.cachedFrom, undefined)
  const rec = registry.getAgent(run.id, "a1")!
  assert.equal(rec.cached, undefined)
  assert.equal(rec.key, "scout")
  assert.equal(rec.promptDigest, agentCacheDigest("a DIFFERENT prompt", {}, "general"))
  assert.equal(rec.resultText, "done")
})

test("AgentRunner: keyed real-path success persists replay identity; unkeyed does not", async () => {
  const { registry, run, calls, runner } = makeRunner()
  const p1 = runner.call("step one", { key: "lane1" })
  await tick()
  calls[0]!.resolve(okResult("ses_1"))
  await p1
  const keyed = registry.getAgent(run.id, "a1")!
  assert.equal(keyed.key, "lane1")
  assert.equal(keyed.promptDigest, agentCacheDigest("step one", {}, "general"))
  assert.equal(keyed.resultText, "done")

  const p2 = runner.call("step two", {})
  await tick()
  calls[1]!.resolve(okResult("ses_2"))
  await p2
  const unkeyed = registry.getAgent(run.id, "a2")!
  assert.equal(unkeyed.key, undefined)
  assert.equal(unkeyed.resultText, undefined)
})

test("AgentRunner warm cache: schema or agent changes flip the digest (no stale replay)", async () => {
  const source = makeSourceRun()
  const schema = { type: "object", required: ["x"], properties: { x: { type: "number" } } }
  const { calls, runner } = makeRunner({ warmCache: buildWarmCache(source) })
  const pending = runner.call("scout the repo", { key: "scout", schema, agent: "explore" })
  await tick()
  assert.equal(calls.length, 1, "same prompt but different schema/agent must spawn")
  calls[0]!.resolve(okResult("ses_schema"))
  await pending
})
