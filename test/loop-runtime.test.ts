/**
 * Loop-engine tests — runs WORKER_SOURCE in REAL node:worker_threads workers
 * with a mock host bridge (mirrors worker-script.test.ts). Covers the
 * engine-owned disciplines: budgets, auto-keys, verdict + skeptic, stall,
 * queue, unit preflight, nesting depth, deadlines.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"
import { WORKER_SOURCE } from "../src/worker-script.ts"
import type { Json } from "../src/types.ts"

interface WorkerEvent {
  kind: "progress" | "phase" | "log" | "checkpoint"
  data: Json
}

interface WorkerCall {
  fn: string
  args: Json[]
}

interface RunResult {
  ok: boolean
  value?: Json
  error?: string
  events: WorkerEvent[]
  calls: WorkerCall[]
}

type MockCallHandler = (fn: string, args: Json[], callIndex: number) => Promise<Json>

function runInWorker(
  script: string,
  opts: { args?: Json; caps?: Record<string, Json>; onCall?: MockCallHandler } = {},
): Promise<RunResult> {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  const events: WorkerEvent[] = []
  const calls: WorkerCall[] = []
  return new Promise<RunResult>((resolve, reject) => {
    worker.on("message", (msg: unknown) => {
      const m = msg as { type?: string; [k: string]: unknown }
      if (m.type === "call") {
        const args = (Array.isArray(m.args) ? m.args : []) as Json[]
        const index = calls.length
        calls.push({ fn: String(m.fn), args })
        const handler = opts.onCall
        if (!handler) {
          worker.postMessage({ type: "result", id: Number(m.id), ok: false, error: `no mock handler for ${String(m.fn)}` })
          return
        }
        void Promise.resolve()
          .then(() => handler(String(m.fn), args, index))
          .then(
            (value) => worker.postMessage({ type: "result", id: Number(m.id), ok: true, value: value ?? null }),
            (err: unknown) =>
              worker.postMessage({ type: "result", id: Number(m.id), ok: false, error: String((err as Error)?.message ?? err) }),
          )
        return
      }
      if (m.type === "event") {
        events.push({ kind: String(m.kind) as WorkerEvent["kind"], data: (m.data ?? null) as Json })
        return
      }
      if (m.type === "done") {
        const result: RunResult = {
          ok: m.ok === true,
          value: (m.value ?? undefined) as Json | undefined,
          error: typeof m.error === "string" ? m.error : undefined,
          events,
          calls,
        }
        void worker.terminate()
        resolve(result)
      }
    })
    worker.on("error", (err: Error) => {
      void worker.terminate()
      reject(err)
    })
    worker.postMessage({
      type: "init",
      script,
      args: opts.args,
      meta: {},
      ...(opts.caps !== undefined ? { caps: opts.caps } : {}),
    })
  })
}

const GENERAL_AGENT_CAPS = { maxAgents: 200, maxLoopDepth: 2 }

function agentResult(overrides: Record<string, Json> = {}): Json {
  return { text: "ok", sessionID: "ses_mock", agent: "general", tokens: { input: 1, output: 1, reasoning: 0 }, ...overrides }
}

function checkpointsOf(result: RunResult): Array<{ name: string; value: Json }> {
  return result.events
    .filter((e) => e.kind === "checkpoint")
    .map((e) => e.data as { name: string; value: Json })
}

function agentCallsOf(result: RunResult): WorkerCall[] {
  return result.calls.filter((c) => c.fn === "agent")
}

// ---------------------------------------------------------------------------

test("loop: iterations budget, auto-keys, checkpoints and summary shape", async () => {
  const result = await runInWorker(
    `
const seen = []
const summary = await loop({
  key: "basic",
  goal: "count",
  budget: { iterations: 3, agentsPerIteration: 2 },
  state: { n: 0 },
  stop: { stallK: 9 },
}, async (ctx) => {
  await agent("step " + ctx.i)
  seen.push(ctx.i)
  return { state: { n: ctx.state.n + 1 }, result: { i: ctx.i } }
})
return { seen, summary }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { seen: number[]; summary: Record<string, Json> }
  assert.deepEqual(value.seen, [0, 1, 2])
  assert.equal(value.summary["iterations"], 3)
  assert.equal(value.summary["stopReason"], "budget")
  assert.equal((value.summary["state"] as { n: number }).n, 3)
  // Auto-keys: <key>:i<i>:a<n>
  const keys = agentCallsOf(result).map((c) => (c.args[1] as { key?: string }).key)
  assert.deepEqual(keys, ["basic:i0:a1", "basic:i1:a1", "basic:i2:a1"])
  // Per-iteration checkpoints persisted
  const cps = checkpointsOf(result)
  assert.deepEqual(cps.map((c) => c.name), ["loop:basic:i0", "loop:basic:i1", "loop:basic:i2"])
})

test("loop: verdict done + verified skeptic stops with target", async () => {
  const result = await runInWorker(
    `
const summary = await loop({
  key: "judged",
  budget: { iterations: 5, agentsPerIteration: 4 },
  state: {},
  verdict: {
    schema: { type: "object", required: ["status"], properties: { status: { type: "string" }, evidence: { type: "string" } } },
    prompt: (ctx) => "judge iteration " + ctx.i,
  },
}, async () => ({ state: { done: true } }))
return { summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn !== "agent") return { ok: true }
        const opts = args[1] as { key?: string }
        if (opts.key?.endsWith(":verdict")) return agentResult({ data: { status: "done", evidence: "quoted output" } })
        if (opts.key?.endsWith(":skeptic")) return agentResult({ data: { verified: true, reason: "re-derived" } })
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "target")
  assert.equal(summary["iterations"], 1)
  const keys = agentCallsOf(result).map((c) => (c.args[1] as { key?: string }).key)
  assert.deepEqual(keys, ["judged:i0:verdict", "judged:i0:skeptic"])
})

test("loop: refuted terminating verdict keeps the loop going", async () => {
  let verdicts = 0
  const result = await runInWorker(
    `
const summary = await loop({
  key: "refuted",
  budget: { iterations: 2, agentsPerIteration: 4 },
  verdict: {
    schema: { type: "object", required: ["status"], properties: { status: { type: "string" } } },
    prompt: "judge",
  },
}, async () => ({ state: {} }))
return { summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn !== "agent") return { ok: true }
        const opts = args[1] as { key?: string }
        if (opts.key?.endsWith(":verdict")) {
          verdicts += 1
          return agentResult({ data: { status: "done" } })
        }
        if (opts.key?.endsWith(":skeptic")) return agentResult({ data: { verified: false, reason: "cannot reproduce" } })
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "budget", "refuted terminations must not stop the loop")
  assert.equal(verdicts, 2)
})

test("loop: predicate stop carries its reason string", async () => {
  const result = await runInWorker(
    `
const summary = await loop({
  key: "pred",
  budget: { iterations: 5 },
  state: { queue: [1, 2] },
  stop: { predicate: (v) => v.state.queue.length === 0 && "queue-empty" },
}, async (ctx) => ({ state: { queue: ctx.state.queue.slice(1) } }))
return { summary }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "queue-empty")
})

test("loop: stall stop when state stops changing", async () => {
  const result = await runInWorker(
    `
const summary = await loop({
  key: "stallme",
  budget: { iterations: 10 },
  state: { fixed: true },
  stop: { stallK: 3 },
}, async () => ({ state: { fixed: true } }))
return { summary }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "stall")
})

test("loop: agentsPerIteration overflow surfaces via the iteration policy", async () => {
  const result = await runInWorker(
    `
let err = null
try {
  await loop({
    key: "over",
    budget: { iterations: 3, agentsPerIteration: 2 },
    onIterationError: "abort",
  }, async () => {
    await agent("a")
    await agent("b")
    await agent("c")
    return { state: {} }
  })
} catch (e) { err = String(e && e.message ? e.message : e) }
return { err }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { err: string | null }
  // abort policy stops the loop with reason "error" — the loop call itself resolves
  // (the overflow does not throw out of loop()).
  assert.equal(value.err, null)
})

test("loop: overflow is reported as stopReason error with policy abort", async () => {
  const result = await runInWorker(
    `
const summary = await loop({
  key: "over2",
  budget: { iterations: 3, agentsPerIteration: 2 },
  onIterationError: "abort",
}, async () => {
  await agent("a")
  await agent("b")
  await agent("c")
  return { state: {} }
})
return { summary }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "error")
})

test("queue: deps gating, dedupe by content hash, done/block/sizes", async () => {
  const result = await runInWorker(
    `
const q = queue([
  { text: "first" },
  { text: "second" },
])
const ids = q.push([{ text: "follow-up", deps: [q.items()[0].id] }, { text: "first" }])
q.done(q.items()[0].id)
const out = []
out.push(q.pop())          // "second" — insertion order among ready items
const follow = q.pop()     // "follow-up" — its dep ("first") is done
out.push({ id: follow.id, text: follow.text })
q.block(follow.id, "waiting on triage")
out.push(q.pop())          // null: everything else is done or blocked
out.push(q.sizes())
out.push(ids.length)
return { out }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const out = (result.value as { out: unknown[] }).out
  assert.equal((out[0] as { text: string }).text, "second", "insertion order among ready items")
  assert.equal((out[1] as { text: string }).text, "follow-up", "dependency-cleared item becomes ready")
  assert.equal(out[2], null, "blocked item is not popped")
  const sizes = out[3] as Record<string, number>
  assert.equal(sizes.done, 1)
  assert.equal(sizes.blocked, 1)
  assert.equal(sizes.active, 1, "second was popped and is still active")
  assert.equal(out[4], 2, "push returns one id per item (dedupe still returns the existing id)")
})

test("loop: unit preflight checks the trusted workflow before iteration 1", async () => {
  const result = await runInWorker(
    `
let err = null
try {
  await loop({ key: "unitbad", unit: { name: "does-not-exist" }, budget: { iterations: 2 } })
} catch (e) { err = String(e && e.message ? e.message : e) }
return { err }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn) => {
        if (fn === "workflow-check") throw new Error('workflow "does-not-exist" is not trusted')
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { err: string | null }
  assert.match(value.err ?? "", /not trusted/)
  const agentCalls = result.calls.filter((c) => c.fn === "agent")
  assert.equal(agentCalls.length, 0, "no child spawns when the unit preflight fails")
})

test("loop: nesting depth cap rejects a third level at preflight", async () => {
  const result = await runInWorker(
    `
let err = null
try {
  await loop({ key: "l1", budget: { iterations: 1 } }, async () => {
    await loop({ key: "l2", budget: { iterations: 1 } }, async () => {
      await loop({ key: "l3", budget: { iterations: 1 } }, async () => ({ state: {} }))
      return { state: {} }
    })
    return { state: {} }
  })
} catch (e) { err = String(e && e.message ? e.message : e) }
return { err }
`,
    { caps: { maxAgents: 200, maxLoopDepth: 2 }, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { err: string | null }
  assert.match(value.err ?? "", /maxLoopDepth/)
})

test("loop: deadline in the past stops immediately with budget", async () => {
  const result = await runInWorker(
    `
const summary = await loop({
  key: "late",
  budget: { iterations: 5, deadline: Date.now() - 1000 },
}, async () => ({ state: {} }))
return { summary }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "budget")
  assert.equal(summary["iterations"], 0)
})

test("loop: preflight rejects iterations x agentsPerIteration beyond maxAgents", async () => {
  const result = await runInWorker(
    `
let err = null
try {
  await loop({ key: "toobig", budget: { iterations: 30, agentsPerIteration: 20 } }, async () => ({ state: {} }))
} catch (e) { err = String(e && e.message ? e.message : e) }
return { err }
`,
    { caps: { maxAgents: 100, maxLoopDepth: 2 }, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { err: string | null }
  assert.match(value.err ?? "", /exceeds the run cap maxAgents=100/)
})

test("loop: budgetLeft exposes the verdict-reserved per-iteration allowance", async () => {
  const result = await runInWorker(
    `
const summary = await loop({
  key: "left",
  budget: { iterations: 1, agentsPerIteration: 4 },
  verdict: { schema: { type: "object", properties: {} }, prompt: "judge", skeptic: false },
}, async (ctx) => {
  return { state: {}, result: { left: ctx.budgetLeft } }
})
return { summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn !== "agent") return { ok: true }
        const opts = args[1] as { key?: string }
        if (opts.key?.endsWith(":verdict")) return agentResult({ data: { status: "improve" } })
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  const left = (summary["lastResult"] as { left: { agentsPerIteration: number } }).left
  assert.equal(left.agentsPerIteration, 3, "4 total minus the 1 verdict reservation (skeptic off)")
})

test("queue: statuses and notes survive an items() round-trip (state persistence)", async () => {
  const result = await runInWorker(
    `
const q = queue([{ text: "a" }, { text: "b" }, { text: "c" }])
q.done(q.items()[0].id, "shipped")
q.block(q.items()[1].id, "needs triage")
const persisted = q.items()          // what the template writes into loop state
const q2 = queue(persisted)           // next iteration rebuilds from state
const sizes = q2.sizes()
const popped = q2.pop()               // only "c" is open
return { sizes, poppedText: popped ? popped.text : null, note: q2.items()[0].note }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { sizes: Record<string, number>; poppedText: string | null; note: string }
  assert.equal(value.sizes.done, 1, "done survives the rebuild")
  assert.equal(value.sizes.blocked, 1, "blocked survives the rebuild")
  assert.equal(value.poppedText, "c", "the open item is the only one poppable")
  assert.equal(value.note, "shipped", "notes persist")
})

test("loop: unit lane runs EVERY iteration at the caller's depth (scriptDepth leak fix)", async () => {
  const workflowDepths: number[] = []
  const checkNames: string[] = []
  const result = await runInWorker(
    `
const summary = await loop({ key: "unitloop", unit: { name: "unit-wf" }, budget: { iterations: 2 } })
return { summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn === "workflow-check") {
          checkNames.push(String(args[0]))
          return { ok: true }
        }
        if (fn === "workflow") {
          workflowDepths.push(Number(args[2]))
          return { script: "return { state: { ok: true } }", meta: {} }
        }
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  assert.deepEqual(checkNames, ["unit-wf"], "preflight runs once, before iteration 1")
  assert.deepEqual(workflowDepths, [0, 0], "composed execution must not leak its depth into iteration 2")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["iterations"], 2)
  assert.equal(summary["stopReason"], "budget")
})

test("loop: workflow() then a unit loop in one script keeps depths independent", async () => {
  const depths: Array<{ name: string; depth: number }> = []
  const result = await runInWorker(
    `
const direct = await workflow("helper")
const summary = await loop({ key: "after-wf", unit: { name: "unit-wf" }, budget: { iterations: 2 } })
return { direct, summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn === "workflow-check") return { ok: true }
        if (fn === "workflow") {
          const name = String(args[0])
          depths.push({ name, depth: Number(args[2]) })
          return name === "helper"
            ? { script: "return { answer: 42 }", meta: {} }
            : { script: "return { state: { ok: true } }", meta: {} }
        }
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { direct: { answer: number }; summary: Record<string, Json> }
  assert.equal(value.direct.answer, 42)
  assert.equal(value.summary["iterations"], 2)
  assert.deepEqual(
    depths.map((d) => d.name + "@" + d.depth),
    ["helper@0", "unit-wf@0", "unit-wf@0"],
    "a completed composed workflow must not raise the caller's composition depth",
  )
})

test("loop: a refuted verdict voids predicate stops for that iteration", async () => {
  let verdicts = 0
  const result = await runInWorker(
    `
const summary = await loop({
  key: "refpred",
  budget: { iterations: 2, agentsPerIteration: 4 },
  verdict: {
    schema: { type: "object", required: ["status"], properties: { status: { type: "string" }, metrics: { type: "object" } } },
    prompt: "judge",
  },
  stop: { predicate: function (v) { return v.state.hit === true && "state-stop" }, stallK: 9 },
}, async (ctx) => ({ state: { hit: true, n: ctx.i } }))
return { summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn !== "agent") return { ok: true }
        const opts = args[1] as { key?: string }
        if (opts.key?.endsWith(":verdict")) {
          verdicts += 1
          return agentResult({ data: { status: "done", metrics: { cv: 0.95 } } })
        }
        if (opts.key?.endsWith(":skeptic")) return agentResult({ data: { verified: false, reason: "cannot reproduce" } })
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  assert.equal(summary["stopReason"], "budget", "a refuted iteration must not stop, even on state the skeptic just voided")
  assert.equal(summary["lastVerdict"], null, "a refuted claim is not exposed as the loop's verdict")
  assert.equal(verdicts, 2)
  const history = summary["history"] as Array<{ skeptic?: string }>
  assert.equal(
    history.filter((row) => row.skeptic === "refuted").length,
    2,
    "each refutation is recorded in the history row",
  )
})

test("loop: maxLoopDepth 1 rejects any nesting", async () => {
  const result = await runInWorker(
    `
let err = null
try {
  await loop({ key: "outer", budget: { iterations: 1 } }, async () => {
    await loop({ key: "inner", budget: { iterations: 1 } }, async () => ({ state: {} }))
    return { state: {} }
  })
} catch (e) { err = String(e && e.message ? e.message : e) }
return { err }
`,
    { caps: { maxAgents: 200, maxLoopDepth: 1 }, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  assert.match((result.value as { err: string | null }).err ?? "", /maxLoopDepth/)
  assert.equal(result.calls.filter((c) => c.fn === "agent").length, 0, "no spawns before the structural rejection")
})

test("queue: same text with different deps coexists; sizes expose unready and missing deps", async () => {
  const result = await runInWorker(
    `
const q = queue([{ text: "same", deps: [] }, { text: "same", deps: ["missing"] }])
const sizes = q.sizes()
const first = q.pop()
return { sizes, firstText: first ? first.text : null, itemCount: q.items().length }
`,
    { caps: GENERAL_AGENT_CAPS, onCall: async () => agentResult() },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const value = result.value as { sizes: Record<string, number>; firstText: string | null; itemCount: number }
  assert.equal(value.itemCount, 2, "different deps make distinct ids (no false dedupe)")
  assert.equal(value.sizes.ready, 1)
  assert.equal(value.sizes.unready, 1)
  assert.equal(value.sizes.missingDeps, 1)
  assert.equal(value.firstText, "same")
})

test("loop: a retry that trips the iteration budget surfaces the first attempt's error", async () => {
  const result = await runInWorker(
    `
const summary = await loop({ key: "retrybudget", budget: { iterations: 1, agentsPerIteration: 2 }, stop: { stallK: 1 } },
  async () => {
    await agent("a")
    await agent("b")
    return { state: {} }
  })
return { summary }
`,
    {
      caps: GENERAL_AGENT_CAPS,
      onCall: async (fn, args) => {
        if (fn !== "agent") return { ok: true }
        if (String(args[0]) === "b") throw new Error("provider exploded")
        return agentResult()
      },
    },
  )
  assert.equal(result.ok, true, result.error ?? "loop run failed")
  const summary = (result.value as { summary: Record<string, Json> }).summary
  const history = summary["history"] as Array<{ status: string; error?: string }>
  const errorRow = history.find((row) => row.status === "error")
  assert.ok(errorRow, "an error row is recorded")
  assert.match(errorRow!.error ?? "", /provider exploded/, "the real first-attempt error is surfaced")
  assert.doesNotMatch(
    errorRow!.error ?? "",
    /exceeded its agent budget/,
    "the deterministic budget trip must not mask the first failure",
  )
})
