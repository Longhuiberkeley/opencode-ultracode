import assert from "node:assert/strict"
import { test } from "node:test"
import { childLimitFor, estimateRequestInput, parseChildLimits } from "../src/child-context.ts"

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
