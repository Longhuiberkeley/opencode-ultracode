/**
 * Builder B tests — supervisor integration smoke tests: run lifecycle through
 * a REAL worker + FakeSessionCtx/FakeRegistry/FakeStorage (no plugin imports).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { SupervisorImpl } from "../src/supervisor.ts"
import { RegistryImpl } from "../src/registry.ts"
import type { Json, ParentContext, RunRecord, SessionCtx, UltracodeOptions } from "../src/types.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"
import { FakeRegistry, FakeSessionCtx, FakeStorage } from "./fakes.ts"
import { capturedFromRecord, remainingTimeoutMs } from "../src/settings.ts"

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeSupervisor(
  optionsOverrides: Partial<UltracodeOptions> = {},
  graces: { settleGraceMs?: number; stopKillGraceMs?: number } = {},
) {
  const registry = new FakeRegistry()
  const storage = new FakeStorage()
  const sessions = new FakeSessionCtx()
  const options = { ...DEFAULT_OPTIONS, timeoutMs: 5_000, ...optionsOverrides }
  const supervisor = new SupervisorImpl({
    registry,
    storage,
    sessions,
    options,
    settleGraceMs: graces.settleGraceMs ?? 300,
    stopKillGraceMs: graces.stopKillGraceMs ?? 80,
  })
  const reports: string[] = []
  const parent: ParentContext = {
    sessionID: "ses_parent",
    agent: "build",
    report: (s) => reports.push(s),
  }
  return { supervisor, registry, storage, sessions, options, reports, parent }
}

/** SessionCtx wrapper whose create() waits on a gate before delegating. */
class GatedCreateSessions implements SessionCtx {
  private readonly inner: SessionCtx
  private readonly gate: Promise<void>

  constructor(inner: SessionCtx, gate: Promise<void>) {
    this.inner = inner
    this.gate = gate
  }

  async create(i: {
    title?: string
    agent?: string
    metadata?: Record<string, unknown>
  }): Promise<{ id: string; agent?: string }> {
    await this.gate
    return this.inner.create(i)
  }
  async get(i: { sessionID: string }) {
    return this.inner.get(i)
  }
  async prompt(i: { sessionID: string; text: string }) {
    return this.inner.prompt(i)
  }
  async wait(i: { sessionID: string }) {
    return this.inner.wait(i)
  }
  async context(i: { sessionID: string }) {
    return this.inner.context(i)
  }
  async interrupt(i: { sessionID: string; continue: boolean }) {
    return this.inner.interrupt(i)
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await tick(10)
  }
}

// ---------------------------------------------------------------------------

test("supervisor: happy path — agent call, records, tokens, script artifact, envelope", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({
    text: "PROBE_OK",
    agent: "general",
    tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const outcome = await ctx.supervisor.start(
    {
      script: `
        phase("verify");
        const r = await agent("say PROBE_OK", { label: "probe" });
        return { said: r.text, sessionID: r.sessionID };
      `,
      meta: { phases: ["verify"] },
      args: { n: 1 },
      name: "smoke",
    },
    ctx.parent,
  )

  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.truncated, false)
  const result = outcome.envelope.result as { [key: string]: Json | undefined } | undefined
  assert.equal(result?.said, "PROBE_OK")
  assert.equal(outcome.envelope.agents.total, 1)
  assert.equal(outcome.envelope.agents.succeeded, 1)
  assert.deepEqual(outcome.envelope.tokens, { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } })
  assert.equal(outcome.run.status, "succeeded")
  assert.equal(outcome.run.scriptPath?.endsWith(".js"), true)
  assert.equal(ctx.storage.scriptArtifacts.size, 1)
  assert.equal(outcome.run.agents[0].status, "succeeded")
  assert.equal(outcome.run.agents[0].sessionID !== undefined, true)
  assert.equal(outcome.run.agents[0].phase, "verify")
  assert.equal(ctx.reports.some((s) => s.includes("verify — ")), true)
  assert.deepEqual(ctx.sessions.interrupts, [])
  assert.equal(ctx.supervisor.activeRuns().length, 0) // cleaned up
})

test("supervisor: script throw => failed envelope with error", async () => {
  const ctx = makeSupervisor()
  const outcome = await ctx.supervisor.start({ script: `throw new Error("script kaboom");` }, ctx.parent)
  assert.equal(outcome.envelope.status, "failed")
  assert.match(outcome.envelope.error ?? "", /script kaboom/)
})

test("supervisor: invalid script rejected before any run is created", async () => {
  const ctx = makeSupervisor()
  await assert.rejects(
    ctx.supervisor.start({ script: `export default 1;` }, ctx.parent),
    /invalid workflow script.*import\/export/,
  )
  assert.equal(ctx.registry.runs.size, 0)
})

test("supervisor: oversized result truncated + artifact persisted", async () => {
  const ctx = makeSupervisor({ maxResultChars: 20 })
  const outcome = await ctx.supervisor.start(
    { script: `return { blob: "${"x".repeat(500)}" };` },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.truncated, true)
  assert.equal(outcome.envelope.result, undefined)
  assert.ok(typeof outcome.envelope.preview === "string" && outcome.envelope.preview.length <= 20)
  assert.ok(outcome.run.resultArtifactKey)
  const stored = ctx.storage.loadResultArtifact(outcome.run.resultArtifactKey as string)
  assert.ok(stored && typeof stored === "object")
})

test("supervisor: timeout watchdog stops the run", async () => {
  const ctx = makeSupervisor({ timeoutMs: 150 })
  const outcome = await ctx.supervisor.start({ script: `await sleep(60000); return 1;` }, ctx.parent)
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "timeout")
})

test("supervisor: stop() is idempotent and interrupts live children", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.hangWait = true
  const pending = ctx.supervisor.start(
    { script: `const r = await agent("slow one"); return r.text;` },
    ctx.parent,
  )
  await waitFor(() => ctx.registry.activeRuns().length > 0, "run creation")
  await waitFor(() => ctx.sessions.sessions.size > 0, "child session")
  const runID = ctx.registry.activeRuns()[0].id
  assert.equal(ctx.supervisor.isOwnedSession([...ctx.sessions.sessions.keys()][0]), true)

  assert.equal(ctx.supervisor.stop(runID, "user request"), true)
  assert.equal(ctx.supervisor.stop(runID, "user request"), false) // idempotent no-op
  const outcome = await pending

  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "user request")
  assert.deepEqual(ctx.sessions.interrupts.length, 1)
  assert.equal(outcome.run.agents[0].status, "interrupted")
})

test("supervisor: dispose stops active runs", async () => {
  const ctx = makeSupervisor()
  const pending = ctx.supervisor.start({ script: `await sleep(60000); return 1;` }, ctx.parent)
  await waitFor(() => ctx.registry.activeRuns().length > 0, "run creation")
  await ctx.supervisor.dispose()
  const outcome = await pending
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "plugin unload")
})

// ---------------------------------------------------------------------------
// Reviewer fixes: late children, stop-during-settle, delayed-interrupt scope,
// child titles.
// ---------------------------------------------------------------------------

test("supervisor: late-created child after finalize => marker N=1, never prompted, never owned", async () => {
  const registry = new FakeRegistry()
  const storage = new FakeStorage()
  const inner = new FakeSessionCtx()
  inner.push({ text: "late" })
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const supervisor = new SupervisorImpl({
    registry,
    storage,
    sessions: new GatedCreateSessions(inner, gate),
    options: { ...DEFAULT_OPTIONS, timeoutMs: 5_000 },
    settleGraceMs: 150,
    stopKillGraceMs: 100,
  })
  const parent: ParentContext = { sessionID: "ses_p", report: () => {} }
  // Fire-and-forget agent(): its session.create() is gated; the script returns
  // immediately and the run finalizes while the create is still pending.
  const pending = supervisor.start({ script: `agent("deferred"); return "ok";` }, parent)
  const outcome = await pending // settle grace expires, run finalizes anyway
  assert.equal(outcome.run.status, "succeeded")
  assert.equal(outcome.envelope.status, "succeeded")
  // Honest accounting: the unresolved creation still in flight at finalize
  // counts as pending cleanup (N=1) even though no cleanup promise was pushed.
  assert.equal(outcome.envelope.stopReason, "(1 cleanup pending)")

  // The deferred create() resolves AFTER finalize: registration is refused —
  // the driver cancels that call BEFORE any prompt and interrupts best-effort.
  releaseGate()
  await waitFor(() => inner.interrupts.length > 0, "late child interrupt")
  const child = [...inner.sessions.values()][0]
  assert.ok(child, "late child session exists")
  assert.equal(child.prompts, 0, "late child was never prompted")
  assert.ok(inner.interrupts.length >= 1, "late child interrupted best-effort")
  // Never gained ownership — not active, not even historically:
  assert.equal(registry.owned.size, 0)
  assert.equal(registry.everOwned.size, 0)
  // ...and the run record stayed finalized:
  assert.equal(registry.get(outcome.run.id)?.status, "succeeded")
})

test("supervisor: child created DURING settle grace => cancelled before prompt, settle exits early, no marker", async () => {
  const registry = new FakeRegistry()
  const storage = new FakeStorage()
  const inner = new FakeSessionCtx()
  inner.push({ text: "unused reply" })
  let releaseGate!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve
  })
  const supervisor = new SupervisorImpl({
    registry,
    storage,
    sessions: new GatedCreateSessions(inner, gate),
    options: { ...DEFAULT_OPTIONS, timeoutMs: 5_000 },
    settleGraceMs: 1_500, // long grace — must NOT be burned
    stopKillGraceMs: 100,
  })
  const parent: ParentContext = { sessionID: "ses_p", report: () => {} }
  const pending = supervisor.start({ script: `agent("late"); return "ok";` }, parent)
  // Let the script finish + the settle phase begin with the gated create pending.
  await waitFor(() => registry.activeRuns().length > 0, "run creation")
  await tick(150)

  const t0 = Date.now()
  releaseGate() // create() resolves DURING the settle grace
  const outcome = await pending
  const elapsed = Date.now() - t0

  // Registration refused -> driver threw RunClosedError before prompting ->
  // cleanup (interrupt) completed -> settle exited early, honest zero marker.
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.stopReason, undefined)
  assert.ok(elapsed < 700, `settle exited early (took ${elapsed}ms of the 1500ms grace)`)
  const child = [...inner.sessions.values()][0]
  assert.ok(child)
  assert.equal(child.prompts, 0, "child was never prompted (cancelled before prompt)")
  assert.ok(inner.interrupts.length >= 1, "child interrupted best-effort")
  assert.equal(registry.owned.size, 0, "child never gained ownership")
  // The cancelled call surfaced as a script-visible agent error (record interrupted).
  assert.ok(["interrupted", "failed"].includes(outcome.run.agents[0].status))
  assert.equal(outcome.run.agents[0].status, "interrupted")
})

test("supervisor: workflow() composition uses the injected loadWorkflowFresh dep", async () => {
  const ctx = makeSupervisor()
  const loads: string[] = []
  const supervisor = new SupervisorImpl({
    registry: ctx.registry,
    storage: ctx.storage,
    sessions: ctx.sessions,
    options: ctx.options,
    loadWorkflowFresh: async (name) => {
      loads.push(name)
      return {
        manifest: { version: 1, name, hash: "", source: "project", savedAt: 0 },
        script: "return 40 + 2;",
      }
    },
  })
  const outcome = await supervisor.start({ script: `return await workflow("helper", null);` }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, 42)
  assert.deepEqual(loads, ["helper"])
})

test("supervisor: stop during settle grace reports stopped, not succeeded", async () => {
  const ctx = makeSupervisor({}, { settleGraceMs: 900, stopKillGraceMs: 100 })
  ctx.sessions.hangWait = true // dangling agent call never settles on its own
  const pending = ctx.supervisor.start({ script: `agent("dangling"); return "ok";` }, ctx.parent)
  await waitFor(() => ctx.sessions.sessions.size > 0, "child session created")
  await tick(120) // script returned + done received; settle is now waiting on the dangling call
  const runID = ctx.registry.activeRuns()[0].id
  assert.equal(ctx.supervisor.stop(runID, "user request"), true)

  const outcome = await pending
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "user request")
  assert.notEqual(outcome.envelope.status, "succeeded")
  assert.ok(ctx.sessions.interrupts.length >= 1, "dangling child interrupted via abort race")
})

test("supervisor: normal completion cancels the delayed interrupt — no interrupts after finalize", async () => {
  const ctx = makeSupervisor({}, { settleGraceMs: 400, stopKillGraceMs: 600 })
  ctx.sessions.push({ text: "first done" })
  const pending = ctx.supervisor.start(
    { script: `await agent("first"); await sleep(80); return "ok";` },
    ctx.parent,
  )
  await waitFor(
    () => ctx.registry.activeRuns()[0]?.agents[0]?.status === "succeeded",
    "first agent done",
  )
  const runID = ctx.registry.activeRuns()[0].id
  // Stop while the script sleeps: kill timer (600ms) is scheduled, but the
  // script completes first and the run must cancel it before it fires.
  assert.equal(ctx.supervisor.stop(runID, "wrapping up"), true)
  const outcome = await pending
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "wrapping up")
  // The completed child is historical (not in the live set) and the delayed
  // interrupt was canceled: no interrupts may fire, ever.
  await tick(700)
  assert.deepEqual(ctx.sessions.interrupts, [])
})

test("supervisor: child session titles carry the [uc:<runID> <ord>] prefix", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({ text: "hi" })
  const outcome = await ctx.supervisor.start(
    { script: `await agent("say hi", { label: "probe" }); return 1;` },
    ctx.parent,
  )
  const sessionID = outcome.run.agents[0].sessionID
  assert.ok(sessionID)
  const title = ctx.sessions.sessions.get(sessionID)?.title
  // FakeRegistry ids are run_fake<N>; no explicit/ambient phase → phase segment omitted.
  assert.match(title ?? "", /^\[uc:run_fake\d+ a1 p:ses_parent\] probe$/)
  assert.deepEqual(ctx.registry.agentForSession(sessionID), { runID: outcome.run.id, agentID: "a1" })
})

test("supervisor: startDetached returns runID before finalize; done settles with envelope", async () => {
  const ctx = makeSupervisor()
  const { runID, done } = ctx.supervisor.startDetached({ script: `return 7;` }, ctx.parent)
  assert.match(runID, /^run_/)
  assert.equal(ctx.registry.get(runID)?.status, "running")
  const outcome = await done
  assert.equal(outcome.envelope.runID, runID)
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, 7)
})

test("supervisor: startDetached rejects nested-owned parents", async () => {
  const ctx = makeSupervisor()
  const other = ctx.registry.create({ parentSessionID: "ses_other", script: "s" })
  ctx.registry.markOwned(other.id, ctx.parent.sessionID)
  assert.throws(
    () => ctx.supervisor.startDetached({ script: `return 1;` }, ctx.parent),
    /nested workflow runs are not allowed/,
  )
  assert.equal(ctx.registry.runs.size, 1) // only the pre-existing run
})

test("supervisor: pause queues new agent() until resume; in-flight completes", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({ text: "AFTER" })
  const { runID, done } = ctx.supervisor.startDetached(
    { script: `await sleep(80); const r = await agent("after pause", { label: "late" }); return r.text;` },
    ctx.parent,
  )
  await waitFor(() => ctx.registry.activeRuns().length > 0, "run creation")
  assert.equal(ctx.supervisor.pause(runID), true)
  assert.equal(ctx.registry.get(runID)?.status, "paused")
  assert.ok(ctx.reports.some((s) => s.startsWith("paused ")))
  await tick(200) // sleep finished; agent() blocked on pause gate
  assert.equal(ctx.sessions.sessions.size, 0, "new agent() not admitted while paused")
  assert.equal(ctx.supervisor.resume(runID), true)
  assert.equal(ctx.registry.get(runID)?.status, "running")
  assert.ok(ctx.reports.some((s) => s.startsWith("resumed ")))
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, "AFTER")
  assert.equal(ctx.sessions.sessions.size, 1)
})

test("supervisor: in-flight agent completes while paused", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({ text: "INFLIGHT" })
  ctx.sessions.waitDelayMs = 200
  const { runID, done } = ctx.supervisor.startDetached(
    { script: `return (await agent("go", { label: "live" })).text;` },
    ctx.parent,
  )
  await waitFor(() => ctx.sessions.sessions.size > 0, "in-flight child")
  assert.equal(ctx.supervisor.pause(runID), true)
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, "INFLIGHT")
})

test("supervisor: queued semaphore waiter stays queued while paused, runs on resume", async () => {
  const ctx = makeSupervisor({ concurrency: 1 })
  ctx.sessions.push({ text: "one" })
  ctx.sessions.push({ text: "two" })
  ctx.sessions.hangWait = true
  let creates = 0
  let prompts = 0
  const origCreate = ctx.sessions.create.bind(ctx.sessions)
  const origPrompt = ctx.sessions.prompt.bind(ctx.sessions)
  ctx.sessions.create = async (input) => {
    creates++
    return origCreate(input)
  }
  ctx.sessions.prompt = async (input) => {
    prompts++
    return origPrompt(input)
  }
  const { runID, done } = ctx.supervisor.startDetached(
    {
      script: `
        const a = agent("one", { label: "first" });
        const b = agent("two", { label: "second" });
        return { a: (await a).text, b: (await b).text };
      `,
    },
    ctx.parent,
  )
  await waitFor(() => ctx.sessions.sessions.size === 1, "first child in-flight")
  const createsAfterFirst = creates
  const promptsAfterFirst = prompts
  assert.equal(createsAfterFirst, 1)
  assert.equal(promptsAfterFirst, 1)
  assert.equal(ctx.supervisor.pause(runID), true)
  ctx.sessions.hangWait = false
  ctx.sessions.releaseHangs()
  await waitFor(
    () => ctx.registry.get(runID)?.agents.some((a) => a.status === "succeeded") === true,
    "first child finished during pause",
  )
  await tick(80)
  assert.equal(creates, createsAfterFirst, "second never created during pause")
  assert.equal(prompts, promptsAfterFirst, "second never prompted during pause")
  assert.equal(ctx.sessions.sessions.size, 1, "queued waiter did not start a session")
  assert.equal(ctx.supervisor.resume(runID), true)
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded")
  const result = outcome.envelope.result as { a?: string; b?: string }
  assert.equal(result.a, "one")
  assert.equal(result.b, "two")
  assert.equal(creates, 2)
  assert.equal(prompts, 2)
})

test("supervisor: stop during pause finalizes stopped with no cleanup-pending marker", async () => {
  const ctx = makeSupervisor({ concurrency: 1 })
  ctx.sessions.hangWait = true
  const { runID, done } = ctx.supervisor.startDetached(
    {
      script: `
        const a = agent("one");
        const b = agent("two");
        return { a: (await a).text, b: (await b).text };
      `,
    },
    ctx.parent,
  )
  await waitFor(() => ctx.sessions.sessions.size === 1, "first child")
  assert.equal(ctx.supervisor.pause(runID), true)
  assert.equal(ctx.supervisor.stop(runID, "user request"), true)
  const outcome = await done
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "user request")
  assert.ok(!String(outcome.envelope.stopReason).includes("cleanup pending"))
})

test("supervisor: watchdog suspends while paused then settles after resume", async () => {
  const ctx = makeSupervisor({ timeoutMs: 180 })
  const { runID, done } = ctx.supervisor.startDetached(
    { script: `await sleep(60000); return 1;` },
    ctx.parent,
  )
  await waitFor(() => ctx.registry.activeRuns().length > 0, "run creation")
  assert.equal(ctx.supervisor.pause(runID), true)
  await tick(400) // past the original 180ms deadline
  assert.equal(ctx.registry.get(runID)?.status, "paused")
  assert.equal(ctx.registry.get(runID)?.endedAt, undefined)
  assert.equal(ctx.supervisor.resume(runID), true)
  const outcome = await done
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "timeout")
})

test("supervisor: startDetached freezes effective options before artifact write", async () => {
  const ctx = makeSupervisor({ concurrency: 4, timeoutMs: 5_000, permissions: "ask" })
  const { runID, done } = ctx.supervisor.startDetached({ script: `return 1;` }, ctx.parent)
  const snap = ctx.registry.get(runID)?.effective
  assert.ok(snap)
  assert.equal(snap.concurrency, 4)
  assert.equal(snap.timeoutMs, 5_000)
  assert.equal(snap.permissions, "ask")
  ctx.supervisor.updateDefaults({ ...DEFAULT_OPTIONS, timeoutMs: 5_000, concurrency: 1, permissions: "noEditTools" })
  assert.equal(ctx.registry.get(runID)?.effective?.timeoutMs, 5_000)
  assert.equal(ctx.registry.get(runID)?.effective?.permissions, "ask")
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded")
  const second = ctx.supervisor.startDetached({ script: `return 1;` }, ctx.parent)
  assert.equal(ctx.registry.get(second.runID)?.effective?.concurrency, 1)
  assert.equal(ctx.registry.get(second.runID)?.effective?.permissions, "noEditTools")
  const secondOut = await second.done
  assert.equal(secondOut.envelope.status, "succeeded")
})

test("supervisor: mutating defaults after startDetached does not rewrite remaining timeout", async () => {
  const ctx = makeSupervisor({ timeoutMs: 5_000 })
  const { runID, done } = ctx.supervisor.startDetached({ script: `await sleep(60000); return 1;` }, ctx.parent)
  await waitFor(() => ctx.registry.activeRuns().length > 0, "run creation")
  ctx.supervisor.updateDefaults({ ...DEFAULT_OPTIONS, timeoutMs: 1 })
  assert.equal(ctx.registry.get(runID)?.effective?.timeoutMs, 5_000)
  assert.equal(ctx.supervisor.pause(runID), true)
  assert.equal(ctx.supervisor.resume(runID), true)
  ctx.supervisor.stop(runID, "user request")
  const outcome = await done
  assert.equal(outcome.envelope.status, "stopped")
})

test("resume remainingTimeoutMs is pinned to the frozen effective timeout", async () => {
  const ctx = makeSupervisor({ timeoutMs: 5_000 })
  const { runID, done } = ctx.supervisor.startDetached({ script: `await sleep(60000); return 1;` }, ctx.parent)
  await waitFor(() => ctx.registry.activeRuns().length > 0, "run creation")
  const frozen = ctx.registry.get(runID)?.effective?.timeoutMs
  assert.equal(frozen, 5_000)
  assert.equal(ctx.supervisor.pause(runID), true)
  ctx.supervisor.updateDefaults({ ...DEFAULT_OPTIONS, timeoutMs: 1 })
  await tick(40)
  assert.equal(ctx.supervisor.resume(runID), true)
  const left = ctx.supervisor.remainingTimeoutFor(runID)
  assert.equal(typeof left, "number")
  assert.ok(left! > 1_000, `remaining ${left} should still track frozen 5000ms`)
  const sharedWouldBe = remainingTimeoutMs(1, Date.now() - 50, 0, false, undefined, Date.now())
  assert.ok(sharedWouldBe < 1, "shared options=1ms would already have expired")
  assert.ok(left! > sharedWouldBe)
  ctx.supervisor.stop(runID, "user request")
  const outcome = await done
  assert.equal(outcome.envelope.status, "stopped")
  assert.equal(outcome.envelope.stopReason, "user request")
})

test("startDetached persists effective snapshot so a settings query after reload sees it", async () => {
  const persisted: RunRecord[] = []
  const registry = new RegistryImpl({
    persist: (r) =>
      persisted.push({
        ...r,
        agents: r.agents.map((a) => ({ ...a })),
        effective: r.effective ? { ...r.effective } : undefined,
      }),
    throttleMs: 0,
    now: () => 1_000,
  })
  const storage = new FakeStorage()
  const sessions = new FakeSessionCtx()
  const supervisor = new SupervisorImpl({
    registry,
    storage,
    sessions,
    options: { ...DEFAULT_OPTIONS, concurrency: 4, timeoutMs: 5_000, permissions: "ask" },
  })
  const parent: ParentContext = { sessionID: "ses_parent", agent: "build", report: () => {} }
  const { runID, done } = supervisor.startDetached({ script: `return 1;` }, parent)
  const withEffective = persisted.filter((p) => p.id === runID && p.effective)
  assert.ok(withEffective.length >= 1, "effective must be persisted after assignment, not only the create snapshot")
  assert.equal(withEffective[withEffective.length - 1]!.effective?.concurrency, 4)
  assert.equal(withEffective[withEffective.length - 1]!.effective?.permissions, "ask")

  const reloaded = new RegistryImpl({
    persist: () => {},
    loader: () => persisted.filter((p) => p.id === runID).slice(-1),
    throttleMs: 0,
  })
  reloaded.reconcileOrphans()
  const loaded = reloaded.get(runID)
  assert.equal(capturedFromRecord(loaded)?.concurrency, 4)
  assert.equal(capturedFromRecord(loaded)?.permissions, "ask")
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded")
  await supervisor.dispose()
})
