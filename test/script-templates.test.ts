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
    ["staged-delivery", "verify-fix"],
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
  // Queue empties after these: the repair round repeats the broken text, the
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
    ["staged-delivery", "verify-fix"],
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
