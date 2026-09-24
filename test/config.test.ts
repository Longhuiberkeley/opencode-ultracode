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
    agentScope: "host",
    agentRetryAttempts: 1,
    agentRetryBackoffMs: 5_000,
    childStallMs: 900_000,
    maxLoopDepth: 2,
    modelFallbacks: {},
    failover: "auto",
    askTimeoutMs: 0,
    providerConcurrency: {},
    routing: null,
    quotaCommand: null,
    quotaSources: {},
    childLimits: {},
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
    agentScope: "configured",
    agentRetryAttempts: 2,
    agentRetryBackoffMs: 30_000,
    childStallMs: 600_000,
    maxLoopDepth: 3,
    modelFallbacks: { "xai/grok-4.6": ["google/gemini-3.7-flash#lite", "anthropic/claude-x"] },
    failover: "ask",
    askTimeoutMs: 900_000,
    providerConcurrency: { anthropic: 2, openai: 1 },
    routing: null,
    quotaCommand: null,
    quotaSources: {},
    childLimits: {},
  }
  const { options, warnings } = loadOptions(raw)
  assert.deepEqual(options, raw)
  assert.deepEqual(warnings, [])
})

test("loadOptions: modelFallbacks validates per entry and normalizes keys", () => {
  const { options, warnings } = loadOptions({
    modelFallbacks: {
      "xai/grok-4.6#medium": ["openai/gpt-6#high"], // variant on the key is normalized away
      "no-slash": ["openai/gpt-6"], // invalid key dropped
      "google/gemini-3.7-flash": ["also-bad", 42, "openai/gpt-6"], // invalid pins dropped, valid one kept
      "anthropic/claude-x": "not-an-array", // invalid value dropped
      "deepseek/v4": [], // empty list: nothing to store
    },
  })
  assert.deepEqual(options.modelFallbacks, {
    "xai/grok-4.6": ["openai/gpt-6#high"],
    "google/gemini-3.7-flash": ["openai/gpt-6"],
  })
  assert.equal(warnings.length, 4, warnings.join(" | "))
  assert.ok(warnings.some((w) => /modelFallbacks.*key/.test(w)))
  assert.ok(warnings.some((w) => /must be an array/.test(w)))
  assert.ok(warnings.filter((w) => /invalid pin/.test(w)).length === 2)
})

test("loadOptions: non-object modelFallbacks falls back to the empty default", () => {
  for (const bad of [42, "openai/gpt-6", [], null]) {
    const { options, warnings } = loadOptions({ modelFallbacks: bad })
    assert.deepEqual(options.modelFallbacks, {})
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /modelFallbacks/)
  }
})

test("loadOptions: agentScope enum", () => {
  const on = loadOptions({ agentScope: "configured" })
  assert.equal(on.options.agentScope, "configured")
  assert.deepEqual(on.warnings, [])
  for (const bad of [" Host", "strict", 1, null]) {
    const { options, warnings } = loadOptions({ agentScope: bad })
    assert.equal(options.agentScope, DEFAULT_OPTIONS.agentScope)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /agentScope/)
  }
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

test("loadOptions: failover enum and askTimeoutMs range", () => {
  for (const valid of ["auto", "ask", "off"] as const) {
    const { options, warnings } = loadOptions({ failover: valid })
    assert.equal(options.failover, valid)
    assert.deepEqual(warnings, [])
  }
  for (const bad of [" Auto", "manual", 3, null]) {
    const { options, warnings } = loadOptions({ failover: bad })
    assert.equal(options.failover, DEFAULT_OPTIONS.failover)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /failover/)
  }

  const off = loadOptions({ askTimeoutMs: 0 })
  assert.equal(off.options.askTimeoutMs, 0, "0 waits indefinitely")
  assert.deepEqual(off.warnings, [])
  const hi = loadOptions({ askTimeoutMs: 86_400_000 })
  assert.equal(hi.options.askTimeoutMs, 86_400_000)
  assert.deepEqual(hi.warnings, [])
  for (const bad of [-1, 86_400_001, 1.5, "soon"]) {
    const { options, warnings } = loadOptions({ askTimeoutMs: bad })
    assert.equal(options.askTimeoutMs, DEFAULT_OPTIONS.askTimeoutMs)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /askTimeoutMs/)
  }
})

test("loadOptions: providerConcurrency validates per entry", () => {
  const { options, warnings } = loadOptions({
    providerConcurrency: {
      anthropic: 2,
      openai: 1,
      "not/a/provider": 3, // slash — dropped
      "..": 1, // parent segment — dropped
      xai: 0, // below min
      google: 17, // above max
      deepseek: 1.5, // non-integer
      foo: "2", // wrong type
    },
  })
  assert.deepEqual(options.providerConcurrency, { anthropic: 2, openai: 1 })
  assert.equal(warnings.length, 6, warnings.join(" | "))
  assert.ok(warnings.some((w) => /not\/a\/provider/.test(w)))
  assert.ok(warnings.some((w) => /"\.\."/.test(w)))
  assert.ok(warnings.filter((w) => /must be an integer 1\.\.16/.test(w)).length === 4)
})

test("loadOptions: non-object providerConcurrency falls back to the empty default", () => {
  for (const bad of [42, "anthropic", [], null]) {
    const { options, warnings } = loadOptions({ providerConcurrency: bad })
    assert.deepEqual(options.providerConcurrency, {})
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /providerConcurrency/)
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
