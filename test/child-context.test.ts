import assert from "node:assert/strict"
import { test } from "node:test"
import {
  childLimitFor,
  estimateAndRecordRequestInput,
  estimateRequestInput,
  estimateRequestInputFor,
  parseChildLimits,
  recordContextCalibration,
  recordMeasuredContext,
} from "../src/child-context.ts"

test("context limits apply only to named models; variant overrides base", () => {
  const limits = parseChildLimits({
    "xiaomi/mimo-v2.6-pro": { targetInput: 250000, hardInput: 300000 },
    "xiaomi/mimo-v2.6-pro#high": { targetInput: 200000, hardInput: 280000 },
  })
  assert.equal(childLimitFor({ providerID: "xiaomi", id: "mimo-v2.6-pro" }, limits)?.hardInput, 300000)
  assert.equal(childLimitFor({ providerID: "xiaomi", id: "mimo-v2.6-pro", variant: "high" }, limits)?.hardInput, 280000)
  assert.equal(childLimitFor({ providerID: "openai", id: "gpt-6-sol" }, limits), undefined)
  assert.ok(estimateRequestInput([{ type: "text", text: "hello" }], [], {}) > 0)
  assert.throws(() => parseChildLimits({ "xiaomi/flash": { targetInput: 300000, hardInput: 250000 } }), /require integer/)
})

// Calibration fixture: ASCII only, so the serialized byte count is stable.
const calSystem = [{ type: "text", text: "system prompt" }]
const calMessages = [{ role: "user", content: [{ type: "text", text: "hello world" }] }]
const calTools = { read: { description: "read a file", input: { type: "object" } } }
const CAL_BYTES = Buffer.byteLength(JSON.stringify([calSystem, calMessages, calTools]), "utf8")

test("context calibration: unmeasured pins keep the /3 default", () => {
  assert.equal(
    estimateRequestInputFor("acme/unmeasured", calSystem, calMessages, calTools),
    estimateRequestInput(calSystem, calMessages, calTools),
  )
})

test("context calibration: a recorded sample moves the divisor to its measured ratio", () => {
  recordContextCalibration("acme/measured-half", CAL_BYTES / 2, CAL_BYTES)
  assert.equal(
    estimateRequestInputFor("acme/measured-half", calSystem, calMessages, calTools),
    Math.ceil(CAL_BYTES / 2),
  )
})

test("context calibration: samples fold into a bounded running mean", () => {
  recordContextCalibration("acme/folded", CAL_BYTES / 2, CAL_BYTES)
  recordContextCalibration("acme/folded", CAL_BYTES / 6, CAL_BYTES)
  // (1/2 + 1/6) / 2 = 1/3 — the default divisor reached by measurement, not fallback.
  assert.equal(
    estimateRequestInputFor("acme/folded", calSystem, calMessages, calTools),
    estimateRequestInput(calSystem, calMessages, calTools),
  )
})

test("context calibration: out-of-bound samples clamp to [1/6, 1/2]", () => {
  recordContextCalibration("acme/over", CAL_BYTES * 10, CAL_BYTES)
  assert.equal(
    estimateRequestInputFor("acme/over", calSystem, calMessages, calTools),
    Math.ceil(CAL_BYTES / 2),
  )
  recordContextCalibration("acme/under", 1, CAL_BYTES)
  assert.equal(
    estimateRequestInputFor("acme/under", calSystem, calMessages, calTools),
    Math.ceil(CAL_BYTES / 6),
  )
})

test("context calibration: the hook's stored bytes feed the measurement that lands later", () => {
  const pin = "acme/bridged"
  assert.equal(
    estimateAndRecordRequestInput("ses_cc_bridge", pin, calSystem, calMessages, calTools),
    estimateRequestInput(calSystem, calMessages, calTools),
  )
  recordMeasuredContext("ses_cc_bridge", pin, CAL_BYTES / 2)
  assert.equal(
    estimateRequestInputFor(pin, calSystem, calMessages, calTools),
    Math.ceil(CAL_BYTES / 2),
  )
})

test("context calibration: a pin mismatch consumes without folding", () => {
  const pin = "acme/mismatch"
  estimateAndRecordRequestInput("ses_cc_mismatch", pin, calSystem, calMessages, calTools)
  recordMeasuredContext("ses_cc_mismatch", "acme/other", CAL_BYTES / 2)
  assert.equal(
    estimateRequestInputFor(pin, calSystem, calMessages, calTools),
    estimateRequestInput(calSystem, calMessages, calTools),
  )
})

test("context calibration: a stale fallback measurement consumes without folding", () => {
  const pin = "acme/stale"
  estimateAndRecordRequestInput("ses_cc_stale", pin, calSystem, calMessages, calTools)
  // Usage fell back to an earlier request than the bytes describe: skip the fold.
  recordMeasuredContext("ses_cc_stale", pin, CAL_BYTES / 2, true)
  assert.equal(
    estimateRequestInputFor(pin, calSystem, calMessages, calTools),
    estimateRequestInput(calSystem, calMessages, calTools),
  )
  // The pending bytes were still consumed; a later FRESH measurement folds normally.
  estimateAndRecordRequestInput("ses_cc_stale", pin, calSystem, calMessages, calTools)
  recordMeasuredContext("ses_cc_stale", pin, CAL_BYTES / 2)
  assert.equal(
    estimateRequestInputFor(pin, calSystem, calMessages, calTools),
    Math.ceil(CAL_BYTES / 2),
  )
})

test("context calibration: a re-touched active session survives the oldest-first trim (LRU)", () => {
  const pin = "acme/lru"
  for (let i = 0; i < 64; i++) {
    estimateAndRecordRequestInput(`ses_cc_lru_${i}`, pin, calSystem, calMessages, calTools)
  }
  // Re-touch the OLDEST entry, then push 63 more hook passes through the cap.
  estimateAndRecordRequestInput("ses_cc_lru_0", pin, calSystem, calMessages, calTools)
  for (let i = 64; i < 127; i++) {
    estimateAndRecordRequestInput(`ses_cc_lru_${i}`, pin, calSystem, calMessages, calTools)
  }
  // Without the delete-then-set touch, ses_cc_lru_0 would have been evicted
  // first (plain Map.set keeps the original insertion position) and its
  // measurement would silently teach nothing.
  recordMeasuredContext("ses_cc_lru_0", pin, CAL_BYTES / 2)
  assert.equal(
    estimateRequestInputFor(pin, calSystem, calMessages, calTools),
    Math.ceil(CAL_BYTES / 2),
  )
})
