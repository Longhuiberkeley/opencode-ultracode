/**
 * Catalog builder tests (workstream C) — src/catalog.ts.
 *
 * Two properties matter and both are asserted here: the view is USEFUL (params,
 * trust, kind, last-run stats, templates) and it is BOUNDED (every list capped,
 * every string sliced) because the payload lands in a context window. Ownership
 * filtering happens in the caller (src/index.ts) — the builder renders whatever
 * runs it is handed, so these tests hand it only owned runs and pin the contract
 * that the tool executor must pre-filter.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  MAX_CATALOG_AGENTS,
  MAX_CATALOG_DESCRIPTION_CHARS,
  MAX_CATALOG_WORKFLOWS,
  MAX_DETAIL_SCRIPT_HEAD,
  buildCatalog,
} from "../src/catalog.ts"
import { GRAPH_TEMPLATES } from "../src/graph-templates.ts"
import type { CatalogWorkflow } from "../src/catalog.ts"
import type { Json, RunRecord, SavedWorkflow } from "../src/types.ts"

const GRAPH_SPEC = {
  name: "lane-review",
  nodes: [
    { id: "scout", kind: "agent", agent: "explore", prompt: "Inventory {{args.area}} with line counts." },
    { id: "lanes", kind: "partition", from: "$scout.files" },
    { id: "review", kind: "fanout", over: "$lanes", max: 8, prompt: "Review these files: {{item}}" },
  ],
  returns: { report: "$review" },
}

function scriptWorkflow(name: string, overrides: Partial<SavedWorkflow> = {}): SavedWorkflow {
  return {
    manifest: {
      version: 1,
      name,
      description: "a script workflow",
      phases: ["scan", "review"],
      requires: ["general"],
      hash: "h",
      source: "project",
      savedAt: 1,
      kind: "script",
      params: { args: [{ name: "modules", type: "array", required: true }, { name: "focus", type: "string", required: false }] },
    },
    script: "// Tool input: { args: { modules: [] } }\n" + "return 1\n".repeat(400),
    ...overrides,
  }
}

function graphWorkflow(name: string, overrides: Partial<SavedWorkflow> = {}): SavedWorkflow {
  return {
    manifest: {
      version: 1,
      name,
      description: "a graph workflow",
      phases: ["scout", "review"],
      requires: ["explore"],
      hash: "h",
      source: "project",
      savedAt: 1,
      kind: "graph",
      params: { args: [{ name: "area", type: "string" }] },
    },
    script: "const G_args = args",
    graphSpec: JSON.parse(JSON.stringify(GRAPH_SPEC)) as Json,
    ...overrides,
  }
}

function entry(workflow: SavedWorkflow, trusted = true): CatalogWorkflow {
  return { workflow, trusted }
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_a",
    parentSessionID: "ses_owner",
    status: "succeeded",
    script: "return 1",
    workflowName: "lane-review",
    startedAt: 1_000,
    endedAt: 4_000,
    agents: [{ id: "a1", status: "succeeded" }],
    totalTokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Listing view
// ---------------------------------------------------------------------------

test("catalog: the empty view is bounded, self-describing and never throws", () => {
  const out = buildCatalog({}) as Record<string, Json>
  assert.deepEqual(out["workflows"], [])
  assert.equal(out["trustedCount"], 0)
  assert.equal((out["templates"] as unknown[]).length, GRAPH_TEMPLATES.length)
  assert.match(String(out["hint"]), /workflow: "<name>"/)
  assert.match(String(out["hint"]), /never executes|Nothing here executes/)
})

test("catalog: a workflow row carries kind, params, phases, trust and node count", () => {
  const out = buildCatalog({
    workflows: [entry(graphWorkflow("lane-review")), entry(scriptWorkflow("code-audit"), false)],
  }) as Record<string, Json>
  const rows = out["workflows"] as Array<Record<string, Json>>
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    name: "code-audit",
    kind: "script",
    trusted: false,
    source: "project",
    description: "a script workflow",
    params: "modules: array, focus?: string",
    phases: ["scan", "review"],
    requires: ["general"],
  })
  assert.deepEqual(rows[1], {
    name: "lane-review",
    kind: "graph",
    trusted: true,
    source: "project",
    description: "a graph workflow",
    params: "area: string",
    phases: ["scout", "review"],
    requires: ["explore"],
    nodes: 3,
  })
  assert.equal(out["trustedCount"], 1)
})

test("catalog: an unloadable graph is listed as broken and never as trusted", () => {
  const broken = graphWorkflow("broken", { script: "", graphSpec: undefined, graphError: "the graph spec failed validation: nodes[0]: prompt is required" })
  const out = buildCatalog({ workflows: [entry(broken, true)] }) as Record<string, Json>
  const row = (out["workflows"] as Array<Record<string, Json>>)[0]!
  assert.equal(row["broken"], "the graph spec failed validation: nodes[0]: prompt is required")
  assert.equal(row["trusted"], false, "a broken spec cannot be trusted, whatever the trust store says")
  assert.equal(out["trustedCount"], 0)
})

test("catalog: listings are capped and sliced, with the overflow reported", () => {
  const many = Array.from({ length: MAX_CATALOG_WORKFLOWS + 7 }, (_, i) =>
    entry(scriptWorkflow(`wf${String(i).padStart(3, "0")}`, {
      manifest: {
        ...scriptWorkflow("x").manifest,
        name: `wf${String(i).padStart(3, "0")}`,
        description: "d".repeat(MAX_CATALOG_DESCRIPTION_CHARS * 3),
      },
    })),
  )
  const out = buildCatalog({ workflows: many }) as Record<string, Json>
  const rows = out["workflows"] as Array<Record<string, Json>>
  assert.equal(rows.length, MAX_CATALOG_WORKFLOWS)
  assert.equal(out["moreWorkflows"], 7)
  for (const row of rows) {
    assert.ok(String(row["description"]).length <= MAX_CATALOG_DESCRIPTION_CHARS + 1, "description must be sliced")
  }
  const agents = Array.from({ length: MAX_CATALOG_AGENTS + 3 }, (_, i) => ({ id: `agent${i}`, description: "x".repeat(400) }))
  const withAgents = buildCatalog({ agents }) as Record<string, Json>
  assert.equal((withAgents["agents"] as unknown[]).length, MAX_CATALOG_AGENTS)
  assert.equal(withAgents["moreAgents"], 3)
})

test("catalog: last-run stats come from the runs handed in, newest wins", () => {
  const runs = [
    run({ id: "run_old", startedAt: 1_000, endedAt: 2_000, status: "failed", error: "boom" }),
    run({ id: "run_new", startedAt: 5_000, endedAt: 9_000, status: "succeeded" }),
    run({ id: "run_other", workflowName: "code-audit", startedAt: 7_000 }),
  ]
  const out = buildCatalog({ workflows: [entry(graphWorkflow("lane-review"))], runs }) as Record<string, Json>
  const row = (out["workflows"] as Array<Record<string, Json>>)[0]!
  assert.equal(row["runs"], 2, "only this workflow's runs are counted")
  const last = row["lastRun"] as Record<string, Json>
  assert.equal(last["runID"], "run_new")
  assert.equal(last["status"], "succeeded")
  assert.equal(last["durationMs"], 4_000)
  assert.deepEqual(last["tokens"], { input: 100, output: 20 })
  assert.deepEqual(last["agents"], { total: 1, succeeded: 1, failed: 0 })
  assert.equal("error" in last, false)
})

test("catalog: agents are listed with sliced descriptions, or the failure is surfaced", () => {
  const out = buildCatalog({ agents: [{ id: "general", description: "general-purpose" }, { id: "explore" }] }) as Record<string, Json>
  assert.deepEqual(out["agents"], [{ id: "general", description: "general-purpose" }, { id: "explore" }])
  const failed = buildCatalog({ agentsUnavailable: "ctx.agent.list threw" }) as Record<string, Json>
  assert.equal(failed["agentsUnavailable"], "ctx.agent.list threw")
  assert.equal("agents" in failed, false)
})

test("catalog: caps are echoed so the model can budget the run it is about to author", () => {
  const out = buildCatalog({ caps: { concurrency: 8, maxAgents: 200, timeoutMs: 3_600_000 } }) as Record<string, Json>
  assert.deepEqual(out["caps"], { concurrency: 8, maxAgents: 200, timeoutMs: 3_600_000 })
})

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

test("catalog: the graph detail view hands over the whole spec plus an invoke hint", () => {
  const out = buildCatalog({ workflows: [entry(graphWorkflow("lane-review"))], workflow: "lane-review" }) as Record<string, Json>
  const detail = out["workflow"] as Record<string, Json>
  assert.equal(detail["name"], "lane-review")
  assert.equal(detail["kind"], "graph")
  assert.deepEqual(detail["graph"], JSON.parse(JSON.stringify(GRAPH_SPEC)))
  assert.deepEqual(detail["nodeIds"], ["scout", "lanes", "review"])
  assert.deepEqual(detail["params"], [{ name: "area", type: "string" }])
  assert.equal(detail["invoke"], 'ultracode_run { workflow: "lane-review", args: { … } }')
  assert.equal("scriptHead" in detail, false, "a graph's compiled script is noise — the spec is the artifact")
  assert.equal("workflows" in out, false, "the detail view replaces the listing")
})

test("catalog: the script detail view bounds the script to a head slice", () => {
  const out = buildCatalog({ workflows: [entry(scriptWorkflow("code-audit"), false)], workflow: "code-audit" }) as Record<string, Json>
  const detail = out["workflow"] as Record<string, Json>
  assert.equal(detail["kind"], "script")
  assert.ok(String(detail["scriptHead"]).length <= MAX_DETAIL_SCRIPT_HEAD)
  assert.equal(detail["scriptChars"], scriptWorkflow("code-audit").script.length)
  assert.match(String(detail["scriptHead"]), /Tool input:/, "the head is where the args contract lives")
  assert.equal(detail["invoke"], "needs one user approval first: /ultracode trust code-audit")
  assert.equal("graph" in detail, false)
})

test("catalog: a broken workflow's detail says it is unusable instead of inviting a run", () => {
  const broken = graphWorkflow("broken", { script: "", graphSpec: undefined, graphError: "the graph spec is not valid JSON" })
  const out = buildCatalog({ workflows: [entry(broken, true)], workflow: "broken" }) as Record<string, Json>
  const detail = out["workflow"] as Record<string, Json>
  assert.equal(detail["trusted"], false)
  assert.match(String(detail["invoke"]), /unusable until the spec is fixed/)
})

test("catalog: an unknown detail name returns the available list, not a throw", () => {
  const out = buildCatalog({ workflows: [entry(scriptWorkflow("code-audit"))], workflow: "nope" }) as Record<string, Json>
  assert.match(String(out["error"]), /no saved workflow named "nope"/)
  assert.deepEqual(out["available"], ["code-audit"])
})

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

test("catalog: templates are summaries by default, full specs on request", () => {
  const summaries = buildCatalog({}) as Record<string, Json>
  const row = (summaries["templates"] as Array<Record<string, Json>>)[0]!
  assert.deepEqual(Object.keys(row).sort(), ["args", "description", "name"])

  const full = buildCatalog({ templates: true }) as Record<string, Json>
  const fullRow = (full["templates"] as Array<Record<string, Json>>)[0]!
  assert.ok(fullRow["graph"], "templates: true must carry the spec body")
  assert.equal((full["templates"] as unknown[]).length, GRAPH_TEMPLATES.length)

  const one = buildCatalog({ template: "research-verify" }) as Record<string, Json>
  const single = one["template"] as Record<string, Json>
  assert.equal(single["name"], "research-verify")
  assert.ok(single["graph"])
  assert.equal("templates" in one, false, "one template replaces the listing")
})

test("catalog: an unknown template name falls back to the summaries", () => {
  const out = buildCatalog({ template: "nope" }) as Record<string, Json>
  assert.match(String(out["templateError"]), /no graph template named "nope"/)
  assert.equal((out["templates"] as unknown[]).length, GRAPH_TEMPLATES.length)
})

// ---------------------------------------------------------------------------
// Size discipline
// ---------------------------------------------------------------------------

test("catalog: a pathological install still produces a bounded payload", () => {
  const workflows = Array.from({ length: 200 }, (_, i) =>
    entry(
      scriptWorkflow(`wf${i}`, {
        manifest: {
          ...scriptWorkflow("x").manifest,
          name: `wf${i}`,
          description: "description ".repeat(200),
          phases: Array.from({ length: 50 }, (_, p) => `phase${p}`),
        },
      }),
    ),
  )
  const runs = Array.from({ length: 50 }, (_, i) => run({ id: `run_${i}`, workflowName: `wf${i}` }))
  const serialized = JSON.stringify(buildCatalog({ workflows, runs, templates: true, agents: Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` })) }))
  assert.ok(serialized.length < 120_000, `catalog payload is ${serialized.length} chars — must stay context-cheap`)
})
