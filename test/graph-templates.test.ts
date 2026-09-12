/**
 * Graph template tests (workstream C) — src/graph-templates.ts.
 *
 * Templates are content the model adapts, so the guards are the same ones the
 * shipped script samples get: they must validate, compile to a runnable script,
 * route only through stock agents, carry no provider or model ids, and declare
 * the args they actually read. A template that silently rots is worse than no
 * template — it teaches a shape that fails at run time.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { GRAPH_TEMPLATES, graphTemplate, graphTemplateNames, graphTemplateSummaries } from "../src/graph-templates.ts"
import { compileGraphSpec, graphParamNames, validateGraphSpec, type GraphNode, type GraphSpec } from "../src/graph.ts"
import { validateScriptSource } from "../src/worker-script.ts"
import { WORKFLOW_NAME_RE } from "../src/storage.ts"

const STOCK_AGENTS = new Set(["general", "explore"])

test("templates: at least the three canonical shapes ship", () => {
  assert.deepEqual(graphTemplateNames(), ["partitioned-review", "research-verify", "draft-fact-check"])
  assert.equal(graphTemplate("research-verify")?.name, "research-verify")
  assert.equal(graphTemplate("nope"), undefined)
})

for (const template of GRAPH_TEMPLATES) {
  test(`template ${template.name}: name is saveable and description explains when to use it`, () => {
    assert.match(template.name, WORKFLOW_NAME_RE, "a template could be saved under its own name")
    assert.equal(template.graph.name, template.name, "spec name matches the template id")
    assert.ok(template.description.length > 40, "description must say when to reach for it")
    assert.ok(template.args.length > 0, "a template with no args is not parameterized")
  })

  test(`template ${template.name}: validates cleanly and compiles to a runnable script`, () => {
    const check = validateGraphSpec(template.graph)
    assert.equal(check.ok, true, check.ok ? "" : check.errors.join("; "))
    if (check.ok) assert.deepEqual(check.warnings, [], "templates model good practice — no warnings")
    const compiled = compileGraphSpec(template.graph)
    assert.deepEqual(validateScriptSource(compiled.script), { ok: true })
    assert.ok(compiled.meta.phases.length > 0)
    for (const id of compiled.meta.requires) assert.ok(STOCK_AGENTS.has(id), `non-stock agent: ${id}`)
  })

  test(`template ${template.name}: routes via stock agents only and names no model`, () => {
    const agents = template.graph.nodes.map((n) => n.agent).filter((a): a is string => typeof a === "string")
    assert.ok(agents.length > 0, "a template must show explicit agent routing")
    for (const id of agents) assert.ok(STOCK_AGENTS.has(id), `non-stock agent: ${id}`)
    const serialized = JSON.stringify(template.graph)
    assert.equal(serialized.match(/[a-z-]+\/[a-z0-9.:-]+/), null, "provider/model-looking ref in template")
    assert.doesNotMatch(serialized, /\b(opus|sonnet|haiku)\b|\b(gpt|claude|gemini)-/i, "model family name in template")
  })

  test(`template ${template.name}: declared args match what the spec actually reads`, () => {
    assert.deepEqual([...graphParamNames(template.graph)].sort(), [...template.args].sort())
  })

  test(`template ${template.name}: every fanout is capped and prompts are self-contained`, () => {
    const ids = new Set<string>()
    for (const node of template.graph.nodes as ReadonlyArray<GraphNode>) {
      assert.ok(!ids.has(node.id), `duplicate node id ${node.id}`)
      ids.add(node.id)
      if (node.kind === "fanout") {
        assert.ok(typeof node.max === "number" && node.max >= 1, `${node.id}: fanout without a max cap`)
        assert.ok(typeof node.over === "string" && node.over.startsWith("$"), `${node.id}: fanout needs an over ref`)
      }
      if (node.kind === "merge") assert.ok(typeof node.from === "string", `${node.id}: merge needs a from ref`)
      if (node.kind === "agent" || node.kind === "fanout" || node.kind === "merge") {
        const prompt = node.prompt ?? ""
        assert.ok(prompt.length > 60, `${node.id}: prompt is too thin to be self-contained`)
        // Real instruction must survive stripping the interpolations — a prompt
        // that is only data gives the child no task, no criteria, no output shape.
        assert.ok(
          prompt.replace(/\{\{[^}]*\}\}/g, "").trim().length > 40,
          `${node.id}: prompt is mostly interpolation — it must frame the data with a task and an output contract`,
        )
      }
      // A fan-out or merge child that never reads its item does identical work
      // per lane — the classic wasted-budget bug, caught here instead of at run time.
      if (node.kind === "fanout" || node.kind === "merge") {
        assert.match(node.prompt ?? "", /\{\{\s*(item|index)\s*\}\}/, `${node.id}: never interpolates its item`)
      }
    }
  })
}

test("templates: summaries carry no spec bodies (the cheap catalog listing)", () => {
  const summaries = graphTemplateSummaries()
  assert.equal(summaries.length, GRAPH_TEMPLATES.length)
  for (const s of summaries) {
    assert.deepEqual(Object.keys(s).sort(), ["args", "description", "name"])
    assert.ok(typeof s.description === "string" && s.description.length > 0)
  }
  assert.ok(JSON.stringify(summaries).length < JSON.stringify(GRAPH_TEMPLATES).length / 2)
})

test("templates: each shape is distinct (no two templates compile to the same structure)", () => {
  const shapes = GRAPH_TEMPLATES.map((t) =>
    (t.graph.nodes as ReadonlyArray<GraphNode>).map((n) => n.kind).join(">"),
  )
  assert.equal(new Set(shapes).size, shapes.length, `duplicate template shapes: ${shapes.join(" | ")}`)
  for (const spec of GRAPH_TEMPLATES.map((t) => t.graph as GraphSpec)) {
    assert.ok(spec.nodes.length >= 3, "a template earns its place with real structure")
  }
})
