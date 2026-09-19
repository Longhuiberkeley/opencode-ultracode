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
  extraDeps: {
    pinForAgent?: (agentId: string) => Promise<{ providerID: string; id: string; variant?: string } | undefined>
    isProviderDisabled?: (providerID: string) => Promise<boolean>
    pinPool?: (agentIDs: readonly string[]) => Promise<ReadonlyArray<{ agentID: string; pin: string }>>
    disabledProviders?: () => Promise<ReadonlySet<string>>
  } = {},
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
    ...extraDeps,
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

test("supervisor: burst failure retries as a same-session continue — one session, one row", async () => {
  const ctx = makeSupervisor({ agentRetryBackoffMs: 0 })
  ctx.sessions.push({
    text: "",
    outcome: "failed",
    finish: "error",
    failure: { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
  })
  ctx.sessions.push({
    text: "RECOVERED",
    agent: "general",
    tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const outcome = await ctx.supervisor.start(
    { script: `const r = await agent("do the thing"); return r.text;` },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, "RECOVERED")
  assert.equal(ctx.sessions.sessions.size, 1, "the retry must continue the existing session")
  assert.equal(outcome.run.agents.length, 1, "one registry row per agent() call")
  const agent = outcome.run.agents[0]!
  assert.equal(agent.status, "succeeded")
  assert.equal(agent.sessionID, [...ctx.sessions.sessions.keys()][0])
  assert.equal(ctx.sessions.sessions.get(agent.sessionID!)!.prompts, 2)
  assert.ok(ctx.reports.some((s) => s.includes("retry 1/1")), `expected continue report, got: ${ctx.reports.join(" / ")}`)
})

test("supervisor: quota failure fails over the SAME session via modelFallbacks (one session, one row)", async () => {
  const ctx = makeSupervisor({ modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] } })
  ctx.sessions.push({
    text: "",
    outcome: "failed",
    finish: "error",
    failure: { type: "provider.rate-limit", message: "Usage limit reached for 5 hour", status: 429 },
  })
  ctx.sessions.push({
    text: "FAILED_OVER",
    agent: "general",
    model: { providerID: "google", id: "gemini-3.7-flash" },
  })
  const outcome = await ctx.supervisor.start(
    {
      script: `const r = await agent("do the thing", { model: { providerID: "xai", id: "grok-4.6" } }); return r.text;`,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, "FAILED_OVER")
  assert.equal(ctx.sessions.sessions.size, 1, "failover must continue the existing session")
  assert.equal(outcome.run.agents.length, 1, "one registry row per agent() call")
  const sessionID = [...ctx.sessions.sessions.keys()][0]!
  assert.deepEqual(ctx.sessions.switches, [
    { sessionID, model: { providerID: "google", id: "gemini-3.7-flash" }, beforePrompt: 1 },
  ])
  const agent = outcome.run.agents[0]!
  assert.equal(agent.status, "succeeded")
  assert.equal(agent.spawnModel?.providerID, "xai")
  assert.equal(agent.effectiveModel?.providerID, "google")
  assert.ok(ctx.reports.some((s) => s.includes("failover 1/1")), ctx.reports.join(" / "))
})

test("supervisor: quota failover uses the agent-config pin pool when no explicit ladder exists", async () => {
  const seenAgentIDs: string[][] = []
  const ctx = makeSupervisor(
    {},
    {},
    {
      pinForAgent: async (agentId) =>
        agentId === "general" ? { providerID: "xai", id: "grok-4.6" } : undefined,
      pinPool: async (agentIDs) => {
        seenAgentIDs.push([...agentIDs])
        return [
          { agentID: "general", pin: "xai/grok-mini" }, // dead provider: quota excludes it
          { agentID: "explore", pin: "google/gemini-3.7-flash" },
        ]
      },
    },
  )
  ctx.parent.availableAgents = ["general", "explore"]
  ctx.sessions.push({
    text: "",
    outcome: "failed",
    finish: "error",
    failure: { type: "provider.rate-limit", message: "Usage limit reached for 5 hour", status: 429 },
  })
  ctx.sessions.push({ text: "PIN_POOL_RECOVERY", agent: "general", model: { providerID: "google", id: "gemini-3.7-flash" } })
  const outcome = await ctx.supervisor.start({ script: `const r = await agent("do it"); return r.text;` }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.result, "PIN_POOL_RECOVERY")
  assert.deepEqual(seenAgentIDs, [["general", "explore"]])
  assert.equal(ctx.sessions.sessions.size, 1)
  const sessionID = [...ctx.sessions.sessions.keys()][0]!
  assert.deepEqual(ctx.sessions.switches, [
    { sessionID, model: { providerID: "google", id: "gemini-3.7-flash" }, beforePrompt: 1 },
  ])
})

test("supervisor: per-call opts.fallbacks are admitted and win; invalid pins fail the call fast", async () => {
  // The plugin-option ladder is configured too — the per-call rung must win.
  const ctx = makeSupervisor({ modelFallbacks: { "xai/grok-4.6": ["option/never-tried"] } })
  ctx.sessions.push({
    text: "",
    outcome: "failed",
    finish: "error",
    failure: { type: "provider.rate-limit", message: "Usage limit reached for 5 hour", status: 429 },
  })
  ctx.sessions.push({ text: "CALL_LADDER", agent: "explore", model: { providerID: "google", id: "gemini-3.7-flash" } })
  const ok = await ctx.supervisor.start(
    {
      script:
        `const r = await agent("go", { agent: "explore", model: { providerID: "xai", id: "grok-4.6" },` +
        ` fallbacks: ["google/gemini-3.7-flash", "anthropic/claude-x"] }); return r.text;`,
    },
    ctx.parent,
  )
  assert.equal(ok.envelope.status, "succeeded")
  assert.equal(ok.envelope.result, "CALL_LADDER")
  assert.deepEqual(
    ctx.sessions.switches.map((s) => `${s.model.providerID}/${s.model.id}`),
    ["google/gemini-3.7-flash"],
    "the per-call first rung recovered; the option-map rung was never tried",
  )

  const bad = makeSupervisor()
  const outcome = await bad.supervisor.start(
    { script: `await agent("x", { fallbacks: ["not-a-pin"] }); return 1;` },
    bad.parent,
  )
  assert.equal(outcome.envelope.status, "failed")
  assert.match(outcome.envelope.error ?? "", /opts\.fallbacks/)
  assert.equal(bad.sessions.sessions.size, 0, "admission rejects the call before any session is created")
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
  assert.ok(outcome.run.resultTruncated === true)
  assert.ok(outcome.run.resultArtifactKey)
  const stored = ctx.storage.loadResultArtifact(outcome.run.resultArtifactKey as string)
  assert.ok(stored && typeof stored === "object")
})

test("supervisor: artifact failure keeps resultTruncated honest, no phantom key", async () => {
  const ctx = makeSupervisor({ maxResultChars: 20 })
  ctx.storage.failSaveResultArtifact = true
  const outcome = await ctx.supervisor.start(
    { script: `return { blob: "${"x".repeat(500)}" };` },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  // Delivery is still truncated (preview), but no artifact key is claimed.
  assert.equal(outcome.envelope.truncated, true)
  assert.equal(outcome.envelope.resultArtifactKey, undefined)
  assert.equal(outcome.run.resultTruncated, true)
  assert.equal(outcome.run.resultArtifactKey, undefined)
  // The full result survives on the run record (renderResult fallback path).
  assert.ok(outcome.run.result && typeof outcome.run.result === "object")
})

test("supervisor: non-string agent() prompt fails the call, not silently empty", async () => {
  const ctx = makeSupervisor()
  const outcome = await ctx.supervisor.start(
    { script: `await agent(42); return "unreachable";` },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "failed")
  assert.match(outcome.envelope.error ?? "", /prompt must be a non-empty string/)
  assert.equal(outcome.run.agents.length, 0)
})

test("supervisor: non-string workflow() name fails the call", async () => {
  const ctx = makeSupervisor()
  const outcome = await ctx.supervisor.start(
    { script: `await workflow(undefined); return "unreachable";` },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "failed")
  assert.match(outcome.envelope.error ?? "", /name must be a non-empty string/)
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

test("supervisor: workflow() of a saved graph executes the compiled script against fake agents", async () => {
  const ctx = makeSupervisor()
  const spec = {
    nodes: [{ id: "say", kind: "agent", prompt: "Say GRAPH_OK" }],
    returns: { said: "$say" },
  }
  await ctx.storage.saveGraphWorkflow("hello-graph", spec as Json, { name: "hello-graph", source: "project" })
  ctx.sessions.push({ text: "GRAPH_OK" })
  const outcome = await ctx.supervisor.start({ script: `return await workflow("hello-graph");` }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded")
  assert.deepEqual(outcome.envelope.result, { said: "GRAPH_OK" })
  assert.equal(outcome.run.agents.length, 1, "the compiled graph spawned the one agent node")
  assert.equal(outcome.run.agents[0]!.status, "succeeded")
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

test("supervisor: run record keeps permissionStallMs for the stall watchdog", async () => {
  const ctx = makeSupervisor()
  const { runID, done } = ctx.supervisor.startDetached({ script: `return 1;` }, ctx.parent)
  const effective = ctx.registry.get(runID)?.effective
  assert.equal(effective?.permissions, DEFAULT_OPTIONS.permissions)
  assert.equal(effective?.permissionStallMs, DEFAULT_OPTIONS.permissionStallMs, "panelSettingsFrom must not drop it")
  await done
})

test("supervisor: graphSpec on the launch input lands on the run record (and is persisted)", async () => {
  const ctx = makeSupervisor()
  const spec = { nodes: [{ id: "a", kind: "agent", prompt: "say hi" }] } as Json
  const { runID, done } = ctx.supervisor.startDetached({ script: `return 1;`, graphSpec: spec }, ctx.parent)
  assert.deepEqual(ctx.registry.get(runID)?.graphSpec, spec)
  const snapshot = ctx.registry.saveCalls.find((r) => r.id === runID)
  assert.deepEqual(snapshot?.graphSpec, spec, "the first snapshot carries the spec (crash-visible)")
  const plain = ctx.supervisor.startDetached({ script: `return 1;` }, ctx.parent)
  assert.equal("graphSpec" in (ctx.registry.get(plain.runID) ?? {}), false)
  await Promise.all([done, plain.done])
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

// ---------------------------------------------------------------------------
// checkpoint() + keyed warm replay (resumeFrom)
// ---------------------------------------------------------------------------

test("supervisor: checkpoint(name, value) persists onto the run record and reports", async () => {
  const ctx = makeSupervisor()
  const outcome = await ctx.supervisor.start(
    { script: 'checkpoint("scout-done", { files: 2 })\ncheckpoint("bare")\nreturn "ok"' },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  const run = ctx.registry.get(outcome.envelope.runID)!
  assert.equal(run.checkpoints?.length, 2)
  assert.equal(run.checkpoints![0]!.name, "scout-done")
  assert.deepEqual(run.checkpoints![0]!.value, { files: 2 })
  assert.equal(run.checkpoints![1]!.name, "bare")
  assert.ok(run.checkpoints![1]!.value == null, "bare checkpoint carries no value (sanitized to null)")
  assert.ok(ctx.reports.some((r) => r.includes("checkpoint: scout-done")))
})

test("supervisor: resumeFrom replays keyed succeeded agents without spawning; envelope carries resumedFrom", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({
    text: "WORK_DONE",
    agent: "general",
    tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const script = 'const r = await agent("do work", { key: "work", label: "worker" })\nreturn { said: r.text }'
  const first = await ctx.supervisor.start({ script }, ctx.parent)
  assert.equal(first.envelope.status, "succeeded")
  assert.equal(first.envelope.agents.total, 1)
  const sessionsAfterFirst = ctx.sessions.sessions.size
  const sourceID = first.envelope.runID
  assert.equal(ctx.registry.get(sourceID)!.agents[0]!.key, "work")

  // Warm rerun: same script + same args shape — the keyed call replays.
  const second = await ctx.supervisor.start({ script, resumeFrom: sourceID }, ctx.parent)
  assert.equal(second.envelope.status, "succeeded")
  assert.equal(second.envelope.resumedFrom, sourceID)
  const result = second.envelope.result as { [key: string]: Json | undefined } | undefined
  assert.equal(result?.said, "WORK_DONE", "replayed text comes from the cache")
  assert.equal(second.envelope.agents.total, 1)
  assert.equal(second.envelope.agents.succeeded, 1)
  const warmRun = ctx.registry.get(second.envelope.runID)!
  assert.equal(warmRun.agents[0]!.cached, true)
  assert.equal(warmRun.agents[0]!.key, "work")
  assert.equal(warmRun.resumedFrom, sourceID)
  assert.equal(ctx.sessions.sessions.size, sessionsAfterFirst, "warm replay spawned no new session")
  assert.deepEqual(second.envelope.tokens, { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
})

test("supervisor: resumeFrom with a changed prompt spawns fresh (digest mismatch)", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({
    text: "FIRST",
    agent: "general",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  ctx.sessions.push({
    text: "SECOND",
    agent: "general",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const first = await ctx.supervisor.start(
    { script: 'const r = await agent("original prompt", { key: "k" })\nreturn r.text' },
    ctx.parent,
  )
  assert.equal(first.envelope.status, "succeeded")
  const second = await ctx.supervisor.start(
    { script: 'const r = await agent("CHANGED prompt", { key: "k" })\nreturn r.text', resumeFrom: first.envelope.runID },
    ctx.parent,
  )
  assert.equal(second.envelope.status, "succeeded")
  assert.equal(second.envelope.result, "SECOND", "digest mismatch spawned a real child")
  const warmRun = ctx.registry.get(second.envelope.runID)!
  assert.equal(warmRun.agents[0]!.cached, undefined)
})

test("supervisor: per-run timeoutMs overrides effective for that run only", async () => {
  const ctx = makeSupervisor({ timeoutMs: 5_000 })
  ctx.sessions.push({ text: "ok", agent: "general" })
  const outcome = await ctx.supervisor.start(
    { script: 'const r = await agent("say ok", { label: "t" })\nreturn r.text', timeoutMs: 7_200_000 },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  const run = ctx.registry.get(outcome.envelope.runID)!
  assert.equal(run.effective?.timeoutMs, 7_200_000, "the override is captured on the run record")
  assert.equal(run.timeoutOverrideMs, 7_200_000, "the explicit override is recorded distinctly for warm reruns")
  // The next run keeps the supervisor default — the override never leaks.
  ctx.sessions.push({ text: "ok", agent: "general" })
  const next = await ctx.supervisor.start({ script: "return 1" }, ctx.parent)
  const nextRun = ctx.registry.get(next.envelope.runID)!
  assert.equal(nextRun.effective?.timeoutMs, 5_000)
  assert.equal(nextRun.timeoutOverrideMs, undefined)
})

test("supervisor: per-run maxLoopDepth unlocks a deeper design for that run only", async () => {
  const ctx = makeSupervisor({ maxLoopDepth: 2 })
  const nested = `
let err = null
try {
  await loop({ key: "a", budget: { iterations: 1 } }, async () => {
    await loop({ key: "b", budget: { iterations: 1 } }, async () => {
      await loop({ key: "c", budget: { iterations: 1 } }, async () => ({ state: {} }))
      return { state: {} }
    })
    return { state: {} }
  })
} catch (e) { err = String(e && e.message ? e.message : e) }
return { err }
`
  // Without the input: the plugin default (2) structurally rejects depth 3.
  const blocked = await ctx.supervisor.start({ script: nested }, ctx.parent)
  assert.equal(blocked.envelope.status, "succeeded")
  assert.match(JSON.stringify(blocked.envelope.result), /maxLoopDepth/)
  // With the input: the same script runs, and the override is recorded.
  const passed = await ctx.supervisor.start({ script: nested, maxLoopDepth: 3 }, ctx.parent)
  assert.equal(passed.envelope.status, "succeeded")
  assert.deepEqual(passed.envelope.result, { err: null })
  const run = ctx.registry.get(passed.envelope.runID)!
  assert.equal(run.effective?.maxLoopDepth, 3, "the enforced cap is captured on the record")
  assert.equal(run.maxLoopDepthOverride, 3, "the explicit override is recorded for warm reruns")
  // The next run reverts to the configured default — the override never leaks.
  const next = await ctx.supervisor.start({ script: "return 1" }, ctx.parent)
  const nextRun = ctx.registry.get(next.envelope.runID)!
  assert.equal(nextRun.effective?.maxLoopDepth, 2)
  assert.equal(nextRun.maxLoopDepthOverride, undefined)
})

test("supervisor: per-run maxLoopIterations caps an authored loop budget for that run only", async () => {
  const ctx = makeSupervisor({})
  const script = `
const summary = await loop({
  key: "count",
  budget: { iterations: 4 },
}, async (ctx) => ({ state: { n: (ctx.state.n || 0) + 1 } }))
return { iterations: summary.iterations, budget: summary.budget }
`
  const outcome = await ctx.supervisor.start({ script, maxLoopIterations: 2 }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded")
  const result = outcome.envelope.result as { iterations: number; budget: { requested: number; effective: number } }
  assert.equal(result.iterations, 2, "the ceiling tightens the authored budget")
  assert.deepEqual(result.budget, { requested: 4, effective: 2 })
  const run = ctx.registry.get(outcome.envelope.runID)!
  assert.equal(run.maxLoopIterationsOverride, 2)
  assert.equal(run.effective?.maxLoopIterations, 2, "the ceiling is captured on the record")
  // The next run reverts: the authored budget runs unclamped, nothing recorded.
  const next = await ctx.supervisor.start({ script }, ctx.parent)
  const nextResult = next.envelope.result as { iterations: number }
  assert.equal(nextResult.iterations, 4)
  const nextRun = ctx.registry.get(next.envelope.runID)!
  assert.equal(nextRun.maxLoopIterationsOverride, undefined)
  assert.equal(nextRun.effective?.maxLoopIterations, undefined)
})

// ---------------------------------------------------------------------------
// Child-liveness watchdog (childStallMs)
// ---------------------------------------------------------------------------

test("childStallMs watchdog: stalled live child marked + interrupted; activity resets the clock", async () => {
  const made = makeSupervisor({ childStallMs: 60_000, timeoutMs: 60_000, agentRetryAttempts: 0 })
  const { supervisor, registry, sessions, parent } = made
  const reports = made.reports
  sessions.hangWait = true
  const started = supervisor.startDetached({ script: "await agent('hi')", name: "stall-test" }, parent)
  await tick(30) // child created, its wait() parked in hangWait

  const internals = supervisor as unknown as {
    runs: Map<
      string,
      { live: Set<string>; childLastActivity: Map<string, number>; stallNotified: Set<string> }
    >
    scanForStalledChildren(state: unknown): void
  }
  const state = internals.runs.get(started.runID)!
  assert.ok(state, "run state exists while a child is live")
  const sid = [...state.live][0]!
  assert.ok(sid, "one live child session")

  // Activity bump resets the clock: backdate, bump via noteChildActivity, scan -> no action.
  state.childLastActivity.set(sid, Date.now() - 120_000)
  supervisor.noteChildActivity(sid)
  internals.scanForStalledChildren(state)
  assert.equal(sessions.interrupts.length, 0, "fresh activity must not stall")
  assert.equal(state.stallNotified.size, 0)

  // Backdate past the threshold -> record error + best-effort interrupt + report.
  state.childLastActivity.set(sid, Date.now() - 120_000)
  internals.scanForStalledChildren(state)
  assert.ok(sessions.interrupts.includes(sid), "stalled child is interrupted")
  assert.ok(reports.some((r) => r.includes("stalled")), `expected stall report, got: ${reports.join(" / ")}`)
  const rec = registry.getAgent(started.runID, "a1")!
  assert.ok((rec.error ?? "").includes("child stalled"), `record carries stall cause, got: ${rec.error}`)
  assert.equal(state.stallNotified.size, 1, "stall fires once per child")

  // Release the hang: the interrupt-driven outcome fails the run VISIBLY
  // (no zombie "running" rows) and the run settles.
  sessions.releaseHangs()
  const outcome = await started.done
  assert.equal(outcome.run.status, "failed")
})

// ---------------------------------------------------------------------------
// Model overrides (call-site > run-level > pin; disabled providers gate)
// ---------------------------------------------------------------------------

test("model override: call-site string reaches session.create with source provenance", async () => {
  const ctx = makeSupervisor({}, {}, {
    pinForAgent: async () => ({ providerID: "xai", id: "pinned-model" }),
  })
  ctx.sessions.push({ text: "ok", agent: "general" })
  const outcome = await ctx.supervisor.start(
    {
      script: `const r = await agent("hello", { model: "google/gemini-3.7-flash#lite" })
return { text: r.text }`,
    },
    ctx.parent,
  )
  assert.equal(outcome.run.status, "succeeded")
  assert.deepEqual(ctx.sessions.createdModels[0], {
    providerID: "google",
    id: "gemini-3.7-flash",
    variant: "lite",
  }, "the per-call override rides session.create (beats the pin)")
  const rec = ctx.registry.getAgent(outcome.run.id, "a1")!
  assert.equal(rec.spawnModel?.source, "call")
  assert.equal(rec.spawnModel?.providerID, "google")
})

test("model override: invalid shape fails the agent call fast", async () => {
  const ctx = makeSupervisor()
  const outcome = await ctx.supervisor.start(
    {
      script: `await agent("hello", { model: "not-a-pin" })
return { ok: true }`,
    },
    ctx.parent,
  )
  assert.equal(outcome.run.status, "failed")
  assert.match(outcome.run.error ?? "", /model must be/)
  assert.equal(ctx.sessions.createdModels.length, 0, "no session spawned for a bad override")
})

test("model override: disabled provider is a hard error; allowDisabledProviders unlocks it", async () => {
  // Vetoed
  {
    const ctx = makeSupervisor({}, {}, { isProviderDisabled: async () => true })
    const outcome = await ctx.supervisor.start(
      { script: `await agent("hello", { model: "offline/m1" })\nreturn 1` },
      ctx.parent,
    )
    assert.equal(outcome.run.status, "failed")
    assert.match(outcome.run.error ?? "", /disabled \(disabled_providers\)/)
    assert.match(outcome.run.error ?? "", /allowDisabledProviders/)
    assert.equal(ctx.sessions.createdModels.length, 0)
  }
  // Unlocked per-run
  {
    const ctx = makeSupervisor({}, {}, { isProviderDisabled: async () => true })
    ctx.sessions.push({ text: "ok", agent: "general" })
    const outcome = await ctx.supervisor.start(
      {
        script: `await agent("hello", { model: "offline/m1" })\nreturn 1`,
        allowDisabledProviders: true,
      },
      ctx.parent,
    )
    assert.equal(outcome.run.status, "succeeded")
    assert.deepEqual(ctx.sessions.createdModels[0], { providerID: "offline", id: "m1" })
  }
})

test("model override: run-level model applies to children without a per-call model", async () => {
  const ctx = makeSupervisor({}, {}, {
    pinForAgent: async () => ({ providerID: "xai", id: "pinned-model" }),
  })
  ctx.sessions.push({ text: "a", agent: "general" })
  ctx.sessions.push({ text: "b", agent: "general" })
  const outcome = await ctx.supervisor.start(
    {
      script: `
await agent("run model")
await agent("call model", { model: "google/gemini-3.7-flash" })
return 1`,
      model: { providerID: "openai", id: "gpt-6" },
    },
    ctx.parent,
  )
  assert.equal(outcome.run.status, "succeeded")
  assert.deepEqual(ctx.sessions.createdModels[0], { providerID: "openai", id: "gpt-6" }, "run model applied")
  assert.deepEqual(ctx.sessions.createdModels[1], { providerID: "google", id: "gemini-3.7-flash" }, "call beats run")
  const a1 = ctx.registry.getAgent(outcome.run.id, "a1")!
  const a2 = ctx.registry.getAgent(outcome.run.id, "a2")!
  assert.equal(a1.spawnModel?.source, "run")
  assert.equal(a2.spawnModel?.source, "call")
})

test("model override: run-level model on a disabled provider fails before any child spawns", async () => {
  const ctx = makeSupervisor({}, {}, { isProviderDisabled: async (p) => p === "offline" })
  const outcome = await ctx.supervisor.start(
    { script: `await agent("hello")\nreturn 1`, model: { providerID: "offline", id: "m1" } },
    ctx.parent,
  )
  assert.equal(outcome.run.status, "failed")
  assert.match(outcome.run.error ?? "", /targets provider "offline"/)
  assert.equal(ctx.sessions.createdModels.length, 0, "preflight gate: no session created")
})

test("model override: graph node model flows end-to-end through the worker", async () => {
  const { compileGraphSpec } = await import("../src/graph.ts")
  const ctx = makeSupervisor({}, {}, {
    pinForAgent: async () => ({ providerID: "xai", id: "pinned-model" }),
  })
  ctx.sessions.push({ text: "done", agent: "explore" })
  const compiled = compileGraphSpec({
    nodes: [
      { id: "solo", kind: "agent", agent: "explore", model: "google/gemini-3.7-flash", prompt: "hi {{args.x}}" },
    ],
  })
  const outcome = await ctx.supervisor.start({ script: compiled.script, args: { x: 1 } }, ctx.parent)
  assert.equal(outcome.run.status, "succeeded", outcome.run.error ?? "")
  assert.deepEqual(ctx.sessions.createdModels[0], { providerID: "google", id: "gemini-3.7-flash" })
  assert.equal(ctx.registry.getAgent(outcome.run.id, "a1")!.spawnModel?.source, "call")
  // run-level model persists on the record for rerun reproduction
  const ctx2 = makeSupervisor()
  ctx2.sessions.push({ text: "ok", agent: "general" })
  const out2 = await ctx2.supervisor.start(
    { script: `return 1`, model: { providerID: "openai", id: "gpt-6" } },
    ctx2.parent,
  )
  assert.deepEqual(out2.run.modelOverride, { providerID: "openai", id: "gpt-6" })
})

test("supervisor: loop auto-keys replay on a warm rerun (resumeFrom)", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({ text: "A", agent: "general" }).push({ text: "B", agent: "general" })
  const script = `
const summary = await loop({ key: "warmloop", budget: { iterations: 2, agentsPerIteration: 2 }, stop: { stallK: 9 } },
  async (c) => {
    await agent("step " + c.i)
    return { state: { n: c.i + 1 } }
  })
return { iterations: summary.iterations, stopReason: summary.stopReason }`
  const first = await ctx.supervisor.start({ script }, ctx.parent)
  assert.equal(first.envelope.status, "succeeded", first.envelope.error ?? "run failed")
  assert.equal(first.envelope.agents.total, 2)
  const sessionsAfterFirst = ctx.sessions.sessions.size

  const second = await ctx.supervisor.start({ script, resumeFrom: first.envelope.runID }, ctx.parent)
  assert.equal(second.envelope.status, "succeeded", second.envelope.error ?? "warm run failed")
  const warm = ctx.registry.get(second.envelope.runID)!
  assert.deepEqual(
    warm.agents.map((a) => a.key),
    ["warmloop:i0:a1", "warmloop:i1:a1"],
    "auto-keys are deterministic across runs",
  )
  assert.deepEqual(warm.agents.map((a) => a.cached), [true, true], "both iterations replay from the source run")
  assert.equal(ctx.sessions.sessions.size, sessionsAfterFirst, "warm loop replay spawned no new sessions")
})
