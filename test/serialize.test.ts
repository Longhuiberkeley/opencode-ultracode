/**
 * Builder B tests — serialize: schema validator matrix, tolerant JSON
 * extraction, envelope truncation boundaries.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  buildEnvelope,
  boundedStringify,
  collectBalancedSpans,
  extractJson,
  resultFits,
  validateJsonSchemaValue,
} from "../src/serialize.ts"
import type { AgentRecord, Json, RunRecord } from "../src/types.ts"

// ---------------------------------------------------------------------------
// validateJsonSchemaValue
// ---------------------------------------------------------------------------

test("schema validator: primitive types", () => {
  assert.deepEqual(validateJsonSchemaValue({ type: "string" }, "x"), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: "string" }, 1), {
    ok: false,
    error: '$: expected type string, got number',
  })
  assert.deepEqual(validateJsonSchemaValue({ type: "number" }, 1.5), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: "integer" }, 3), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: "integer" }, 3.5), {
    ok: false,
    error: "$: expected type integer, got number",
  })
  assert.deepEqual(validateJsonSchemaValue({ type: "boolean" }, true), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: "null" }, null), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: "object" }, {}), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: "object" }, [1]), {
    ok: false,
    error: "$: expected type object, got array",
  })
  assert.deepEqual(validateJsonSchemaValue({ type: "array" }, []), { ok: true })
})

test("schema validator: boolean/number quirks — true is not 1, 1 is not true", () => {
  assert.equal(validateJsonSchemaValue({ type: "number" }, true).ok, false)
  assert.equal(validateJsonSchemaValue({ type: "integer" }, true).ok, false)
  assert.equal(validateJsonSchemaValue({ type: "boolean" }, 1).ok, false)
  assert.equal(validateJsonSchemaValue({ type: "boolean" }, 0).ok, false)
  assert.equal(validateJsonSchemaValue({ type: "number" }, 1).ok, true)
})

test("schema validator: union types", () => {
  assert.deepEqual(validateJsonSchemaValue({ type: ["string", "null"] }, null), { ok: true })
  assert.deepEqual(validateJsonSchemaValue({ type: ["string", "null"] }, "s"), { ok: true })
  assert.equal(validateJsonSchemaValue({ type: ["string", "null"] }, 5).ok, false)
})

test("schema validator: required + properties + nesting", () => {
  const schema: Json = {
    type: "object",
    required: ["name", "tags"],
    properties: {
      name: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      score: { type: "number", minimum: 0, maximum: 10 },
      inner: {
        type: "object",
        required: ["flag"],
        properties: { flag: { type: "boolean" } },
      },
    },
  }
  assert.deepEqual(
    validateJsonSchemaValue(schema, { name: "a", tags: ["x"], score: 5, inner: { flag: true } }),
    { ok: true },
  )
  // missing required
  const missing = validateJsonSchemaValue(schema, { name: "a" })
  assert.equal(missing.ok, false)
  assert.match(!missing.ok ? missing.error : "", /missing required property "tags"/)
  // nested array item type
  const badItem = validateJsonSchemaValue(schema, { name: "a", tags: ["x", 3] })
  assert.equal(badItem.ok, false)
  assert.match(!badItem.ok ? badItem.error : "", /\$\.tags\[1\]: expected type string/)
  // nested object property
  const badInner = validateJsonSchemaValue(schema, { name: "a", tags: [], inner: { flag: "yes" } })
  assert.equal(badInner.ok, false)
  assert.match(!badInner.ok ? badInner.error : "", /\$\.inner\.flag: expected type boolean/)
})

test("schema validator: minimum/maximum boundaries are inclusive", () => {
  assert.equal(validateJsonSchemaValue({ type: "number", minimum: 2 }, 2).ok, true)
  assert.equal(validateJsonSchemaValue({ type: "number", minimum: 2 }, 1.99).ok, false)
  assert.equal(validateJsonSchemaValue({ type: "number", maximum: 2 }, 2).ok, true)
  assert.equal(validateJsonSchemaValue({ type: "number", maximum: 2 }, 2.01).ok, false)
})

test("schema validator: enum", () => {
  assert.equal(validateJsonSchemaValue({ enum: ["a", "b"] }, "a").ok, true)
  assert.equal(validateJsonSchemaValue({ enum: ["a", "b"] }, "c").ok, false)
  assert.equal(validateJsonSchemaValue({ enum: [1, 2, null] }, null).ok, true)
  assert.equal(validateJsonSchemaValue({ enum: [{ x: 1 }] }, { x: 1 }).ok, true)
  assert.equal(validateJsonSchemaValue({ enum: [{ x: 1 }] }, { x: 2 }).ok, false)
})

test("schema validator: additionalProperties ignored, undefined/true schemas accept", () => {
  const schema: Json = {
    type: "object",
    properties: { a: { type: "number" } },
    additionalProperties: false,
  }
  assert.equal(validateJsonSchemaValue(schema, { a: 1, extra: "ok" }).ok, true)
  assert.equal(validateJsonSchemaValue(undefined, "anything").ok, true)
  assert.equal(validateJsonSchemaValue(true, "anything").ok, true)
  assert.equal(validateJsonSchemaValue(false, "anything").ok, false)
})

test("schema validator: empty object schema accepts everything", () => {
  assert.equal(validateJsonSchemaValue({}, { any: ["thing"] }).ok, true)
})

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

test("extractJson: clean whole-response JSON", () => {
  const r = extractJson('  {"a": 1}\n')
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : undefined, { a: 1 })
  const arr = extractJson("[1, 2, 3]")
  assert.equal(arr.ok, true)
  assert.deepEqual(arr.ok ? arr.value : undefined, [1, 2, 3])
})

test("extractJson: single fenced ```json block", () => {
  const text = 'Here is the result:\n```json\n{"a": {"b": [1, 2]}}\n```\nHope that helps.'
  const r = extractJson(text)
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : undefined, { a: { b: [1, 2] } })
})

test("extractJson: embedded balanced span in prose", () => {
  const text = 'Sure! The value is {"s": "a } b { c", "n": 2} as requested.'
  const r = extractJson(text)
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : undefined, { s: "a } b { c", n: 2 })
})

test("extractJson: embedded array span", () => {
  const r = extractJson("results: [ {\"k\": \"v\"} ] done")
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : undefined, [{ k: "v" }])
})

test("extractJson: apostrophes in prose do not swallow the span", () => {
  const r = extractJson("Here's the JSON you asked for: {\"a\": 1}")
  assert.equal(r.ok, true)
  assert.deepEqual(r.ok ? r.value : undefined, { a: 1 })
})

test("extractJson: ambiguous multiple candidates rejected", () => {
  const r = extractJson('{"a": 1} and then {"b": 2}')
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : "", /ambiguous/)
})

test("extractJson: multiple fenced blocks rejected", () => {
  const r = extractJson('```json\n{"a": 1}\n```\n```json\n{"b": 2}\n```')
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : "", /ambiguous.*2.*fenced/)
})

test("extractJson: garbage rejected", () => {
  const r = extractJson("no json here at all, sorry")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : "", /no JSON value found/)
  assert.equal(extractJson("").ok, false)
})

test("extractJson: unparseable single span gives invalid-JSON error", () => {
  const r = extractJson("value: {not valid json}")
  assert.equal(r.ok, false)
  assert.match(!r.ok ? r.error : "", /invalid JSON/)
})

test("collectBalancedSpans: nested spans are consumed by their outer span", () => {
  const spans = collectBalancedSpans('x {"a": [1, {"b": 2}]} y')
  assert.equal(spans.length, 1)
  assert.equal(spans[0], '{"a": [1, {"b": 2}]}')
})

// ---------------------------------------------------------------------------
// boundedStringify / resultFits
// ---------------------------------------------------------------------------

test("boundedStringify truncates to maxChars", () => {
  assert.equal(boundedStringify("abcdef", 3), '"ab') // JSON form '"abcdef"' sliced
  assert.equal(boundedStringify("abc", 10), '"abc"')
  assert.equal(boundedStringify({ a: 1 }, 100), '{"a":1}')
  assert.equal(boundedStringify(undefined), "null")
})

test("resultFits boundary is inclusive", () => {
  assert.equal(resultFits({ a: "12345" }, 13), true) // {"a":"12345"} is 13 chars
  assert.equal(resultFits({ a: "12345" }, 12), false)
  assert.equal(resultFits(undefined, 0), true)
})

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

function fakeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const agents: AgentRecord[] = [
    { id: "a1", status: "succeeded", tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
    { id: "a2", status: "failed", error: "boom" },
    { id: "a3", status: "interrupted" },
    { id: "a4", status: "succeeded", tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
  ]
  return {
    id: "run_test1",
    parentSessionID: "ses_parent",
    status: "succeeded",
    script: "return 1",
    startedAt: 1_000,
    endedAt: 3_000,
    agents,
    result: undefined,
    ...overrides,
  }
}

test("buildEnvelope: fields and counts", () => {
  const env = buildEnvelope(fakeRun({ name: "myflow", workflowName: "saved", scriptPath: "/x.js" }), 1000)
  assert.equal(env.runID, "run_test1")
  assert.equal(env.status, "succeeded")
  assert.equal(env.durationMs, 2000)
  assert.deepEqual(env.agents, { total: 4, succeeded: 2, failed: 1, interrupted: 1 })
  assert.equal(env.name, "myflow")
  assert.equal(env.workflowName, "saved")
  assert.equal(env.scriptPath, "/x.js")
  assert.equal(env.truncated, false)
  assert.equal(env.result, undefined)
  assert.equal(env.preview, undefined)
})

test("buildEnvelope: distinct effective models surface, sorted and deduped", () => {
  const agents: AgentRecord[] = [
    {
      id: "a1",
      status: "succeeded",
      effectiveModel: { providerID: "xai", id: "grok-4.6" },
    },
    {
      id: "a2",
      status: "succeeded",
      effectiveModel: { providerID: "zai-coding-plan", id: "glm-5.3-flash" },
    },
    { id: "a3", status: "succeeded", effectiveModel: { providerID: "xai", id: "grok-4.6" } },
    { id: "a4", status: "failed", error: "no model observed" },
  ]
  const env = buildEnvelope(fakeRun({ agents }), 1000)
  assert.deepEqual(env.models, ["xai/grok-4.6", "zai-coding-plan/glm-5.3-flash"])
})

test("buildEnvelope: models omitted when no child recorded one", () => {
  const env = buildEnvelope(fakeRun(), 1000)
  assert.equal(env.models, undefined)
})

test("buildEnvelope: result fits at exactly maxChars", () => {
  const value: Json = { a: "12345" } // compact form is exactly 13 chars
  const env = buildEnvelope(fakeRun({ result: value }), 13)
  assert.deepEqual(env.result, value)
  assert.equal(env.truncated, false)
  assert.equal(env.preview, undefined)
})

test("buildEnvelope: result over budget becomes preview + truncated", () => {
  const value: Json = { a: "12345" }
  const env = buildEnvelope(fakeRun({ result: value }), 12)
  assert.equal(env.result, undefined)
  assert.equal(env.truncated, true)
  assert.ok(typeof env.preview === "string")
  assert.equal(env.preview.length, 12)
  assert.ok(env.preview.startsWith('{\n  "a": "1'))
})

test("buildEnvelope: large result preview is a prefix of pretty JSON", () => {
  const value: Json = { rows: ["x".repeat(300), "y".repeat(300)] }
  const env = buildEnvelope(fakeRun({ result: value }), 64)
  assert.equal(env.truncated, true)
  const pretty = JSON.stringify(value, null, 2)
  assert.equal(env.preview, pretty.slice(0, 64))
})

test("buildEnvelope: truncated result carries resultArtifactKey", () => {
  const env = buildEnvelope(
    fakeRun({ result: { a: "12345" }, resultArtifactKey: "results/run_test1" }),
    12,
  )
  assert.equal(env.truncated, true)
  assert.equal(env.preview !== undefined, true)
  assert.equal(env.resultArtifactKey, "results/run_test1")
})

test("buildEnvelope: non-truncated result omits resultArtifactKey", () => {
  const env = buildEnvelope(
    fakeRun({ result: { a: 1 }, resultArtifactKey: "results/run_test1" }),
    1000,
  )
  assert.equal(env.truncated, false)
  assert.deepEqual(env.result, { a: 1 })
  assert.equal(env.resultArtifactKey, undefined)
})

test("buildEnvelope: error + stopReason + tokens carried", () => {
  const env = buildEnvelope(
    fakeRun({
      status: "stopped",
      error: undefined,
      stopReason: "timeout",
      totalTokens: { input: 11, output: 22, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    1000,
  )
  assert.equal(env.status, "stopped")
  assert.equal(env.stopReason, "timeout")
  assert.deepEqual(env.tokens, { input: 11, output: 22, reasoning: 0, cache: { read: 0, write: 0 } })
})
