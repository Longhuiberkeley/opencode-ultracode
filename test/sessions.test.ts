/**
 * Builder B tests — sessions: the verified runAgent sequence against
 * FakeSessionCtx (happy path, fail-fast, outcome errors, schema repair,
 * abort -> interrupt).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createSessionDriver } from "../src/sessions.ts"
import { AgentCallError } from "../src/sessions.ts"
import { FakeSessionCtx } from "./fakes.ts"
import type { ScriptedReply } from "./fakes.ts"
import type { TokenUsage } from "../src/types.ts"
import type { AgentRunInput, SessionDriver } from "../src/sessions.ts"

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

const TOKENS: TokenUsage = { input: 100, output: 20, reasoning: 3, cache: { read: 40, write: 0 } }

function makeDriver(replies: ScriptedReply[] = []): { fake: FakeSessionCtx; driver: SessionDriver } {
  const fake = new FakeSessionCtx()
  for (const reply of replies) fake.push(reply)
  const driver = createSessionDriver(fake)
  return { fake, driver }
}

function hooks(onSessionID: (id: string) => void = () => {}, signal: AbortSignal = new AbortController().signal) {
  return { onSessionID, signal }
}

function input(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return { prompt: "say hi", defaultAgent: "general", ...overrides }
}

// ---------------------------------------------------------------------------

test("runAgent: happy path — create, register sessionID immediately, extract text/model/tokens", async () => {
  const { fake, driver } = makeDriver([
    { text: "hello world", agent: "general", model: { providerID: "openrouter", id: "m/1" }, tokens: TOKENS },
  ])
  const seen: string[] = []
  const result = await driver.runAgent(input({ label: "greeter" }), ["general", "explore"], hooks((id) => seen.push(id)))

  assert.equal(seen.length, 1)
  assert.equal(result.sessionID, seen[0])
  assert.equal(result.text, "hello world")
  assert.equal(result.agent, "general")
  assert.deepEqual(result.model, { providerID: "openrouter", id: "m/1" })
  assert.deepEqual(result.tokens, TOKENS)

  const session = fake.sessions.get(result.sessionID)
  assert.ok(session)
  assert.equal(session.title, "greeter")
  assert.equal(session.agent, "general")
  assert.equal(session.prompts, 1)
})

test("runAgent: title falls back label -> phase -> 'workflow agent'", async () => {
  const a = makeDriver([{ text: "x" }])
  await a.driver.runAgent(input({ phase: "extract" }), ["general"], hooks())
  assert.equal([...a.fake.sessions.values()][0].title, "extract")

  const b = makeDriver([{ text: "x" }])
  await b.driver.runAgent(input(), ["general"], hooks())
  assert.equal([...b.fake.sessions.values()][0].title, "workflow agent")
})

test("runAgent: unknown explicit agent fails fast, listing available agents, no session created", async () => {
  const { fake, driver } = makeDriver()
  await assert.rejects(
    driver.runAgent(input({ agent: "nope" }), ["general", "explore"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "agent" &&
      /unknown agent "nope"/.test(err.message) &&
      /available agents: general, explore/.test(err.message),
  )
  assert.equal(fake.sessions.size, 0)
})

test("runAgent: missing default agent fails fast with guidance", async () => {
  const { fake, driver } = makeDriver()
  await assert.rejects(
    driver.runAgent(input({ defaultAgent: "missing" }), ["general", "explore"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "agent" &&
      /default agent "missing" is not available/.test(err.message),
  )
  assert.equal(fake.sessions.size, 0)
})

test("runAgent: agent validation skipped when availableAgents is undefined", async () => {
  const { driver } = makeDriver([{ text: "ok" }])
  const result = await driver.runAgent(input({ agent: "anything" }), undefined, hooks())
  assert.equal(result.text, "ok")
})

test("runAgent: outcome !== succeeded => typed error carrying extracted text", async () => {
  const { fake, driver } = makeDriver([{ text: "I could not do it", outcome: "failed" }])
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "outcome" &&
      /outcome "failed"/.test(err.message) &&
      /I could not do it/.test(err.message) &&
      err.text === "I could not do it",
  )
  assert.equal(fake.sessions.size, 1)
})

test("runAgent: interrupted outcome => error too", async () => {
  const { driver } = makeDriver([{ text: "partial", outcome: "interrupted" }])
  await assert.rejects(driver.runAgent(input(), ["general"], hooks()), /outcome "interrupted"/)
})

test("runAgent: happy path extracts the last assistant text", async () => {
  const { driver } = makeDriver([{ text: "first" }])
  const result = await driver.runAgent(input(), ["general"], hooks())
  assert.equal(result.text, "first")
})

test("text extraction: concatenated multi-part text parts (verified rule)", async () => {
  const { assistantText } = await import("../src/sessions.ts")
  const message = {
    id: "msg_x",
    type: "assistant" as const,
    content: [
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "part one " },
      { type: "text", text: "part two" },
      { type: "tool", text: "ignored" },
    ],
  }
  assert.equal(assistantText(message), "part one part two")
  assert.equal(assistantText(undefined), "")
  assert.equal(assistantText({ id: "m", type: "assistant", text: "flat" }), "flat")
})

// ---------------------------------------------------------------------------
// Schema mode
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: "object",
  required: ["answer"],
  properties: { answer: { type: "string" } },
}

test("runAgent: schema mode — valid JSON on first reply (no repair)", async () => {
  const { fake, driver } = makeDriver([{ text: '{"answer": "42"}' }])
  const result = await driver.runAgent(input({ prompt: "extract", schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "42" })
  const session = [...fake.sessions.values()][0]
  assert.equal(session.prompts, 1)
  // The prompt carries the strict JSON instruction + the schema.
  const userMsg = session.messages.find((m) => m.type === "user")
  assert.ok(userMsg)
  assert.match(userMsg.text ?? "", /Respond with ONLY a JSON value matching this JSON schema/)
  assert.match(userMsg.text ?? "", /"required":\["answer"\]/)
})

test("runAgent: schema mode — one repair round (bad reply then good)", async () => {
  const { fake, driver } = makeDriver([{ text: "sure! the answer is forty-two" }, { text: '{"answer": "42"}' }])
  const result = await driver.runAgent(input({ prompt: "extract", schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "42" })
  const session = [...fake.sessions.values()][0]
  assert.equal(session.prompts, 2)
  const repairMsg = session.messages.filter((m) => m.type === "user")[1]
  assert.ok(repairMsg)
  assert.match(repairMsg.text ?? "", /not a valid JSON value/)
  assert.match(repairMsg.text ?? "", /Output only the corrected JSON/)
})

test("runAgent: schema mode — fenced JSON accepted without repair", async () => {
  const { fake, driver } = makeDriver([{ text: '```json\n{"answer": "ok"}\n```' }])
  const result = await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "ok" })
  assert.equal([...fake.sessions.values()][0].prompts, 1)
})

test("runAgent: schema mode — still invalid after repair => typed schema error", async () => {
  const { fake, driver } = makeDriver([{ text: "nope" }, { text: '{"wrong": 1}' }])
  await assert.rejects(
    driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "schema" &&
      /still invalid after repair/.test(err.message) &&
      /missing required property "answer"/.test(err.message),
  )
  const session = [...fake.sessions.values()][0]
  assert.equal(session.prompts, 2) // exactly one repair round, no third prompt
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test("runAgent: abort mid-wait => interrupt recorded + typed abort error", async () => {
  const { fake, driver } = makeDriver([{ text: "slow reply" }])
  fake.hangWait = true
  const ctrl = new AbortController()
  let sessionID = ""
  const pending = driver.runAgent(input(), ["general"], hooks((id) => (sessionID = id), ctrl.signal))
  await tick(20) // prompt in flight, wait hanging
  ctrl.abort()
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof AgentCallError && err.kind === "abort" && /run stopping/.test(err.message),
  )
  assert.deepEqual(fake.interrupts, [sessionID])
})

test("runAgent: abort right after create => interrupt + abort error before prompt", async () => {
  const { fake, driver } = makeDriver([{ text: "x" }])
  const ctrl = new AbortController()
  let sessionID = ""
  const pending = driver.runAgent(input(), ["general"], {
    onSessionID: (id) => {
      sessionID = id
      ctrl.abort()
    },
    signal: ctrl.signal,
  })
  await assert.rejects(pending, (err: unknown) => err instanceof AgentCallError && err.kind === "abort")
  assert.deepEqual(fake.interrupts, [sessionID])
  const session = fake.sessions.get(sessionID)
  assert.ok(session)
  assert.equal(session.prompts, 0) // aborted before any prompt
})

test("runAgent: no interrupt when the run completes before abort", async () => {
  const { fake, driver } = makeDriver([{ text: "fast" }])
  const ctrl = new AbortController()
  const result = await driver.runAgent(input(), ["general"], hooks(() => {}, ctrl.signal))
  ctrl.abort() // after completion: no effect
  assert.equal(result.text, "fast")
  assert.deepEqual(fake.interrupts, [])
})
