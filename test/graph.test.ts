/**
 * Graph layer tests: validator, compiler determinism, emitted-script validity,
 * end-to-end execution of compiled graphs in a REAL worker with a mock bridge,
 * and renderers.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"
import type { Json } from "../src/types.ts"
import { WORKER_SOURCE, validateScriptSource } from "../src/worker-script.ts"
import { GRAPH_TEMPLATES } from "../src/graph-templates.ts"
import {
  DEFAULT_FANOUT_MAX,
  GRAPH_SPEC_VERSION,
  canonicalGraphSpec,
  compileGraphSpec,
  graphNodeCount,
  graphNodeIds,
  graphToAscii,
  graphToMermaid,
  graphLevels,
  validateGraphSpec,
  type GraphSpec,
} from "../src/graph.ts"

// ---------------------------------------------------------------------------
// Spec fixtures
// ---------------------------------------------------------------------------

const INVENTORY_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["name", "lines"],
        properties: { name: { type: "string" }, lines: { type: "number" } },
      },
    },
  },
}

const SUMMARY_SCHEMA = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
}

const CANONICAL: GraphSpec = {
  name: "partitioned-review",
  description: "scout, partition, review lanes, gate, merge",
  nodes: [
    {
      id: "scout",
      kind: "agent",
      agent: "explore",
      prompt: "Inventory {{args.area}}. Per file: name + line count. Do not read contents.",
      schema: INVENTORY_SCHEMA,
    },
    { id: "lanes", kind: "partition", from: "$scout.items", budgetTokens: 100, tokensPerLine: 10 },
    {
      id: "review",
      kind: "fanout",
      over: "$lanes",
      agent: "explore",
      max: 8,
      prompt: "Review exactly these files (ranged reads only):\n{{item}}\nReturn a summary.",
      schema: SUMMARY_SCHEMA,
    },
    { id: "qc", kind: "gate", from: "$review", onFail: "abort" },
    {
      id: "report",
      kind: "merge",
      from: "$review",
      prompt: "Merge these lane reports into one report. Reports only:\n{{item}}",
      batches: 2,
    },
  ],
  returns: { report: "$report", laneCount: "$lanes.length" },
}

// ---------------------------------------------------------------------------
// Mock worker harness (same protocol as test/worker-script.test.ts)
// ---------------------------------------------------------------------------

type WorkerEvent = { kind: string; data: Json }
type MockCall = { fn: string; args: Json[] }
type MockHandler = (fn: string, args: Json[]) => Promise<Json>

function runInWorker(script: string, args: Json | undefined, onCall: MockHandler): Promise<{
  ok: boolean
  value?: Json
  error?: string
  events: WorkerEvent[]
  calls: MockCall[]
}> {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  const events: WorkerEvent[] = []
  const calls: MockCall[] = []
  return new Promise((resolve, reject) => {
    worker.on("message", (msg: unknown) => {
      const m = msg as { type?: string; [k: string]: unknown }
      if (m.type === "call") {
        const callArgs = (Array.isArray(m.args) ? m.args : []) as Json[]
        calls.push({ fn: String(m.fn), args: callArgs })
        void Promise.resolve()
          .then(() => onCall(String(m.fn), callArgs))
          .then(
            (value) => worker.postMessage({ type: "result", id: Number(m.id), ok: true, value: value ?? null }),
            (err: unknown) =>
              worker.postMessage({
                type: "result",
                id: Number(m.id),
                ok: false,
                error: String((err as Error)?.message ?? err),
              }),
          )
        return
      }
      if (m.type === "event") {
        events.push({ kind: String(m.kind), data: (m.data ?? null) as Json })
        return
      }
      if (m.type === "done") {
        const result = {
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
    worker.postMessage({ type: "init", script, args, meta: {} })
  })
}

/** Mock bridge: schema-driven canned replies. */
function makeMockAgent(gatePass: boolean): MockHandler {
  return async (fn, callArgs) => {
    if (fn === "workflow") {
      // the worker EXECUTES the composed script with the workflow args —
      // return a runnable one that echoes them back
      return { script: "return { composed: true, topic: args && args.topic }", meta: {} } as unknown as Json
    }
    const prompt = String(callArgs[0] ?? "")
    const opts = (callArgs[1] ?? {}) as { schema?: Json; key?: string }
    const sessionID = "ses_" + String(opts.key ?? Math.random()).replace(/[^a-z0-9]/gi, "")
    if (opts.schema && (opts.schema as { properties?: Record<string, unknown> }).properties?.["pass"]) {
      // gate schema
      return {
        text: JSON.stringify({ pass: gatePass, action: gatePass ? "continue" : "abort", issues: gatePass ? [] : ["empty output"] }),
        sessionID,
        agent: "general",
        data: { pass: gatePass, action: gatePass ? "continue" : "abort", issues: gatePass ? [] : ["empty output"] },
      }
    }
    if (opts.schema && (opts.schema as { properties?: Record<string, unknown> }).properties?.["items"]) {
      return {
        text: "inventory",
        sessionID,
        agent: "explore",
        data: {
          items: [
            { name: "a.ts", lines: 10 },
            { name: "b.ts", lines: 8 },
            { name: "c.ts", lines: 12 },
          ],
        },
      }
    }
    if (opts.schema && (opts.schema as { properties?: Record<string, unknown> }).properties?.["topic"]) {
      return { text: "prep", sessionID, agent: "general", data: { topic: "agent evals" } }
    }
    if (opts.schema) {
      return { text: "summary", sessionID, agent: "explore", data: { summary: "lane-ok:" + prompt.slice(0, 12) } }
    }
    void prompt
    return { text: "merged-text", sessionID, agent: "general" }
  }
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

test("graph: canonical spec validates (warnings only)", () => {
  const check = validateGraphSpec(CANONICAL)
  assert.equal(check.ok, true)
  assert.deepEqual(check.ok && check.warnings, [])
})

test("graph: forward-only refs enforced (cycle-equivalent)", () => {
  const check = validateGraphSpec({
    nodes: [
      { id: "b", kind: "merge", from: "$a", prompt: "m {{item}}" },
      { id: "a", kind: "agent", prompt: "x" },
    ],
  })
  assert.equal(check.ok, false)
  if (!check.ok) assert.match(check.errors.join("; "), /does not match any node defined earlier/)
})

test("graph: unknown kind, duplicate id, missing prompt, bad keys", () => {
  const check = validateGraphSpec({
    nodes: [
      { id: "t", kind: "teleport" },
      { id: "a", kind: "agent", prompt: "p" },
      { id: "a", kind: "agent", prompt: "p" },
      { id: "ok", kind: "agent", prompt: "p", bogus: 1 },
    ],
  })
  assert.equal(check.ok, false)
  if (!check.ok) {
    const all = check.errors.join("; ")
    assert.match(all, /unknown kind/)
    assert.match(all, /duplicate id/)
    assert.match(all, /unexpected key "bogus"/)
  }
})

test("graph: missing prompt is an error", () => {
  const check = validateGraphSpec({ nodes: [{ id: "a", kind: "agent" }] })
  assert.equal(check.ok, false)
  if (!check.ok) assert.match(check.errors.join("; "), /prompt is required/)
})

test("graph: unresolved template vars and bad returns refs are errors", () => {
  const check = validateGraphSpec({
    nodes: [
      { id: "a", kind: "agent", prompt: "hello {{nosuch}} and {{args.x}}" },
      { id: "f", kind: "fanout", over: "$a", prompt: "{{item}} at {{index}}" },
    ],
    returns: { out: "$missing.text" },
  })
  assert.equal(check.ok, false)
  if (!check.ok) {
    const all = check.errors.join("; ")
    assert.match(all, /\{\{nosuch\}\}/)
    assert.match(all, /returns\.out/)
  }
})

test("graph: fanout without max warns; reserved ids rejected", () => {
  const check = validateGraphSpec({
    nodes: [
      { id: "args", kind: "agent", prompt: "p" },
      { id: "f", kind: "fanout", over: "$args2", prompt: "{{item}}" },
      { id: "args2", kind: "agent", prompt: "p" },
    ],
  })
  assert.equal(check.ok, false)
  if (!check.ok) {
    assert.match(check.errors.join("; "), /reserved/)
  }
  const check2 = validateGraphSpec({
    nodes: [
      { id: "src", kind: "agent", prompt: "p", schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "string" } } } } },
      { id: "f", kind: "fanout", over: "$src", prompt: "{{item}}" },
    ],
  })
  assert.equal(check2.ok, true)
  if (check2.ok) {
    assert.ok(check2.warnings.some((w) => w.includes(`default cap ${DEFAULT_FANOUT_MAX}`)))
  }
})

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

test("graph: compiled script passes script validation and is deterministic", () => {
  const first = compileGraphSpec(CANONICAL)
  const second = compileGraphSpec(CANONICAL)
  assert.equal(first.script, second.script)
  assert.deepEqual(validateScriptSource(first.script), { ok: true })
  const meta = first.meta
  assert.equal(meta.name, "partitioned-review")
  assert.deepEqual(meta.phases, ["scout", "review", "qc", "report"])
  assert.deepEqual(meta.requires, ["explore"])
})

test("graph: compiled script carries keys, phases, partition, gate checkpoint, batches", () => {
  const { script } = compileGraphSpec(CANONICAL)
  assert.match(script, /key: "scout"/)
  assert.match(script, /key: "review:" \+ index/)
  assert.match(script, /key: "report:b" \+ index/)
  assert.match(script, /phase: "review"/)
  assert.match(script, /G_est_lanes/) // partition estimate
  assert.match(script, /checkpoint\("qc"/) // gate auto-checkpoint
  assert.match(script, /gate qc rejected/) // abort branch
  assert.match(script, /G_batches_report/)
  assert.match(script, /v_lanes\.length/) // returns ref
})

test("graph: levels group independent nodes into parallel waves", () => {
  const spec: GraphSpec = {
    nodes: [
      { id: "a", kind: "agent", prompt: "a" },
      { id: "b", kind: "agent", prompt: "b" },
      { id: "c", kind: "merge", from: "$a", prompt: "m {{item}}" },
    ],
  }
  const levels = graphLevels(spec)
  assert.deepEqual(
    levels.map((l) => l.map((n) => n.id)),
    [["a", "b"], ["c"]],
  )
  const { script } = compileGraphSpec(spec)
  assert.match(script, /const \[r_a, r_b\] = await parallel\(\[/)
})

// ---------------------------------------------------------------------------
// End-to-end execution in a real worker
// ---------------------------------------------------------------------------

test("graph e2e: canonical spec executes — partition, fanout, gate, merge, returns", async () => {
  const compiled = compileGraphSpec(CANONICAL)
  const result = await runInWorker(compiled.script, { area: "src/util" }, makeMockAgent(true))
  assert.equal(result.ok, true, result.error ?? "run failed")
  const value = result.value as { report?: string; laneCount?: number }
  // 3 files, budget 100 tokens, 10 tokens/line: a(100) | b(80) | c(120) → 3 lanes
  assert.equal(value.laneCount, 3)
  assert.equal(value.report, "merged-text\n---\nmerged-text")

  // agent calls: 1 scout + 3 lanes + 1 gate + 2 merge batches = 7
  const agentCalls = result.calls.filter((c) => c.fn === "agent")
  assert.equal(agentCalls.length, 7)
  const keys = agentCalls.map((c) => String(((c.args[1] ?? {}) as { key?: string }).key))
  assert.deepEqual(keys.sort(), ["qc", "report:b0", "report:b1", "review:0", "review:1", "review:2", "scout"])

  // the scout prompt interpolated args.area
  assert.match(String(agentCalls[0]!.args[0]), /src\/util/)
  // the fanout prompt interpolated the lane item JSON
  assert.match(String(agentCalls[1]!.args[0]), /a\.ts/)

  // gate checkpoint event landed
  const cp = result.events.find((e) => e.kind === "checkpoint")
  assert.ok(cp, "gate emitted a checkpoint")
  assert.deepEqual(cp!.data, { name: "qc", value: { pass: true, issues: [] } })
})

test("graph e2e: failed gate aborts the run with the issues", async () => {
  const compiled = compileGraphSpec(CANONICAL)
  const result = await runInWorker(compiled.script, { area: "x" }, makeMockAgent(false))
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /gate qc rejected the batch/)
  assert.match(result.error ?? "", /empty output/)
})

test("graph e2e: workflow node composes a saved workflow with args from a ref", async () => {
  const spec: GraphSpec = {
    nodes: [
      { id: "prep", kind: "agent", prompt: "prepare {{args.topic}}", schema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } } },
      { id: "deep", kind: "workflow", name: "deep-research", argsFrom: "$prep" },
    ],
    returns: { deep: "$deep" },
  }
  const check = validateGraphSpec(spec)
  assert.equal(check.ok, true, JSON.stringify(check))
  const compiled = compileGraphSpec(spec)
  const result = await runInWorker(compiled.script, { topic: "agent evals" }, makeMockAgent(true))
  assert.equal(result.ok, true, result.error ?? "run failed")
  const wfCall = result.calls.find((c) => c.fn === "workflow")
  assert.ok(wfCall, "workflow bridge called")
  assert.equal(wfCall!.args[0], "deep-research")
  assert.deepEqual(wfCall!.args[1], { topic: "agent evals" })
  const value = result.value as { deep?: { composed?: boolean; topic?: string } }
  assert.equal(value.deep?.composed, true)
  assert.equal(value.deep?.topic, "agent evals")
})

test("graph e2e: checkpoint node persists refs; parallel wave tolerates one failure", async () => {
  const spec: GraphSpec = {
    nodes: [
      { id: "a", kind: "agent", prompt: "a" },
      { id: "b", kind: "agent", prompt: "b" },
      { id: "mark", kind: "checkpoint", value: "$a" },
    ],
    returns: { a: "$a", b: "$b" },
  }
  const compiled = compileGraphSpec(spec)
  let n = 0
  const handler: MockHandler = async (fn) => {
    void fn
    n += 1
    if (n === 2) throw new Error("child b exploded")
    return { text: "A", sessionID: "ses_a" }
  }
  const result = await runInWorker(compiled.script, undefined, handler)
  assert.equal(result.ok, true, result.error ?? "run failed")
  const value = result.value as { a?: string; b?: string | null }
  assert.equal(value.a, "A")
  assert.equal(value.b, null, "a failed sibling nulls, tolerated")
  const cp = result.events.find((e) => e.kind === "checkpoint")
  assert.deepEqual(cp!.data, { name: "mark", value: "A" })
})

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

test("graph: mermaid + ascii renders", () => {
  const mermaid = graphToMermaid(CANONICAL)
  assert.match(mermaid, /graph TD/)
  assert.match(mermaid, /scout --> lanes/)
  assert.match(mermaid, /review --> qc/)
  assert.match(mermaid, /review --> report/)
  const ascii = graphToAscii(CANONICAL)
  assert.match(ascii, /wave 1: scout\(agent\)/)
  assert.match(ascii, /wave 3: review\(fanout\)/)
  assert.match(ascii, /wave 4 \[parallel\]: qc\(gate\)\s+\+\s+report\(merge\)/)
})

// ---------------------------------------------------------------------------
// Persistence helpers (saved graph workflows + run-record provenance)
// ---------------------------------------------------------------------------

test("graph: canonicalGraphSpec is key-order independent but order-sensitive where it matters", () => {
  const a = { name: "n", nodes: [{ id: "a", kind: "agent", prompt: "p {{args.x}}" }], returns: { r: "$a" } }
  const b = { returns: { r: "$a" }, nodes: [{ kind: "agent", id: "a", prompt: "p {{args.x}}" }], name: "n" }
  assert.equal(canonicalGraphSpec(a), canonicalGraphSpec(b), "key order is not semantic")
  assert.notEqual(canonicalGraphSpec(a), canonicalGraphSpec({ ...a, name: "other" }))
  // Node order IS the topological order, so arrays must not be sorted.
  const nodes = [
    { id: "b", kind: "agent", prompt: "p" },
    { id: "a", kind: "agent", prompt: "p" },
  ]
  assert.notEqual(canonicalGraphSpec({ nodes }), canonicalGraphSpec({ nodes: [...nodes].reverse() }))
  assert.equal(canonicalGraphSpec(undefined), "null")
  assert.equal(canonicalGraphSpec(null), "null")
})

test("graph: node count and ids tolerate junk specs", () => {
  assert.equal(graphNodeCount(CANONICAL), 5)
  assert.deepEqual(graphNodeIds(CANONICAL), ["scout", "lanes", "review", "qc", "report"])
  for (const junk of [null, undefined, 3, "x", [], {}, { nodes: "nope" }, { nodes: [null, 1, { id: "ok" }] }]) {
    assert.doesNotThrow(() => graphNodeCount(junk))
    assert.doesNotThrow(() => graphNodeIds(junk))
  }
  assert.equal(graphNodeCount({ nodes: "nope" }), 0)
  assert.deepEqual(graphNodeIds({ nodes: [null, { id: "ok" }, 5] }), ["ok"])
})

test("graph: compiled header is name-independent, so a rename cannot move the trust digest", () => {
  const base = compileGraphSpec(CANONICAL).script
  const renamed = compileGraphSpec({ ...CANONICAL, name: "renamed-flow" }).script
  assert.equal(base, renamed, "the spec name must not appear in the compiled script")
  assert.doesNotMatch(base, /partitioned-review/)
  assert.match(base, new RegExp(`graph v${GRAPH_SPEC_VERSION}`))
  assert.match(base, /do not hand-edit/)
})

// ---------------------------------------------------------------------------
// Template-only data edges (regression: waves scheduled on refs alone put the
// reader beside its producer, and the interpolation silently degraded to the
// literal "{{node}}" inside a child prompt)
// ---------------------------------------------------------------------------

test("graph: a prompt template is a data edge — waves order after the node it reads", () => {
  const spec: GraphSpec = {
    nodes: [
      { id: "a", kind: "agent", prompt: "First pass over {{args.topic}}." },
      { id: "b", kind: "agent", prompt: "Second pass. First said: {{a}}" },
    ],
  }
  assert.equal(validateGraphSpec(spec).ok, true)
  assert.deepEqual(
    graphLevels(spec).map((w) => w.map((n) => n.id)),
    [["a"], ["b"]],
    "b reads a's value, so it cannot share a's wave",
  )
  const { script } = compileGraphSpec(spec)
  assert.doesNotMatch(script, /"\{\{a\}\}"/, "the interpolation must not degrade to a literal placeholder")
  assert.match(script, /G_str\(v_a\)/)
  assert.match(graphToMermaid(spec), /a --> b/, "the rendered DAG shows template edges too")
})

test("graph e2e: a template-only dependency delivers the real value to the later child", async () => {
  const spec: GraphSpec = {
    nodes: [
      { id: "first", kind: "agent", prompt: "Summarize {{args.topic}} in one line." },
      { id: "second", kind: "agent", prompt: "Critique this summary: {{first}}" },
    ],
    returns: { critique: "$second" },
  }
  const { script } = compileGraphSpec(spec)
  const prompts: string[] = []
  const result = await runInWorker(script, { topic: "agent evals" }, async (_fn, callArgs) => {
    const prompt = String(callArgs[0] ?? "")
    prompts.push(prompt)
    return {
      text: prompts.length === 1 ? "SUMMARY-TEXT" : "CRITIQUE",
      sessionID: `ses_${prompts.length}`,
      agent: "general",
    } as unknown as Json
  })
  assert.equal(result.ok, true, result.error ?? "run failed")
  assert.equal(prompts.length, 2, "one child per node, in dependency order")
  assert.match(prompts[0]!, /Summarize "agent evals"/)
  assert.match(prompts[1]!, /Critique this summary: "SUMMARY-TEXT"/, "the second child sees the first child's output")
  assert.doesNotMatch(prompts[1]!, /\{\{first\}\}/)
  assert.deepEqual(result.value, { critique: "CRITIQUE" })
})

test("graph: a backward-but-acyclic template reference is reordered by data flow, not rejected", () => {
  // Spec order says a reads b; validateGraphSpec rejects that (templates resolve
  // against nodes defined EARLIER), but the compiler schedules by data flow, so
  // compiling anyway still produces a correct, interpolated script.
  const spec = {
    nodes: [
      { id: "a", kind: "agent", prompt: "Use {{b}} please." },
      { id: "b", kind: "agent", prompt: "Plain prompt." },
    ],
  } as unknown as GraphSpec
  assert.equal(validateGraphSpec(spec).ok, false)
  const { script } = compileGraphSpec(spec)
  assert.doesNotMatch(script, /"\{\{b\}\}"/)
  assert.match(script, /G_str\(v_b\)/)
  assert.ok(script.indexOf("v_b =") < script.indexOf("G_str(v_b)"), "b is emitted before a reads it")
})

test("graph: a cyclic template dependency fails loudly instead of emitting placeholders", () => {
  const spec = {
    nodes: [
      { id: "a", kind: "agent", prompt: "Use {{b}} please." },
      { id: "b", kind: "agent", prompt: "Use {{a}} please." },
    ],
  } as unknown as GraphSpec
  assert.equal(validateGraphSpec(spec).ok, false, "cycles are rejected up front")
  assert.throws(() => compileGraphSpec(spec), /graph compiler invariant: node "a" interpolates \{\{b\}\}/)
})

// ---------------------------------------------------------------------------
// Template e2e: a shipped template must actually run, not merely validate
// ---------------------------------------------------------------------------

test("graph e2e: the partitioned-review template runs end to end (partition, fanout, gate, merge)", async () => {
  const template = GRAPH_TEMPLATES.find((t) => t.name === "partitioned-review")
  assert.ok(template, "template missing")
  const { script } = compileGraphSpec(template.graph)
  const prompts: string[] = []
  const result = await runInWorker(script, { area: "src/api" }, async (_fn, callArgs) => {
    const prompt = String(callArgs[0] ?? "")
    prompts.push(prompt)
    const opts = (callArgs[1] ?? {}) as { schema?: Json; key?: string }
    const schema = (opts.schema ?? {}) as { properties?: Record<string, unknown> }
    const sessionID = `ses_${String(opts.key ?? prompts.length).replace(/[^a-z0-9]/gi, "")}`
    if (schema.properties?.["files"]) {
      return {
        text: "inventory",
        sessionID,
        agent: "explore",
        data: { files: [{ path: "src/api/a.ts", lines: 1200 }, { path: "src/api/b.ts", lines: 300 }] },
      } as unknown as Json
    }
    if (schema.properties?.["pass"]) {
      return {
        text: '{"pass":true}',
        sessionID,
        agent: "general",
        data: { pass: true, action: "continue", issues: [] },
      } as unknown as Json
    }
    if (schema.properties?.["summary"]) {
      return {
        text: "lane report",
        sessionID,
        agent: "explore",
        data: { summary: "no defects", covered: ["src/api/a.ts", "src/api/b.ts"], overflow: [] },
      } as unknown as Json
    }
    return { text: "MERGED-REPORT", sessionID, agent: "general" } as unknown as Json
  })
  assert.equal(result.ok, true, result.error ?? "template run failed")
  const value = result.value as { report?: string; lanes?: number }
  assert.equal(value.lanes, 1, "1500 estimated tokens over a 35000 budget is one lane")
  assert.equal(value.report, "MERGED-REPORT")
  assert.match(prompts[0]!, /Inventory "src\/api"/, "the scout prompt interpolated args.area")
  assert.ok(
    prompts.some((p) => p.includes("src/api/a.ts") && p.includes("src/api/b.ts")),
    "the lane child received its file list, not a placeholder",
  )
  assert.ok(!prompts.some((p) => p.includes("{{")), "no unresolved template reached a child")
  assert.ok(
    result.events.some((e) => e.kind === "checkpoint"),
    "the gate auto-checkpointed",
  )
})
