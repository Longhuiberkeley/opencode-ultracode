/**
 * Chunk 2 — background ultracode_run admission, status, pause, blocking path.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  BACKGROUND_RUN_HINT,
  executeWorkflowLaunch,
} from "../src/command.ts"
import { SupervisorImpl } from "../src/supervisor.ts"
import { applySettleTick, type RunView, type SettleMaps } from "../src/tui-render.ts"
import type { ParentContext, RunOutcome, UltracodeOptions } from "../src/types.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"
import { FakeRegistry, FakeSessionCtx, FakeStorage } from "./fakes.ts"

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms))

function makeSupervisor(optionsOverrides: Partial<UltracodeOptions> = {}) {
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
  })
  const reports: string[] = []
  const parent: ParentContext = {
    sessionID: "ses_parent",
    agent: "build",
    report: (s) => reports.push(s),
  }
  return { supervisor, registry, storage, sessions, reports, parent }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`)
    await tick(10)
  }
}

test("background branch attaches a logged catch so a rejecting done is not unhandled", async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    const done = Promise.reject(new Error("finalize boom"))
    const result = await executeWorkflowLaunch(
      {
        start: async () => {
          throw new Error("background must not call start")
        },
        startDetached: () => ({ runID: "run_bgcatch", done }),
      },
      { script: "return 1" },
      { sessionID: "ses_parent", report: () => {} },
      true,
    )
    assert.equal(JSON.parse(result.content).runID, "run_bgcatch")
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(unhandled.length, 0)
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
  const src = readFileSync(new URL("../src/command.ts", import.meta.url), "utf8")
  assert.match(src, /const \{ runID, done \} = supervisor\.startDetached/)
  assert.match(src, /done\.catch/)
})

test("fast-return admission: background true returns runID + running without awaiting worker settlement", async () => {
  let startCalls = 0
  const neverStart: Pick<SupervisorImpl, "start" | "startDetached"> = {
    start: async () => {
      startCalls++
      return await new Promise<RunOutcome>(() => {})
    },
    startDetached: (_input, _parent) => ({
      runID: "run_fastadmit",
      done: new Promise<RunOutcome>(() => {}),
    }),
  }
  const t0 = Date.now()
  const result = await executeWorkflowLaunch(
    neverStart,
    { script: `await sleep(60000); return 1;` },
    { sessionID: "ses_parent", report: () => {} },
    true,
  )
  assert.ok(Date.now() - t0 < 200, "background must not wait for the worker")
  assert.equal(startCalls, 0, "background must not call supervisor.start")
  const body = JSON.parse(result.content) as { runID: string; status: string; hint: string }
  assert.equal(body.runID, "run_fastadmit")
  assert.equal(body.status, "running")
  assert.equal(body.hint, BACKGROUND_RUN_HINT)
  assert.match(body.hint, /ctrl\+g/)
  assert.match(body.hint, /not auto-woken/)
})

test("fast-return admission: invalid script errors before return", async () => {
  const ctx = makeSupervisor()
  await assert.rejects(
    () => executeWorkflowLaunch(ctx.supervisor, { script: `export default 1;` }, ctx.parent, true),
    /invalid workflow script/,
  )
  assert.equal(ctx.registry.runs.size, 0)
})

test("fast-return admission: nested owned session errors before return", async () => {
  const ctx = makeSupervisor()
  const other = ctx.registry.create({ parentSessionID: "ses_other", script: "s" })
  ctx.registry.markOwned(other.id, ctx.parent.sessionID)
  await assert.rejects(
    () => executeWorkflowLaunch(ctx.supervisor, { script: `return 1;` }, ctx.parent, true),
    /nested workflow runs are not allowed/,
  )
  assert.equal(ctx.registry.runs.size, 1)
})

test("default blocking path unchanged: omit background / false waits for envelope", async () => {
  const ctx = makeSupervisor()
  const omitted = await executeWorkflowLaunch(ctx.supervisor, { script: `return 7;` }, ctx.parent, false)
  const env = JSON.parse(omitted.content) as { status: string; result: unknown; runID: string; truncated: boolean }
  assert.equal(env.status, "succeeded")
  assert.equal(env.result, 7)
  assert.match(env.runID, /^run_/)
  assert.equal(env.truncated, false)

  let startCalls = 0
  let detachedCalls = 0
  const blocking: Pick<SupervisorImpl, "start" | "startDetached"> = {
    start: async (input, parent) => {
      startCalls++
      return await ctx.supervisor.start(input, parent)
    },
    startDetached: (input, parent) => {
      detachedCalls++
      return ctx.supervisor.startDetached(input, parent)
    },
  }
  const viaFalse = await executeWorkflowLaunch(blocking, { script: `return 8;` }, ctx.parent, false)
  assert.equal(startCalls, 1)
  assert.equal(detachedCalls, 0)
  assert.equal(JSON.parse(viaFalse.content).result, 8)
})

test("pause interaction with a background run: pause gates agent(); stop interrupts", async () => {
  const ctx = makeSupervisor()
  ctx.sessions.push({ text: "AFTER" })
  const ack = await executeWorkflowLaunch(
    ctx.supervisor,
    { script: `await sleep(80); const r = await agent("after pause", { label: "late" }); return r.text;` },
    ctx.parent,
    true,
  )
  const body = JSON.parse(ack.content) as { runID: string; status: string }
  assert.equal(body.status, "running")
  const runID = body.runID
  await waitFor(() => ctx.registry.activeRuns().some((r) => r.id === runID), "background run creation")
  assert.equal(ctx.supervisor.pause(runID), true)
  assert.equal(ctx.registry.get(runID)?.status, "paused")
  await tick(200)
  assert.equal(ctx.sessions.sessions.size, 0, "queued agent() stays gated while paused")
  assert.equal(ctx.supervisor.stop(runID, "user requested (/ultracode stop)"), true)
  await waitFor(() => {
    const status = ctx.registry.get(runID)?.status
    return status === "stopped" || status === "interrupted"
  }, "background run interrupted")
})

test("synthetic completion event emission: settled background run still toasts via applySettleTick", () => {
  const maps: SettleMaps = { lastChange: {}, fired: {}, prev: new Map() }
  const settled: RunView = {
    runID: "run_bgdone",
    agents: [{ sessionID: "s1", ord: "a1", status: "succeeded", title: "t1" }],
    phases: ["-"],
    counts: { total: 1, done: 1, failed: 0 },
    startedAt: 0,
    settled: true,
  }
  const quietMs = 5_000
  assert.deepEqual(applySettleTick([settled], maps, 1000, quietMs), [])
  assert.deepEqual(applySettleTick([settled], maps, 6000, quietMs), ["run_bgdone"])
  assert.deepEqual(applySettleTick([settled], maps, 99_000, quietMs), [])
})
