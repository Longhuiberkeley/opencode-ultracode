/**
 * Builder B tests — supervisor integration smoke tests: run lifecycle through
 * a REAL worker + FakeSessionCtx/FakeRegistry/FakeStorage (no plugin imports).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { SupervisorImpl } from "../src/supervisor.ts"
import type { Json, ParentContext, SessionCtx, UltracodeOptions } from "../src/types.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"
import { FakeRegistry, FakeSessionCtx, FakeStorage } from "./fakes.ts"

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

  async create(i: { title?: string; agent?: string }): Promise<{ id: string; agent?: string }> {
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

test("supervisor: late-created child after finalize => interrupted, never owned, run finalizes", async () => {
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

  // The deferred create() resolves AFTER finalize:
  releaseGate()
  await waitFor(() => inner.interrupts.length > 0, "late child interrupt")
  assert.ok(inner.interrupts.length >= 1, "late child interrupted best-effort")
  // Never gained ownership — not active, not even historically:
  assert.equal(registry.owned.size, 0)
  assert.equal(registry.everOwned.size, 0)
  // ...and the run record stayed finalized:
  assert.equal(registry.get(outcome.run.id)?.status, "succeeded")
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

test("supervisor: child session titles carry the [uc:<runTag>] prefix", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({ text: "hi" })
  const outcome = await ctx.supervisor.start(
    { script: `await agent("say hi", { label: "probe" }); return 1;` },
    ctx.parent,
  )
  const sessionID = outcome.run.agents[0].sessionID
  assert.ok(sessionID)
  const title = ctx.sessions.sessions.get(sessionID)?.title
  // FakeRegistry ids are run_fake<N> -> tag "fake<N>" (first 8 chars sans prefix)
  assert.match(title ?? "", /^\[uc:fake\d+\] probe$/)
})
