/**
 * Stage breaker-ask tests — run-level provider breaker (quota quarantine +
 * burst throttle), ask mode (pause + one coalesced report + resume override)
 * and the quota-skip admission path, through the real supervisor + fakes.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { ProviderBreaker, SupervisorImpl, PROVIDER_BURST_STRIKE_LIMIT, PROVIDER_BURST_WINDOW_MS } from "../src/supervisor.ts"
import type { ParentContext, UltracodeOptions } from "../src/types.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"
import { ULTRACODE_RPC } from "../src/rpc-definition.ts"
import { loadOptions } from "../src/config.ts"
import { applyOverlay, parseSettingsOverlay, rememberModelFallback } from "../src/settings.ts"
import { FakeRegistry, FakeSessionCtx, FakeStorage } from "./fakes.ts"

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeSupervisor(
  optionsOverrides: Partial<UltracodeOptions> = {},
  depsOverrides: { breakerStaggerMs?: number; now?: () => number } = {},
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
    settleGraceMs: 300,
    stopKillGraceMs: 80,
    ...depsOverrides,
  })
  const reports: string[] = []
  const parent: ParentContext = {
    sessionID: "ses_parent",
    agent: "build",
    report: (s) => reports.push(s),
  }
  return { supervisor, registry, storage, sessions, options, reports, parent }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await tick(10)
  }
}

const QUOTA_REPLY = {
  text: "",
  outcome: "failed",
  finish: "error",
  failure: { type: "provider.rate-limit", message: "Usage limit reached for 5 hour", status: 429 },
}

const BURST_REPLY = {
  text: "",
  outcome: "failed",
  finish: "error",
  failure: { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
}

const ok = (text: string, providerID: string, id: string) => ({
  text,
  agent: "general",
  model: { providerID, id },
})

// ---------------------------------------------------------------------------
// ProviderBreaker unit tests (injected clock)
// ---------------------------------------------------------------------------

test("breaker: quota quarantines until the parsed reset, emits once, expires on time", () => {
  let now = 1_000_000
  const events: Array<{ kind: string; providerID: string; resetAt?: number; model?: string }> = []
  const breaker = new ProviderBreaker({ now: () => now, onEvent: (e) => events.push(e) })
  const resetAt = now + 3 * 3_600_000

  breaker.report({ runID: "run_a", providerID: "xai", class: "quota", resetAt, model: "xai/grok-4.6" })
  assert.equal(breaker.isQuarantined("xai"), true)
  assert.equal(breaker.quarantinedUntil("xai"), resetAt)
  assert.equal(events.length, 1, "one transition event")
  assert.deepEqual(breaker.quarantines(), [{ providerID: "xai", resetAt, models: ["xai/grok-4.6"] }])

  // A second child dying on the same dead provider must not ask again.
  breaker.report({ runID: "run_a", providerID: "xai", class: "quota", model: "xai/grok-mini" })
  assert.equal(events.length, 1, "ask reports once per quarantine, not per child")
  assert.deepEqual(breaker.quarantines()[0]!.models, ["xai/grok-4.6", "xai/grok-mini"])

  // Burst noise on a quarantined provider is ignored (quota dominates).
  breaker.report({ runID: "run_a", providerID: "xai", class: "burst" })
  assert.equal(breaker.isThrottled("xai"), false)

  now = resetAt + 1
  assert.equal(breaker.isQuarantined("xai"), false, "the parsed reset lifts the quarantine")
  assert.deepEqual(breaker.quarantines(), [])
})

test("breaker: unknown reset quarantines for the supervisor's lifetime", () => {
  const breaker = new ProviderBreaker({ now: () => 1 })
  breaker.report({ runID: "run_a", providerID: "xai", class: "quota" })
  assert.equal(breaker.isQuarantined("xai"), true)
  assert.equal(breaker.quarantinedUntil("xai"), Number.POSITIVE_INFINITY)
  assert.deepEqual(breaker.quarantines(), [{ providerID: "xai", models: [] }])
})

test("breaker: three burst strikes within 60s engage the throttle; a 60s quiet window lifts it", () => {
  let now = 10_000
  const events: Array<{ kind: string; strikes?: number }> = []
  const breaker = new ProviderBreaker({ now: () => now, onEvent: (e) => events.push(e) })
  breaker.report({ runID: "run_a", providerID: "xai", class: "burst" })
  breaker.report({ runID: "run_a", providerID: "xai", class: "burst" })
  assert.equal(breaker.isThrottled("xai"), false, "two strikes are not enough")
  breaker.report({ runID: "run_a", providerID: "xai", class: "burst" })
  assert.equal(breaker.isThrottled("xai"), true)
  assert.equal(events.filter((e) => e.kind === "burst").length, 1, "one engagement event")
  assert.equal(events[0]!.strikes, PROVIDER_BURST_STRIKE_LIMIT)

  // A fourth strike while throttled is not a second engagement.
  breaker.report({ runID: "run_a", providerID: "xai", class: "burst" })
  assert.equal(events.filter((e) => e.kind === "burst").length, 1)

  // Quiet window: no new strikes for 60s => the throttle lifts without an abort.
  now += PROVIDER_BURST_WINDOW_MS + 1
  assert.equal(breaker.isThrottled("xai"), false)
  assert.deepEqual(breaker.quarantines(), [], "throttling never quarantines")
})

test("breaker: admit is a no-op when healthy and serialize + stagger while throttled", async () => {
  let now = 5_000
  const breaker = new ProviderBreaker({ now: () => now, staggerMs: 40 })
  await breaker.admit("xai") // healthy: resolves immediately, no gate

  for (let i = 0; i < 3; i++) breaker.report({ runID: "run_a", providerID: "xai", class: "burst" })
  assert.equal(breaker.isThrottled("xai"), true)

  const starts: number[] = []
  const first = breaker.admit("xai").then(() => starts.push(Date.now()))
  const second = breaker.admit("xai").then(() => starts.push(Date.now()))
  await Promise.all([first, second])
  assert.equal(starts.length, 2)
  assert.ok(starts[1]! - starts[0]! >= 30, `throttled admissions are staggered (gap ${starts[1]! - starts[0]!}ms)`)
})

test("breaker: throttled admit is abort-aware", async () => {
  const breaker = new ProviderBreaker({ staggerMs: 5_000 })
  for (let i = 0; i < 3; i++) breaker.report({ runID: "run_a", providerID: "p", class: "burst" })
  await breaker.admit("p", AbortSignal.timeout(0)) // first admission: no wait (lastAdmissionAt 0)
  const controller = new AbortController()
  const queued = breaker.admit("p", controller.signal)
  controller.abort()
  await assert.rejects(queued, /run stopping/)
})

// ---------------------------------------------------------------------------
// Supervisor integration: quarantine skips session.create
// ---------------------------------------------------------------------------

test("breaker: a later child resolving to the quarantined provider never creates a session on it", async () => {
  const ctx = makeSupervisor({ modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] } })
  ctx.sessions.push(QUOTA_REPLY)
  ctx.sessions.push(ok("FIRST_RECOVERED", "google", "gemini-3.7-flash"))
  ctx.sessions.push(ok("SECOND", "google", "gemini-3.7-flash"))
  const outcome = await ctx.supervisor.start(
    {
      script: `
const a = await agent("one", { model: "xai/grok-4.6", label: "first" });
const b = await agent("two", { model: "xai/grok-4.6", label: "second" });
return { a: a.text, b: b.text, bFailover: b.failover ?? null };
`,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.run.error ?? "")
  assert.equal(ctx.sessions.sessions.size, 2, "exactly one session for the dead child + one routed child")
  assert.deepEqual(
    ctx.sessions.createdModels,
    [
      { providerID: "xai", id: "grok-4.6" },
      { providerID: "google", id: "gemini-3.7-flash" },
    ],
    "the second child must skip create on the quarantined provider",
  )
  // The first child failed over in place (switchModel); the second was created
  // on the candidate directly.
  assert.equal(ctx.sessions.switches.length, 1)
  assert.deepEqual(ctx.sessions.switches[0]!.model, { providerID: "google", id: "gemini-3.7-flash" })

  const rows = outcome.run.agents
  assert.equal(rows.length, 2, "one registry row per agent() call")
  for (const row of rows) {
    assert.equal(row.spawnModel?.providerID, "xai", "the intended pin is recorded")
    assert.equal(row.effectiveModel?.providerID, "google", "the routed model actually ran")
  }
  const result = outcome.envelope.result as { a?: string; b?: string; bFailover?: { from?: { providerID?: string }; to?: { providerID?: string }; class?: string } }
  assert.equal(result.a, "FIRST_RECOVERED")
  assert.equal(result.b, "SECOND")
  assert.equal(result.bFailover?.from?.providerID, "xai")
  assert.equal(result.bFailover?.to?.providerID, "google")
  assert.equal(result.bFailover?.class, "quota")
  assert.deepEqual(ctx.supervisor.providerQuarantines(), [{ providerID: "xai", models: ["xai/grok-4.6"] }])
})

test("breaker: quarantine with no eligible candidate fails the child before session.create", async () => {
  const ctx = makeSupervisor()
  // Quarantine xai first (same supervisor, shared breaker).
  ctx.sessions.push(QUOTA_REPLY)
  const first = await ctx.supervisor.start(
    { script: `try { await agent("boom", { model: "xai/grok-4.6" }) } catch {}\nreturn "ok"` },
    ctx.parent,
  )
  assert.equal(first.envelope.status, "succeeded")
  assert.equal(ctx.sessions.sessions.size, 1)

  const second = await ctx.supervisor.start(
    { script: `await agent("doomed", { model: "xai/grok-4.6" })\nreturn "unreachable"` },
    ctx.parent,
  )
  assert.equal(second.envelope.status, "failed")
  assert.match(second.run.error ?? "", /is quarantined/)
  assert.equal(ctx.sessions.sessions.size, 1, "no fresh session on the quarantined provider")
  assert.equal(second.run.agents[0]!.status, "failed")
  assert.equal(second.run.agents[0]!.spawnModel?.providerID, "xai")
})

test("breaker: supervisor-scoped burst throttle staggers admission across runs", async () => {
  const ctx = makeSupervisor({ agentRetryAttempts: 0 }, { breakerStaggerMs: 40 })
  // Run 1: three children die burst-shaped (no candidates) => 3 strikes / 60s.
  ctx.sessions.push(BURST_REPLY)
  ctx.sessions.push(BURST_REPLY)
  ctx.sessions.push(BURST_REPLY)
  const first = await ctx.supervisor.start(
    {
      script: `
for (let i = 0; i < 3; i++) {
  try { await agent("burst " + i, { model: "xai/grok-4.6" }) } catch {}
}
return "done"
`,
    },
    ctx.parent,
  )
  assert.equal(first.envelope.status, "succeeded", first.run.error ?? "")
  assert.equal(ctx.sessions.sessions.size, 3)

  // Run 2: two parallel children on the same provider are admitted with the
  // throttle stagger (shared breaker; the run itself is never aborted).
  ctx.sessions.push(ok("P1", "xai", "grok-mini"))
  ctx.sessions.push(ok("P2", "xai", "grok-mini"))
  const createTimes: number[] = []
  const origCreate = ctx.sessions.create.bind(ctx.sessions)
  ctx.sessions.create = async (input) => {
    createTimes.push(Date.now())
    return origCreate(input)
  }
  const second = await ctx.supervisor.start(
    {
      script: `
const rs = await parallel([
  () => agent("p1", { model: "xai/grok-mini" }),
  () => agent("p2", { model: "xai/grok-mini" }),
]);
return rs.map((r) => (r ? r.text : "null")).join(",");
`,
    },
    ctx.parent,
  )
  assert.equal(second.envelope.status, "succeeded", second.run.error ?? "")
  assert.equal(createTimes.length, 2)
  const gap = Math.abs(createTimes[1]! - createTimes[0]!)
  assert.ok(gap >= 30, `admissions staggered (gap ${gap}ms)`)
})

// ---------------------------------------------------------------------------
// Ask mode
// ---------------------------------------------------------------------------

test("ask mode: quarantine pauses the run once, reports the resume invocation, resume proceeds in auto mode", async () => {
  const ctx = makeSupervisor({ failover: "ask", modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] } })
  const resetAt = Date.now() + 3 * 3_600_000
  const resetIso = new Date(resetAt).toISOString().slice(0, 19).replace("T", " ")
  ctx.sessions.push({
    text: "",
    outcome: "failed",
    finish: "error",
    failure: {
      type: "provider.rate-limit",
      message: `Usage limit reached for 5 hour. Your limit will reset at ${resetIso}`,
      status: 429,
    },
  })
  ctx.sessions.push(ok("RECOVERED", "google", "gemini-3.7-flash"))
  const { runID, done } = ctx.supervisor.startDetached(
    { script: `const r = await agent("one", { model: "xai/grok-4.6", label: "first" }); return r.text;` },
    ctx.parent,
  )
  await waitFor(() => ctx.reports.some((r) => r.includes("provider ask —")), "ask report")
  assert.equal(ctx.registry.get(runID)?.status, "paused")
  assert.equal(ctx.registry.get(runID)?.endedAt, undefined, "the paused run does not settle")
  assert.ok((ctx.supervisor.remainingTimeoutFor(runID) ?? 0) > 0, "watchdog suspended while paused")

  const asks = ctx.reports.filter((r) => r.includes("provider ask —"))
  assert.equal(asks.length, 1, "ONE coalesced report, not per child")
  assert.match(asks[0]!, /account quota on xai/)
  assert.match(asks[0]!, /affected children: 1/)
  assert.match(asks[0]!, /proposed fallback: google\/gemini-3.7-flash/)
  assert.match(asks[0]!, new RegExp(`ultracode_control \\{ "action": "resume", "runID": "${runID}", "model": "google/gemini-3.7-flash" \\}`))

  // Resume without a model: auto-mode policy (the configured ladder).
  assert.equal(ctx.supervisor.resume(runID), true)
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded", outcome.run.error ?? "")
  assert.equal(outcome.envelope.result, "RECOVERED")
  assert.equal(ctx.sessions.sessions.size, 1, "no deadlock, no extra session")
  assert.deepEqual(ctx.sessions.switches.map((s) => `${s.model.providerID}/${s.model.id}`), ["google/gemini-3.7-flash"])
})

test("ask mode: resume-with-model routes the parked failover and later children to the override", async () => {
  const ctx = makeSupervisor({ failover: "ask", modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] } })
  ctx.sessions.push(QUOTA_REPLY)
  ctx.sessions.push(ok("FIRST", "openai", "gpt-6"))
  ctx.sessions.push(ok("SECOND", "openai", "gpt-6"))
  const { runID, done } = ctx.supervisor.startDetached(
    {
      script: `
const a = await agent("one", { model: "xai/grok-4.6", label: "first" });
const b = await agent("two", { model: "xai/grok-4.6", label: "second" });
return { a: a.text, b: b.text };
`,
    },
    ctx.parent,
  )
  await waitFor(() => ctx.registry.get(runID)?.status === "paused", "ask pause")
  assert.equal(ctx.sessions.sessions.size, 1, "the parked child holds its session; no new session while paused")
  await tick(80)
  assert.equal(ctx.sessions.sessions.size, 1, "admission stays closed while the ask holds")
  assert.equal(ctx.sessions.switches.length, 0, "the failover waits for the answer — no model switch while paused")
  assert.equal([...ctx.sessions.sessions.values()][0]!.prompts, 1, "no continuation prompt while paused")

  assert.equal(ctx.supervisor.resume(runID, { model: { providerID: "openai", id: "gpt-6" } }), true)
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded", outcome.run.error ?? "")
  const result = outcome.envelope.result as { a?: string; b?: string }
  assert.equal(result.a, "FIRST")
  assert.equal(result.b, "SECOND")
  // Parked failover picked up the override instead of the ladder's google rung.
  assert.deepEqual(ctx.sessions.switches.map((s) => `${s.model.providerID}/${s.model.id}`), ["openai/gpt-6"])
  // Later child: created directly on the override (no create on xai).
  assert.deepEqual(ctx.sessions.createdModels[1], { providerID: "openai", id: "gpt-6" })
  const rows = outcome.run.agents
  assert.equal(rows[1]!.spawnModel?.providerID, "xai")
  assert.equal(rows[1]!.effectiveModel?.providerID, "openai")
})

test("ask mode: askTimeoutMs > 0 auto-resumes in auto-mode policy after the timeout", async () => {
  const ctx = makeSupervisor({
    failover: "ask",
    askTimeoutMs: 60,
    modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] },
  })
  ctx.sessions.push(QUOTA_REPLY)
  ctx.sessions.push(ok("AUTO", "google", "gemini-3.7-flash"))
  const { runID, done } = ctx.supervisor.startDetached(
    { script: `const r = await agent("one", { model: "xai/grok-4.6" }); return r.text;` },
    ctx.parent,
  )
  await waitFor(() => ctx.reports.some((r) => r.includes("ask timeout")), "ask timeout auto-resume")
  assert.ok(ctx.reports.some((r) => r.includes("auto-resumes in 60ms")), "the ask report names the timeout")
  const outcome = await done
  assert.equal(outcome.envelope.status, "succeeded", outcome.run.error ?? "")
  assert.equal(outcome.envelope.result, "AUTO")
  assert.deepEqual(ctx.sessions.switches.map((s) => `${s.model.providerID}/${s.model.id}`), ["google/gemini-3.7-flash"])
})

test("ask mode: off-mode-like auto runs never pause; failover off fails typed without switching", async () => {
  // auto (default): no ask pause for the same failure.
  const auto = makeSupervisor({ modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] } })
  auto.sessions.push(QUOTA_REPLY)
  auto.sessions.push(ok("AUTO", "google", "gemini-3.7-flash"))
  const autoOut = await auto.supervisor.start(
    { script: `const r = await agent("one", { model: "xai/grok-4.6" }); return r.text;` },
    auto.parent,
  )
  assert.equal(autoOut.envelope.status, "succeeded", autoOut.run.error ?? "")
  assert.equal(auto.reports.some((r) => r.includes("provider ask —")), false)

  // off: children fail with the typed quota error — no switch, no routing.
  const off = makeSupervisor({ failover: "off", modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash"] } })
  off.sessions.push(QUOTA_REPLY)
  const offOut = await off.supervisor.start(
    { script: `await agent("doomed", { model: "xai/grok-4.6" })\nreturn "unreachable"` },
    off.parent,
  )
  assert.equal(offOut.envelope.status, "failed")
  assert.match(offOut.run.error ?? "", /Usage limit reached/)
  assert.equal(off.sessions.sessions.size, 1)
  assert.deepEqual(off.sessions.switches, [])
  assert.equal(offOut.run.agents[0]!.status, "failed")
})

test("remember: a persisted fallback entry routes the NEXT run's quota failover (settings path)", async () => {
  const storage = new FakeStorage()
  storage.saveSettingsOverlay(rememberModelFallback({}, "xai/grok-4.6", "openai/gpt-6"))
  const overlay = parseSettingsOverlay(storage.loadSettingsOverlay())
  const options = applyOverlay(loadOptions({}).options, overlay)
  assert.deepEqual(options.modelFallbacks, { "xai/grok-4.6": ["openai/gpt-6"] })

  const registry = new FakeRegistry()
  const sessions = new FakeSessionCtx()
  const supervisor = new SupervisorImpl({
    registry,
    storage,
    sessions,
    options: { ...options, timeoutMs: 5_000 },
    settleGraceMs: 300,
    stopKillGraceMs: 80,
  })
  sessions.push(QUOTA_REPLY)
  sessions.push(ok("REMEMBERED", "openai", "gpt-6"))
  const outcome = await supervisor.start(
    { script: `const r = await agent("one", { model: "xai/grok-4.6" }); return r.text;` },
    { sessionID: "ses_parent", report: () => {} },
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.run.error ?? "")
  assert.equal(outcome.envelope.result, "REMEMBERED")
  assert.deepEqual(
    sessions.switches.map((s) => `${s.model.providerID}/${s.model.id}`),
    ["openai/gpt-6"],
    "the remembered entry drives the next run's ladder",
  )
})

// ---------------------------------------------------------------------------
// RPC surface
// ---------------------------------------------------------------------------

test("rpc definition: control method carries the ask-mode resume surface", () => {
  const control = (ULTRACODE_RPC.methods as Record<string, { input: { properties?: Record<string, unknown> }; output: { properties?: Record<string, unknown> } }>)["control"]
  assert.ok(control, "control method defined")
  assert.deepEqual(Object.keys(control.input.properties ?? {}), ["action", "runID", "model", "remember"])
  assert.deepEqual(Object.keys(control.output.properties ?? {}), [
    "runID",
    "action",
    "status",
    "model",
    "remembered",
    "rememberError",
  ])
})