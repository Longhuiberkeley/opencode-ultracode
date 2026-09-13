/**
 * Builder A tests — src/config.ts option loading.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadOptions } from "../src/config.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"

test("loadOptions: undefined/null/non-object inputs use defaults without warnings", () => {
  for (const raw of [undefined, null]) {
    const { options, warnings } = loadOptions(raw)
    assert.deepEqual(options, DEFAULT_OPTIONS)
    assert.deepEqual(warnings, [])
  }
})

test("loadOptions: arrays and primitives are rejected with a warning", () => {
  for (const raw of [[], "general", 42, true]) {
    const { options, warnings } = loadOptions(raw)
    assert.deepEqual(options, DEFAULT_OPTIONS)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /options must be an object/)
  }
})

test("loadOptions: empty object gives all defaults", () => {
  const { options, warnings } = loadOptions({})
  assert.deepEqual(options, {
    agent: "general",
    concurrency: 8,
    maxAgents: 200,
    timeoutMs: 3_600_000,
    permissions: "ask",
    permissionStallMs: 300_000,
    maxResultChars: 65_536,
  })
  assert.deepEqual(warnings, [])
})

test("loadOptions: fully valid options round-trip", () => {
  const raw = {
    agent: "explore",
    concurrency: 16,
    maxAgents: 1000,
    timeoutMs: 600_000,
    permissions: "noEditTools",
    permissionStallMs: 60_000,
    maxResultChars: 10_000,
  }
  const { options, warnings } = loadOptions(raw)
  assert.deepEqual(options, raw)
  assert.deepEqual(warnings, [])
})

test("loadOptions: permissionStallMs accepts 0 (disabled) and rejects out-of-range", () => {
  const off = loadOptions({ permissionStallMs: 0 })
  assert.equal(off.options.permissionStallMs, 0)
  assert.deepEqual(off.warnings, [])
  const hi = loadOptions({ permissionStallMs: 3_600_000 })
  assert.equal(hi.options.permissionStallMs, 3_600_000)
  assert.deepEqual(hi.warnings, [])
  for (const bad of [-1, 3_600_001, 1.5, "soon"]) {
    const { options, warnings } = loadOptions({ permissionStallMs: bad })
    assert.equal(options.permissionStallMs, DEFAULT_OPTIONS.permissionStallMs)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /permissionStallMs/)
  }
})

test("loadOptions: numeric ranges reject out-of-range values with default fallback", () => {
  const cases: Array<[keyof typeof DEFAULT_OPTIONS, unknown, string]> = [
    ["concurrency", 0, "concurrency"],
    ["concurrency", 65, "concurrency"],
    ["maxAgents", 0, "maxAgents"],
    ["maxAgents", 10_001, "maxAgents"],
    ["timeoutMs", 9_999, "timeoutMs"],
    ["timeoutMs", 86_400_001, "timeoutMs"],
    ["maxResultChars", 999, "maxResultChars"],
    ["maxResultChars", 1_000_001, "maxResultChars"],
  ]
  for (const [key, value, needle] of cases) {
    const { options, warnings } = loadOptions({ [key]: value })
    assert.equal((options as Record<string, unknown>)[key], (DEFAULT_OPTIONS as Record<string, unknown>)[key], `${key}=${String(value)}`)
    assert.equal(warnings.length, 1, `${key}=${String(value)}`)
    assert.match(warnings[0]!, new RegExp(needle))
  }
})

test("loadOptions: non-integer, NaN and wrong-typed numbers fall back", () => {
  for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, "8", null]) {
    const { options, warnings } = loadOptions({ concurrency: value })
    assert.equal(options.concurrency, DEFAULT_OPTIONS.concurrency)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /concurrency/)
  }
})

test("loadOptions: numeric boundaries are inclusive", () => {
  const { options, warnings } = loadOptions({
    concurrency: 1,
    maxAgents: 10_000,
    timeoutMs: 10_000,
    maxResultChars: 1_000,
  })
  assert.deepEqual(warnings, [])
  assert.equal(options.concurrency, 1)
  assert.equal(options.maxAgents, 10_000)
  assert.equal(options.timeoutMs, 10_000)
  assert.equal(options.maxResultChars, 1_000)
  const hi = loadOptions({ concurrency: 64, maxAgents: 1, timeoutMs: 86_400_000, maxResultChars: 1_000_000 })
  assert.deepEqual(hi.warnings, [])
  assert.equal(hi.options.concurrency, 64)
})

test("loadOptions: permissions enum", () => {
  for (const valid of ["ask", "autoEditsWorkflow", "noEditTools"] as const) {
    const { options, warnings } = loadOptions({ permissions: valid })
    assert.equal(options.permissions, valid)
    assert.deepEqual(warnings, [])
  }
  const bad = loadOptions({ permissions: "yolo" })
  assert.equal(bad.options.permissions, "ask")
  assert.equal(bad.warnings.length, 1)
  assert.match(bad.warnings[0]!, /permissions/)
  const worse = loadOptions({ permissions: 3 })
  assert.equal(worse.options.permissions, "ask")
  assert.match(worse.warnings[0]!, /permissions/)
})

test("loadOptions: agent must be a non-empty string", () => {
  const ok = loadOptions({ agent: "  explore  " })
  assert.equal(ok.options.agent, "explore")
  assert.deepEqual(ok.warnings, [])

  for (const bad of ["", "   ", 42, null]) {
    const { options, warnings } = loadOptions({ agent: bad })
    assert.equal(options.agent, "general")
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /agent/)
  }
})

test("loadOptions: unknown keys are ignored without warnings", () => {
  const { options, warnings } = loadOptions({
    agent: "explore",
    futureOption: { nested: true },
    another: "whatever",
  })
  assert.equal(options.agent, "explore")
  assert.deepEqual(warnings, [])
})

test("loadOptions: multiple bad values collect one warning each", () => {
  const { warnings } = loadOptions({
    concurrency: 0,
    maxAgents: "lots",
    permissions: "auto",
    agent: "",
  })
  assert.equal(warnings.length, 4)
})
