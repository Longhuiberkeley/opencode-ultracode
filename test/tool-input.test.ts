/**
 * Builder A tests — src/tool-input.ts union validation.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_ARGS_BYTES,
  MAX_CATALOG_NAME_CHARS,
  MAX_SCRIPT_BYTES,
  resolveBackground,
  validateCatalogToolInput,
  validateResultToolInput,
  validateStatusToolInput,
  validateToolInput,
} from "../src/tool-input.ts"

type ValidInput = Extract<ReturnType<typeof validateToolInput>, { ok: true }>

function ok(raw: unknown): ValidInput {
  const result = validateToolInput(raw)
  assert.ok(result.ok, `expected ok, got error: ${result.ok ? "" : result.error}`)
  return result
}

function bad(raw: unknown, pattern?: RegExp): string {
  const result = validateToolInput(raw)
  assert.ok(!result.ok, `expected error, got: ${JSON.stringify(result.ok ? result.input : null)}`)
  const error = result.error
  if (pattern) assert.match(error, pattern)
  return error
}

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

test("inline: minimal script-only input", () => {
  const { input } = ok({ script: "return 1" })
  assert.deepEqual(input, { script: "return 1" })
  assert.equal("name" in input, false)
  assert.equal("meta" in input, false)
  assert.equal("args" in input, false)
})

test("inline: full input with name, meta, args", () => {
  const { input } = ok({
    script: "return args.x",
    name: "my run",
    meta: {
      name: "research",
      description: "fan out and verify",
      phases: ["extract", "verify"],
      requires: ["general", "explore"],
    },
    args: { x: 1, list: [1, 2, 3] },
  })
  assert.deepEqual(input, {
    script: "return args.x",
    name: "my run",
    meta: {
      name: "research",
      description: "fan out and verify",
      phases: ["extract", "verify"],
      requires: ["general", "explore"],
    },
    args: { x: 1, list: [1, 2, 3] },
  })
})

test("inline: args may be any JSON value including null and arrays", () => {
  assert.deepEqual(ok({ script: "s", args: null }).input, { script: "s", args: null })
  assert.deepEqual(ok({ script: "s", args: [1, "two", null] }).input, { script: "s", args: [1, "two", null] })
  assert.deepEqual(ok({ script: "s", args: 42 }).input, { script: "s", args: 42 })
})

test("saved: minimal workflow-only input", () => {
  const { input } = ok({ workflow: "deep-research" })
  assert.deepEqual(input, { workflow: "deep-research" })
})

test("saved: workflow + args", () => {
  const { input } = ok({ workflow: "code-audit", args: { modules: ["a", "b"] } })
  assert.deepEqual(input, { workflow: "code-audit", args: { modules: ["a", "b"] } })
})

test("inline: background true/false accepted; non-boolean rejected", () => {
  assert.deepEqual(ok({ script: "return 1", background: true }).input, { script: "return 1", background: true })
  assert.deepEqual(ok({ script: "return 1", background: false }).input, { script: "return 1", background: false })
  assert.deepEqual(ok({ script: "return 1" }).input, { script: "return 1" })
  bad({ script: "return 1", background: "true" }, /"background" must be a boolean/)
  bad({ script: "return 1", background: 1 }, /"background" must be a boolean/)
  bad({ script: "return 1", background: null }, /"background" must be a boolean/)
})

test("saved: background true/false accepted; non-boolean rejected", () => {
  assert.deepEqual(ok({ workflow: "x", background: true }).input, { workflow: "x", background: true })
  assert.deepEqual(ok({ workflow: "x", background: false }).input, { workflow: "x", background: false })
  bad({ workflow: "x", background: "yes" }, /"background" must be a boolean/)
})

test("resolveBackground: omitted/true -> background run; only explicit false blocks", () => {
  assert.equal(resolveBackground({}), true, "omitted defaults to background")
  assert.equal(resolveBackground({ background: true }), true)
  assert.equal(resolveBackground({ background: false }), false, "explicit false blocks for the envelope")
})

test("saved: confirm field is rejected (trust gate replaced the old hash bypass)", () => {
  bad({ workflow: "x", confirm: true }, /unexpected key "confirm"/)
  bad({ workflow: "x", confirm: false }, /unexpected key "confirm"/)
  bad({ workflow: "x", confirm: "yes" }, /unexpected key "confirm"/)
})

// ---------------------------------------------------------------------------
// Discrimination + shape rejection
// ---------------------------------------------------------------------------

test("rejects non-object inputs", () => {
  for (const raw of [null, undefined, 5, "script", true, []]) {
    bad(raw, /input must be an object/)
  }
})

test("rejects input with neither script nor workflow", () => {
  bad({}, /must specify/)
  bad({ name: "x", args: {} }, /must specify/)
})

test("rejects input with both script and workflow", () => {
  bad({ script: "return 1", workflow: "x" }, /cannot specify both/)
})

test("rejects unknown keys in the inline shape", () => {
  bad({ script: "return 1", extra: 1 }, /unexpected key "extra"/)
  bad({ script: "return 1", confirm: true }, /unexpected key "confirm"/)
  bad({ script: "return 1", workflowName: "x" }, /unexpected key "workflowName"/)
})

test("rejects unknown keys in the saved shape", () => {
  bad({ workflow: "x", script2: "y" }, /unexpected key/)
  bad({ workflow: "x", meta: {} }, /unexpected key "meta"/)
})

test("rejects wrong types for script and workflow", () => {
  bad({ script: 42 }, /"script" must be a string/)
  bad({ script: null }, /"script" must be a string/)
  bad({ script: ["a"] }, /"script" must be a string/)
  bad({ workflow: 42 }, /"workflow" must be a non-empty string/)
  bad({ workflow: "" }, /"workflow" must be a non-empty string/)
})

test("rejects empty script", () => {
  bad({ script: "" }, /must not be empty/)
  bad({ script: "   " }, /must not be empty/)
})

test("rejects bad name", () => {
  bad({ script: "s", name: "" }, /"name" must be a non-empty string/)
  bad({ script: "s", name: 7 }, /"name" must be a non-empty string/)
})

test("rejects bad confirm", () => {
  bad({ workflow: "x", confirm: "yes" }, /unexpected key "confirm"/)
  bad({ workflow: "x", confirm: 1 }, /unexpected key "confirm"/)
})

// ---------------------------------------------------------------------------
// meta validation
// ---------------------------------------------------------------------------

test("meta: rejects non-object, unknown keys, wrong types", () => {
  bad({ script: "s", meta: "x" }, /"meta" must be an object/)
  bad({ script: "s", meta: [] }, /"meta" must be an object/)
  bad({ script: "s", meta: { unknown: 1 } }, /meta: unexpected key "unknown"/)
  bad({ script: "s", meta: { name: 5 } }, /meta\.name must be a string/)
  bad({ script: "s", meta: { description: 5 } }, /meta\.description must be a string/)
  bad({ script: "s", meta: { phases: "extract" } }, /meta\.phases must be an array of strings/)
  bad({ script: "s", meta: { phases: [1] } }, /meta\.phases must be an array of strings/)
})

test("meta: requires must be an array of strings", () => {
  bad({ script: "s", meta: { requires: "general" } }, /meta\.requires must be an array of strings/)
  bad({ script: "s", meta: { requires: ["general", 5] } }, /meta\.requires must be an array of strings/)
  bad({ script: "s", meta: { requires: null } }, /meta\.requires must be an array of strings/)
  assert.deepEqual(ok({ script: "s", meta: { requires: [] } }).input, { script: "s", meta: { requires: [] } })
})

test("meta: partial meta with only some fields", () => {
  const { input } = ok({ script: "s", meta: { requires: ["explore"] } })
  assert.deepEqual(input, { script: "s", meta: { requires: ["explore"] } })
})

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

test("script at exactly 512 KB is accepted, one byte over is rejected", () => {
  assert.equal(ok({ script: "a".repeat(MAX_SCRIPT_BYTES) }).ok, true)
  const error = bad({ script: "a".repeat(MAX_SCRIPT_BYTES + 1) }, /"script" is too large/)
  assert.match(error, new RegExp(String(MAX_SCRIPT_BYTES + 1)))
})

test("args at exactly 64 KB serialized is accepted, over is rejected", () => {
  // JSON.stringify of an N-char string is N + 2 bytes (quotes).
  assert.equal(ok({ script: "s", args: "x".repeat(MAX_ARGS_BYTES - 2) }).ok, true)
  const error = bad({ script: "s", args: "x".repeat(MAX_ARGS_BYTES - 1) }, /"args" is too large/)
  assert.match(error, /64 KB|65536|too large/)
})

test("args applies the same cap in the saved shape", () => {
  bad({ workflow: "x", args: "x".repeat(MAX_ARGS_BYTES) }, /"args" is too large/)
})

test("args containing non-JSON values is rejected", () => {
  bad({ script: "s", args: () => 1 }, /must be a JSON value/)
  bad({ script: "s", args: Symbol("nope") }, /must be a JSON value/)
})

test("multi-byte characters count as bytes, not chars", () => {
  // "é" is 2 UTF-8 bytes — 300k chars => 600k bytes => over the 512 KB cap.
  bad({ script: "é".repeat(300_000) }, /"script" is too large/)
})

test("status tool input: omitted, runID, extras, wrong types", () => {
  assert.deepEqual(validateStatusToolInput(undefined), { ok: true })
  assert.deepEqual(validateStatusToolInput(null), { ok: true })
  assert.deepEqual(validateStatusToolInput({}), { ok: true })
  assert.deepEqual(validateStatusToolInput({ runID: "run_abc" }), { ok: true, runID: "run_abc" })
  const extra = validateStatusToolInput({ runID: "run_abc", extra: 1 })
  assert.equal(extra.ok, false)
  if (!extra.ok) assert.match(extra.error, /unexpected key "extra"/)
  const badType = validateStatusToolInput({ runID: 1 })
  assert.equal(badType.ok, false)
  if (!badType.ok) assert.match(badType.error, /"runID" must be a non-empty string/)
  const empty = validateStatusToolInput({ runID: "" })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.error, /empty string/)
})

test("result tool input: runID required; offset/maxLength validated; extras rejected", () => {
  assert.deepEqual(validateResultToolInput({ runID: "run_abc" }), { ok: true, runID: "run_abc" })
  assert.deepEqual(validateResultToolInput({ runID: "run_abc", offset: 50, maxLength: 1000 }), {
    ok: true,
    runID: "run_abc",
    offset: 50,
    maxLength: 1000,
  })
  const missing = validateResultToolInput({})
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /"runID" must be a non-empty string/)
  const badOffset = validateResultToolInput({ runID: "r", offset: -1 })
  assert.equal(badOffset.ok, false)
  if (!badOffset.ok) assert.match(badOffset.error, /"offset" must be a non-negative integer/)
  const fracOffset = validateResultToolInput({ runID: "r", offset: 1.5 })
  assert.equal(fracOffset.ok, false)
  if (!fracOffset.ok) assert.match(fracOffset.error, /"offset" must be a non-negative integer/)
  const badLength = validateResultToolInput({ runID: "r", maxLength: 0 })
  assert.equal(badLength.ok, false)
  if (!badLength.ok) assert.match(badLength.error, /"maxLength" must be an integer of at least 2/)
  const lone = validateResultToolInput({ runID: "r", maxLength: 1 })
  assert.equal(lone.ok, false)
  if (!lone.ok) assert.match(lone.error, /at least 2 \(one UTF-16 unit can be half a surrogate pair\)/)
  const extra = validateResultToolInput({ runID: "r", nope: 1 })
  assert.equal(extra.ok, false)
  if (!extra.ok) assert.match(extra.error, /unexpected key "nope"/)
})

test("resumeFrom: valid run id accepted on both union branches; junk rejected", () => {
  const saved = validateToolInput({ workflow: "deep-research", resumeFrom: "run_4uqmzwttnxcm" })
  assert.equal(saved.ok, true)
  if (saved.ok) assert.equal(saved.input.resumeFrom, "run_4uqmzwttnxcm")

  const inline = validateToolInput({ script: "return 1", resumeFrom: "run_abc123def456" })
  assert.equal(inline.ok, true)
  if (inline.ok) assert.equal(inline.input.resumeFrom, "run_abc123def456")

  for (const bad of ["nope", "run_", "run_XX!", 42, null]) {
    const check = validateToolInput({ script: "return 1", resumeFrom: bad })
    assert.equal(check.ok, false, `resumeFrom=${JSON.stringify(bad)} must be rejected`)
    if (!check.ok) assert.match(check.error, /resumeFrom/)
  }
})

// ---------------------------------------------------------------------------
// ultracode_catalog input (workstream C)
// ---------------------------------------------------------------------------

test("catalog input: no input, or one view, is accepted", () => {
  for (const raw of [undefined, null, {}]) {
    const parsed = validateCatalogToolInput(raw)
    assert.equal(parsed.ok, true, `expected ok for ${JSON.stringify(raw)}`)
    if (parsed.ok) {
      assert.equal(parsed.workflow, undefined)
      assert.equal(parsed.template, undefined)
      assert.equal(parsed.templates, undefined)
    }
  }
  const detail = validateCatalogToolInput({ workflow: " lane-review " })
  assert.equal(detail.ok, true)
  if (detail.ok) assert.equal(detail.workflow, "lane-review", "names are trimmed")
  const one = validateCatalogToolInput({ template: "research-verify" })
  assert.equal(one.ok, true)
  if (one.ok) assert.equal(one.template, "research-verify")
  const all = validateCatalogToolInput({ templates: true })
  assert.equal(all.ok, true)
  if (all.ok) assert.equal(all.templates, true)
  const off = validateCatalogToolInput({ templates: false })
  assert.equal(off.ok, true)
  if (off.ok) assert.equal(off.templates, false)
})

test("catalog input: exactly one view per call", () => {
  for (const raw of [
    { workflow: "a", template: "b" },
    { workflow: "a", templates: true },
    { template: "a", templates: true },
    { workflow: "a", template: "b", templates: true },
  ]) {
    const parsed = validateCatalogToolInput(raw)
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(raw)}`)
    if (!parsed.ok) assert.match(parsed.error, /choose ONE view per call/)
  }
  const rejected = validateCatalogToolInput({ template: "a", templates: true })
  assert.ok(!rejected.ok)
  assert.match(rejected.error, /got template \+ templates/, "the message names the conflicting views")
})

test("catalog input: bad names, bad flags and unknown keys are rejected precisely", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ workflow: "" }, /"workflow" must be a non-empty name/],
    [{ workflow: "   " }, /"workflow" must be a non-empty name/],
    [{ workflow: 42 }, /"workflow" must be a non-empty name, got number/],
    [{ template: null }, /"template" must be a non-empty name, got null/],
    [{ workflow: "x".repeat(MAX_CATALOG_NAME_CHARS + 1) }, /too long/],
    [{ templates: "yes" }, /"templates" must be a boolean, got string/],
    [{ bogus: 1 }, /unexpected key "bogus"/],
    ["nope", /input must be an object, got string/],
    [[], /input must be an object, got array/],
  ]
  for (const [raw, pattern] of cases) {
    const parsed = validateCatalogToolInput(raw)
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(raw)}`)
    if (!parsed.ok) assert.match(parsed.error, pattern)
  }
})

// ---------------------------------------------------------------------------
// Script template views
// ---------------------------------------------------------------------------

test("catalog input: scriptTemplate and scriptTemplates views validate like their graph twins", () => {
  const one = validateCatalogToolInput({ scriptTemplate: "staged-delivery" })
  assert.equal(one.ok, true)
  if (one.ok) assert.equal(one.scriptTemplate, "staged-delivery")
  const all = validateCatalogToolInput({ scriptTemplates: true })
  assert.equal(all.ok, true)
  if (all.ok) assert.equal(all.scriptTemplates, true)

  const cases: Array<[unknown, RegExp]> = [
    [{ scriptTemplate: "" }, /"scriptTemplate" must be a non-empty name/],
    [{ scriptTemplate: 7 }, /"scriptTemplate" must be a non-empty name, got number/],
    [{ scriptTemplates: "yes" }, /"scriptTemplates" must be a boolean, got string/],
  ]
  for (const [raw, pattern] of cases) {
    const parsed = validateCatalogToolInput(raw)
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(raw)}`)
    if (!parsed.ok) assert.match(parsed.error, pattern)
  }
})

test("catalog input: script template views join the one-view-per-call rule", () => {
  for (const raw of [
    { scriptTemplate: "a", template: "b" },
    { scriptTemplate: "a", scriptTemplates: true },
    { scriptTemplates: true, templates: true },
    { workflow: "a", scriptTemplate: "b" },
  ]) {
    const parsed = validateCatalogToolInput(raw)
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(raw)}`)
    if (!parsed.ok) assert.match(parsed.error, /choose ONE view per call/)
  }
})

// ---------------------------------------------------------------------------
// Per-run timeoutMs
// ---------------------------------------------------------------------------

test("timeoutMs is accepted on all three run forms and carried through", () => {
  const inline = ok({ script: "s", timeoutMs: 90 * 60_000 })
  assert.equal(inline.input.timeoutMs, 90 * 60_000)
  const saved = ok({ workflow: "w", timeoutMs: 90 * 60_000 })
  assert.equal(saved.input.timeoutMs, 90 * 60_000)
  const graph = ok({ graph: { nodes: [] }, timeoutMs: 90 * 60_000 })
  assert.equal(graph.input.timeoutMs, 90 * 60_000)
  const none = ok({ script: "s" })
  assert.equal(none.input.timeoutMs, undefined)
})

test("timeoutMs bounds match /ultracode set: 10 s to 24 h, integers only", () => {
  bad({ script: "s", timeoutMs: 9_999 }, /"timeoutMs" must be between 10000 and 86400000/)
  bad({ script: "s", timeoutMs: 86_400_001 }, /"timeoutMs" must be between/)
  bad({ script: "s", timeoutMs: 60_000.5 }, /"timeoutMs" must be an integer/)
  bad({ script: "s", timeoutMs: "60000" }, /"timeoutMs" must be an integer/)
  bad({ workflow: "w", timeoutMs: 1 }, /"timeoutMs" must be between/)
  ok({ script: "s", timeoutMs: 10_000 })
  ok({ script: "s", timeoutMs: 86_400_000 })
})

// ---------------------------------------------------------------------------
// path / template run inputs
// ---------------------------------------------------------------------------

test("path input: relative js file accepted, args/background/resumeFrom/timeoutMs carried", () => {
  const r = validateToolInput({
    path: ".opencode/workflows/audit.js",
    args: { goal: "x" },
    background: false,
    resumeFrom: "run_ab12cd34ef56",
    timeoutMs: 600_000,
  })
  assert.equal(r.ok, true)
  if (r.ok && "path" in r.input) {
    assert.equal(r.input.path, ".opencode/workflows/audit.js")
    assert.deepEqual(r.input.args, { goal: "x" })
    assert.equal(r.input.background, false)
    assert.equal(r.input.resumeFrom, "run_ab12cd34ef56")
    assert.equal(r.input.timeoutMs, 600_000)
  }
})

test("path input: absolute, home, traversal and non-js targets rejected precisely", () => {
  for (const path of ["/etc/passwd", "~/w.js", ".opencode/../../escape.js", "notes.txt"]) {
    const r = validateToolInput({ path })
    assert.equal(r.ok, false, `expected rejection for ${path}`)
    if (!r.ok) assert.ok(r.error.includes('"path"'), `error names the key: ${r.error}`)
  }
})

test("template input: known name accepted; unknown name lists the known set", () => {
  const ok = validateToolInput({ template: "verify-fix", args: { goal: "g" } })
  assert.equal(ok.ok, true)
  if (ok.ok && "template" in ok.input) assert.equal(ok.input.template, "verify-fix")
  const bad = validateToolInput({ template: "nope" })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.ok(bad.error.includes("verify-fix") && bad.error.includes("staged-delivery"), bad.error)
})

test("source keys are mutually exclusive across all five forms", () => {
  for (const raw of [
    { path: "a.js", script: "return 1" },
    { path: "a.js", workflow: "w" },
    { path: "a.js", template: "verify-fix" },
    { template: "verify-fix", script: "return 1" },
    { template: "verify-fix", graph: { nodes: [] } },
  ]) {
    const r = validateToolInput(raw)
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(raw)}`)
    if (!r.ok) assert.match(r.error, /cannot combine|cannot specify both/)
  }
})
