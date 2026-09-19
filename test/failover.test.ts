/**
 * Failover policy tests — the ordered fallback ladder and its tier gate.
 * Pure module: no sessions, no host; the whole matrix is driven directly.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { isReadOnlyChild, resolveFallbacks } from "../src/failover.ts"
import type { ModelCatalogEntry, PinPoolEntry } from "../src/failover.ts"

const DEAD = { providerID: "xai", id: "grok-4.6", variant: "medium" }

function models(candidates: ReturnType<typeof resolveFallbacks>): string[] {
  return candidates.map((c) => `${c.model.providerID}/${c.model.id}${c.model.variant !== undefined ? `#${c.model.variant}` : ""}`)
}

function sources(candidates: ReturnType<typeof resolveFallbacks>): string[] {
  return candidates.map((c) => c.source)
}

test("resolveFallbacks: ladder order call > option > pin > catalog (read-only), order preserved", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["call/first"],
    modelFallbacks: { "xai/grok-4.6": ["option/second", "option/third"] },
    pinPool: [{ agentID: "a1", pin: "pin/fourth" }],
    readOnly: true,
    catalog: [{ providerID: "catalog", id: "fifth", toolCapable: true, contextLimit: 100_000 }],
  })
  assert.deepEqual(models(candidates), ["call/first", "option/second", "option/third", "pin/fourth", "catalog/fifth"])
  assert.deepEqual(sources(candidates), ["call", "option", "option", "pin", "catalog"])
  assert.equal(candidates[2]!.pin, "option/third")
  assert.equal(candidates[3]!.agentID, "a1")
})

test("resolveFallbacks: variant parses through the shared pin parser; invalid pins are dropped", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["openai/gpt-6#high", "not a pin", "", 42 as unknown as string],
    readOnly: false,
  })
  assert.deepEqual(models(candidates), ["openai/gpt-6#high"])
  assert.deepEqual(candidates[0]!.model, { providerID: "openai", id: "gpt-6", variant: "high" })
})

test("resolveFallbacks: quota excludes the dead provider entirely; burst allows another model on it", () => {
  const input = {
    dead: DEAD,
    callFallbacks: ["xai/grok-mini", "google/gemini-3.7-flash"],
    readOnly: false,
  }
  const quota = resolveFallbacks({ ...input, failureClass: "quota" })
  assert.deepEqual(models(quota), ["google/gemini-3.7-flash"])
  const burst = resolveFallbacks({ ...input, failureClass: "burst" })
  assert.deepEqual(models(burst), ["xai/grok-mini", "google/gemini-3.7-flash"])
})

test("resolveFallbacks: the dead providerID+id is never a candidate, from any source", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["xai/grok-4.6#medium", "xai/grok-4.6#low", "openai/gpt-6"],
    modelFallbacks: { "xai/grok-4.6": ["xai/grok-4.6"] },
    pinPool: [{ agentID: "general", pin: "xai/grok-4.6" }],
    readOnly: true,
    catalog: [{ providerID: "xai", id: "grok-4.6", toolCapable: true, contextLimit: 100_000 }],
  })
  assert.deepEqual(models(candidates), ["openai/gpt-6"])
})

test("resolveFallbacks: disabled providers are excluded from every source", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "burst",
    callFallbacks: ["disabledprov/a", "openai/gpt-6"],
    pinPool: [{ agentID: "a1", pin: "disabledprov/b" }],
    disabledProviders: new Set(["disabledprov"]),
    readOnly: false,
  })
  assert.deepEqual(models(candidates), ["openai/gpt-6"])
})

test("resolveFallbacks: duplicates keep the highest-precedence occurrence", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["openai/gpt-6"],
    modelFallbacks: { "xai/grok-4.6": ["openai/gpt-6", "google/gemini-3.7-flash"] },
    pinPool: [{ agentID: "a1", pin: "openai/gpt-6" }],
    readOnly: false,
  })
  assert.deepEqual(sources(candidates), ["call", "option"])
  assert.deepEqual(models(candidates), ["openai/gpt-6", "google/gemini-3.7-flash"])
})

test("resolveFallbacks: catalog inference is read-only-only, enabled + tool-capable + different provider", () => {
  const catalog: ModelCatalogEntry[] = [
    { providerID: "chat", id: "chat-only", toolCapable: false, contextLimit: 100_000 },
    { providerID: "off", id: "disabled", enabled: false, toolCapable: true, contextLimit: 100_000 },
    { providerID: "sameprov", id: "other-model", toolCapable: true, contextLimit: 100_000 },
    { providerID: "good", id: "worker", toolCapable: true, contextLimit: 100_000 },
  ]
  const dead = { providerID: "sameprov", id: "dead" }
  const edit = resolveFallbacks({ dead, failureClass: "quota", readOnly: false, catalog, sessionTokens: 10_000 })
  assert.deepEqual(models(edit), [], "edit-capable children never infer from the catalog")
  const readOnly = resolveFallbacks({ dead, failureClass: "quota", readOnly: true, catalog, sessionTokens: 10_000 })
  assert.deepEqual(models(readOnly), ["good/worker"])
  assert.equal(readOnly[0]!.source, "catalog")
})

test("resolveFallbacks: context-fit uses the dead session's tokens when the catalog knows limits", () => {
  const catalog: ModelCatalogEntry[] = [
    { providerID: "small", id: "m", toolCapable: true, contextLimit: 4_000 },
    { providerID: "large", id: "m", toolCapable: true, contextLimit: 200_000 },
    { providerID: "unknown", id: "m", toolCapable: true },
  ]
  const readOnly = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    readOnly: true,
    catalog,
    sessionTokens: 10_000,
  })
  assert.deepEqual(models(readOnly), ["large/m"], "inference needs a known, fitting window")
  // An explicit candidate is not vetoed by an unknown limit — only a KNOWN
  // too-small window excludes it.
  const explicit = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["small/m", "unknown/m"],
    readOnly: false,
    catalog,
    sessionTokens: 10_000,
  })
  assert.deepEqual(models(explicit), ["unknown/m"])
})

test("resolveFallbacks: edit-capable children may not fail over DOWN; read-only children may", () => {
  const catalog: ModelCatalogEntry[] = [
    { providerID: "cheap", id: "small", priceTier: 1 },
    { providerID: "equal", id: "same", priceTier: 3 },
    { providerID: "pricey", id: "big", priceTier: 5 },
  ]
  const dead = { providerID: "dead", id: "dead-model" }
  const fullCatalog = [{ providerID: "dead", id: "dead-model", priceTier: 3 }, ...catalog]
  const edit = resolveFallbacks({
    dead,
    failureClass: "quota",
    pinPool: [
      { agentID: "a1", pin: "cheap/small" },
      { agentID: "a2", pin: "equal/same" },
      { agentID: "a3", pin: "pricey/big" },
    ],
    readOnly: false,
    catalog: fullCatalog,
  })
  assert.deepEqual(models(edit), ["equal/same", "pricey/big"], "no failover-down for edit-capable children")
  // Only cheaper candidates => the ladder is empty and the caller fails the
  // child with its typed quota error (fail closed, never a weak-model swap).
  const cheaperOnly = resolveFallbacks({
    dead,
    failureClass: "quota",
    pinPool: [{ agentID: "a1", pin: "cheap/small" }],
    readOnly: false,
    catalog: fullCatalog,
  })
  assert.deepEqual(cheaperOnly, [])
  const readOnly = resolveFallbacks({
    dead,
    failureClass: "quota",
    pinPool: [
      { agentID: "a1", pin: "cheap/small" },
      { agentID: "a2", pin: "equal/same" },
    ],
    readOnly: true,
    catalog: fullCatalog,
  })
  assert.deepEqual(models(readOnly), ["cheap/small", "equal/same"])
})

test("resolveFallbacks: without tier metadata, explicit and pin candidates pass but catalog inference never does", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["openai/gpt-6"],
    pinPool: [{ agentID: "a1", pin: "google/gemini-3.7-flash" }],
    readOnly: false,
  })
  assert.deepEqual(models(candidates), ["openai/gpt-6", "google/gemini-3.7-flash"])
})

test("resolveFallbacks: unknown dead model + no rungs => empty (caller fails the child)", () => {
  assert.deepEqual(resolveFallbacks({ dead: DEAD, failureClass: "quota", readOnly: true }), [])
  // A modelFallbacks map keyed for a DIFFERENT dead model does not apply.
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    modelFallbacks: { "other/model": ["openai/gpt-6"] },
    readOnly: false,
  })
  assert.deepEqual(candidates, [])
})

test("resolveFallbacks: pinPool entries carry their agent id (pin-pool cross-provider selection)", () => {
  const pool: PinPoolEntry[] = [
    { agentID: "general", pin: "xai/grok-4.6" }, // dead provider: quota excludes it
    { agentID: "explore", pin: "google/gemini-3.7-flash#lite" },
    { agentID: "reviewer", pin: "anthropic/claude-x" },
  ]
  const candidates = resolveFallbacks({ dead: DEAD, failureClass: "quota", pinPool: pool, readOnly: false })
  assert.deepEqual(models(candidates), ["google/gemini-3.7-flash#lite", "anthropic/claude-x"])
  assert.deepEqual(
    candidates.map((c) => c.agentID),
    ["explore", "reviewer"],
  )
})

test("resolveFallbacks: the run-level override sits after per-call fallbacks and before the option map", () => {
  const candidates = resolveFallbacks({
    dead: DEAD,
    failureClass: "quota",
    callFallbacks: ["call/first"],
    runFallback: "openai/gpt-6#high",
    modelFallbacks: { "xai/grok-4.6": ["option/third"] },
    pinPool: [{ agentID: "explore", pin: "pin/fourth" }],
    readOnly: false,
  })
  assert.deepEqual(models(candidates), ["call/first", "openai/gpt-6#high", "option/third", "pin/fourth"])
  assert.deepEqual(sources(candidates), ["call", "run", "option", "pin"])
  assert.equal(candidates[1]!.pin, "openai/gpt-6#high")
  // An override equal to the dead model is dropped like any other rung; a
  // malformed override is ignored (the caller validates at admission).
  assert.deepEqual(
    models(resolveFallbacks({ dead: DEAD, failureClass: "quota", runFallback: "xai/grok-4.6", readOnly: false })),
    [],
  )
  assert.deepEqual(
    models(resolveFallbacks({ dead: DEAD, failureClass: "quota", runFallback: "not a pin", readOnly: false })),
    [],
  )
})

test("isReadOnlyChild: noEditTools mode or the explore agent", () => {
  assert.equal(isReadOnlyChild("noEditTools", "general"), true)
  assert.equal(isReadOnlyChild("ask", "explore"), true)
  assert.equal(isReadOnlyChild("ask", "general"), false)
  assert.equal(isReadOnlyChild("autoEditsWorkflow", "build"), false)
  assert.equal(isReadOnlyChild(undefined, "general"), false)
})