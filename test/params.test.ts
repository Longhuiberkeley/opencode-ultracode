/**
 * Params derivation tests (workstream C) — src/params.ts.
 *
 * The point of the module is that a caller can learn a saved workflow's `args`
 * WITHOUT reading its script, so the assertions here are written against the
 * shapes real workflows use: the `// Tool input:` header convention, the
 * `const input = args && …` alias idiom, bracket access, destructuring, and the
 * shipped samples in workflows/samples.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  MAX_PARAMS,
  mergeParams,
  paramsFromArgs,
  paramsFromGraph,
  paramsFromScript,
  paramsFromScriptCode,
  paramsFromToolInputHeader,
  paramsLine,
  paramsValue,
  parseParams,
} from "../src/params.ts"
import type { Json } from "../src/types.ts"

const names = (params: ReadonlyArray<{ name: string }>): string[] => params.map((p) => p.name)

// ---------------------------------------------------------------------------
// Header convention
// ---------------------------------------------------------------------------

test("params: the Tool input header yields names, optionality and example types", () => {
  const script = [
    "// partitioned-review: material-budgeted review of a large repo area.",
    '// Tool input: { workflow: "partitioned-review", args: { area: "src", budget?: 35000, maxLanes?: 12, deep?: false, tags?: ["a"] } }',
    "const input = args && typeof args === 'object' ? args : {}",
  ].join("\n")
  const params = paramsFromToolInputHeader(script)
  assert.deepEqual(params, [
    { name: "area", required: true, type: "string" },
    { name: "budget", required: false, type: "number" },
    { name: "maxLanes", required: false, type: "number" },
    { name: "deep", required: false, type: "boolean" },
    { name: "tags", required: false, type: "array" },
  ])
})

test("params: a nested example object does not leak its keys in as top-level params", () => {
  const script = '// Tool input: { args: { filters: { severity: "high", path: "src" }, area: "src" } }'
  assert.deepEqual(names(paramsFromToolInputHeader(script)), ["filters", "area"], "declaration order, top level only")
})

test("params: no header, or a header without args, yields nothing", () => {
  assert.deepEqual(paramsFromToolInputHeader("return 1"), [])
  assert.deepEqual(paramsFromToolInputHeader("// Tool input: { workflow: \"x\" }"), [])
  assert.deepEqual(paramsFromToolInputHeader("// Tool input: { args: "), [], "unbalanced span is skipped")
})

// ---------------------------------------------------------------------------
// Code references
// ---------------------------------------------------------------------------

test("params: args.x, args?.x, args[\"x\"] and the alias idiom are all found", () => {
  const script = [
    "const input = args && typeof args === 'object' ? args : {}",
    "const topic = String(args.topic)",
    "const depth = input.depth ?? 2",
    "const mode = args?.mode",
    'const raw = args["rawKey"]',
    "const viaAlias = input.aliasOnly",
  ].join("\n")
  assert.deepEqual(names(paramsFromScriptCode(script)), ["topic", "mode", "rawKey", "depth", "aliasOnly"], "args first, then its alias")
})

test("params: destructuring from args or its alias is found", () => {
  assert.deepEqual(names(paramsFromScriptCode("const { a, b = 2 } = args")), ["a", "b"])
  assert.deepEqual(names(paramsFromScriptCode("const cfg = args ?? {}\nconst { x, y } = cfg")), ["x", "y"])
})

test("params: object properties and unrelated identifiers are not params", () => {
  assert.deepEqual(names(paramsFromScriptCode("if (args.length > 2) return args.toString()")), [])
  assert.deepEqual(names(paramsFromScriptCode("const totals = { length: 1 }\nreturn totals.length")), [])
  assert.deepEqual(names(paramsFromScriptCode("return 1")), [])
})

test("params: the code scan is textual — args.x in comments still counts", () => {
  assert.deepEqual(names(paramsFromScriptCode("// see args.secret")), ["secret"])
})

test("params: header wins on type and optionality, code refs fill the gaps", () => {
  const script = [
    '// Tool input: { args: { area: "src", budget?: 35000 } }',
    "const input = args ?? {}",
    "const area = input.area",
    "const extra = input.onlyInCode",
  ].join("\n")
  const params = paramsFromScript(script)
  assert.deepEqual(params, [
    { name: "area", required: true, type: "string" },
    { name: "budget", required: false, type: "number" },
    { name: "onlyInCode" },
  ])
})

// ---------------------------------------------------------------------------
// Run args, graph specs
// ---------------------------------------------------------------------------

test("params: a run's real args give names and JSON types, never required-ness", () => {
  const params = paramsFromArgs({ area: "src", budget: 35000, deep: false, tags: ["a"], nested: { x: 1 }, nothing: null })
  assert.deepEqual(params, [
    { name: "area", type: "string" },
    { name: "budget", type: "number" },
    { name: "deep", type: "boolean" },
    { name: "tags", type: "array" },
    { name: "nested", type: "object" },
    { name: "nothing", type: "null" },
  ])
  for (const p of params) assert.equal("required" in p, false, "one run passing an arg does not make it required")
  assert.deepEqual(paramsFromArgs("bare string"), [])
  assert.deepEqual(paramsFromArgs(["array"]), [])
  assert.deepEqual(paramsFromArgs(undefined), [])
  assert.deepEqual(paramsFromArgs(null), [])
})

test("params: a graph spec contributes its {{args.x}} templates and $args.x refs", () => {
  const spec = {
    nodes: [
      { id: "scout", kind: "agent", prompt: "Inventory {{args.area}} using {{args.depth}} levels." },
      { id: "fan", kind: "fanout", over: "$args.angles", prompt: "Angle {{item}} of {{args.area}}" },
      { id: "note", kind: "checkpoint", value: "$args.marker" },
    ],
    returns: { out: "$args.tail" },
  }
  assert.deepEqual(names(paramsFromGraph(spec)), ["area", "depth", "angles", "marker", "tail"], "first-appearance order")
  assert.deepEqual(paramsFromGraph({ nodes: "junk" }), [])
  assert.deepEqual(paramsFromGraph(null), [])
})

// ---------------------------------------------------------------------------
// Merge, parse, render
// ---------------------------------------------------------------------------

test("params: mergeParams lets explicit values win field-by-field and derived fill gaps", () => {
  const derived = [
    { name: "area", required: true, type: "string" },
    { name: "budget", required: false, type: "number" },
  ]
  const merged = parseParams(mergeParams({ args: [{ name: "area", type: "object", description: "the target" }] }, derived))
  assert.deepEqual(merged?.args, [
    { name: "area", type: "object", required: true, description: "the target" },
    { name: "budget", required: false, type: "number" },
  ])
})

test("params: mergeParams returns undefined when nothing is known (no empty params on manifests)", () => {
  assert.equal(mergeParams(undefined, []), undefined)
  assert.equal(mergeParams({ args: [] }, []), undefined)
  assert.equal(mergeParams("junk" as Json, []), undefined)
})

test("params: parseParams rejects junk and drops malformed entries", () => {
  assert.equal(parseParams(undefined), undefined)
  assert.equal(parseParams(null), undefined)
  assert.equal(parseParams([]), undefined)
  assert.equal(parseParams({}), undefined)
  assert.deepEqual(parseParams({ args: [{ name: "ok" }, { name: 5 }, null, "x", { name: "has space" }] }), {
    args: [{ name: "ok" }],
  })
})

test("params: paramsLine renders a compact, optional-marked signature", () => {
  assert.equal(
    paramsLine({ args: [{ name: "area", type: "string", required: true }, { name: "budget", type: "number", required: false }, { name: "loose" }] }),
    "area: string, budget?: number, loose",
  )
  assert.equal(paramsLine(undefined), "")
  assert.equal(paramsLine({ args: [] }), "")
})

test("params: paramsValue normalizes and caps the list", () => {
  const many = Array.from({ length: MAX_PARAMS + 10 }, (_, i) => ({ name: `p${String(i).padStart(3, "0")}` }))
  const value = paramsValue(many)
  const parsed = parseParams(value)
  assert.equal(parsed?.args.length, MAX_PARAMS)
  assert.equal(paramsValue([]), undefined)
})

// ---------------------------------------------------------------------------
// The shipped samples: derivation must work on real content
// ---------------------------------------------------------------------------

const SAMPLE_PARAMS: Record<string, string[]> = {
  "partitioned-review": ["area", "budget", "maxLanes"],
  "deep-research": ["topic", "angles"],
  "code-audit": ["modules", "focus"],
  "fact-check": ["draft", "sources"],
  "dev-loop": ["task", "repo", "scope", "fixPasses", "reviewer"],
}

for (const [sample, expected] of Object.entries(SAMPLE_PARAMS)) {
  test(`params: sample ${sample} declares ${expected.join(", ")}`, () => {
    const script = readFileSync(new URL(`../workflows/samples/${sample}.js`, import.meta.url), "utf8")
    const found = names(paramsFromScript(script))
    for (const name of expected) {
      assert.ok(found.includes(name), `${sample}: expected param "${name}" in [${found.join(", ")}]`)
    }
  })
}
