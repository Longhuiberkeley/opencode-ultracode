/**
 * Pure tool-event reducer: family names, dedupe on data.id per session.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { emptyToolEventState, reduceToolEvent, toolCallsFor } from "../src/run-events.ts"
import { fakeToolEvent } from "./fakes.ts"

test("run-events: counts unique ids; duplicate data.id counted once", () => {
  const state = emptyToolEventState()
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_a", "call_1"))
  reduceToolEvent(state, fakeToolEvent("session.tool.success", "ses_a", "call_1"))
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_a", "call_2"))
  reduceToolEvent(state, fakeToolEvent("session.tool.failed", "ses_a", "call_2"))
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_a", "call_1")) // dup
  assert.equal(toolCallsFor(state, "ses_a"), 2)
})

test("run-events: unknown session ignored; missing sessionID/id ignored", () => {
  const state = emptyToolEventState()
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_a", "call_1"))
  reduceToolEvent(state, fakeToolEvent("session.tool.called", undefined, "call_x"))
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_a", undefined))
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "", "call_y"))
  reduceToolEvent(state, { type: "session.tool.called" })
  reduceToolEvent(state, fakeToolEvent("session.tool.progress", "ses_a", "call_p"))
  reduceToolEvent(state, fakeToolEvent("session.created", "ses_a", "call_z"))
  assert.equal(toolCallsFor(state, "ses_a"), 1)
  assert.equal(toolCallsFor(state, "ses_unknown"), 0)
})

test("run-events: sessions are counted independently", () => {
  const state = emptyToolEventState()
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_a", "call_1"))
  reduceToolEvent(state, fakeToolEvent("session.tool.called", "ses_b", "call_1"))
  assert.equal(toolCallsFor(state, "ses_a"), 1)
  assert.equal(toolCallsFor(state, "ses_b"), 1)
})
