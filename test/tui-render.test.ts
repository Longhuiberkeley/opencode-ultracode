/**
 * Pure TUI inspect helpers (version gate, grouping, cells, pagination, settle).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { agentCells } from "../src/run-format.ts"
import type { AgentRecord, TokenUsage } from "../src/types.ts"
import {
  STATUS_DOT,
  agentRows,
  defaultRunIndex,
  detailsFromMessages,
  footerHints,
  formatCounts,
  groupRuns,
  inspectModel,
  inspectPhaseList,
  nextSettlePrev,
  outcomeToStatus,
  paginate,
  parseRunAck,
  phaseColumns,
  planSettleCheck,
  runFingerprint,
  runningRunCount,
  settleCandidate,
  shouldEnableTui,
  shortRunID,
  twoColumn,
  type RunView,
  type SessionView,
  type SettlePrev,
} from "../src/tui-render.ts"

const TOKENS_42_6K: TokenUsage = { input: 40_000, output: 2_600, reasoning: 0, cache: { read: 0, write: 0 } }

test("shouldEnableTui: strict beta + build >= minBuild", () => {
  assert.equal(shouldEnableTui("0.0.0-beta-19271", "beta", 19271), true)
  assert.equal(shouldEnableTui("v0.0.0-beta-19271", "beta", 19271), true)
  assert.equal(shouldEnableTui("0.0.0-beta-19289", "beta", 19271), true)
  assert.equal(shouldEnableTui("0.0.0-beta-19270", "beta", 19271), false)
  assert.equal(shouldEnableTui("0.0.0-beta-19271", "alpha", 19271), false)
  assert.equal(shouldEnableTui("0.0.0-beta-19271", undefined, 19271), false)
  assert.equal(shouldEnableTui("0.0.0-beta-19271", "dev", 19271), false)
  assert.equal(shouldEnableTui("1.2.3", "beta", 1), false)
  assert.equal(shouldEnableTui("v0.0.0-beta-", "beta", 0), false)
  assert.equal(shouldEnableTui("", "beta", 19271), false)
  assert.equal(shouldEnableTui("0.0.0-beta-abc", "beta", 0), false)
  assert.equal(shouldEnableTui("0.0.0-beta-19271-extra", "beta", 19271), false)
})

test("groupRuns: joins by parseChildTitle.runID, ignores non-uc, orders by ord", () => {
  const sessions: SessionView[] = [
    { id: "ses_noise", title: "plain title", outcome: "succeeded" },
    { id: "ses_a2", title: "[uc:run_abc a2 extract p:ses_parent] judge", outcome: "failed", time: { created: 200 } },
    { id: "ses_a1", title: "[uc:run_abc a1 research p:ses_parent] seeker", outcome: undefined, time: { created: 100 }, tokens: TOKENS_42_6K },
    { id: "ses_b", title: "[uc:run_other a1 p:ses_parent] other", outcome: "succeeded", time: 50 },
    { id: "ses_a3", title: "[uc:run_abc a3 research p:ses_parent] retry", outcome: "succeeded", time: { created: 150 } },
  ]
  const runs = groupRuns(sessions)
  assert.equal(runs.length, 2)
  assert.equal(runs[0]!.runID, "run_abc")
  assert.deepEqual(
    runs[0]!.agents.map((a) => a.ord),
    ["a1", "a2", "a3"],
  )
  assert.equal(runs[0]!.agents[0]!.status, "running")
  assert.equal(runs[0]!.agents[1]!.status, "failed")
  assert.equal(runs[0]!.agents[2]!.status, "succeeded")
  assert.deepEqual(runs[0]!.phases, ["research", "extract"])
  assert.deepEqual(runs[0]!.counts, { total: 3, done: 2, failed: 1 })
  assert.equal(runs[0]!.startedAt, 100)
  assert.equal(runs[0]!.settled, false)
  assert.equal(runs[1]!.runID, "run_other")
  assert.equal(runs[1]!.settled, true)
  assert.equal(runs[1]!.startedAt, 50)
  assert.equal(runningRunCount(runs), 1)
})

test("groupRuns: legacy [uc:<tag>] titles join; missing ord keeps appearance order", () => {
  const sessions: SessionView[] = [
    { id: "ses_1", title: "[uc:ab12cd34] seeker", outcome: "succeeded", time: { created: 1 } },
    { id: "ses_2", title: "[uc:ab12cd34] judge", outcome: "failed", time: { created: 2 } },
    { id: "ses_3", title: "not-uc", outcome: "succeeded" },
  ]
  const runs = groupRuns(sessions)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.runID, "ab12cd34")
  assert.deepEqual(
    runs[0]!.agents.map((a) => a.sessionID),
    ["ses_1", "ses_2"],
  )
  assert.equal(runs[0]!.agents[0]!.ord, undefined)
  assert.equal(runs[0]!.agents[0]!.label, "seeker")
  assert.deepEqual(runs[0]!.phases, [])
  assert.equal(runs[0]!.settled, true)
  assert.deepEqual(runs[0]!.counts, { total: 2, done: 2, failed: 1 })
})

test("groupRuns: empty / all non-uc → []", () => {
  assert.deepEqual(groupRuns([]), [])
  assert.deepEqual(groupRuns([{ id: "x", title: "hello" }]), [])
})

test("outcomeToStatus", () => {
  assert.equal(outcomeToStatus(undefined), "running")
  assert.equal(outcomeToStatus(""), "running")
  assert.equal(outcomeToStatus("succeeded"), "succeeded")
  assert.equal(outcomeToStatus("interrupted"), "interrupted")
  assert.equal(outcomeToStatus("failed"), "failed")
  assert.equal(outcomeToStatus("error"), "failed")
})

test("phaseColumns + agentRows D11 parity (status dot replaces status cell)", () => {
  const run: RunView = {
    runID: "run_abc123def456",
    phases: ["extract", "verify"],
    startedAt: 1000,
    settled: false,
    counts: { total: 3, done: 1, failed: 1 },
    agents: [
      {
        sessionID: "ses_1",
        ord: "a3",
        phase: "extract",
        label: "seeker",
        status: "running",
        tokens: TOKENS_42_6K,
        title: "[uc:run_abc123def456 a3 extract p:ses_parent] seeker",
        agent: "explore",
        model: { providerID: "openrouter", id: "kimi" },
        toolCalls: 4,
      },
      {
        sessionID: "ses_2",
        ord: "a1",
        phase: "verify",
        label: undefined,
        status: "pending",
        title: "[uc:run_abc123def456 a1 verify p:ses_parent] a1",
        agent: "general",
        model: { providerID: "anthropic", id: "sonnet" },
        toolCalls: 1,
      },
      {
        sessionID: "ses_3",
        ord: "a2",
        phase: "verify",
        label: "judge",
        status: "failed",
        title: "[uc:run_abc123def456 a2 verify p:ses_parent] judge",
        agent: "general",
        model: { providerID: "anthropic", id: "sonnet" },
        toolCalls: 2,
      },
    ],
  }

  assert.deepEqual(phaseColumns(run), [
    { phase: "extract", done: 0, total: 1 },
    { phase: "verify", done: 1, total: 2 },
  ])

  const full: AgentRecord = {
    id: "a3",
    label: "seeker",
    phase: "extract",
    status: "running",
    tokens: TOKENS_42_6K,
    sessionID: "ses_1",
    effectiveAgent: "explore",
    effectiveModel: { providerID: "openrouter", id: "kimi" },
    toolCalls: 4,
  }
  const sparse: AgentRecord = {
    id: "a1",
    phase: "verify",
    status: "pending",
    sessionID: "ses_2",
    effectiveAgent: "general",
    effectiveModel: { providerID: "anthropic", id: "sonnet" },
    toolCalls: 1,
  }
  const failed: AgentRecord = {
    id: "a2",
    label: "judge",
    phase: "verify",
    status: "failed",
    sessionID: "ses_3",
    effectiveAgent: "general",
    effectiveModel: { providerID: "anthropic", id: "sonnet" },
    toolCalls: 2,
  }

  const expectedFull = agentCells(full)
  expectedFull[0] = STATUS_DOT.running
  const expectedSparse = agentCells(sparse)
  expectedSparse[0] = STATUS_DOT.pending
  const expectedFailed = agentCells(failed)
  expectedFailed[0] = STATUS_DOT.failed

  assert.deepEqual(agentRows(run), [expectedFull, expectedSparse, expectedFailed])
  assert.deepEqual(agentRows(run, "verify"), [expectedSparse, expectedFailed])
  assert.deepEqual(agentRows(run, "extract"), [expectedFull])
  assert.deepEqual(agentRows(run, "missing"), [])

  // Explicit golden strings — populated agent/model/tokens/tools (sparse "-" must not pass).
  assert.deepEqual(expectedFull, ["●", "a3 seeker", "extract", "explore", "openrouter/kimi", "42.6k", "4"])
  assert.deepEqual(expectedSparse, ["○", "a1", "verify", "general", "anthropic/sonnet", "-", "1"])
  assert.deepEqual(expectedFailed, ["✗", "a2 judge", "verify", "general", "anthropic/sonnet", "-", "2"])
})

test("paginate", () => {
  const rows = ["a", "b", "c", "d", "e"]
  assert.deepEqual(paginate(rows, 0, 2), { window: ["a", "b"], label: "1–2 of 5" })
  assert.deepEqual(paginate(rows, 2, 2), { window: ["c", "d"], label: "3–4 of 5" })
  assert.deepEqual(paginate(rows, 4, 2), { window: ["d", "e"], label: "4–5 of 5" })
  assert.deepEqual(paginate(rows, -3, 2), { window: ["a", "b"], label: "1–2 of 5" })
  assert.deepEqual(paginate(rows, 99, 2), { window: ["d", "e"], label: "4–5 of 5" })
  assert.deepEqual(paginate(rows, 0, 10), { window: rows, label: "1–5 of 5" })
  assert.deepEqual(paginate([], 0, 5), { window: [], label: "0–0 of 0" })
  assert.deepEqual(paginate(rows, 0, 0), { window: ["a"], label: "1–1 of 5" })
})

test("settleCandidate: quiet window + once-per-run dedupe", () => {
  const settled: RunView = {
    runID: "run_x",
    agents: [
      { sessionID: "s1", ord: "a1", status: "succeeded", title: "t1" },
      { sessionID: "s2", ord: "a2", status: "failed", title: "t2" },
    ],
    phases: [],
    counts: { total: 2, done: 2, failed: 1 },
    startedAt: 0,
    settled: true,
  }
  const running: RunView = {
    ...settled,
    settled: false,
    agents: [{ sessionID: "s1", ord: "a1", status: "running", title: "t1" }],
  }

  assert.equal(settleCandidate(undefined, settled, 5000, 10_000), false)

  const first = nextSettlePrev(undefined, settled, 1000)
  assert.equal(first.fired, false)
  assert.equal(settleCandidate(first, settled, 5000, 2000), false)
  assert.equal(settleCandidate(first, settled, 5000, 6000), true)

  const fired: SettlePrev = { ...first, fired: true }
  assert.equal(settleCandidate(fired, settled, 5000, 99_000), false)

  assert.equal(settleCandidate(first, running, 5000, 99_000), false)

  const changed: RunView = {
    ...settled,
    agents: [{ sessionID: "s1", ord: "a1", status: "interrupted", title: "t1" }],
    settled: true,
  }
  assert.equal(settleCandidate(first, changed, 5000, 99_000), false)

  const afterChange = nextSettlePrev(first, changed, 7000)
  assert.equal(afterChange.lastChangeAt, 7000)
  assert.equal(settleCandidate(afterChange, changed, 5000, 11_000), false)
  assert.equal(settleCandidate(afterChange, changed, 5000, 12_000), true)
})

test("runFingerprint + formatCounts", () => {
  const run: RunView = {
    runID: "run_x",
    agents: [
      { sessionID: "s1", status: "succeeded", title: "a" },
      { sessionID: "s2", status: "failed", title: "b" },
    ],
    phases: [],
    counts: { total: 2, done: 2, failed: 1 },
    startedAt: 0,
    settled: true,
  }
  assert.equal(runFingerprint(run), "s1:succeeded|s2:failed")
  assert.equal(formatCounts(run.counts), "2/2 failed 1")
  assert.equal(formatCounts({ total: 3, done: 3, failed: 0 }), "3/3")
})

test("footerHints: only bound keys, collapsed chords", () => {
  assert.equal(footerHints([]), "")
  assert.equal(footerHints(["up", "down", "x", "p", "s", "return", "right", "esc"]), "↑↓ select  x stop  p pause/resume  s save  enter/→ drill  esc close")
  assert.equal(footerHints(["x", "esc"]), "x stop  esc close")
  assert.equal(footerHints(["enter"]), "enter drill")
  assert.equal(footerHints(["right"]), "→ drill")
  assert.equal(footerHints(["p", "custom"]), "p pause/resume  custom")
  assert.equal(footerHints(["[", "]"]), "[ ] run")
})

test("twoColumn: phases left, D11 right, pagination ↓, header", () => {
  const run: RunView = {
    runID: "run_abc123def456789",
    phases: ["extract", "verify"],
    startedAt: 1000,
    settled: false,
    counts: { total: 3, done: 1, failed: 1 },
    agents: [
      {
        sessionID: "ses_1",
        ord: "a3",
        phase: "extract",
        label: "seeker",
        status: "running",
        tokens: TOKENS_42_6K,
        title: "[uc:run_abc123def456789 a3 extract p:ses_parent] seeker",
        agent: "explore",
        model: { providerID: "openrouter", id: "kimi" },
        toolCalls: 4,
      },
      {
        sessionID: "ses_2",
        ord: "a1",
        phase: "verify",
        label: undefined,
        status: "pending",
        title: "[uc:run_abc123def456789 a1 verify p:ses_parent] a1",
        agent: "general",
        model: { providerID: "anthropic", id: "sonnet" },
        toolCalls: 1,
      },
      {
        sessionID: "ses_3",
        ord: "a2",
        phase: "verify",
        label: "judge",
        status: "failed",
        title: "[uc:run_abc123def456789 a2 verify p:ses_parent] judge",
        agent: "general",
        model: { providerID: "anthropic", id: "sonnet" },
        toolCalls: 2,
      },
    ],
  }

  assert.equal(shortRunID(run.runID), "run_abc123def456")

  const page0 = twoColumn(run, { width: 80, selectedPhase: 0, offset: 0, height: 10, now: 2500 })
  assert.deepEqual(page0.header, ["run_abc123def456 · 1/3 agents · 1.5s"])
  assert.deepEqual(page0.left, ["Phases", "> 1 extract 0/1", "  2 verify 1/2"])
  assert.equal(page0.right[0]![0], "extract · 1 agents")
  assert.deepEqual(page0.right[1], ["●", "a3 seeker", "extract", "explore", "openrouter/kimi", "42.6k", "4"])
  assert.equal(page0.page, "1–1 of 1")
  assert.deepEqual(page0.footer, [])

  const page1 = twoColumn(run, { width: 80, selectedPhase: 1, offset: 0, height: 1, now: 2500 })
  assert.deepEqual(page1.left, ["Phases", "  1 extract 0/1", "> 2 verify 1/2"])
  assert.equal(page1.right[0]![0], "verify · 2 agents")
  assert.equal(page1.right.length, 2) // title + 1 window row
  assert.equal(page1.page, "1–1 of 2 ↓")

  const page1b = twoColumn(run, { width: 80, selectedPhase: 1, offset: 1, height: 1, now: 2500 })
  assert.equal(page1b.page, "2–2 of 2")
  assert.deepEqual(page1b.right[1], ["✗", "a2 judge", "verify", "general", "anthropic/sonnet", "-", "2"])

  const emptyPhases: RunView = {
    runID: "ab12cd34",
    phases: [],
    startedAt: 0,
    settled: true,
    counts: { total: 1, done: 1, failed: 0 },
    agents: [{ sessionID: "s1", status: "succeeded", title: "[uc:ab12cd34] seeker" }],
  }
  const none = twoColumn(emptyPhases, { width: 40, selectedPhase: 9, offset: 0, height: 5, now: 0 })
  assert.deepEqual(none.left, ["Phases", "  (none)"])
  assert.equal(none.right[0]![0], "agents · 1 agents")
})

test("inspectModel: same sessions array mutated (complete / new child) + selection change", () => {
  const sessions: SessionView[] = [
    {
      id: "ses_a1",
      title: "[uc:run_abc a1 research p:ses_p] seeker",
      outcome: undefined,
      time: { created: 100 },
      agent: "explore",
      tokens: TOKENS_42_6K,
      model: { providerID: "openrouter", id: "kimi" },
      toolCalls: 3,
    },
    {
      id: "ses_a2",
      title: "[uc:run_abc a2 extract p:ses_p] judge",
      outcome: undefined,
      time: { created: 110 },
      agent: "general",
      model: { providerID: "anthropic", id: "sonnet" },
      toolCalls: 1,
    },
  ]
  const sel = { runIndex: 0, phase: "all", offset: 0, selected: 0, parentSessionID: "ses_p" }
  const before = inspectModel(sessions, sel, 1000)
  assert.equal(before.run?.runID, "run_abc")
  assert.equal(before.runningCount, 1)
  assert.equal(before.rows.length, 2)
  assert.match(before.header, /run 1\/1/)
  assert.equal(before.rows[0]![3], "explore")
  assert.equal(before.rows[0]![4], "openrouter/kimi")
  assert.equal(before.rows[0]![6], "3")
  assert.notEqual(before.rows[0]![3], "-")
  assert.notEqual(before.rows[0]![4], "-")
  assert.notEqual(before.rows[0]![6], "-")

  sessions[0] = { ...sessions[0]!, outcome: "succeeded" }
  const afterComplete = inspectModel(sessions, sel, 1000)
  assert.equal(afterComplete.runningCount, 1)
  assert.equal(afterComplete.rows[0]![0], STATUS_DOT.succeeded)
  assert.notDeepEqual(afterComplete.rows[0], before.rows[0])

  sessions.push({
    id: "ses_a3",
    title: "[uc:run_abc a3 research p:ses_p] retry",
    outcome: undefined,
    time: { created: 120 },
    agent: "explore",
    model: { providerID: "openrouter", id: "kimi" },
    toolCalls: 2,
  })
  const afterNew = inspectModel(sessions, sel, 1000)
  assert.equal(afterNew.rows.length, 3)
  assert.notEqual(afterNew.pageLabel, before.pageLabel)

  const moved = inspectModel(sessions, { ...sel, selected: 1 }, 1000)
  assert.equal(moved.selected, 1)
  assert.equal(moved.selectedSessionID, "ses_a2")
  assert.notEqual(moved.selectedSessionID, before.selectedSessionID)
})

test("inspectModel: default run is parsed parent, else most recent started", () => {
  const sessions: SessionView[] = [
    { id: "ses_a", title: "[uc:run_a a1 p:ses_parentA] one", outcome: "succeeded", time: { created: 10 } },
    { id: "ses_b1", title: "[uc:run_b a1 p:ses_parentB] two", outcome: undefined, time: { created: 50 } },
    { id: "ses_c", title: "[uc:run_c a1 p:ses_parentC] three", outcome: "succeeded", time: { created: 90 } },
  ]
  const fromB = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_parentB" }, 1000)
  assert.equal(fromB.run?.runID, "run_b")
  assert.equal(fromB.run?.parent, "ses_parentB")
  assert.match(fromB.header, /run 2\/3/)
  assert.equal(defaultRunIndex(fromB.runs, "ses_parentB"), fromB.runIndex)

  const fromUnknown = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_other" }, 1000)
  assert.equal(fromUnknown.run?.runID, "run_c")
  assert.match(fromUnknown.header, /run 3\/3/)

  const cycled = inspectModel(sessions, { runIndex: 0, offset: 0, selected: 0, parentSessionID: "ses_parentB" }, 1000)
  assert.equal(cycled.run?.runID, "run_a")
  assert.match(cycled.header, /run 1\/3/)
})

test("inspectModel: unphased agents live under '-' and remain listed from all", () => {
  const sessions: SessionView[] = [
    {
      id: "ses_1",
      title: "[uc:run_m a1 research p:ses_p] phased",
      outcome: "succeeded",
      time: { created: 1 },
      agent: "explore",
      model: { providerID: "openrouter", id: "kimi" },
      toolCalls: 1,
    },
    {
      id: "ses_2",
      title: "[uc:run_m a2 p:ses_p] unphased",
      outcome: undefined,
      time: { created: 2 },
      agent: "general",
      model: { providerID: "anthropic", id: "sonnet" },
      toolCalls: 0,
    },
  ]
  const all = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 10)
  assert.deepEqual(all.phases, ["all", "research", "-"])
  assert.equal(all.selectedPhase, "all")
  assert.equal(all.rows.length, 2)
  assert.deepEqual(inspectPhaseList(all.run!), ["all", "research", "-"])

  const unphased = inspectModel(sessions, { phase: "-", offset: 0, selected: 0 }, 10)
  assert.equal(unphased.selectedPhase, "-")
  assert.equal(unphased.rows.length, 1)
  assert.equal(unphased.selectedSessionID, "ses_2")
  assert.equal(unphased.rows[0]![1], "a2 unphased")
  assert.ok(unphased.left.some((line) => line.includes("- 0/1") || line.includes("> - ")))
})

test("planSettleCheck: completion then silence → due after quietMs; event before deadline → not due", () => {
  const fired: Record<string, number> = {}
  const lastChange: Record<string, number> = { run_x: 1000 }
  assert.deepEqual(planSettleCheck(fired, lastChange, 5999, 5000), [])
  assert.deepEqual(planSettleCheck(fired, lastChange, 6000, 5000), ["run_x"])
  lastChange.run_x = 4000
  assert.deepEqual(planSettleCheck(fired, lastChange, 6000, 5000), [])
  fired.run_x = 1
  lastChange.run_x = 1000
  assert.deepEqual(planSettleCheck(fired, lastChange, 99_000, 5000), [])
})

test("parseRunAck", () => {
  assert.deepEqual(parseRunAck("paused run_abc123"), { runID: "run_abc123", kind: "paused" })
  assert.deepEqual(parseRunAck("Paused run `run_abc123` — status: paused"), { runID: "run_abc123", kind: "paused" })
  assert.deepEqual(parseRunAck("resumed run_abc123"), { runID: "run_abc123", kind: "resumed" })
  assert.deepEqual(parseRunAck("Resumed run `run_abc123` — status: running"), { runID: "run_abc123", kind: "resumed" })
  assert.deepEqual(parseRunAck("Stopping run `run_abc123` — in-flight agents will be interrupted."), {
    runID: "run_abc123",
    kind: "stopped",
  })
  assert.deepEqual(parseRunAck("Saved workflow `demo` from run `run_abc123`"), { runID: "run_abc123", kind: "saved" })
  assert.equal(parseRunAck("cannot pause run `run_abc123` (status: succeeded)")?.kind, "error")
  assert.equal(parseRunAck("error: supervisor unavailable")?.kind, "error")
  assert.equal(parseRunAck(""), undefined)
  assert.equal(parseRunAck("hello world"), undefined)
})

test("detailsFromMessages: last assistant model + tool part count", () => {
  const got = detailsFromMessages([
    { type: "user", content: [{ type: "text" }] },
    {
      type: "assistant",
      model: { providerID: "openrouter", id: "kimi" },
      content: [{ type: "text" }, { type: "tool" }, { type: "tool" }],
    },
    {
      type: "assistant",
      model: { providerID: "anthropic", id: "sonnet" },
      content: [{ type: "tool" }],
    },
  ])
  assert.deepEqual(got.model, { providerID: "anthropic", id: "sonnet" })
  assert.equal(got.toolCalls, 3)
})

