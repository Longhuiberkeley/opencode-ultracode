/**
 * Builder B tests — sessions: the verified runAgent sequence against
 * FakeSessionCtx (happy path, fail-fast, outcome errors, schema repair,
 * abort -> interrupt).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createSessionDriver, buildChildTitle, parseChildTitle, describeSessionFailure, buildContinuationPrompt, SCHEMA_REPAIR_ROUNDS, INTERRUPT_CONFIRM_MS, SALVAGE_CONTEXT_MS, SESSION_CONTROL_TIMEOUT_MS } from "../src/sessions.ts"
import { AgentCallError, RunClosedError } from "../src/sessions.ts"
import { FakeSessionCtx } from "./fakes.ts"
import type { ScriptedReply } from "./fakes.ts"
import type { ContextMessage, SessionCtx, TokenUsage } from "../src/types.ts"
import type { AgentRunInput, SessionDriver } from "../src/sessions.ts"

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Bound a deadline test so a missed timer fails fast instead of hanging the suite. */
function rejectSoon<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline test exceeded ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

const TOKENS: TokenUsage = { input: 100, output: 20, reasoning: 3, cache: { read: 40, write: 0 } }

function makeDriver(replies: ScriptedReply[] = []): { fake: FakeSessionCtx; driver: Required<SessionDriver> } {
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
  // The final assistant message exposes usage => requestTokens come from it,
  // so the sample is not stale (calibration may fold it).
  assert.deepEqual(result.requestTokens, TOKENS)
  assert.equal(result.requestTokensStale, undefined)

  const session = fake.sessions.get(result.sessionID)
  assert.ok(session)
  assert.equal(session.title, "greeter")
  assert.equal(session.agent, "general")
  assert.equal(session.prompts, 1)
})

test("runAgent: title falls back label -> phase -> 'agent'", async () => {
  const a = makeDriver([{ text: "x" }])
  await a.driver.runAgent(input({ phase: "extract" }), ["general"], hooks())
  assert.equal([...a.fake.sessions.values()][0].title, "extract")

  const b = makeDriver([{ text: "x" }])
  await b.driver.runAgent(input(), ["general"], hooks())
  assert.equal([...b.fake.sessions.values()][0].title, "agent")
})

test("runAgent: titles carry the [uc:<runID> <ord> <phase>] prefix", async () => {
  const a = makeDriver([{ text: "x" }])
  await a.driver.runAgent(
    input({ label: "seeker", runID: "run_ab12cd34efgh", ord: "a1", parentSessionID: "ses_parent" }),
    ["general"],
    hooks(),
  )
  assert.equal([...a.fake.sessions.values()][0].title, "[uc:run_ab12cd34efgh a1 p:ses_parent] seeker")

  const b = makeDriver([{ text: "x" }])
  await b.driver.runAgent(
    input({ phase: "extract", runID: "run_ab12cd34efgh", ord: "a1", parentSessionID: "ses_parent" }),
    ["general"],
    hooks(),
  )
  assert.equal([...b.fake.sessions.values()][0].title, "[uc:run_ab12cd34efgh a1 extract p:ses_parent] extract")

  const c = makeDriver([{ text: "x" }])
  await c.driver.runAgent(
    input({ runID: "run_ab12cd34efgh", ord: "a1", parentSessionID: "ses_parent" }),
    ["general"],
    hooks(),
  )
  assert.equal([...c.fake.sessions.values()][0].title, "[uc:run_ab12cd34efgh a1 p:ses_parent] agent")

  const e = makeDriver([{ text: "x" }])
  await e.driver.runAgent(
    input({
      label: "seeker",
      phase: "extract",
      runID: "run_ab12cd34efgh",
      ord: "a2",
      parentSessionID: "ses_parent",
    }),
    ["general"],
    hooks(),
  )
  assert.equal([...e.fake.sessions.values()][0].title, "[uc:run_ab12cd34efgh a2 extract p:ses_parent] seeker")

  // No runID (direct driver use): plain title.
  const d = makeDriver([{ text: "x" }])
  await d.driver.runAgent(input({ label: "solo" }), ["general"], hooks())
  assert.equal([...d.fake.sessions.values()][0].title, "solo")
})

test("buildChildTitle / parseChildTitle round-trip + legacy parse", () => {
  const full = buildChildTitle({
    runID: "run_abc123def456",
    ord: "a3",
    phase: "extract",
    label: "seeker",
    parentSessionID: "ses_parent",
  })
  assert.equal(full, "[uc:run_abc123def456 a3 extract p:ses_parent] seeker")
  assert.deepEqual(parseChildTitle(full), {
    runID: "run_abc123def456",
    ord: "a3",
    phase: "extract",
    label: "seeker",
    parent: "ses_parent",
  })

  const noPhase = buildChildTitle({
    runID: "run_abc123def456",
    ord: "a1",
    label: "probe",
    parentSessionID: "ses_parent",
  })
  assert.equal(noPhase, "[uc:run_abc123def456 a1 p:ses_parent] probe")
  assert.deepEqual(parseChildTitle(noPhase), {
    runID: "run_abc123def456",
    ord: "a1",
    phase: undefined,
    label: "probe",
    parent: "ses_parent",
  })

  const noParent = buildChildTitle({ runID: "run_abc123def456", ord: "a1", label: "probe" })
  assert.equal(noParent, "[uc:run_abc123def456 a1] probe")
  assert.deepEqual(parseChildTitle(noParent), {
    runID: "run_abc123def456",
    ord: "a1",
    phase: undefined,
    label: "probe",
    parent: undefined,
  })

  // Legacy `[uc:<tag>] label` — runID=tag, ord/phase/parent undefined.
  assert.deepEqual(parseChildTitle("[uc:ab12cd34] seeker"), {
    runID: "ab12cd34",
    ord: undefined,
    phase: undefined,
    label: "seeker",
    parent: undefined,
  })
  assert.equal(parseChildTitle("plain title"), undefined)
})

test("runAgent: stamps D12 metadata on create (never read back)", async () => {
  const { fake, driver } = makeDriver([{ text: "x" }])
  await driver.runAgent(
    input({
      label: "seeker",
      phase: "extract",
      runID: "run_x",
      ord: "a1",
      parentSessionID: "ses_p",
      workflowName: "demo",
    }),
    ["general"],
    hooks(),
  )
  const session = [...fake.sessions.values()][0]
  assert.deepEqual(session.metadata, {
    uc: { v: 1, run: "run_x", ord: "a1", phase: "extract", label: "seeker", wf: "demo", parent: "ses_p" },
  })
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

// ---------------------------------------------------------------------------
// Request-token resolution (most recent assistant message exposing usage)
// ---------------------------------------------------------------------------

test("runAgent: no assistant message exposes usage => requestTokens stays undefined", async () => {
  const { driver } = makeDriver([{ text: "no usage here" }])
  const result = await driver.runAgent(input(), ["general"], hooks())
  assert.equal(result.text, "no usage here")
  assert.equal(result.requestTokens, undefined)
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

test("runAgent: schema repair refreshes text/model/tokens from the REPAIRED response", async () => {
  const { driver } = makeDriver([
    {
      text: "not json at all",
      model: { providerID: "p", id: "attempt-1" },
      tokens: { input: 11, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    {
      text: '{"answer": "42"}',
      model: { providerID: "p", id: "attempt-2" },
      tokens: { input: 99, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ])
  const result = await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "42" })
  // .text/.model/.tokens must describe attempt 2, consistent with .data:
  assert.equal(result.text, '{"answer": "42"}')
  assert.deepEqual(result.model, { providerID: "p", id: "attempt-2" })
  assert.deepEqual(result.tokens, { input: 99, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
  // The repaired reply exposes usage => requestTokens describe it, like .tokens.
  assert.deepEqual(result.requestTokens, { input: 99, output: 5, reasoning: 0, cache: { read: 0, write: 0 } })
  assert.equal(result.requestTokensStale, undefined)
})

test("runAgent: schema repair — repaired reply without usage keeps requestTokens from the latest reply that exposed it", async () => {
  const attempt1: TokenUsage = { input: 11, output: 7, reasoning: 1, cache: { read: 5, write: 2 } }
  const { driver } = makeDriver([
    { text: "not json at all", tokens: attempt1 },
    { text: '{"answer": "42"}' }, // repaired reply exposes no usage
  ])
  const result = await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "42" })
  // .tokens stays session-cumulative (the fake's session total is attempt1).
  assert.deepEqual(result.tokens, attempt1)
  // .requestTokens fall back past the usage-less repaired reply, marked stale
  // so calibration never pairs the older usage with the repaired request bytes.
  assert.deepEqual(result.requestTokens, attempt1)
  assert.equal(result.requestTokensStale, true)
})

test("runAgent: schema mode — valid first reply keeps attempt-1 metadata", async () => {
  const { driver } = makeDriver([
    {
      text: '{"answer": "42"}',
      model: { providerID: "p", id: "only-attempt" },
      tokens: { input: 4, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ])
  const result = await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "42" })
  assert.equal(result.text, '{"answer": "42"}')
  assert.deepEqual(result.model, { providerID: "p", id: "only-attempt" })
})

test("runAgent: schema mode — fenced JSON accepted without repair", async () => {
  const { fake, driver } = makeDriver([{ text: '```json\n{"answer": "ok"}\n```' }])
  const result = await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "ok" })
  assert.equal([...fake.sessions.values()][0].prompts, 1)
})

test("runAgent: schema mode — both repair rounds invalid => typed schema error naming the round count", async () => {
  // The fake repeats its last queued reply once the queue is down to one, so
  // every repair round fails with the same schema-invalid JSON.
  const { fake, driver } = makeDriver([{ text: "nope" }, { text: '{"wrong": 1}' }])
  await assert.rejects(
    driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "schema" &&
      /structured output repair failed after 2 rounds/.test(err.message) &&
      /missing required property "answer"/.test(err.message),
  )
  const session = [...fake.sessions.values()][0]
  // first prompt + the bounded repair rounds — never an unbounded loop.
  assert.equal(session.prompts, 1 + SCHEMA_REPAIR_ROUNDS)
})

test("runAgent: schema mode — a second repair round can still rescue the call", async () => {
  const { fake, driver } = makeDriver([
    { text: "not json at all" },
    { text: '{"wrong": 1}' },
    { text: '{"answer": "42"}', model: { providerID: "p", id: "repair-2" } },
  ])
  const result = await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(result.data, { answer: "42" }) // repaired: true — text/model come from the FINAL repaired reply.
  assert.equal(result.text, '{"answer": "42"}')
  assert.deepEqual(result.model, { providerID: "p", id: "repair-2" })
  const session = [...fake.sessions.values()][0]
  assert.equal(session.prompts, 3, "initial prompt + two repair rounds")
  const repairMsgs = session.messages.filter((m) => m.type === "user").slice(1)
  assert.equal(repairMsgs.length, 2)
  // Round 1 keeps the established repair prompt; round 2 escalates.
  assert.match(repairMsgs[0]!.text ?? "", /not a valid JSON value/)
  assert.doesNotMatch(repairMsgs[0]!.text ?? "", /no trailing commas/)
  // Each repair prompt carries the LATEST problem, not the first one.
  assert.match(repairMsgs[1]!.text ?? "", /missing required property "answer"/)
  assert.match(
    repairMsgs[1]!.text ?? "",
    /Start your reply with \{ or \[ and end with the matching closing bracket\. No prose, no markdown fences, no trailing commas, no comments\./,
  )
})

test("runAgent: schema mode — scalar schema escalates with bare-value guidance, not brackets", async () => {
  // A top-level scalar schema must NOT be pushed toward { / [ on the escalated
  // round — a bare value ("42") is the valid shape and must rescue the call.
  const { fake, driver } = makeDriver([
    { text: "the answer is forty-two" },
    { text: "still not a number" },
    { text: "42" },
  ])
  const result = await driver.runAgent(
    input({ prompt: "extract", schema: { type: "number" } }),
    ["general"],
    hooks(),
  )
  assert.deepEqual(result.data, 42)
  const session = [...fake.sessions.values()][0]
  assert.equal(session.prompts, 3, "initial prompt + two repair rounds")
  const escalated = session.messages.filter((m) => m.type === "user")[2]
  assert.ok(escalated)
  assert.match(escalated.text ?? "", /bare JSON value only/)
  assert.doesNotMatch(escalated.text ?? "", /Start your reply with \{ or \[/)
})

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test("runAgent: abort mid-wait => interrupt recorded + typed abort error", async () => {
  const { fake, driver } = makeDriver([{ text: "slow reply" }])
  fake.hangWait = true
  const ctrl = new AbortController()
  let sessionID = ""
  const started = Date.now()
  const pending = driver.runAgent(input(), ["general"], hooks((id) => (sessionID = id), ctrl.signal))
  await tick(20) // prompt in flight, wait hanging
  ctrl.abort()
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof AgentCallError && err.kind === "abort" && /run stopping/.test(err.message),
  )
  // Default confirm is 3s. Abort must not use that helper.
  assert.ok(Date.now() - started < 400, "abort mid-wait must not wait the interrupt confirm bound")
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

test("runAgent: rejected registration (run closed) => interrupt + RunClosedError before any prompt", async () => {
  const { fake, driver } = makeDriver([{ text: "never used" }])
  await assert.rejects(
    driver.runAgent(input(), ["general"], {
      signal: new AbortController().signal,
      onSessionID: () => "rejected" as const,
    }),
    (err: unknown) =>
      err instanceof RunClosedError &&
      err.kind === "abort" &&
      /run closed while this agent was being created/.test(err.message),
  )
  const session = [...fake.sessions.values()][0]
  assert.equal(session.prompts, 0) // never prompted
  assert.deepEqual(fake.interrupts, [session.id]) // interrupted best-effort
})

test("runAgent: accepted registration proceeds normally", async () => {
  const { fake, driver } = makeDriver([{ text: "ok" }])
  const registrations: Array<"accepted" | "rejected" | void> = []
  const result = await driver.runAgent(input(), ["general"], {
    signal: new AbortController().signal,
    onSessionID: (id) => {
      registrations.push(undefined)
      void id
    },
  })
  assert.equal(result.text, "ok")
  assert.deepEqual(registrations, [undefined])
  assert.equal(fake.interrupts.length, 0)
})

// ---------------------------------------------------------------------------
// Extraction honesty (succeeded outcome must yield a real assistant reply)
// ---------------------------------------------------------------------------

function makeMinimalSessions(overrides: {
  outcome?: string
  context: () => Promise<ReadonlyArray<ContextMessage>>
}): SessionCtx {
  const base = new FakeSessionCtx()
  return {
    create: async (i) => base.create(i),
    get: async () => ({ id: "ses_min", outcome: overrides.outcome ?? "succeeded" }),
    prompt: async () => ({ id: "msg_min" }),
    wait: async () => {},
    context: overrides.context,
    interrupt: async () => {},
  }
}

test("runAgent: succeeded outcome + context fetch failure => typed extraction error", async () => {
  const sessions = makeMinimalSessions({
    context: async () => {
      throw new Error("context backend down")
    },
  })
  const driver = createSessionDriver(sessions)
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "extraction" &&
      /failed to read session context: context backend down/.test(err.message),
  )
})

test("runAgent: succeeded outcome + no assistant message => typed extraction error", async () => {
  const sessions = makeMinimalSessions({
    context: async () => [{ id: "msg_only_user", type: "user", text: "hello?" }],
  })
  const driver = createSessionDriver(sessions)
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError && err.kind === "extraction" && /no assistant message/.test(err.message),
  )
})

test("runAgent: failed outcome + context failure still reports the outcome error", async () => {
  const sessions = makeMinimalSessions({
    outcome: "failed",
    context: async () => {
      throw new Error("context backend down")
    },
  })
  const driver = createSessionDriver(sessions)
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) => err instanceof AgentCallError && err.kind === "outcome" && /outcome "failed"/.test(err.message),
  )
})

// ---------------------------------------------------------------------------
// Failure-detail enrichment (describeSessionFailure)
// ---------------------------------------------------------------------------

test("describeSessionFailure: server error text, error parts, finish reason — empty when none", () => {
  assert.equal(describeSessionFailure({}, undefined), "")
  assert.equal(describeSessionFailure({ error: "403 quota exceeded" }, undefined), "403 quota exceeded")
  const withErrorPart: ContextMessage = {
    id: "m",
    type: "assistant",
    content: [{ type: "text", text: "partial" }, { type: "error", text: "provider stream aborted" }],
  }
  assert.equal(describeSessionFailure({}, withErrorPart), "provider stream aborted")
  assert.equal(describeSessionFailure({ error: "e1" }, withErrorPart), "e1 | provider stream aborted")
  assert.equal(describeSessionFailure({}, { id: "m", type: "assistant", finish: "length" }), "finish: length")
  assert.equal(describeSessionFailure({}, { id: "m", type: "assistant", finish: "stop" }), "")
})

test("describeSessionFailure: structured message error is surfaced with type/status", () => {
  const structured: ContextMessage = {
    id: "m",
    type: "assistant",
    finish: "error",
    error: { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
  }
  assert.equal(
    describeSessionFailure({}, structured),
    "Rate limit reached for requests (provider.rate-limit, 429)",
  )
  // Type/status only (no message) still surfaces something usable.
  assert.equal(
    describeSessionFailure({}, { id: "m", type: "assistant", error: { type: "provider.rate-limit", status: 429 } }),
    "provider.rate-limit, 429",
  )
})

// ---------------------------------------------------------------------------
// Structured failure classification on thrown AgentCallError
// ---------------------------------------------------------------------------

test("runAgent: failed outcome attaches the burst classification", async () => {
  const { driver } = makeDriver([
    {
      text: "",
      outcome: "failed",
      finish: "error",
      failure: { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
    },
  ])
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.kind, "outcome")
      assert.equal(err.failure?.class, "burst")
      assert.equal(err.failure?.status, 429)
      assert.equal(err.failure?.message, "Rate limit reached for requests")
      assert.equal(err.failure?.resetAt, undefined)
      assert.match(err.message, /Rate limit reached for requests/)
      assert.match(err.message, /provider\.rate-limit/)
      return true
    },
  )
})

test("runAgent: failed outcome classifies a quota message and surfaces resetAt", async () => {
  const reset = Date.now() + 5 * 60 * 60_000
  const stamp = new Date(reset).toISOString().slice(0, 19).replace("T", " ")
  const { driver } = makeDriver([
    {
      text: "",
      outcome: "failed",
      finish: "error",
      failure: {
        type: "provider.rate-limit",
        message: `Usage limit reached for 5 hour. Your limit will reset at ${stamp}`,
        status: 429,
      },
    },
  ])
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.kind, "outcome")
      assert.equal(err.failure?.class, "quota")
      assert.ok(err.failure?.resetAt !== undefined && err.failure.resetAt > Date.now() + 60_000)
      return true
    },
  )
})

test("runAgent: outcome without an error signal is classified 'other' (no string parsing downstream)", async () => {
  const { driver } = makeDriver([{ text: "no output", outcome: "failed" }])
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.failure?.class, "other")
      return true
    },
  )
})

test("runAgent: schema-repair outcome failure carries the classification too", async () => {
  const { driver } = makeDriver([
    { text: "not json at all" },
    {
      text: "",
      outcome: "failed",
      finish: "error",
      failure: { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
    },
  ])
  await assert.rejects(
    driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks()),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.kind, "outcome")
      assert.equal(err.failure?.class, "burst")
      assert.match(err.message, /during schema repair/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// continueAgent — same-session continue (burst retry / failover)
// ---------------------------------------------------------------------------

const CONTINUE_SIGNAL = new AbortController().signal

test("continueAgent: continues the SAME session — no create, history reused, new reply extracted", async () => {
  const { fake, driver } = makeDriver([
    {
      text: "",
      outcome: "failed",
      finish: "error",
      failure: { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
    },
    { text: "recovered", model: { providerID: "openrouter", id: "m/1" }, tokens: TOKENS },
  ])
  await assert.rejects(driver.runAgent(input({ prompt: "do it" }), ["general"], hooks()), /outcome "failed"/)
  const sessionID = [...fake.sessions.keys()][0]!
  const result = await driver.continueAgent(
    { sessionID, continuationPrompt: buildContinuationPrompt("do it", "transient provider rate limit (burst)") },
    { signal: CONTINUE_SIGNAL },
  )
  assert.equal(fake.sessions.size, 1, "continue must never create a session")
  assert.equal(result.sessionID, sessionID)
  assert.equal(result.text, "recovered")
  assert.deepEqual(result.model, { providerID: "openrouter", id: "m/1" })
  const session = fake.sessions.get(sessionID)!
  assert.equal(session.prompts, 2)
  const userMsgs = session.messages.filter((m) => m.type === "user")
  assert.match(userMsgs[1]!.text ?? "", /The previous turn of this session did not complete\./)
  assert.match(userMsgs[1]!.text ?? "", /may be EMPTY/)
  assert.match(userMsgs[1]!.text ?? "", /Original request:\ndo it/)
})

test("continueAgent: usage-less final reply keeps requestTokens from the earlier turn", async () => {
  const earlier: TokenUsage = { input: 50, output: 7, reasoning: 1, cache: { read: 10, write: 2 } }
  const { fake, driver } = makeDriver([
    { text: "first", tokens: earlier },
    { text: "second" }, // continued (final) assistant message exposes no usage
  ])
  const first = await driver.runAgent(input(), ["general"], hooks())
  const result = await driver.continueAgent(
    { sessionID: first.sessionID, continuationPrompt: "keep going" },
    { signal: CONTINUE_SIGNAL },
  )
  assert.equal(result.text, "second")
  // `tokens` stays session-cumulative; requestTokens fall back to the most
  // recent assistant message that exposed usage — flagged stale, because that
  // was an EARLIER turn than the final (usage-less) one.
  assert.deepEqual(result.tokens, earlier)
  assert.deepEqual(result.requestTokens, earlier)
  assert.equal(result.requestTokensStale, true)
  assert.equal(fake.sessions.get(first.sessionID)!.prompts, 2)
})

test("continueAgent: requested model is switched BEFORE the continuation prompt", async () => {
  const { fake, driver } = makeDriver([
    {
      text: "",
      outcome: "failed",
      failure: { type: "provider.rate-limit", message: "Usage limit reached for 5 hour", status: 429 },
    },
    { text: "on the fallback", model: { providerID: "anthropic", id: "claude-x" } },
  ])
  await assert.rejects(driver.runAgent(input(), ["general"], hooks()))
  const sessionID = [...fake.sessions.keys()][0]!
  const result = await driver.continueAgent(
    { sessionID, continuationPrompt: "continue", model: { providerID: "anthropic", id: "claude-x" } },
    { signal: CONTINUE_SIGNAL },
  )
  assert.deepEqual(fake.switches, [
    { sessionID, model: { providerID: "anthropic", id: "claude-x" }, beforePrompt: 1 },
  ])
  assert.equal(result.text, "on the fallback")
  assert.equal(fake.sessions.get(sessionID)!.prompts, 2)
})

test("continueAgent: a requested model without switchModel support fails typed and never prompts", async () => {
  let prompts = 0
  const sessions: SessionCtx = {
    create: async () => ({ id: "ses_min" }),
    get: async () => ({ id: "ses_min", outcome: "succeeded" }),
    prompt: async () => {
      prompts++
      return { id: "msg_min" }
    },
    wait: async () => {},
    context: async () => [],
    interrupt: async () => {},
  }
  const driver = createSessionDriver(sessions)
  await assert.rejects(
    driver.continueAgent(
      { sessionID: "ses_min", continuationPrompt: "x", model: { providerID: "p", id: "m" } },
      { signal: CONTINUE_SIGNAL },
    ),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "agent" &&
      /switchModel is unavailable/.test(err.message) &&
      /cannot continue session ses_min/.test(err.message),
  )
  assert.equal(prompts, 0)
})

test("continueAgent: same-model continue never calls switchModel", async () => {
  const { fake, driver } = makeDriver([
    { text: "first" },
    { text: "second" },
  ])
  const first = await driver.runAgent(input(), ["general"], hooks())
  await driver.continueAgent({ sessionID: first.sessionID, continuationPrompt: "keep going" }, { signal: CONTINUE_SIGNAL })
  assert.equal(fake.switches.length, 0)
})

test("continueAgent: an empty re-failure reports noProgress; a turn with tokens reads as progress", async () => {
  const empty = makeDriver([
    { text: "", outcome: "failed", failure: { type: "provider.rate-limit", message: "Rate limit reached", status: 429 } },
    { text: "", outcome: "failed", failure: { type: "provider.rate-limit", message: "Rate limit reached", status: 429 } },
  ])
  await assert.rejects(empty.driver.runAgent(input(), ["general"], hooks()))
  const emptySession = [...empty.fake.sessions.keys()][0]!
  await assert.rejects(
    empty.driver.continueAgent({ sessionID: emptySession, continuationPrompt: "go" }, { signal: CONTINUE_SIGNAL }),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.noProgress, true, "empty turn with no token growth is the 0-token instant-death shape")
      assert.equal(err.failure?.class, "burst")
      return true
    },
  )

  const worked = makeDriver([
    { text: "", outcome: "failed", failure: { type: "provider.rate-limit", message: "Rate limit reached", status: 429 } },
    { text: "", outcome: "failed", tokens: TOKENS, failure: { type: "provider.rate-limit", message: "Rate limit reached", status: 429 } },
  ])
  await assert.rejects(worked.driver.runAgent(input(), ["general"], hooks()))
  const workedSession = [...worked.fake.sessions.keys()][0]!
  await assert.rejects(
    worked.driver.continueAgent({ sessionID: workedSession, continuationPrompt: "go" }, { signal: CONTINUE_SIGNAL }),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.noProgress, false, "token growth proves the turn did work")
      return true
    },
  )
})

test("continueAgent: the first turn never carries noProgress", async () => {
  const { driver } = makeDriver([{ text: "", outcome: "failed", failure: { status: 429, message: "Rate limit reached" } }])
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.noProgress, undefined)
      return true
    },
  )
})

test("continueAgent: completed tool results without an exposed error carry an observable hint and stay in history", async () => {
  const { fake, driver } = makeDriver([
    { text: "", outcome: "failed", finish: "tool-calls", tokens: TOKENS },
    { text: "", outcome: "failed" },
    { text: "recovered from retained results" },
  ])
  const prompt = fake.prompt.bind(fake)
  const completedTool = { type: "tool", name: "read", state: { status: "completed", content: "retained tool payload" } }
  fake.prompt = async (input) => {
    const result = await prompt(input)
    const session = fake.sessions.get(input.sessionID)!
    if (session.prompts === 1) session.messages.at(-1)!.content = [completedTool]
    // Replay the production shape: failed continuation, no new assistant,
    // unchanged tokens, last assistant still ends with completed tool results.
    if (session.prompts === 2) session.messages.pop()
    return result
  }
  let hint = ""
  const checkError = (err: unknown) => {
    assert.ok(err instanceof AgentCallError)
    assert.equal(err.kind, "outcome")
    assert.equal(err.failure?.class, "other")
    assert.equal(err.continuationHint,
      "finish=tool-calls with completed tool results and no exposed error; continue using those results; do not treat this as provider quota")
    assert.doesNotMatch(err.continuationHint!, /host closed|provider failure/i)
    hint = err.continuationHint!
    return true
  }
  await assert.rejects(driver.runAgent(input(), ["general"], hooks()), checkError)
  const sessionID = [...fake.sessions.keys()][0]!
  const session = fake.sessions.get(sessionID)!
  const originalAssistant = session.messages.at(-1)!
  await assert.rejects(driver.continueAgent(
    { sessionID, continuationPrompt: buildContinuationPrompt("say hi", hint) }, { signal: CONTINUE_SIGNAL }),
    (err: unknown) => { checkError(err); assert.equal((err as AgentCallError).noProgress, true); return true })
  assert.equal(session.messages.filter((m) => m.type === "assistant").length, 1)
  const result = await driver.continueAgent(
    { sessionID, continuationPrompt: buildContinuationPrompt("say hi", hint) }, { signal: CONTINUE_SIGNAL })
  assert.equal(result.text, "recovered from retained results")
  assert.equal(result.sessionID, sessionID)
  assert.equal(fake.sessions.size, 1)
  assert.deepEqual(fake.switches, [])
  assert.ok(session.messages.includes(originalAssistant), "original tool-result message retained by identity")
  assert.equal(originalAssistant.content![0], completedTool)
  for (const msg of session.messages.filter((m) => m.type === "user").slice(1)) {
    assert.match(msg.text ?? "", /continue using those results/)
    assert.doesNotMatch(msg.text ?? "", /retained tool payload/)
  }
})

for (const shape of ["pending", "running", "error", "missing tools", "content error", "provider error", "session error", "succeeded", "other finish"]) {
test(`runAgent: tool-result hint excludes ${shape}`, async () => {
  const { fake, driver } = makeDriver([{ text: "", outcome: shape === "succeeded" ? "succeeded" : "failed", finish: "tool-calls" }])
  const prompt = fake.prompt.bind(fake)
  fake.prompt = async (input) => {
    const result = await prompt(input)
    const last = fake.sessions.get(input.sessionID)!.messages.at(-1)!
    const tools = [{ type: "tool", state: { status: "completed" } }]
    if (["pending", "running", "error"].includes(shape)) tools.push({ type: "tool", state: { status: shape } })
    last.content = shape === "missing tools" ? [] : tools
    if (shape === "content error") last.content = [...tools, { type: "error", text: "tool failed" }]
    if (shape === "provider error") last.error = { status: 429, message: "Rate limit reached" }
    if (shape === "other finish") last.finish = "error"
    return result
  }
  if (shape === "session error") {
    const get = fake.get.bind(fake)
    fake.get = async (input) => ({ ...await get(input), error: "session error" })
  }
  if (shape === "succeeded") {
    const result = await driver.runAgent(input(), ["general"], hooks())
    assert.equal("continuationHint" in result, false)
  } else {
    await assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
      assert.ok(err instanceof AgentCallError)
      assert.equal(err.continuationHint, undefined)
      if (shape === "provider error") assert.equal(err.failure?.class, "burst")
      return true
    })
  }
})
}

test("continueAgent: schema mode reuses structured extraction (repair round included)", async () => {
  const { fake, driver } = makeDriver([
    { text: "died", outcome: "failed", failure: { status: 429, message: "Rate limit reached" } },
    { text: "not json" },
    { text: '{"answer": "42"}' },
  ])
  await assert.rejects(driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks()))
  const sessionID = [...fake.sessions.keys()][0]!
  const result = await driver.continueAgent(
    { sessionID, continuationPrompt: "continue", schema: SCHEMA },
    { signal: CONTINUE_SIGNAL },
  )
  assert.deepEqual(result.data, { answer: "42" })
  assert.equal(fake.sessions.get(sessionID)!.prompts, 3, "continue prompt + one repair round")
})

test("continueAgent: abort mid-wait interrupts the SAME session", async () => {
  const { fake, driver } = makeDriver([{ text: "first" }])
  const first = await driver.runAgent(input(), ["general"], hooks())
  fake.hangWait = true
  const ctrl = new AbortController()
  const pending = driver.continueAgent(
    { sessionID: first.sessionID, continuationPrompt: "slow continuation" },
    { signal: ctrl.signal },
  )
  await tick(20)
  ctrl.abort()
  await assert.rejects(
    pending,
    (err: unknown) => err instanceof AgentCallError && err.kind === "abort" && /run stopping/.test(err.message),
  )
  assert.deepEqual(fake.interrupts, [first.sessionID])
})

// ---------------------------------------------------------------------------
// Per-await deadlines (P1-1): a hung RPC lands typed + terminal, never a wedge
// ---------------------------------------------------------------------------

test("runAgent: a hung wait() hits the await deadline — typed timeout error + best-effort interrupt", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const awaitMs = 80
  const driver = createSessionDriver(fake, { awaitTimeoutMs: awaitMs, interruptConfirmMs: 8, salvageContextMs: 8 })
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(
          err.message,
          /session\.wait on session .+ exceeded \d+ms — await budget exceeded on a live session \(session\.prompt already returned\)/,
        )
        assert.doesNotMatch(err.message, /appears hung/)
        assert.match(err.message, /interrupt confirmed/)
        const elapsed = Number(err.message.match(/exceeded (\d+)ms/)?.[1])
        // No extend: die at the armed budget, not the 2× hard cap. 1.5× leaves
        // timer slop without accepting a wait that ran to the cap.
        assert.ok(elapsed >= awaitMs && elapsed < awaitMs * 1.5, `no-extend wait should die near awaitMs, got ${elapsed}`)
        return true
      }),
      500,
    )
    assert.ok(fake.interrupts.length >= 1, "hung wait best-effort interrupted")
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("runAgent: a hung session.prompt() stays the hung-RPC arm", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: () => new Promise(() => {}),
    wait: (i) => fake.wait(i),
    context: (i) => fake.context(i),
    interrupt: (i) => fake.interrupt(i),
  }
  let budgets = 0
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: 40,
    interruptConfirmMs: 8,
    salvageContextMs: 8,
    onWaitBudget: () => {
      budgets++
    },
  })
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(err.message, /session\.prompt .* appears hung/)
        assert.match(err.message, /interrupt confirmed/)
        assert.doesNotMatch(err.message, /await budget exceeded/)
        assert.doesNotMatch(err.message, /salvage=/)
        return true
      }),
      500,
    )
    assert.equal(budgets, 0, "prompt arm must not register a wait budget")
    assert.ok(fake.interrupts.length >= 1, "hung prompt still best-effort interrupted")
  } finally {
    fake.releaseHangs()
  }
})

test("onWaitBudget.extend() pushes a hung wait past awaitMs and does not also fire the original timer", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "released in time" })
  fake.hangWait = true
  const awaitMs = 120
  let extend: (() => void) | undefined
  let cleared = 0
  const driver = createSessionDriver(fake, {
    awaitTimeoutMs: awaitMs,
    onWaitBudget: (_sessionID, ctl) => {
      if (ctl) extend = ctl.extend
      else cleared++
    },
  })
  let settled = false
  const pending = driver.runAgent(input(), ["general"], hooks()).then(
    (result) => {
      settled = true
      return result
    },
    (err) => {
      settled = true
      throw err
    },
  )
  pending.catch(() => {})
  try {
    await tick(70)
    assert.ok(extend, "wait arm registered extend")
    assert.equal(settled, false, "original deadline has not fired yet")
    extend()
    // Past the original 120ms deadline, before the extended one (70+120).
    // An uncleared original timer would have interrupted already.
    await tick(70)
    assert.equal(settled, false, "extend prevented rejection at awaitMs")
    assert.deepEqual(fake.interrupts, [], "original timer must not also interrupt")
    fake.hangWait = false
    fake.releaseHangs()
    const result = await rejectSoon(pending, 500)
    assert.equal(result.text, "released in time")
    assert.deepEqual(fake.interrupts, [], "a wait that settles before the hard cap does not interrupt")
    assert.equal(cleared, 1, "wait budget cleared when the wait settles")
    extend()
    await tick(awaitMs + 20)
    assert.deepEqual(fake.interrupts, [], "extend after settle is a no-op")
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("repeated extend() still rejects at the 2× hard cap with the await-budget string", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const awaitMs = 50
  let extend: (() => void) | undefined
  const driver = createSessionDriver(fake, {
    awaitTimeoutMs: awaitMs,
    interruptConfirmMs: 5,
    salvageContextMs: 5,
    onWaitBudget: (_sessionID, ctl) => {
      if (!ctl) return
      extend = ctl.extend
      // Before the original deadline, so the cap (not the first timer) is what fires.
      setTimeout(() => ctl.extend(), 15)
    },
  })
  const started = Date.now()
  const pending = driver.runAgent(input(), ["general"], hooks())
  const pump = setInterval(() => extend?.(), 15)
  try {
    await rejectSoon(
      assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(err.message, /await budget exceeded/)
        assert.doesNotMatch(err.message, /appears hung/)
        const elapsed = Number(err.message.match(/exceeded (\d+)ms/)?.[1])
        const wall = Date.now() - started
        // 2× from waitStartedAt (100ms), not the original 50ms budget and not
        // the 30-minute production constant.
        assert.ok(elapsed >= 85 && elapsed < 180, `hard-cap elapsed ${elapsed}`)
        assert.ok(wall >= 85 && wall < 500, `hard-cap wall ${wall}`)
        return true
      }),
      500,
    )
    assert.equal(fake.interrupts.length, 1, "exactly one interrupt from the deadline path")
    await tick(awaitMs + 30)
    assert.equal(fake.interrupts.length, 1, "the original timer must not interrupt again after the cap")
  } finally {
    clearInterval(pump)
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("a raw activity bump is not an extend — only extend() moves the await timer", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const awaitMs = 80
  let extend: (() => void) | undefined
  const driver = createSessionDriver(fake, {
    awaitTimeoutMs: awaitMs,
    interruptConfirmMs: 8,
    salvageContextMs: 8,
    onWaitBudget: (_sessionID, ctl) => {
      if (ctl) extend = ctl.extend
    },
  })
  // Stand-ins for session.tool.progress and noteChildActivity: they can see
  // the session, but they do not receive or call extend.
  const noteChildActivity = () => {}
  const noteToolProgress = () => {}
  const pending = driver.runAgent(input(), ["general"], hooks())
  try {
    await tick(10)
    assert.ok(extend, "ctl registered")
    noteChildActivity()
    noteToolProgress()
    await rejectSoon(
      assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(err.message, /await budget exceeded/)
        assert.doesNotMatch(err.message, /appears hung/)
        const elapsed = Number(err.message.match(/exceeded (\d+)ms/)?.[1])
        assert.ok(elapsed >= awaitMs && elapsed < awaitMs * 1.5, `activity bump must not push past awaitMs, got ${elapsed}`)
        return true
      }),
      500,
    )
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("runAgent: a hung session.create() hits the control deadline with a typed timeout", async () => {
  const inner = new FakeSessionCtx()
  inner.push({ text: "x" })
  const hanging: SessionCtx = {
    create: () => new Promise(() => {}),
    get: (i) => inner.get(i),
    prompt: (i) => inner.prompt(i),
    wait: (i) => inner.wait(i),
    context: (i) => inner.context(i),
    interrupt: (i) => inner.interrupt(i),
  }
  const driver = createSessionDriver(hanging, { controlTimeoutMs: 30 })
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) =>
      err instanceof AgentCallError &&
      err.kind === "timeout" &&
      /session\.create exceeded 30ms/.test(err.message) &&
      /appears hung/.test(err.message) &&
      !/await budget exceeded/.test(err.message),
  )
})

test("runAgent: a hung session.get() after a successful turn hits the control deadline", async () => {
  const inner = new FakeSessionCtx()
  inner.push({ text: "done text" })
  const hanging: SessionCtx = {
    create: (i) => inner.create(i),
    // The very first get (the outcome read after the turn) hangs forever.
    get: () => new Promise(() => {}),
    prompt: (i) => inner.prompt(i),
    wait: (i) => inner.wait(i),
    context: (i) => inner.context(i),
    interrupt: (i) => inner.interrupt(i),
  }
  const driver = createSessionDriver(hanging, { controlTimeoutMs: 30 })
  await assert.rejects(
    driver.runAgent(input(), ["general"], hooks()),
    (err: unknown) => err instanceof AgentCallError && err.kind === "timeout" && /session\.get .* exceeded 30ms/.test(err.message),
  )
})

test("deadlines are off at <=0: a slow-but-honest RPC never times out", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "slow ok" })
  const driver = createSessionDriver(fake, { awaitTimeoutMs: 0, controlTimeoutMs: 0 })
  const result = await driver.runAgent(input(), ["general"], hooks())
  assert.equal(result.text, "slow ok")
})

test("deadline confirm: instant interrupt names the await budget and does not wait 60s", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const awaitMs = 40
  const confirmMs = 80
  const events: Array<{ kind: string; detail?: string }> = []
  let extend: (() => void) | undefined
  const driver = createSessionDriver(fake, {
    awaitTimeoutMs: awaitMs,
    interruptConfirmMs: confirmMs,
    salvageContextMs: 10,
    onWaitBudget: (_sessionID, ctl) => {
      if (ctl) extend = ctl.extend
    },
    onEvent: (event) => {
      if (event.kind.startsWith("interrupt.")) events.push(event)
    },
  })
  const started = Date.now()
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.equal(err.text, undefined, "deadline must not write result text")
        assert.match(err.message, /await budget exceeded/)
        assert.match(err.message, /interrupt confirmed/)
        assert.doesNotMatch(err.message, /appears hung/)
        const wall = Date.now() - started
        // Instant interrupt settles the confirm race; do not wait the full
        // confirm window, the 60s control timeout, or the 900s RPC.
        assert.ok(wall < 400, `instant confirm wall ${wall} (confirm bound ${confirmMs}, not 60s)`)
        assert.ok(wall < SESSION_CONTROL_TIMEOUT_MS, "confirm must not be the 60s control timeout")
        return true
      }),
      500,
    )
    assert.ok(fake.interrupts.length >= 1)
    extend?.()
    await tick(confirmMs + 20)
    assert.equal(fake.interrupts.length, 1, "extend during confirm must not schedule a second interrupt")
    assert.deepEqual(events.map((event) => event.kind), ["interrupt.confirmed"])
    assert.ok((events[0]?.detail?.length ?? 0) <= 300)
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("deadline confirm: a hung interrupt RPC is abandoned inside the confirm bound", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  let rejectInterrupt: (err: Error) => void = () => {}
  const hanging = new Promise<void>((_, reject) => {
    rejectInterrupt = reject
  })
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: (i) => fake.prompt(i),
    wait: (i) => fake.wait(i),
    context: (i) => fake.context(i),
    interrupt: (i) => {
      fake.interrupts.push(i.sessionID)
      return hanging
    },
  }
  const awaitMs = 30
  const confirmMs = 40
  const events: Array<{ kind: string; detail?: string }> = []
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: awaitMs,
    interruptConfirmMs: confirmMs,
    salvageContextMs: 10,
    onEvent: (event) => {
      if (event.kind.startsWith("interrupt.")) events.push(event)
    },
  })
  const started = Date.now()
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason)
  }
  process.on("unhandledRejection", onUnhandled)
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(err.message, /interrupt abandoned/)
        assert.match(err.message, /await budget exceeded/)
        assert.doesNotMatch(err.message, /appears hung/)
        const wall = Date.now() - started
        // Abandon fires at the confirm bound, then a fast salvage. Not the hung RPC and not 60s.
        assert.ok(wall >= confirmMs - 5, `abandoned confirm returned too fast (${wall}ms)`)
        assert.ok(wall < 400, `abandoned confirm wall ${wall}`)
        assert.ok(wall < SESSION_CONTROL_TIMEOUT_MS)
        return true
      }),
      500,
    )
    assert.equal(events[0]?.kind, "interrupt.abandoned")
    rejectInterrupt(new Error("dangling interrupt failed later"))
    await tick(30)
    assert.equal(unhandled.length, 0, "abandoned interrupt must not surface as an unhandled rejection")
  } finally {
    process.off("unhandledRejection", onUnhandled)
    rejectInterrupt(new Error("dangling interrupt failed later"))
    fake.hangWait = false
    fake.releaseHangs()
    await tick(10)
  }
})

test("deadline confirm: a rejecting interrupt is interrupt error, detail capped at 300", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const long = "x".repeat(400)
  const events: Array<{ kind: string; detail?: string }> = []
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: (i) => fake.prompt(i),
    wait: (i) => fake.wait(i),
    context: (i) => fake.context(i),
    interrupt: async (i) => {
      fake.interrupts.push(i.sessionID)
      throw new Error(long)
    },
  }
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: 25,
    interruptConfirmMs: 40,
    salvageContextMs: 8,
    onEvent: (event) => {
      if (event.kind.startsWith("interrupt.")) events.push(event)
    },
  })
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(err.message, /interrupt error/)
        assert.doesNotMatch(err.message, /interrupt confirmed|interrupt abandoned/)
        assert.doesNotMatch(err.message, new RegExp(long))
        return true
      }),
      500,
    )
    assert.equal(events[0]?.kind, "interrupt.error")
    assert.ok((events[0]?.detail?.length ?? 0) <= 300)
    assert.match(events[0]?.detail ?? "", /interrupt error/)
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("deadline confirm: context tool parts are named and the call still rejects", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const payload = "0123456789ABCDEFGHIJ"
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: (i) => fake.prompt(i),
    wait: (i) => fake.wait(i),
    context: async () => [
      {
        id: "msg_tools",
        type: "assistant",
        content: [
          { type: "tool", name: "read", state: { status: "completed", content: payload } },
          { type: "tool", name: "bash", state: { status: "error", content: "still in flight" } },
        ],
      } as unknown as ContextMessage,
    ],
    interrupt: (i) => fake.interrupt(i),
  }
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: 30,
    interruptConfirmMs: 8,
    salvageContextMs: 20,
    errorTextSnippetChars: 8,
  })
  let rejected: AgentCallError | undefined
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        rejected = err
        assert.equal(err.kind, "timeout")
        assert.equal(err.text, undefined)
        assert.match(err.message, /interrupt confirmed/)
        assert.match(err.message, /last tools: read:completed, bash:error/)
        assert.match(err.message, /01234567…/)
        assert.doesNotMatch(err.message, /0123456789ABCDEFGHIJ/)
        assert.doesNotMatch(err.message, /appears hung/)
        return true
      }),
      500,
    )
    assert.ok(rejected, "runAgent rejected — no AgentResult")
    assert.equal("data" in (rejected as object), false)
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("deadline confirm: a hung context read suffixes salvage=unavailable inside confirm+salvage", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  const awaitMs = 25
  const confirmMs = 20
  const salvageMs = 30
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: (i) => fake.prompt(i),
    wait: (i) => fake.wait(i),
    context: () => new Promise(() => {}),
    interrupt: (i) => fake.interrupt(i),
  }
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: awaitMs,
    interruptConfirmMs: confirmMs,
    salvageContextMs: salvageMs,
  })
  const started = Date.now()
  try {
    await rejectSoon(
      assert.rejects(driver.runAgent(input(), ["general"], hooks()), (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.match(err.message, /salvage=unavailable/)
        assert.match(err.message, /interrupt confirmed/)
        assert.match(err.message, /await budget exceeded/)
        const wall = Date.now() - started
        const bound = awaitMs + confirmMs + salvageMs + 120
        assert.ok(wall < bound, `salvage stall ${wall} exceeded confirm+salvage`)
        assert.ok(wall < 15_000, "confirm+salvage must stay under SETTLE_GRACE_MS")
        assert.ok(INTERRUPT_CONFIRM_MS + SALVAGE_CONTEXT_MS < 15_000)
        assert.ok(INTERRUPT_CONFIRM_MS < SESSION_CONTROL_TIMEOUT_MS)
        return true
      }),
      800,
    )
  } finally {
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("deadline confirm: session.wait resolving during confirm stays kind timeout", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "late success must not win" })
  fake.hangWait = true
  let releaseInterrupt: () => void = () => {}
  const interruptGate = new Promise<void>((resolve) => {
    releaseInterrupt = resolve
  })
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: (i) => fake.prompt(i),
    wait: (i) => fake.wait(i),
    context: (i) => fake.context(i),
    interrupt: async (i) => {
      fake.interrupts.push(i.sessionID)
      await interruptGate
    },
  }
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: 30,
    interruptConfirmMs: 80,
    salvageContextMs: 10,
  })
  const pending = driver.runAgent(input(), ["general"], hooks())
  pending.catch(() => {})
  try {
    await tick(45)
    fake.hangWait = false
    fake.releaseHangs()
    await tick(15)
    releaseInterrupt()
    await rejectSoon(
      assert.rejects(pending, (err: unknown) => {
        assert.ok(err instanceof AgentCallError)
        assert.equal(err.kind, "timeout")
        assert.notEqual(err.kind, "outcome")
        assert.match(err.message, /interrupt confirmed/)
        assert.match(err.message, /await budget exceeded/)
        assert.doesNotMatch(err.message, /outcome/)
        return true
      }),
      500,
    )
  } finally {
    releaseInterrupt()
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("deadline confirm: abort during confirm rejects abort immediately", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "never reached" })
  fake.hangWait = true
  let releaseInterrupt: () => void = () => {}
  const interruptGate = new Promise<void>((resolve) => {
    releaseInterrupt = resolve
  })
  const sessions: SessionCtx = {
    create: (i) => fake.create(i),
    get: (i) => fake.get(i),
    prompt: (i) => fake.prompt(i),
    wait: (i) => fake.wait(i),
    context: (i) => fake.context(i),
    interrupt: async (i) => {
      fake.interrupts.push(i.sessionID)
      await interruptGate
    },
  }
  const ctrl = new AbortController()
  const driver = createSessionDriver(sessions, {
    awaitTimeoutMs: 30,
    interruptConfirmMs: INTERRUPT_CONFIRM_MS,
    salvageContextMs: 20,
  })
  const started = Date.now()
  const pending = driver.runAgent(input(), ["general"], hooks(() => {}, ctrl.signal))
  try {
    await tick(50)
    ctrl.abort()
    await rejectSoon(
      assert.rejects(
        pending,
        (err: unknown) => err instanceof AgentCallError && err.kind === "abort" && /run stopping/.test(err.message),
      ),
      300,
    )
    assert.ok(Date.now() - started < 400, "abort during confirm must not wait the 3s confirm bound")
    assert.ok(fake.interrupts.length >= 1)
  } finally {
    releaseInterrupt()
    fake.hangWait = false
    fake.releaseHangs()
  }
})

test("a timeout-kind failure is terminal for the runner — no same-model retry, row lands failed", async () => {
  // Timeout is not kind "outcome": the runner's provider-shaped retry loop
  // never re-prompts it; the child record reaches failed with the hung-RPC
  // error. (Exercised through the fake driver the same way the runner sees
  // a real timeout.)
  const err = new AgentCallError("timeout", "session.wait on session s exceeded 15ms — the host session RPC appears hung")
  assert.equal(err instanceof AgentCallError, true)
  assert.equal((err as AgentCallError).kind, "timeout")
})

// ---------------------------------------------------------------------------
// Lifecycle event tap: every RPC boundary is visible (post-mortem trail)
// ---------------------------------------------------------------------------

test("driver onEvent emits the full RPC sequence for a schema-validated child", async () => {
  const kinds: string[] = []
  const fake = new FakeSessionCtx()
  fake.push({ text: '{"answer": "42"}' })
  const driver = createSessionDriver(fake, {
    onEvent: (event) => kinds.push(event.detail !== undefined ? `${event.kind}:${event.detail}` : event.kind),
  })
  await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(kinds, [
    "session.create",
    "prompt.start",
    "prompt.return",
    "wait.start",
    "wait.return",
    "session.get",
    "session.context",
    "schema.validate:ok",
  ])
})

test("driver onEvent emits schema.repair per round and validates after repair", async () => {
  const kinds: string[] = []
  const fake = new FakeSessionCtx()
  fake.push({ text: "not json" })
  fake.push({ text: '{"answer": "42"}' })
  const driver = createSessionDriver(fake, {
    onEvent: (event) => kinds.push(event.kind),
  })
  await driver.runAgent(input({ schema: SCHEMA }), ["general"], hooks())
  assert.deepEqual(kinds, [
    "session.create",
    "prompt.start", "prompt.return", "wait.start", "wait.return", "session.get", "session.context",
    "schema.repair",
    "prompt.start", "prompt.return", "wait.start", "wait.return", "session.get", "session.context",
    "schema.validate",
  ])
})

test("driver onEvent never breaks the child when the emitter throws", async () => {
  const fake = new FakeSessionCtx()
  fake.push({ text: "hello" })
  const driver = createSessionDriver(fake, {
    onEvent: () => { throw new Error("emitter down") },
  })
  const result = await driver.runAgent(input(), ["general"], hooks())
  assert.equal(result.text, "hello")
})
