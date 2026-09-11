/**
 * Builder A tests — src/tool-input.ts union validation.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_ARGS_BYTES,
  MAX_SCRIPT_BYTES,
  resolveBackground,
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
  bad({}, /must specify either/)
  bad({ name: "x", args: {} }, /must specify either/)
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
