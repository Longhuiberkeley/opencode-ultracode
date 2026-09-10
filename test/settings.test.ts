/**
 * Chunk 3: overlay merge, clamp at admission (not parser), set parse,
 * permission ask path, snapshot timeout math.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { loadOptions } from "../src/config.ts"
import { readFileSync } from "node:fs"
import {
  applyOverlay,
  applySetValue,
  evaluateOwnedPermission,
  freezeEffective,
  parseSetArgs,
  parseSettingsOverlay,
  permissionHookDecision,
  remainingTimeoutMs,
  stepPanelSetting,
  panelSettingsFrom,
} from "../src/settings.ts"
import { FakeRegistry } from "./fakes.ts"
import { CONCURRENCY_CAP, DEFAULT_OPTIONS, clampConcurrency } from "../src/types.ts"

test("clampConcurrency: 64 → 8 without changing loadOptions", () => {
  const loaded = loadOptions({ concurrency: 64 })
  assert.equal(loaded.options.concurrency, 64)
  assert.equal(loaded.warnings.length, 0)
  assert.equal(clampConcurrency(64), 8)
  assert.equal(clampConcurrency(64), CONCURRENCY_CAP)
  assert.equal(freezeEffective(loaded.options).concurrency, 8)
})

test("overlay merge wins after loadOptions and is not a persist-by-itself refresh", () => {
  const loaded = loadOptions({ concurrency: 8, maxAgents: 200, timeoutMs: 3_600_000, permissions: "ask" })
  const overlay = parseSettingsOverlay({ concurrency: 3, permissions: "noEditTools", unknown: true })
  const merged = applyOverlay(loaded.options, overlay)
  assert.equal(merged.concurrency, 3)
  assert.equal(merged.maxAgents, 200)
  assert.equal(merged.permissions, "noEditTools")
  assert.equal(loaded.options.concurrency, 8)
  assert.equal(loaded.options.permissions, "ask")
})

test("persist-without-refresh does not change the next snapshot", () => {
  const loaded = loadOptions({ concurrency: 4, timeoutMs: 600_000 })
  let holder = { ...loaded.options }
  const overlay = { concurrency: 2, timeoutMs: 1_800_000 }
  // KV write alone:
  const persisted = parseSettingsOverlay(overlay)
  assert.equal(freezeEffective(holder).concurrency, 4)
  // explicit refresh:
  holder = applyOverlay(loaded.options, persisted)
  assert.equal(freezeEffective(holder).concurrency, 2)
  assert.equal(freezeEffective(holder).timeoutMs, 1_800_000)
})

test("KV-only persist without refreshDefaults cannot change the next freezeEffective snapshot", () => {
  const baseOptions = loadOptions({ concurrency: 4, timeoutMs: 600_000 }).options
  let overlay = parseSettingsOverlay({})
  let options = applyOverlay(baseOptions, overlay)
  const refreshDefaults = (nextOverlay: ReturnType<typeof parseSettingsOverlay>) => {
    overlay = nextOverlay
    options = applyOverlay(baseOptions, overlay)
    return options
  }
  const kvOnly = parseSettingsOverlay({ concurrency: 2, timeoutMs: 1_800_000 })
  assert.equal(freezeEffective(options).concurrency, 4)
  assert.equal(freezeEffective(options).timeoutMs, 600_000)
  refreshDefaults(kvOnly)
  assert.equal(freezeEffective(options).concurrency, 2)
  assert.equal(freezeEffective(options).timeoutMs, 1_800_000)
})

test("set parse/clamp: concurrency 1–8, unknown keys ignored", () => {
  const current = panelSettingsFrom(DEFAULT_OPTIONS)
  assert.deepEqual(parseSetArgs("concurrency 4"), { key: "concurrency", value: "4" })
  const bumped = applySetValue(current, "concurrency", "64")
  assert.notEqual(bumped, "ignored")
  if (bumped !== "ignored") assert.equal(bumped.concurrency, 8)
  const low = applySetValue(current, "concurrency", "0")
  if (low !== "ignored") assert.equal(low.concurrency, 1)
  assert.equal(applySetValue(current, "sizeGuideline", "1"), "ignored")
  assert.equal(applySetValue(current, "concurrency", "nope"), "ignored")
})

test("stepPanelSetting cycles timeout and permissions", () => {
  const current = panelSettingsFrom(DEFAULT_OPTIONS)
  const up = stepPanelSetting(current, "timeoutMs", 1)
  assert.equal(up.timeoutMs, 600_000)
  const perm = stepPanelSetting(current, "permissions", 1)
  assert.equal(perm.permissions, "autoEditsWorkflow")
  const agents = stepPanelSetting(current, "maxAgents", 1)
  assert.equal(agents.maxAgents, 210)
})

test("permission hook: ask delegates; noEditTools denies edits", () => {
  assert.equal(permissionHookDecision("ask", "edit"), "delegate")
  assert.equal(permissionHookDecision(undefined, "edit"), "delegate")
  assert.equal(permissionHookDecision("noEditTools", "edit"), "deny")
  assert.equal(permissionHookDecision("noEditTools", "read"), "ignore")
  assert.equal(permissionHookDecision("autoEditsWorkflow", "write"), "contain")
})

test("remainingTimeoutMs uses the frozen timeout, not a mutated shared value", () => {
  const snap = freezeEffective({ ...DEFAULT_OPTIONS, timeoutMs: 5_000 })
  const shared = { ...DEFAULT_OPTIONS, timeoutMs: 10 }
  const startedAt = 1_000
  const left = remainingTimeoutMs(snap.timeoutMs, startedAt, 0, false, undefined, startedAt + 100)
  assert.equal(left, 4_900)
  const mutated = remainingTimeoutMs(shared.timeoutMs, startedAt, 0, false, undefined, startedAt + 100)
  assert.equal(mutated, -90)
  assert.equal(Object.isFrozen(snap), true)
})

test("permission hook at ask: child of ask snapshot leaves effect unset; next noEditTools run denies", () => {
  const registry = new FakeRegistry()
  const askRun = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  askRun.effective = { concurrency: 8, maxAgents: 200, timeoutMs: 3_600_000, permissions: "ask" }
  registry.markOwned(askRun.id, "ses_ask_child")
  const askEvent: { sessionID: string; action: string; effect?: string; message?: string } = {
    sessionID: "ses_ask_child",
    action: "edit",
  }
  const askDecision = evaluateOwnedPermission(askEvent, registry)
  assert.equal(askDecision, "delegate")
  assert.equal(askEvent.effect, undefined)
  assert.equal(askEvent.message, undefined)

  registry.setStatus(askRun.id, "succeeded")
  const denyRun = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  denyRun.effective = { concurrency: 8, maxAgents: 200, timeoutMs: 3_600_000, permissions: "noEditTools" }
  registry.markOwned(denyRun.id, "ses_deny_child")
  const denyEvent: { sessionID: string; action: string; effect?: string; message?: string } = {
    sessionID: "ses_deny_child",
    action: "edit",
  }
  const denyDecision = evaluateOwnedPermission(denyEvent, registry)
  assert.equal(denyDecision, "deny")
  assert.equal(denyEvent.effect, "deny")
})

test("permission hook is registered even when setup-time mode is ask", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(src, /permission\.hook\("evaluate"/)
  assert.equal(/if\s*\(\s*options\.permissions\s*!==\s*"ask"\s*\)/.test(src), false)
  assert.match(src, /evaluateOwnedPermission/)
})
