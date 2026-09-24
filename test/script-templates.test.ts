/**
 * Script template tests: every served body must (a) pass the same source
 * validation a real run enforces, (b) stay bounded and sequential in its
 * write agents, (c) declare exactly the args it reads, and (d) actually RUN —
 * end-to-end through the supervisor with scripted children, including the
 * fix and abort paths.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { SupervisorImpl } from "../src/supervisor.ts"
import { validateScriptSource } from "../src/worker-script.ts"
import { paramsFromToolInputHeader } from "../src/params.ts"
import {
  MAX_SCRIPT_TEMPLATE_CHARS,
  SCRIPT_TEMPLATES,
  scriptTemplate,
  scriptTemplateSummaries,
} from "../src/script-templates.ts"
import { buildCatalog } from "../src/catalog.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"
import type { ParentContext, UltracodeOptions } from "../src/types.ts"
import { FakeRegistry, FakeSessionCtx, FakeStorage } from "./fakes.ts"

function makeSupervisor(optionsOverrides: Partial<UltracodeOptions> = {}) {
  const registry = new FakeRegistry()
  const storage = new FakeStorage()
  const sessions = new FakeSessionCtx()
  const options = { ...DEFAULT_OPTIONS, timeoutMs: 10_000, ...optionsOverrides }
  const supervisor = new SupervisorImpl({ registry, storage, sessions, options })
  const reports: string[] = []
  const parent: ParentContext = {
    sessionID: "ses_parent",
    agent: "build",
    report: (s) => reports.push(s),
  }
  return { supervisor, registry, storage, sessions, options, reports, parent }
}

const STAGED_ARGS = {
  goal: "ship the feature",
  stages: [
    { id: "a", work: "implement A", verify: "A works and tests pass" },
    { id: "b", work: "implement B", verify: "B works and tests pass" },
  ],
}

const DONE_OK = (s: string) => ({ text: JSON.stringify({ done: true, summary: s, commit: "c0ffe" }), agent: "general" })
const VERIFY_OK = (s: string) => ({ text: JSON.stringify({ pass: true, issues: [], summary: s }), agent: "general" })
const VERIFY_FAIL = (issue: string) => ({
  text: JSON.stringify({ pass: false, issues: [{ severity: "major", issue }], summary: "not yet" }),
  agent: "general",
})

// ---------------------------------------------------------------------------
// shape rules
// ---------------------------------------------------------------------------

test("script templates: pass run-source validation and stay small", () => {
  for (const t of SCRIPT_TEMPLATES) {
    const check = validateScriptSource(t.script)
    assert.equal(check.ok, true, `${t.name}: ${check.ok ? "" : check.error}`)
    assert.equal(t.script.length > 0, true, t.name)
    assert.equal(t.script.length <= MAX_SCRIPT_TEMPLATE_CHARS, true, `${t.name} is ${t.script.length} chars`)
  }
})

test("script templates: write agents are sequential (no parallel fan-in)", () => {
  for (const t of SCRIPT_TEMPLATES) {
    assert.equal(/parallel\s*\(/.test(t.script), false, `${t.name} must keep write agents sequential`)
  }
})

test("script templates: stock agents only, no model-looking references", () => {
  for (const t of SCRIPT_TEMPLATES) {
    const agents = [...t.script.matchAll(/agent:\s*"([^"]+)"/g)].map((m) => m[1])
    for (const id of agents) {
      assert.equal(["general", "explore"].includes(id), true, `${t.name} references non-stock agent "${id}"`)
    }
    assert.equal(/anthropic|openai|claude-|gpt-|model:\s*"/i.test(t.script), false, `${t.name} must not name providers or models`)
  }
})

test("script templates: fail fast on missing or degenerate args, spawning nothing", async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["staged-delivery", undefined, /args\.stages must be a non-empty array/],
    ["staged-delivery", { goal: "g", stages: [] }, /args\.stages must be a non-empty array/],
    ["verify-fix", undefined, /args\.issues must be a non-empty array/],
    ["verify-fix", { goal: "g", issues: [] }, /args\.issues must be a non-empty array/],
    ["kanban", undefined, /args\.tickets must be a non-empty array/],
    ["kanban", { tickets: [] }, /args\.tickets must be a non-empty array/],
    ["kaggle-ml", undefined, /args\.goal is required/],
    ["kaggle-ml", { goal: "x" }, /args\.components must be a non-empty array/],
    ["kaggle-ml", { goal: "x", components: ["model"], metricDirection: "lower_is_better" }, /args\.metricDirection must be min or max/],
  ]
  for (const [name, args, pattern] of cases) {
    const ctx = makeSupervisor()
    const outcome = await ctx.supervisor.start(
      { script: scriptTemplate(name)!.script, ...(args === undefined ? {} : { args: args as never }) },
      ctx.parent,
    )
    assert.equal(outcome.envelope.status, "failed", `${name} with ${JSON.stringify(args)} must fail, not "succeed" silently`)
    assert.match(String(outcome.envelope.error), pattern)
    assert.equal(outcome.envelope.agents.total, 0, "no child is spawned for degenerate args")
  }
})

test("script templates: declared args match the args.<name> references", () => {
  for (const t of SCRIPT_TEMPLATES) {
    const referenced = new Set([...t.script.matchAll(/args\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    for (const name of t.args) {
      assert.equal(referenced.has(name), true, `${t.name} declares ${name} but never reads it`)
    }
    for (const name of referenced) {
      assert.equal(t.args.includes(name), true, `${t.name} reads args.${name} but does not declare it`)
    }
    // The header documents the args so a saved copy reports real params.
    assert.match(t.script, /^\/\/ Tool input:/m, `${t.name} needs a // Tool input: header`)
    const headerParams = paramsFromToolInputHeader(t.script)
    assert.deepEqual(
      headerParams.map((p) => p.name).sort(),
      [...t.args].sort(),
      `${t.name} header args must parse (samples' { args: { … } } convention)`,
    )
  }
})

test("script templates: lookup helpers", () => {
  assert.equal(scriptTemplate("staged-delivery")?.name, "staged-delivery")
  assert.equal(scriptTemplate("nope"), undefined)
  const rows = scriptTemplateSummaries()
  assert.deepEqual(
    rows.map((r) => r.name).sort(),
    ["kaggle-ml", "kanban", "staged-delivery", "verify-fix"],
  )
  for (const r of rows) assert.equal(r.chars > 0, true)
})

// ---------------------------------------------------------------------------
// end-to-end through the supervisor
// ---------------------------------------------------------------------------

test("staged-delivery: two clean stages pass with one writer + one verifier each", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push(DONE_OK("a done"))
    .push(VERIFY_OK("a verified"))
    .push(DONE_OK("b done"))
    .push(VERIFY_OK("b verified"))
  const outcome = await ctx.supervisor.start(
    { script: scriptTemplate("staged-delivery")!.script, args: STAGED_ARGS as never },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.agents.total, 4)
  const result = outcome.envelope.result as { passedStages: number; total: number; stages: Array<{ id: string; passed: boolean; rounds: number }> }
  assert.equal(result.passedStages, 2)
  assert.equal(result.total, 2)
  assert.deepEqual(result.stages.map((s) => [s.id, s.passed, s.rounds]), [["a", true, 0], ["b", true, 0]])
})

test("staged-delivery: a major issue triggers one fix round, then passes", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push(DONE_OK("a done"))
    .push(VERIFY_FAIL("tests do not compile"))
    .push(DONE_OK("fixed"))
    .push(VERIFY_OK("a verified after fix"))
    .push(DONE_OK("b done"))
    .push(VERIFY_OK("b verified"))
  const outcome = await ctx.supervisor.start(
    { script: scriptTemplate("staged-delivery")!.script, args: STAGED_ARGS as never },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.agents.total, 6)
  const result = outcome.envelope.result as { passedStages: number; stages: Array<{ id: string; passed: boolean; rounds: number }> }
  assert.equal(result.passedStages, 2)
  assert.equal(result.stages[0]!.rounds, 1)
  assert.equal(result.stages[0]!.passed, true)
})

test("staged-delivery: a stage that cannot pass aborts the remaining stages with a partial report", async () => {
  const ctx = makeSupervisor()
  // default maxFixes = 2 => 1 writer + 3 verifies + 2 fixes, all failing
  ctx.sessions
    .push(DONE_OK("a done"))
    .push(VERIFY_FAIL("still broken 1"))
    .push(DONE_OK("fix attempt 1"))
    .push(VERIFY_FAIL("still broken 2"))
    .push(DONE_OK("fix attempt 2"))
    .push(VERIFY_FAIL("still broken 3"))
  const outcome = await ctx.supervisor.start(
    { script: scriptTemplate("staged-delivery")!.script, args: STAGED_ARGS as never },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded") // the script returns a report, it does not throw
  assert.equal(outcome.envelope.agents.total, 6)
  const result = outcome.envelope.result as { passedStages: number; total: number; stages: Array<{ id: string; passed: boolean }> }
  assert.equal(result.passedStages, 0)
  assert.equal(result.stages.length, 1) // stage b never started
  assert.equal(result.stages[0]!.passed, false)
})

test("staged-delivery: stage list and fix rounds are capped", async () => {
  const ctx = makeSupervisor()
  const many = Array.from({ length: 40 }, (_, i) => ({ id: "s" + i, work: "w", verify: "v" }))
  // maxFixes 99 clamps to 4: 1 writer + 5 verifies + 4 fixes, verifier never passes.
  ctx.sessions
    .push(DONE_OK("writer done"))
    .push(VERIFY_FAIL("broken"))
    .push(DONE_OK("fix 1"))
    .push(VERIFY_FAIL("broken"))
    .push(DONE_OK("fix 2"))
    .push(VERIFY_FAIL("broken"))
    .push(DONE_OK("fix 3"))
    .push(VERIFY_FAIL("broken"))
    .push(DONE_OK("fix 4"))
    .push(VERIFY_FAIL("broken"))
  const outcome = await ctx.supervisor.start(
    { script: scriptTemplate("staged-delivery")!.script, args: { goal: "g", stages: many, maxFixes: 99 } as never },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.agents.total, 10)
  const result = outcome.envelope.result as { total: number; stages: Array<{ rounds: number }> }
  assert.equal(result.total, 12) // 40 stages sliced to the cap
  assert.equal(result.stages[0]!.rounds, 4) // maxFixes 99 clamped to 4
})

test("staged-delivery: a schema-broken verifier degrades to a stage failure, not a run crash", async () => {
  const ctx = makeSupervisor()
  // Queue empties after these: the repair rounds repeat the broken text, the
  // schema error throws, and the template catches it -> "verifier unavailable".
  ctx.sessions
    .push(DONE_OK("a done"))
    .push({ text: "I cannot answer in JSON, sorry", agent: "general" })
  const outcome = await ctx.supervisor.start(
    { script: scriptTemplate("staged-delivery")!.script, args: STAGED_ARGS as never },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  const result = outcome.envelope.result as { passedStages: number; stages: Array<{ passed: boolean; summary: string }> }
  assert.equal(result.passedStages, 0)
  assert.equal(result.stages.length, 1)
  assert.equal(result.stages[0]!.passed, false)
  assert.match(result.stages[0]!.summary, /verifier unavailable/)
})

test("staged-delivery: duplicate and overlong stage ids get distinct, bounded keys", async () => {
  const ctx = makeSupervisor()
  for (let i = 0; i < 4; i++) ctx.sessions.push(DONE_OK("w" + i)).push(VERIFY_OK("v" + i))
  const long = "x".repeat(80)
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("staged-delivery")!.script,
      args: { goal: "g", stages: [{ id: "dup", work: "w", verify: "v" }, { id: "dup", work: "w", verify: "v" }, { id: long, work: "w", verify: "v" }, { id: long, work: "w", verify: "v" }] } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  const labels = outcome.run.agents.map((a) => a.label).sort()
  // Distinct per stage; the 80-char id truncated to a 44-char base (room for a -N suffix)
  // before opt-key truncation could collide.
  const x44 = "x".repeat(44)
  assert.deepEqual(labels, [
    "dup-2:verify0", "dup-2:write", "dup:verify0", "dup:write",
    x44 + "-2:verify0", x44 + "-2:write", x44 + ":verify0", x44 + ":write",
  ])
  assert.equal(outcome.envelope.agents.total, 8) // 4 stages × (writer + verifier), all clean
  const result = outcome.envelope.result as { passedStages: number; total: number }
  assert.equal(result.passedStages, 4)
  assert.equal(result.total, 4)
})

test("verify-fix: survivors carry forward until the list is empty", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push({ text: "fixed some", agent: "general" })
    .push({ text: JSON.stringify({ issues: ["second issue"] }), agent: "general" })
    .push({ text: "fixed the rest", agent: "general" })
    .push({ text: JSON.stringify({ issues: [] }), agent: "general" })
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("verify-fix")!.script,
      args: { goal: "green tests", issues: ["first issue", "second issue"] } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.agents.total, 4)
  const result = outcome.envelope.result as { remaining: number; passesUsed: number }
  assert.equal(result.remaining, 0)
  assert.equal(result.passesUsed, 2)
})

test("verify-fix: maxPasses bound holds when issues never resolve", async () => {
  const ctx = makeSupervisor()
  const fixAttempt = { text: "fix attempt", agent: "general" }
  const bothAlive = { text: JSON.stringify({ issues: ["first issue", "second issue"] }), agent: "general" }
  for (let pass = 0; pass < 6; pass++) ctx.sessions.push(fixAttempt).push(bothAlive) // more than the cap
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("verify-fix")!.script,
      args: { goal: "green tests", issues: ["first issue", "second issue"], maxPasses: 99 } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded")
  assert.equal(outcome.envelope.agents.total, 10) // 5 passes × (fix + recheck) — the cap held
  const result = outcome.envelope.result as { remaining: number; passesUsed: number }
  assert.equal(result.remaining, 2)
  assert.equal(result.passesUsed, 5) // 99 clamped to the cap of 5
})

// ---------------------------------------------------------------------------
// catalog integration
// ---------------------------------------------------------------------------

test("catalog: scriptTemplate detail serves the body; summaries list in the default view", () => {
  const detail = buildCatalog({ scriptTemplate: "staged-delivery" }) as Record<string, never>
  const view = detail["scriptTemplate"] as unknown as { name: string; script: string; args: string[] }
  assert.equal(view.name, "staged-delivery")
  assert.deepEqual(view.args, ["goal", "stages", "maxFixes"])
  assert.match(view.script, /^\/\/ staged-delivery/)

  const whole = buildCatalog({}) as Record<string, never>
  const rows = whole["scriptTemplates"] as unknown as Array<{ name: string; chars: number }>
  assert.deepEqual(
    rows.map((r) => r.name).sort(),
    ["kaggle-ml", "kanban", "staged-delivery", "verify-fix"],
  )
  assert.equal(rows.every((r) => r.chars > 0), true)
  assert.equal(whole["scriptTemplate"], undefined) // summary view carries no bodies
})

test("catalog: unknown script template errors and lists what exists", () => {
  const out = buildCatalog({ scriptTemplate: "nope" }) as Record<string, never>
  assert.match(String(out["scriptTemplateError"]), /no script template named "nope"/)
  const rows = out["scriptTemplates"] as unknown as Array<{ name: string }>
  assert.equal(rows.length, SCRIPT_TEMPLATES.length)
})

test("catalog: scriptTemplates: true serves every body", () => {
  const out = buildCatalog({ scriptTemplates: true }) as Record<string, never>
  const rows = out["scriptTemplates"] as unknown as Array<{ name: string; script: string }>
  assert.equal(rows.length, SCRIPT_TEMPLATES.length)
  for (const row of rows) assert.equal(row.script.length > 0, true)
})

// ---------------------------------------------------------------------------
// loop templates end-to-end
// ---------------------------------------------------------------------------

const KPLAN_REPLY = (approach: string) => ({
  text: JSON.stringify({ approach, steps: ["s1", "s2"], risks: [] }),
  agent: "explore",
})
const KWORK_REPLY = (summary: string, done = true) => ({
  text: JSON.stringify({ done, summary, files: ["src/x.ts"] }),
  agent: "general",
})
const KREVIEW_REPLY = (pass: boolean, issue?: string) => ({
  text: JSON.stringify({
    pass,
    issues: issue ? [{ issue, suggestion: "do better", severity: "major" }] : [],
    evidence: "checked the diff",
  }),
  agent: "general",
})

test("kanban: two clean tickets drain the queue and stop with queue-empty", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push(KPLAN_REPLY("first approach"))
    .push(KWORK_REPLY("did ticket one"))
    .push(KREVIEW_REPLY(true))
    .push(KPLAN_REPLY("second approach"))
    .push(KWORK_REPLY("did ticket two"))
    .push(KREVIEW_REPLY(true))
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kanban")!.script,
      args: { goal: "empty the board", tickets: [{ text: "fix login", id: "T-1" }, { text: "add tests", id: "T-2" }] } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  assert.equal(outcome.envelope.agents.total, 6)
  const result = outcome.envelope.result as {
    stopReason: string
    iterations: number
    processed: number
    reviewPassed: number
    queue: { done: number; open: number }
  }
  assert.equal(result.stopReason, "queue-empty")
  assert.equal(result.iterations, 2)
  assert.equal(result.processed, 2)
  assert.equal(result.reviewPassed, 2)
  assert.equal(result.queue.done, 2)
  // One writer at a time: exactly one non-explore agent per iteration phase.
  const labels = outcome.run.agents.map((a) => a.label)
  assert.deepEqual(labels, ["T-1:plan", "T-1:work", "T-1:review", "T-2:plan", "T-2:work", "T-2:review"])
})

test("kanban: a failed review spawns a follow-up ticket that gets processed", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push(KPLAN_REPLY("approach one"))
    .push(KWORK_REPLY("attempt one"))
    .push(KREVIEW_REPLY(false, "missing error handling"))
    .push(KPLAN_REPLY("follow-up approach"))
    .push(KWORK_REPLY("addressed the finding"))
    .push(KREVIEW_REPLY(true))
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kanban")!.script,
      args: { goal: "empty the board", tickets: [{ text: "fix login", id: "T-1" }] } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as {
    stopReason: string
    processed: number
    reviewPassed: number
  }
  assert.equal(result.stopReason, "queue-empty")
  assert.equal(result.processed, 2, "the follow-up ticket was processed too")
  assert.equal(result.reviewPassed, 1, "only the follow-up passed review")
})

const mlFormulation = {
  formulations: ["component baseline", "joint end-to-end model"],
  selectionReason: "Start with the cheaper baseline; compare the joint approach if interactions limit it",
  baseline: "fixed split baseline",
  evaluation: "python eval.py on the same held-out population",
}

test("kaggle-ml: one round meeting the target stops with target after skeptic verification", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push({ text: JSON.stringify({ ...mlFormulation, strategy: "stack", components: [{ id: "data", focus: "clean", status: "active" }, { id: "model", focus: "gbdt", status: "active" }] }), agent: "general" })
    .push({ text: JSON.stringify({ variations: [{ idea: "winsorize", rationale: "outliers", expectedDelta: 0.01 }] }), agent: "general" })
    .push({ text: JSON.stringify({ variations: [{ idea: "hist-gbdt", rationale: "tabular", expectedDelta: 0.02 }] }), agent: "general" })
    .push({ text: JSON.stringify({ configs: [{ id: "c1", chosen: [{ componentId: "data", variationId: "data-v1" }, { componentId: "model", variationId: "model-v1" }], why: "one coherent coupled hypothesis" }] }), agent: "general" })
    .push({ text: JSON.stringify({ candidateId: "c1-0", metrics: { cv: 0.95 }, evidence: { command: "python eval.py", exitCode: 0, outputQuote: "cv=0.95" }, artifactsRef: "cand-c1" }), agent: "general" })
    .push({ text: JSON.stringify({ status: "done", candidateId: "c1-0", metrics: { cv: 0.95 }, evidence: { command: "python eval.py", exitCode: 0, outputQuote: "cv=0.95" } }), agent: "general" })
    .push({ text: JSON.stringify({ verified: true, reason: "re-ran eval.py: cv=0.95" }), agent: "general" })
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kaggle-ml")!.script,
      args: { goal: "best CV", components: ["data", "model"], metric: "cv", target: 0.9, evalCommand: "python eval.py" } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; iterations: number; best: { cv: number } | null; bestArtifact: string; bestResolved: Array<{ idea: string }> }
  assert.equal(result.stopReason, "target")
  assert.equal(result.iterations, 1)
  assert.equal(result.best?.cv, 0.95)
  assert.equal(result.bestArtifact, "cand-c1")
  assert.deepEqual(result.bestResolved.map((v) => v.idea), ["winsorize", "hist-gbdt"], "best configuration remains interpretable beyond ephemeral proposal IDs")
  const keys = outcome.run.agents.map((a) => a.key)
  assert.deepEqual(keys, [
    "kaggle-ml:i0:reflect",
    "kaggle-ml:i0:var:data",
    "kaggle-ml:i0:var:model",
    "kaggle-ml:i0:select",
    "kaggle-ml:i0:run:c1-0",
    "kaggle-ml:i0:verdict",
    "kaggle-ml:i0:skeptic",
  ])
})

test("kanban: fails fast (no spawns) when tickets depend on unknown ids", async () => {
  const ctx = makeSupervisor()
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kanban")!.script,
      args: { tickets: [{ text: "first", id: "A", deps: ["B"] }, { text: "second", id: "C" }] } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "failed", "dangling deps are structural")
  assert.match(String(outcome.envelope.error), /unknown ids/)
  assert.equal(ctx.sessions.createdModels.length, 0, "nothing spawns before the validation")
})

test("kanban: explicit deps gate readiness across tickets", async () => {
  const ctx = makeSupervisor()
  ctx.sessions
    .push(KPLAN_REPLY("first"))
    .push(KWORK_REPLY("did first"))
    .push(KREVIEW_REPLY(true))
    .push(KPLAN_REPLY("second"))
    .push(KWORK_REPLY("did second"))
    .push(KREVIEW_REPLY(true))
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kanban")!.script,
      args: { tickets: [{ text: "first", id: "A" }, { text: "second", id: "B", deps: ["A"] }] } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; processed: number }
  assert.equal(result.stopReason, "queue-empty")
  assert.equal(result.processed, 2)
})

test("kaggle-ml: a round with zero selected configs still judges and continues", async () => {
  const ctx = makeSupervisor()
  const reflect = { text: JSON.stringify({ ...mlFormulation, strategy: "explore", components: [{ id: "data", focus: "clean", status: "active" }, { id: "model", focus: "gbdt", status: "active" }] }), agent: "general" }
  const ideas = { text: JSON.stringify({ variations: [{ idea: "x", rationale: "y", expectedDelta: 0.01 }] }), agent: "general" }
  const empty = { text: JSON.stringify({ configs: [] }), agent: "general" }
  const judge = { text: JSON.stringify({ status: "improve", candidateId: "", metrics: {}, evidence: { command: "", exitCode: -1, outputQuote: "No selected candidates" } }), agent: "general" }
  for (let round = 0; round < 2; round++) {
    ctx.sessions.push(reflect).push(ideas).push(ideas).push(empty).push(judge)
  }
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kaggle-ml")!.script,
      args: { goal: "best CV", components: ["data", "model"], metric: "cv", maxIterations: 2 } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; iterations: number; rounds: Array<{ configs: number }> }
  assert.equal(result.stopReason, "budget")
  assert.equal(result.iterations, 2)
  assert.deepEqual(result.rounds.map((r) => r.configs), [0, 0])
  assert.equal(outcome.run.agents.some((a) => a.label?.startsWith("run:")), false, "no runner spawned without configs")
})

test("kaggle-ml: a storage without runDirFor fails structurally before any runner spawns", async () => {
  const ctx = makeSupervisor()
  ;(ctx.storage as unknown as { runDirFor?: undefined }).runDirFor = undefined
  ctx.sessions
    .push({ text: JSON.stringify({ ...mlFormulation, strategy: "s", components: [{ id: "data", focus: "f", status: "active" }, { id: "model", focus: "f", status: "active" }] }), agent: "general" })
    .push({ text: JSON.stringify({ variations: [{ idea: "x", rationale: "y" }] }), agent: "general" })
    .push({ text: JSON.stringify({ variations: [{ idea: "x", rationale: "y" }] }), agent: "general" })
    .push({ text: JSON.stringify({ configs: [{ id: "c1", chosen: [{ componentId: "data", variationId: "data-v1" }, { componentId: "model", variationId: "model-v1" }], why: "w" }] }), agent: "general" })
  const outcome = await ctx.supervisor.start(
    {
      script: scriptTemplate("kaggle-ml")!.script,
      args: { goal: "best CV", components: ["data", "model"], metric: "cv", maxIterations: 2 } as never,
    },
    ctx.parent,
  )
  assert.equal(outcome.envelope.status, "failed")
  assert.match(String(outcome.envelope.error), /no run artifacts dir/)
  assert.equal(
    outcome.run.agents.filter((a) => a.label?.startsWith("run:")).length,
    0,
    "structural failure happens before any runner spawns",
  )
})

function pushResearchRound(ctx: ReturnType<typeof makeSupervisor>, round: number, score: number, options: {
  learning?: { question: string; finding: string; nextDecision: string; evidenceRef: string }
  exitCode?: number
} = {}) {
  const id = (round ? `r${round}-` : "") + "c-0"
  const evidence = { command: "python eval.py", exitCode: options.exitCode ?? 0, outputQuote: `score=${score}` }
  const reply = (data: unknown) => ({ text: JSON.stringify(data), agent: "general" })
  ctx.sessions
    .push(reply({ ...mlFormulation, strategy: "investigate joint formulation", components: [{ id: "joint", focus: "test interactions", status: "active" }] }))
    .push(reply({ variations: [{ idea: `joint variant ${round}`, rationale: "one coherent hypothesis" }] }))
    .push(reply({ configs: [{ id: "c", chosen: [{ componentId: "joint", variationId: "joint-v1" }], why: "compare against baseline" }] }))
    .push(reply({ candidateId: id, metrics: { score }, evidence, artifactsRef: `artifact-${round}` }))
    .push(reply({ status: "improve", candidateId: id, metrics: { score }, evidence, ...(options.learning ? { learning: options.learning } : {}) }))
}

test("kaggle-ml: bookkeeping growth and worse scores do not mask a substantive stall", async () => {
  const ctx = makeSupervisor()
  for (let i = 0; i < 4; i++) pushResearchRound(ctx, i, 1 - i * 0.1)
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "improve", components: ["features", "model"], maxIterations: 8 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; iterations: number; best: { score: number }; recent: Array<{ resolved: Array<{ idea: string }> }> }
  assert.equal(result.stopReason, "stall")
  assert.equal(result.iterations, 4)
  assert.equal(result.best.score, 1)
  assert.equal(result.recent.at(-1)?.resolved[0]?.idea, "joint variant 3", "negative result survives separately from the winner")
})

test("kaggle-ml: evidence-linked negative learning permits focus; repetition does not", async () => {
  const ctx = makeSupervisor()
  pushResearchRound(ctx, 0, 1)
  for (let i = 1; i < 5; i++) pushResearchRound(ctx, i, 0.5, { learning: {
    question: "Can this instrument distinguish size effects?", finding: "Fill path ignores size", nextDecision: "Deprioritize sizing; repair the instrument", evidenceRef: `artifact-${i}`,
  } })
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "improve", components: ["sizing"], maxIterations: 8 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; iterations: number; knowledge: unknown[] }
  assert.equal(result.stopReason, "stall")
  assert.equal(result.iterations, 5, "first useful negative earns continuation, repeated claim at new paths does not")
  assert.equal(result.knowledge.length, 1)
})

test("kaggle-ml: invalid measurement cannot promote a score or learning", async () => {
  const ctx = makeSupervisor()
  for (let i = 0; i < 3; i++) pushResearchRound(ctx, i, 10 + i, { exitCode: 1, learning: {
    question: `q${i}`, finding: `f${i}`, nextDecision: `d${i}`, evidenceRef: `artifact-${i}`,
  } })
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "improve", components: ["data"], maxIterations: 8 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; best: unknown; knowledge: unknown[] }
  assert.equal(result.stopReason, "stall")
  assert.equal(result.best, null)
  assert.deepEqual(result.knowledge, [])
})

test("kaggle-ml: minimization retains the lower independently verified score", async () => {
  const ctx = makeSupervisor()
  pushResearchRound(ctx, 0, 0.4)
  pushResearchRound(ctx, 1, 0.2)
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "reduce loss", components: ["model"], metricDirection: "min", maxIterations: 2 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { best: { score: number }; bestConfig: { id: string } }
  assert.equal(result.best.score, 0.2)
})

for (const missing of ["candidateId", "exitCode"] as const) {
  test(`kaggle-ml: missing judge ${missing} is schema-repaired instead of a false stall`, async () => {
    const ctx = makeSupervisor()
    pushResearchRound(ctx, 0, 0.8)
    const valid = ctx.sessions.replies.pop()!
    const data = JSON.parse(valid.text!)
    if (missing === "exitCode") delete data.evidence.exitCode
    else delete data.candidateId
    ctx.sessions.push({ text: JSON.stringify(data), agent: "general" }).push(valid)
    const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
      args: { goal: "improve", components: ["joint"], maxIterations: 1 } as never }, ctx.parent)
    assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
    assert.equal((outcome.envelope.result as { best: { score: number } }).best.score, 0.8)
    assert.ok([...ctx.sessions.sessions.values()].some((s) => s.prompts === 2), "judge received a repair prompt")
  })
}

test("kaggle-ml: an invalid selection preserves the other candidate and its evidence", async () => {
  const ctx = makeSupervisor()
  pushResearchRound(ctx, 0, 0.8)
  const selection = JSON.parse(ctx.sessions.replies[2]!.text!)
  selection.configs.push({ id: "bad", chosen: [{ componentId: "joint", variationId: "missing" }], why: "bad reference" })
  ctx.sessions.replies[2]!.text = JSON.stringify(selection)
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "improve", components: ["joint"], maxIterations: 1 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { iterations: number; best: { score: number }; recent: Array<{ reason?: string }> }
  assert.equal(result.iterations, 1)
  assert.equal(result.best.score, 0.8)
  assert.ok(result.recent.some((r) => r.reason?.includes("unknown variation")))
  assert.equal(outcome.run.agents.filter((a) => a.label?.startsWith("run:")).length, 1)
})

test("kaggle-ml: minimum iteration budget still completes an investigation", async () => {
  const ctx = makeSupervisor()
  pushResearchRound(ctx, 0, 0.8)
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "improve", components: ["joint"], maxIterations: 1, agentsPerIteration: 6 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  assert.equal((outcome.envelope.result as { best: { score: number } }).best.score, 0.8)
  assert.equal(outcome.envelope.agents.total, 5)
})

test("kaggle-ml: agreement of judge and skeptic cannot override the numerical target", async () => {
  const ctx = makeSupervisor()
  pushResearchRound(ctx, 0, 0.8)
  const judge = JSON.parse(ctx.sessions.replies.at(-1)!.text!)
  judge.status = "done"
  ctx.sessions.replies.at(-1)!.text = JSON.stringify(judge)
  ctx.sessions.push({ text: JSON.stringify({ verified: true }), agent: "general" })
  const outcome = await ctx.supervisor.start({ script: scriptTemplate("kaggle-ml")!.script,
    args: { goal: "improve", components: ["joint"], target: 0.9, maxIterations: 1 } as never }, ctx.parent)
  assert.equal(outcome.envelope.status, "succeeded", outcome.envelope.error ?? "run failed")
  const result = outcome.envelope.result as { stopReason: string; terminationIssue: string; best: { score: number } }
  assert.equal(result.stopReason, "blocked")
  assert.match(result.terminationIssue, /did not establish/)
  assert.equal(result.best.score, 0.8)
})
