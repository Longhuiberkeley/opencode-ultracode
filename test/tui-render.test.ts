/**
 * Pure TUI inspect helpers (version gate, grouping, cells, pagination, settle).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { agentCells } from "../src/run-format.ts"
import type { AgentRecord, TokenUsage } from "../src/types.ts"
import {
  STATUS_DOT,
  agentRows,
  applySettleTick,
  cacheDecision,
  canRefreshRunSettings,
  chipCounts,
  compactRunAcks,
  cycleRunSelection,
  defaultRunIndex,
  detailsCacheEntry,
  detailsFromMessages,
  filterSessionsForChip,
  footerHints,
  formatChipText,
  formatCounts,
  formatPermissionLines,
  formatDetailLines,
  formatTreeLines,
  groupRuns,
  inspectModel,
  inspectPaneView,
  inspectPhaseList,
  inspectSelFromSelection,
  moveTree,
  nextSettlePrev,
  outcomeToStatus,
  PAGE_HEIGHT,
  paginate,
  parsePermissionList,
  parseRunAck,
  pausedRunIDsFromAcks,
  permissionsForRun,
  phaseDetailLines,
  runStripLines,
  runsForParent,
  phaseColumns,
  planSettleCheck,
  runFingerprint,
  runningRunCount,
  sessionToStatus,
  selectForOpen,
  selectedSessionID,
  selectionMapKey,
  UNSEEN_RUN_SELECTION,
  settleCandidate,
  shouldEnableTui,
  shortRunID,
  clip,
  clipPaneLines,
  cycleInspectPane,
  formatLiveStrip,
  formatSettingsLines,
  settingsPaneView,
  splitPanelWidth,
  toggleExpand,
  toggleFollowPin,
  treePaneTitle,
  twoColumn,
  type InspectPane,
  type InspectSelection,
  type RunView,
  type SessionView,
  type SettlePrev,
  type TreeSelection,
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
  assert.deepEqual(paginate(rows, 0, 2), { window: ["a", "b"], label: "1–2 of 5", offset: 0 })
  assert.deepEqual(paginate(rows, 2, 2), { window: ["c", "d"], label: "3–4 of 5", offset: 2 })
  assert.deepEqual(paginate(rows, 4, 2), { window: ["d", "e"], label: "4–5 of 5", offset: 3 })
  assert.deepEqual(paginate(rows, -3, 2), { window: ["a", "b"], label: "1–2 of 5", offset: 0 })
  assert.deepEqual(paginate(rows, 99, 2), { window: ["d", "e"], label: "4–5 of 5", offset: 3 })
  assert.deepEqual(paginate(rows, 0, 10), { window: rows, label: "1–5 of 5", offset: 0 })
  assert.deepEqual(paginate([], 0, 5), { window: [], label: "0–0 of 0", offset: 0 })
  assert.deepEqual(paginate(rows, 0, 0), { window: ["a"], label: "1–1 of 5", offset: 0 })
})

test("paginate: 12 rows, offset 11 → window starts at 2; selected index consistent both directions", () => {
  const rows = Array.from({ length: 12 }, (_, i) => `r${i}`)
  const page = paginate(rows, 11, 10)
  assert.equal(page.offset, 2)
  assert.deepEqual(page.window, rows.slice(2, 12))
  assert.equal(page.window[0], rows[page.offset])
  const sessions: SessionView[] = rows.map((title, i) => ({
    id: `ses_${i}`,
    title: `[uc:run_p a${i + 1} p:ses_p] ${title}`,
    outcome: "succeeded",
    time: { created: i },
  }))
  const model = inspectModel(sessions, { offset: 11, selected: 11, parentSessionID: "ses_p" }, 1000)
  assert.equal(model.offset, 2)
  assert.equal(model.rows.length, 12)
  assert.equal(model.window.length, 10)
  assert.equal(model.window[0], model.rows[model.offset])
  assert.equal(model.selected, 11)
  assert.equal(model.rowInWindow, 9)
  assert.equal(model.offset + model.rowInWindow, model.selected)
  assert.equal(selectedSessionID(model), "ses_11")
  assert.equal(selectedSessionID(model), model.sessionIDs[model.offset + model.rowInWindow])
  assert.equal(model.selectedSessionID, selectedSessionID(model))
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
  assert.equal(
    footerHints(["up", "down", "x", "p", "s", "return", "right", "esc"]),
    "↑↓ move  ←→ expand  enter drill  p pause/resume  x stop  s save  esc or ctrl+g close",
  )
  assert.equal(footerHints(["x", "esc"]), "x stop  esc or ctrl+g close")
  assert.equal(footerHints(["enter"]), "enter drill")
  assert.equal(footerHints(["right"]), "←→ expand")
  assert.equal(footerHints(["p", "custom"]), "p pause/resume  custom")
  assert.equal(footerHints(["[", "]"]), "[ ] run")
  assert.equal(footerHints(["."]), ". follow/pin")
  assert.equal(footerHints(["y", "n"]), "y/n perm")
  assert.equal(
    footerHints(["up", "down", "left", "right", "h", "l", "return", "[", "]", "p", "x", "s", "esc", "ctrl+g"]),
    "↑↓ move  ←→ expand  h/l pane  enter drill  [ ] run  p pause/resume  x stop  s save  esc or ctrl+g close",
  )
  assert.equal(footerHints(["+", "-", "="]), "+/- edit")
  assert.equal(footerHints(["r"]), "r refresh")
  assert.equal(footerHints(["escape"]), "esc or ctrl+g close")
  assert.equal(footerHints(["f"]), "f fullscreen")
  assert.doesNotMatch(footerHints(["esc", "escape", "ctrl+g"]), /\bescape\b/)
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
  assert.equal(fromB.runs.length, 1)
  assert.match(fromB.header, /run 1\/1/)
  assert.equal(defaultRunIndex(fromB.runs, "ses_parentB"), fromB.runIndex)

  const fromUnknown = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_other" }, 1000)
  assert.equal(fromUnknown.run, undefined)
  assert.equal(fromUnknown.runs.length, 0)

  const cycled = inspectModel(sessions, { runIndex: 0, offset: 0, selected: 0, parentSessionID: "ses_parentB" }, 1000)
  assert.equal(cycled.run?.runID, "run_b")
  assert.match(cycled.header, /run 1\/1/)
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

test("cycleRunSelection: cycling into unseen shorter run initializes defaults", () => {
  const long: SessionView[] = Array.from({ length: 12 }, (_, i) => ({
    id: `ses_long_${i}`,
    title: `[uc:run_long a${i + 1} p:ses_p] L${i}`,
    outcome: "succeeded",
    time: { created: i },
  }))
  const short: SessionView[] = [
    { id: "ses_short_0", title: "[uc:run_short a1 p:ses_p] S0", outcome: "succeeded", time: { created: 100 } },
    { id: "ses_short_1", title: "[uc:run_short a2 p:ses_p] S1", outcome: "succeeded", time: { created: 101 } },
  ]
  const runs = groupRuns([...long, ...short])
  assert.deepEqual(
    runs.map((r) => r.runID),
    ["run_long", "run_short"],
  )
  const selMap = {
    [selectionMapKey("ses_p", "run_long")]: {
      phase: "all", offset: 2, selected: 11, runID: "run_long", parentSessionID: "ses_p", rowInWindow: 9,
    },
  }
  const intoShort = cycleRunSelection(selMap, runs, "run_long", 1, "ses_p")
  assert.equal(intoShort.runID, "run_short")
  assert.deepEqual(intoShort.selection, { ...UNSEEN_RUN_SELECTION, pinned: true })
  assert.equal(intoShort.selection.selected, 0)
  assert.equal(intoShort.selection.rowInWindow, 0)

  const back = cycleRunSelection(selMap, runs, "run_short", -1, "ses_p")
  assert.equal(back.runID, "run_long")
  assert.equal(back.selection.selected, 11)
  assert.equal(back.selection.offset, 2)
})

test("cycleRunSelection: per-parent selection restoration (no cross-parent borrow)", () => {
  const mk = (run: string, parent: string): SessionView[] => [
    { id: `${run}_${parent}_0`, title: `[uc:${run} a1 p:${parent}] x`, outcome: "succeeded", time: { created: 1 } },
    { id: `${run}_${parent}_1`, title: `[uc:${run} a2 p:${parent}] y`, outcome: "succeeded", time: { created: 2 } },
    { id: `${run}_${parent}_2`, title: `[uc:${run} a3 p:${parent}] z`, outcome: "succeeded", time: { created: 3 } },
  ]
  const runs = groupRuns([...mk("run_r", "ses_P"), ...mk("run_r", "ses_Q")])
  // same runID observed under two parents yields one grouped run; selections are per (parent, run)
  const selMap = {
    [selectionMapKey("ses_P", "run_r")]: {
      phase: "all", offset: 0, selected: 2, runID: "run_r", parentSessionID: "ses_P", rowInWindow: 2,
    },
    [selectionMapKey("ses_Q", "run_r")]: {
      phase: "-", offset: 0, selected: 0, runID: "run_r", parentSessionID: "ses_Q", rowInWindow: 0,
    },
    [selectionMapKey("ses_Q", "run_other")]: {
      phase: "all", offset: 0, selected: 1, runID: "run_other", parentSessionID: "ses_Q", rowInWindow: 1,
    },
  }
  const fromQ = cycleRunSelection(selMap, runs, "run_other", 1, "ses_Q")
  assert.equal(fromQ.runID, "run_r")
  assert.equal(fromQ.selection.phase, "-")
  assert.equal(fromQ.selection.selected, 0)
  const fromP = cycleRunSelection(selMap, runs, undefined, 0, "ses_P")
  assert.equal(fromP.runID, "run_r")
  assert.equal(fromP.selection.selected, 2)
})

test("inspectModel: marker index equals normalized selected; selectedSessionID is highlighted row", () => {
  const sessions: SessionView[] = [
    { id: "ses_0", title: "[uc:run_s a1 p:ses_p] A", outcome: "succeeded", time: { created: 0 } },
    { id: "ses_1", title: "[uc:run_s a2 p:ses_p] B", outcome: "succeeded", time: { created: 1 } },
  ]
  const model = inspectModel(sessions, { offset: 0, selected: 11, parentSessionID: "ses_p" }, 1000)
  assert.equal(model.rows.length, 2)
  assert.equal(model.selected, 1)
  assert.equal(model.rowInWindow, 1)
  assert.equal(model.offset + model.rowInWindow, model.selected)
  assert.equal(selectedSessionID(model), "ses_1")
  assert.equal(selectedSessionID(model), model.sessionIDs[model.selected])
  assert.equal(model.selectedSessionID, selectedSessionID(model))

  const top = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 1000)
  assert.equal(top.rowInWindow, 0)
  assert.equal(selectedSessionID(top), "ses_0")
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
  const settingsLine =
    'ultracode-settings {"overlay":{"concurrency":4,"maxAgents":200,"timeoutMs":3600000,"permissions":"ask"},"runID":"run_abc123","effective":{"concurrency":4,"maxAgents":200,"timeoutMs":3600000,"permissions":"ask"}}'
  const settingsAck = parseRunAck(settingsLine)
  assert.equal(settingsAck?.kind, "settings")
  assert.equal(settingsAck?.runID, "run_abc123")
  assert.equal(settingsAck?.settings?.overlay.concurrency, 4)
})

test("settings pane: unhydrated values render as unknown", () => {
  const lines = formatSettingsLines(undefined, 0, false)
  assert.ok(lines.some((l) => l.includes("unknown")))
  assert.ok(lines.some((l) => l.includes("concurrency") && l.includes("unknown")))
  const live = formatLiveStrip(undefined, undefined, undefined, false)
  assert.ok(live.some((l) => l.includes("unknown")))
  const view = settingsPaneView(undefined, { byRun: {}, hydrated: false }, 0, 80)
  assert.ok(view.settingsLines.some((l) => l.includes("unknown")))
})

test("canRefreshRunSettings: only active selected runs", () => {
  const active: RunView = {
    runID: "run_live",
    agents: [],
    phases: [],
    counts: { total: 0, done: 0, failed: 0 },
    startedAt: 0,
    settled: false,
  }
  const settled: RunView = { ...active, runID: "run_done", settled: true }
  assert.equal(canRefreshRunSettings(undefined), false)
  assert.equal(canRefreshRunSettings(active), true)
  assert.equal(canRefreshRunSettings(settled), false)
})

test("settings pane: stale per-run effective is unknown while overlay cache remains", () => {
  const overlay = { concurrency: 4, maxAgents: 200, timeoutMs: 3_600_000, permissions: "ask" as const }
  const run: RunView = {
    runID: "run_other",
    agents: [],
    phases: [],
    counts: { total: 0, done: 0, failed: 0 },
    startedAt: 0,
    settled: false,
  }
  const view = settingsPaneView(
    run,
    { overlay, byRun: { run_cached: overlay }, hydrated: true },
    0,
    80,
  )
  assert.ok(view.settingsLines.some((l) => l.includes("4 / 8")))
  assert.ok(view.liveLines.some((l) => l.includes("unknown")))
})

test("settings pane: hydrated overlay and live snapshot", () => {
  const overlay = { concurrency: 4, maxAgents: 200, timeoutMs: 3_600_000, permissions: "ask" as const }
  const lines = formatSettingsLines(overlay, 0, true)
  assert.ok(lines.some((l) => l.startsWith(">") && l.includes("concurrency") && l.includes("4 / 8")))
  const run: RunView = {
    runID: "run_abc",
    agents: [],
    phases: [],
    counts: { total: 0, done: 0, failed: 0 },
    startedAt: 0,
    settled: false,
  }
  const live = formatLiveStrip(run, overlay, overlay, true)
  assert.ok(live.some((l) => l.includes("conc 4/8")))
})

test("cycleInspectPane: tree → detail → settings", () => {
  assert.equal(cycleInspectPane(undefined, 1), "detail")
  assert.equal(cycleInspectPane("tree", 1), "detail")
  assert.equal(cycleInspectPane("detail", 1), "settings")
  assert.equal(cycleInspectPane("settings", 1), "tree")
  assert.equal(cycleInspectPane("tree", -1), "settings")
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

test("detailsFromMessages + cacheDecision: tentative empty, delete on session event, keep populated", () => {
  const empty = detailsFromMessages([])
  assert.equal(empty.toolCalls, 0)
  assert.equal(empty.model, undefined)
  const tentative = detailsCacheEntry(empty)
  assert.equal(tentative.tentative, true)
  assert.equal(tentative.model, null)
  assert.equal(cacheDecision(tentative, { type: "session.updated", sessionID: "ses_1" }), "delete")
  assert.equal(cacheDecision(tentative, { type: "message.updated", sessionID: "ses_1" }), "delete")
  assert.equal(cacheDecision(undefined, { type: "session.updated", sessionID: "ses_1" }), "skip")
  const populated = detailsCacheEntry({ model: { providerID: "anthropic", id: "sonnet" }, toolCalls: 2 })
  assert.equal(populated.tentative, false)
  assert.equal(cacheDecision(populated, { type: "session.updated", sessionID: "ses_1" }), "keep")
})

test("applySettleTick: complete-all → new child before quietMs → no toast; complete-all → silence → toast once", () => {
  const quietMs = 5000
  const settledAgents = [
    { sessionID: "s1", ord: "a1", status: "succeeded" as const, title: "t1" },
    { sessionID: "s2", ord: "a2", status: "succeeded" as const, title: "t2" },
  ]
  const settled: RunView = {
    runID: "run_x",
    agents: settledAgents,
    phases: [],
    counts: { total: 2, done: 2, failed: 0 },
    startedAt: 0,
    settled: true,
  }
  const maps = { lastChange: {} as Record<string, number>, fired: {} as Record<string, number>, prev: new Map<string, SettlePrev>() }

  assert.deepEqual(applySettleTick([settled], maps, 1000, quietMs), [])
  assert.equal(maps.lastChange.run_x, 1000)

  const withChild: RunView = {
    ...settled,
    settled: false,
    counts: { total: 3, done: 2, failed: 0 },
    agents: [...settledAgents, { sessionID: "s3", ord: "a3", status: "running", title: "t3" }],
  }
  assert.deepEqual(applySettleTick([withChild], maps, 2000, quietMs), [])
  assert.equal(maps.lastChange.run_x, undefined)
  assert.deepEqual(applySettleTick([withChild], maps, 99_000, quietMs), [])
  assert.equal(maps.fired.run_x, undefined)

  const maps2 = { lastChange: {} as Record<string, number>, fired: {} as Record<string, number>, prev: new Map<string, SettlePrev>() }
  assert.deepEqual(applySettleTick([settled], maps2, 1000, quietMs), [])
  assert.deepEqual(applySettleTick([settled], maps2, 5999, quietMs), [])
  assert.deepEqual(applySettleTick([settled], maps2, 6000, quietMs), ["run_x"])
  assert.equal(maps2.fired.run_x, 6000)
  assert.deepEqual(applySettleTick([settled], maps2, 99_000, quietMs), [])
})

test("selectForOpen: parent default, reset on open-parent change, keep same parent", () => {
  const runs: RunView[] = [
    {
      runID: "run_a",
      parent: "ses_p",
      agents: [{ sessionID: "s1", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 0 },
      startedAt: 10,
      settled: false,
    },
    {
      runID: "run_b",
      parent: "ses_q",
      agents: [{ sessionID: "s2", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 0 },
      startedAt: 50,
      settled: false,
    },
  ]
  const fromP = selectForOpen(undefined, runs, "ses_p")
  assert.equal(fromP.runID, "run_a")
  assert.equal(fromP.parentSessionID, "ses_p")
  assert.equal(fromP.phase, "all")
  assert.equal(fromP.offset, 0)
  assert.equal(fromP.selected, 0)

  const moved: InspectSelection = { ...fromP, phase: "research", offset: 3, selected: 2 }
  const sameParent = selectForOpen(moved, runs, "ses_p")
  assert.deepEqual(sameParent, { ...moved, parentSessionID: "ses_p", pinned: false })

  const otherParent = selectForOpen(moved, runs, "ses_q")
  assert.equal(otherParent.runID, "run_b")
  assert.equal(otherParent.parentSessionID, "ses_q")
  assert.equal(otherParent.phase, "all")
  assert.equal(otherParent.offset, 0)
  assert.equal(otherParent.selected, 0)
})

const TREE_SESSIONS: SessionView[] = [
  {
    id: "ses_a1",
    title: "[uc:run_abc a1 research p:ses_p] seeker",
    outcome: undefined,
    time: { created: 100 },
    agent: "explore",
    tokens: TOKENS_42_6K,
    toolCalls: 3,
  },
  {
    id: "ses_a3",
    title: "[uc:run_abc a3 research p:ses_p] retry",
    outcome: "succeeded",
    time: { created: 150 },
    agent: "explore",
    toolCalls: 1,
  },
  {
    id: "ses_a2",
    title: "[uc:run_abc a2 extract p:ses_p] judge",
    outcome: undefined,
    time: { created: 110 },
    agent: "general",
  },
]

test("inspectModel tree: default expanded, cursor on first agent, skip synthetic all", () => {
  const model = inspectModel(TREE_SESSIONS, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 1000)
  assert.equal(model.tree.some((r) => r.id === "all"), false)
  assert.ok(model.tree.every((r) => r.kind !== "phase" || r.expanded !== false))
  assert.deepEqual(
    model.tree.filter((r) => r.kind === "phase").map((r) => r.id),
    ["research", "extract"],
  )
  assert.equal(model.treeSel.cursor.kind, "agent")
  assert.equal(model.treeSel.cursor.id, "ses_a1")
  assert.equal(model.selectedSessionID, "ses_a1")
  const lines = formatTreeLines(model.tree, model.treeSel.cursor)
  assert.ok(lines.some((l) => l.startsWith("▾ research") || l.startsWith(" ▾ research") || l.includes("research")))
  assert.ok(lines[0]!.includes("▾"))
})

test("inspectModel tree: cursor on phase ⇒ selectedSessionID is the phase's first child (Enter drills)", () => {
  const treeSel: TreeSelection = {
    expanded: { research: true, extract: true },
    cursor: { kind: "phase", id: "research" },
    detailOffset: 0,
  }
  const model = inspectModel(
    TREE_SESSIONS,
    { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel },
    1000,
  )
  assert.equal(model.treeSel.cursor.kind, "phase")
  assert.equal(model.treeSel.cursor.id, "research")
  assert.equal(model.selectedSessionID, "ses_a1")
  assert.ok(model.detail[0] === "research")
})

test("W3C expand/collapse: right expands then first child; left collapses / parent", () => {
  const collapsed: TreeSelection = {
    expanded: { research: false, extract: true },
    cursor: { kind: "phase", id: "research" },
    detailOffset: 0,
  }
  const before = inspectModel(
    TREE_SESSIONS,
    { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel: collapsed },
    1000,
  )
  assert.equal(
    before.tree.find((r) => r.kind === "phase" && r.id === "research")?.expanded,
    false,
  )
  assert.equal(
    before.tree.some((r) => r.kind === "agent" && r.phase === "research"),
    false,
  )

  const expanded = toggleExpand(before.tree, before.treeSel, "right")
  const afterExpand = inspectModel(
    TREE_SESSIONS,
    { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel: expanded },
    1000,
  )
  assert.equal(
    afterExpand.tree.find((r) => r.kind === "phase" && r.id === "research")?.expanded,
    true,
  )
  const intoChild = toggleExpand(afterExpand.tree, afterExpand.treeSel, "right")
  assert.equal(intoChild.cursor.kind, "agent")
  assert.equal(intoChild.cursor.id, "ses_a1")

  const toParent = toggleExpand(afterExpand.tree, intoChild, "left")
  assert.deepEqual(toParent.cursor, { kind: "phase", id: "research" })
  const collapsedAgain = toggleExpand(afterExpand.tree, toParent, "left")
  assert.equal(collapsedAgain.expanded.research, false)
})

test("phase detail lists its children (status, label, tokens) — a phase row is informative alone", () => {
  const model = inspectModel(
    TREE_SESSIONS,
    { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel: { expanded: {}, cursor: { kind: "phase", id: "research" }, detailOffset: 0 } },
    1000,
  )
  const lines = phaseDetailLines(model.run!, "research")
  assert.equal(lines[0], "research")
  assert.match(lines[1]!, /agents  \d+\/\d+/)
  // child rows: status dot + label
  assert.ok(lines.slice(3).some((l) => l.includes("seeker")), "child labels appear in phase detail")
  assert.ok(lines.slice(3).some((l) => /✓|●|○|✗|■/.test(l)), "child status dots appear")
})

test("phase cursor drills into the phase's first child session (Enter works on phase rows)", () => {
  const model = inspectModel(
    TREE_SESSIONS,
    { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel: { expanded: {}, cursor: { kind: "phase", id: "extract" }, detailOffset: 0 } },
    1000,
  )
  assert.equal(model.selectedSessionID, "ses_a2")
})

test("tree cursor mark stays visible while the detail pane is focused (RC1)", () => {
  const model = inspectModel(TREE_SESSIONS, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 1000)
  const lines = formatTreeLines(model.tree, model.treeSel.cursor, "detail")
  assert.ok(lines.some((l) => l.startsWith(">")), "cursor mark renders even in detail focus")
})

test("tree selection: collapse while a child row is selected moves cursor to the parent phase", () => {
  const treeSel: TreeSelection = {
    expanded: { research: false, extract: true },
    cursor: { kind: "agent", id: "ses_a1" },
    detailOffset: 0,
  }
  const model = inspectModel(
    TREE_SESSIONS,
    { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel },
    1000,
  )
  assert.deepEqual(model.treeSel.cursor, { kind: "phase", id: "research" })
  assert.equal(model.selectedSessionID, "ses_a1")
})

test("tree selection: newly arriving agents do not steal the cursor", () => {
  const sessions: SessionView[] = [
    {
      id: "ses_keep",
      title: "[uc:run_n a2 research p:ses_p] keep",
      outcome: undefined,
      time: { created: 20 },
    },
  ]
  const treeSel: TreeSelection = {
    expanded: { research: true },
    cursor: { kind: "agent", id: "ses_keep" },
    detailOffset: 0,
  }
  const before = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel }, 10)
  assert.equal(before.treeSel.cursor.id, "ses_keep")

  sessions.unshift({
    id: "ses_new",
    title: "[uc:run_n a1 research p:ses_p] newcomer",
    outcome: undefined,
    time: { created: 1 },
  })
  const after = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel }, 10)
  assert.equal(after.treeSel.cursor.kind, "agent")
  assert.equal(after.treeSel.cursor.id, "ses_keep")
  assert.equal(after.selectedSessionID, "ses_keep")
  assert.ok(after.tree.some((r) => r.id === "ses_new"))
})

test("tree selection: run switching restores TreeSelection", () => {
  const sessions: SessionView[] = [
    { id: "ses_l0", title: "[uc:run_long a1 research p:ses_p] L0", outcome: "succeeded", time: { created: 0 } },
    { id: "ses_l1", title: "[uc:run_long a2 research p:ses_p] L1", outcome: "succeeded", time: { created: 1 } },
    { id: "ses_s0", title: "[uc:run_short a1 extract p:ses_p] S0", outcome: "succeeded", time: { created: 100 } },
  ]
  const runs = groupRuns(sessions)
  const longTree: TreeSelection = {
    expanded: { research: false },
    cursor: { kind: "phase", id: "research" },
    detailOffset: 0,
  }
  const selMap = {
    [selectionMapKey("ses_p", "run_long")]: {
      phase: "all",
      offset: 0,
      selected: 1,
      runID: "run_long",
      parentSessionID: "ses_p",
      rowInWindow: 1,
      treeSel: longTree,
    },
  }
  const intoShort = cycleRunSelection(selMap, runs, "run_long", 1, "ses_p")
  assert.equal(intoShort.runID, "run_short")
  assert.equal(intoShort.selection.treeSel, undefined)

  const back = cycleRunSelection(selMap, runs, "run_short", -1, "ses_p")
  assert.equal(back.runID, "run_long")
  assert.deepEqual(back.selection.treeSel, longTree)
  const restored = inspectModel(
    sessions,
    inspectSelFromSelection(
      { ...back.selection, runID: back.runID, parentSessionID: "ses_p", phase: back.selection.phase },
      runs,
    ),
    1000,
  )
  assert.equal(restored.run?.runID, "run_long")
  assert.deepEqual(restored.treeSel.cursor, { kind: "phase", id: "research" })
  assert.equal(restored.tree.find((r) => r.id === "research")?.expanded, false)
})

test("tree pane title: run k of N plus short run id; cycling restores TreeSelection", () => {
  const sessions: SessionView[] = [
    { id: "ses_l0", title: "[uc:run_long a1 research p:ses_p] L0", outcome: "succeeded", time: { created: 0 } },
    { id: "ses_l1", title: "[uc:run_long a2 research p:ses_p] L1", outcome: "succeeded", time: { created: 1 } },
    { id: "ses_s0", title: "[uc:run_short a1 extract p:ses_p] S0", outcome: "succeeded", time: { created: 100 } },
  ]
  const runs = groupRuns(sessions)
  const longTree: TreeSelection = {
    expanded: { research: false },
    cursor: { kind: "phase", id: "research" },
    detailOffset: 0,
  }
  const first = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p", runIndex: 0 }, 10)
  assert.equal(treePaneTitle(first), `── tree  run 1 of 2  ${shortRunID("run_long")}`)
  assert.equal(inspectPaneView(first, "tree", 80).treeTitle, treePaneTitle(first))

  const selMap = {
    [selectionMapKey("ses_p", "run_long")]: {
      phase: "all",
      offset: 0,
      selected: 1,
      runID: "run_long",
      parentSessionID: "ses_p",
      rowInWindow: 1,
      treeSel: longTree,
    },
  }
  const intoShort = cycleRunSelection(selMap, runs, "run_long", 1, "ses_p")
  const shortModel = inspectModel(
    sessions,
    inspectSelFromSelection({ ...intoShort.selection, runID: intoShort.runID, parentSessionID: "ses_p", phase: intoShort.selection.phase }, runs),
    10,
  )
  assert.equal(shortModel.run?.runID, "run_short")
  assert.equal(treePaneTitle(shortModel), `── tree  run 2 of 2  ${shortRunID("run_short")}`)
  assert.equal(intoShort.selection.treeSel, undefined)

  const back = cycleRunSelection(selMap, runs, "run_short", -1, "ses_p")
  const restored = inspectModel(
    sessions,
    inspectSelFromSelection({ ...back.selection, runID: back.runID, parentSessionID: "ses_p", phase: back.selection.phase }, runs),
    10,
  )
  assert.equal(treePaneTitle(restored), `── tree  run 1 of 2  ${shortRunID("run_long")}`)
  assert.deepEqual(restored.treeSel.cursor, { kind: "phase", id: "research" })
  assert.equal(restored.tree.find((r) => r.id === "research")?.expanded, false)
})

test("tree selection: pagination beyond ten visible tree rows (PAGE_HEIGHT)", () => {
  const sessions: SessionView[] = Array.from({ length: 12 }, (_, i) => ({
    id: `ses_p${i}`,
    title: `[uc:run_page a${i + 1} wave p:ses_p] r${i}`,
    outcome: "succeeded",
    time: { created: i },
  }))
  const start = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 1000)
  assert.ok(start.tree.length > PAGE_HEIGHT)
  const startIdx = start.tree.findIndex((r) => r.kind === start.treeSel.cursor.kind && r.id === start.treeSel.cursor.id)
  let treeSel = start.treeSel
  for (let i = 0; i < 11; i++) treeSel = moveTree(start.tree, treeSel, 1)
  const paged = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel }, 1000)
  const cursorIdx = startIdx + 11
  assert.equal(paged.treeSel.cursor.id, start.tree[cursorIdx]!.id)
  assert.ok(paged.treeOffset > 0)
  const window = paginate(paged.tree, paged.treeOffset, PAGE_HEIGHT)
  assert.equal(window.window.length, PAGE_HEIGHT)
  assert.equal(window.window[0], paged.tree[paged.treeOffset])
  assert.ok(window.window.some((r) => r.id === paged.treeSel.cursor.id))
  assert.ok(cursorIdx >= PAGE_HEIGHT)
})

test("tree/detail lines clip to pane width (long session and model ids)", () => {
  const sessions: SessionView[] = [
    {
      id: "ses_very_long_session_identifier_that_must_clip",
      title: "[uc:run_clip a1 research p:ses_p] seeker",
      outcome: undefined,
      time: { created: 1 },
      agent: "explore",
      model: { providerID: "openrouter", id: "a-very-long-model-identifier-value" },
      toolCalls: 9,
    },
  ]
  const model = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 10)
  const { tree, detail } = splitPanelWidth(40)
  const treeLines = clipPaneLines(formatTreeLines(model.tree, model.treeSel.cursor), tree)
  const detailLines = clipPaneLines(formatDetailLines(model.detail, "tree", 0), detail)
  for (const line of treeLines) assert.ok(line.length <= tree)
  for (const line of detailLines) assert.ok(line.length <= detail)
  assert.ok(detailLines.some((l) => l.includes("…")))
  assert.equal(clip("ses_very_long_session_identifier_that_must_clip", 10).endsWith("…"), true)
})

test("moveTree walks visible rows without stealing to a new agent", () => {
  const model = inspectModel(TREE_SESSIONS, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 1000)
  const down = moveTree(model.tree, model.treeSel, 1)
  assert.equal(down.cursor.kind, "agent")
  assert.equal(down.cursor.id, "ses_a3")
  const up = moveTree(model.tree, down, -1)
  assert.equal(up.cursor.id, "ses_a1")
})

test("inspect pane paint: mounted accessors update (run, selection, collapse, details, resize)", () => {
  const tuiSrc = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8")
  assert.match(tuiSrc, /createMemo\(\(\) =>\s*\n\s*inspectPaneView\(/)
  assert.match(tuiSrc, /const treeLines = createMemo\(\(\) => paneView\(\)\.treeLines\)/)
  assert.match(tuiSrc, /const detailLines = createMemo\(\(\) => paneView\(\)\.detailLines\)/)
  assert.match(tuiSrc, /const treePageLabel = createMemo\(\(\) => paneView\(\)\.treePageLabel\)/)
  assert.match(tuiSrc, /const treeTitle = createMemo\(\(\) => paneView\(\)\.treeTitle \+/)
  assert.match(tuiSrc, /\{treeLines\(\)\.map\(/)
  assert.match(tuiSrc, /\{detailLines\(\)\.map\(/)
  assert.match(tuiSrc, /\{treePageLabel\(\)\}/)
  assert.match(tuiSrc, /\{treeTitle\(\)\}/)

  let sessions: SessionView[] = []
  let pane: InspectPane | undefined
  let width = 80
  let treeSel: TreeSelection | undefined
  const modelAcc = () =>
    inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p", treeSel, pane }, 1000)

  // Solid: component body runs once. Snapshots freeze; accessors stay live.
  const snapped = inspectPaneView(modelAcc(), pane, width)
  const paneView = () => inspectPaneView(modelAcc(), pane, width)
  const treeLines = () => paneView().treeLines
  const detailLines = () => paneView().detailLines
  const treePageLabel = () => paneView().treePageLabel
  const mounted = {
    tree: () => treeLines().join("\n"),
    detail: () => detailLines().join("\n"),
    label: () => treePageLabel(),
    pane: () => paneView().pane,
    cols: () => paneView().cols,
    hasRun: () => Boolean(modelAcc().run),
  }

  assert.equal(mounted.hasRun(), false)
  assert.equal(mounted.tree(), "")
  assert.equal(snapped.treeLines.join("\n"), "")

  sessions = TREE_SESSIONS.map((s) => ({ ...s }))
  assert.equal(mounted.hasRun(), true)
  assert.ok(mounted.tree().includes("seeker"))
  assert.ok(mounted.tree().split("\n").some((line) => line.startsWith(">") && line.includes("seeker")))
  assert.equal(snapped.treeLines.join("\n"), "")

  const afterRunTree = mounted.tree()
  treeSel = moveTree(modelAcc().tree, modelAcc().treeSel, 1)
  assert.notEqual(mounted.tree(), afterRunTree)
  assert.ok(mounted.tree().split("\n").some((line) => line.startsWith(">") && line.includes("retry")))

  const expandedTree = mounted.tree()
  treeSel = toggleExpand(modelAcc().tree, modelAcc().treeSel, "left")
  treeSel = toggleExpand(modelAcc().tree, treeSel, "left")
  assert.notEqual(mounted.tree(), expandedTree)
  assert.equal(mounted.tree().includes("seeker"), false)

  pane = "detail"
  assert.equal(mounted.pane(), "detail")
  assert.equal(mounted.tree().split("\n").some((line) => line.startsWith(">")), true)
  assert.ok(mounted.detail().startsWith(">"))

  const beforeDetails = mounted.detail()
  sessions = sessions.map((s) =>
    s.id === "ses_a1" ? { ...s, model: { providerID: "openrouter", id: "loaded-model-id" }, toolCalls: 9 } : s,
  )
  treeSel = {
    expanded: { research: true, extract: true },
    cursor: { kind: "agent", id: "ses_a1" },
    detailOffset: 0,
  }
  pane = "tree"
  assert.ok(mounted.detail().includes("loaded-model-id"))
  assert.notEqual(mounted.detail(), beforeDetails)

  const wideCols = mounted.cols()
  width = 20
  const narrow = paneView()
  assert.ok(narrow.cols.tree < wideCols.tree)
  for (const line of narrow.treeLines) assert.ok(line.length <= narrow.cols.tree)
  for (const line of narrow.detailLines) assert.ok(line.length <= narrow.cols.detail)

  sessions = Array.from({ length: 12 }, (_, i) => ({
    id: `ses_p${i}`,
    title: `[uc:run_page a${i + 1} wave p:ses_p] r${i}`,
    outcome: "succeeded" as const,
    time: { created: i },
  }))
  treeSel = undefined
  pane = "tree"
  width = 80
  assert.ok(modelAcc().tree.length > PAGE_HEIGHT)
  assert.ok(mounted.label().includes("↓"))
})

test("sessionToStatus: idle with no execution is pending; terminal executions and outcomes win", () => {
  assert.equal(sessionToStatus({ id: "a", title: "[uc:run_x a1] x" }), "running")
  assert.equal(sessionToStatus({ id: "a", title: "[uc:run_x a1] x", hostStatus: "idle" }), "pending")
  assert.equal(sessionToStatus({ id: "a", title: "[uc:run_x a1] x", lastExecution: "failed" }), "failed")
  assert.equal(sessionToStatus({ id: "a", title: "[uc:run_x a1] x", lastExecution: "interrupted" }), "interrupted")
  assert.equal(sessionToStatus({ id: "a", title: "[uc:run_x a1] x", lastExecution: "succeeded" }), "succeeded")
  assert.equal(
    sessionToStatus({ id: "a", title: "[uc:run_x a1] x", outcome: "succeeded", hostStatus: "idle" }),
    "succeeded",
  )
})

test("groupRuns: idle no-execution orphans are pending — never running, chip and counts hide them", () => {
  const sessions: SessionView[] = [
    { id: "ses_1", title: "[uc:run_orphan a1 p:ses_p] seeker", outcome: undefined, hostStatus: "idle", time: { created: 1 } },
    { id: "ses_2", title: "[uc:run_orphan a2 p:ses_p] judge", lastExecution: "failed", time: { created: 2 } },
  ]
  const runs = groupRuns(sessions)
  assert.equal(runs.length, 1)
  assert.equal(runs[0]!.settled, false)
  assert.equal(runs[0]!.agents[0]!.status, "pending")
  assert.equal(runs[0]!.agents[1]!.status, "failed")
  assert.equal(runningRunCount(runs), 0)
  assert.equal(inspectModel(sessions, { offset: 0, selected: 0 }, 10).runningCount, 0)
  assert.deepEqual(chipCounts(runs), { running: 0, paused: 0, failed: 0, agents: 0 })
})

test("filterSessionsForChip: other project directories do not leak", () => {
  const sessions: SessionView[] = [
    { id: "here", title: "[uc:run_a a1] x", locationDirectory: "/proj/a", projectID: "p-a" },
    { id: "there", title: "[uc:run_b a1] y", locationDirectory: "/proj/b", projectID: "p-b" },
    { id: "bare", title: "[uc:run_c a1] z" },
  ]
  const scoped = filterSessionsForChip(sessions, { directory: "/proj/a" })
  assert.deepEqual(
    scoped.map((s) => s.id),
    ["here"],
  )
  assert.equal(filterSessionsForChip(sessions, undefined).length, 0)
})

test("session scoping fails closed when project scope cannot be determined", () => {
  const sessions: SessionView[] = [
    { id: "here", title: "[uc:run_a a1] x", locationDirectory: "/proj/a", projectID: "p-a" },
    { id: "bare", title: "[uc:run_c a1] z" },
  ]
  assert.deepEqual(filterSessionsForChip(sessions, undefined), [])
  assert.deepEqual(filterSessionsForChip(sessions, {}), [])
  assert.equal(filterSessionsForChip(sessions, { directory: "/proj/a" }).map((s) => s.id).join(), "here")
})

test("inspectModel uses the same project-scoped filter as the chip", () => {
  const sessions: SessionView[] = [
    { id: "here", title: "[uc:run_a a1 p:ses_p] x", locationDirectory: "/proj/a", projectID: "p-a", time: { created: 1 } },
    { id: "there", title: "[uc:run_b a1 p:ses_q] y", locationDirectory: "/proj/b", projectID: "p-b", time: { created: 2 } },
  ]
  const scope = { directory: "/proj/a", projectID: "p-a" }
  const scoped = filterSessionsForChip(sessions, scope)
  const model = inspectModel(scoped, { offset: 0, selected: 0 }, 10)
  const chipRuns = groupRuns(scoped)
  assert.deepEqual(
    model.runs.map((r) => r.runID),
    chipRuns.map((r) => r.runID),
  )
  assert.deepEqual(
    model.runs.map((r) => r.runID),
    ["run_a"],
  )
  assert.equal(inspectModel(sessions, { offset: 0, selected: 0 }, 10).runs.length, 2)
})

test("formatChipText: hide when idle; running/paused/failed only when real", () => {
  assert.equal(formatChipText({ running: 0, paused: 0, failed: 2 }), "")
  assert.equal(formatChipText({ running: 2, paused: 0, failed: 0 }), "ultracode · 2 runs")
  assert.equal(formatChipText({ running: 0, paused: 1, failed: 0 }), "ultracode · 1 paused")
  assert.equal(formatChipText({ running: 1, paused: 1, failed: 2 }), "ultracode · 1 run · 1 paused · 2 failed")
  assert.equal(
    formatChipText({ running: 1, paused: 0, failed: 0, agents: 3, blocked: 2 }),
    "ultracode · 1 run · 3 agents · 2 awaiting permission",
  )
  const runs: RunView[] = [
    {
      runID: "run_live",
      agents: [{ sessionID: "s1", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 1 },
      startedAt: 0,
      settled: false,
    },
    {
      runID: "run_pause",
      agents: [{ sessionID: "s2", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 0 },
      startedAt: 0,
      settled: false,
    },
    {
      runID: "run_done",
      agents: [{ sessionID: "s3", status: "succeeded", title: "t" }],
      phases: [],
      counts: { total: 1, done: 1, failed: 0 },
      startedAt: 0,
      settled: true,
    },
  ]
  assert.deepEqual(chipCounts(runs, new Set(["run_pause"])), { running: 1, paused: 1, failed: 1, agents: 2 })
  const withRunPaused = runs.map((r) => (r.runID === "run_pause" ? { ...r, paused: true } : r))
  assert.deepEqual(chipCounts(withRunPaused), { running: 1, paused: 1, failed: 1, agents: 2 })
})

test("compactRunAcks keeps last pause/resume/stop ack per runID", () => {
  const acks = [
    parseRunAck("Paused run `run_a`")!,
    parseRunAck("Paused run `run_b`")!,
    parseRunAck("Resumed run `run_a`")!,
    parseRunAck("Stopping run `run_b`")!,
    parseRunAck("Paused run `run_a`")!,
  ]
  const compact = compactRunAcks(acks)
  assert.equal(compact.length, 2)
  assert.equal(compact.find((a) => a.runID === "run_a")?.kind, "paused")
  assert.equal(compact.find((a) => a.runID === "run_b")?.kind, "stopped")
  const ids = pausedRunIDsFromAcks(compact)
  assert.equal(ids.has("run_a"), true)
  assert.equal(ids.has("run_b"), false)
  assert.deepEqual(ids, pausedRunIDsFromAcks(acks))
})

test("paused chip shows only while the run still has unsettled work; ended-while-paused drops off", () => {
  const settled: RunView[] = [
    {
      runID: "run_pause",
      agents: [{ sessionID: "s1", status: "succeeded", title: "t" }],
      phases: [],
      counts: { total: 1, done: 1, failed: 0 },
      startedAt: 0,
      settled: true,
    },
  ]
  // All children final + paused ack: the run ended while paused (nothing will
  // ever clear the ack) — it must NOT become an eternal "1 paused".
  assert.deepEqual(chipCounts(settled, new Set(["run_pause"])), { running: 0, paused: 0, failed: 0, agents: 0 })
  const withFlag = settled.map((r) => ({ ...r, paused: true }))
  assert.deepEqual(chipCounts(withFlag), { running: 0, paused: 0, failed: 0, agents: 0 })

  // Work still in flight (pending child or running child): paused is real.
  const inFlight = settled.map((r): RunView => ({
    ...r,
    settled: false,
    agents: [{ sessionID: "s1", status: "pending", title: "t" }],
  }))
  assert.deepEqual(chipCounts(inFlight, new Set(["run_pause"])), { running: 0, paused: 1, failed: 0, agents: 0 })
  const runningChild = settled.map((r): RunView => ({
    ...r,
    settled: false,
    agents: [{ sessionID: "s1", status: "running", title: "t" }],
  }))
  assert.deepEqual(chipCounts(runningChild, new Set(["run_pause"])), { running: 0, paused: 1, failed: 0, agents: 1 })
  assert.equal(formatChipText(chipCounts(inFlight, new Set(["run_pause"]))), "ultracode · 1 paused")
})

test("chipCounts: pending-only runs are invisible; running+pending counts as running", () => {
  const pendingOnly: RunView[] = [
    {
      runID: "run_q",
      agents: [
        { sessionID: "s1", status: "pending", title: "t" },
        { sessionID: "s2", status: "pending", title: "t" },
      ],
      phases: [],
      counts: { total: 2, done: 0, failed: 0 },
      startedAt: 0,
      settled: false,
    },
  ]
  assert.deepEqual(chipCounts(pendingOnly), { running: 0, paused: 0, failed: 0, agents: 0 })
  assert.equal(formatChipText(chipCounts(pendingOnly)), "")

  const mixed: RunView[] = [
    {
      runID: "run_m",
      agents: [
        { sessionID: "s1", status: "running", title: "t" },
        { sessionID: "s2", status: "pending", title: "t" },
      ],
      phases: [],
      counts: { total: 2, done: 0, failed: 1 },
      startedAt: 0,
      settled: false,
    },
  ]
  assert.deepEqual(chipCounts(mixed), { running: 1, paused: 0, failed: 1, agents: 1 })
  assert.equal(runningRunCount(mixed), 1)
  assert.equal(runningRunCount(pendingOnly), 0)
})

test("paused chip counts derive from run or ack state", () => {
  const acks = [
    parseRunAck("Paused run `run_a`")!,
    parseRunAck("Resumed run `run_a`")!,
    parseRunAck("Paused run `run_b`")!,
    parseRunAck("Stopping run `run_b`")!,
    parseRunAck("Paused run `run_c`")!,
  ]
  const ids = pausedRunIDsFromAcks(acks)
  assert.equal(ids.has("run_a"), false)
  assert.equal(ids.has("run_b"), false)
  assert.equal(ids.has("run_c"), true)
  const runs: RunView[] = [
    {
      runID: "run_c",
      agents: [{ sessionID: "s1", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 0 },
      startedAt: 0,
      settled: false,
    },
    {
      runID: "run_d",
      agents: [{ sessionID: "s2", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 0 },
      startedAt: 0,
      settled: false,
      paused: true,
    },
  ]
  assert.deepEqual(chipCounts(runs, ids), { running: 0, paused: 2, failed: 0, agents: 2 })
})

test("formatTreeLines: connectors and selected mark", () => {
  const model = inspectModel(TREE_SESSIONS, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 1000)
  const lines = formatTreeLines(model.tree, model.treeSel.cursor)
  assert.ok(lines.some((l) => l.includes("├─") || l.includes("└─")))
  assert.ok(lines.some((l) => l.startsWith(">") && l.includes("seeker")))
  assert.ok(lines.some((l) => l.includes("▾") && l.includes("research")))
})

test("tui chip paints formatChipText and binds ctrl+g, not return", () => {
  const tuiSrc = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8")
  assert.match(tuiSrc, /formatChipText\(counts\)/)
  assert.match(tuiSrc, /filterSessionsForChip\(/)
  assert.match(tuiSrc, /bind: "ctrl\+g"/)
  assert.doesNotMatch(tuiSrc, /id: "ultracode\.inspect\.chip\.open"/)
  const chipStart = tuiSrc.indexOf("function Chip(")
  const panelStart = tuiSrc.indexOf("function Panel(")
  assert.ok(chipStart >= 0 && panelStart > chipStart)
  const chipSrc = tuiSrc.slice(chipStart, panelStart)
  assert.doesNotMatch(chipSrc, /bind: "return"/)
  assert.match(tuiSrc, /id: "ultracode\.inspect\.open"[\s\S]*?bind: "return"/)
  assert.match(tuiSrc, /treeTitle\(\)/)
  assert.match(tuiSrc, /PANE_TITLE_DETAIL/)
  assert.doesNotMatch(tuiSrc, /lastSettingsQuery/)
  assert.match(tuiSrc, /id: "ultracode\.inspect\.close\.escape"[\s\S]*?bind: "escape"/)
  assert.match(tuiSrc, /id: "ultracode\.inspect\.settings\.refresh"[\s\S]*?bind: "r"/)
  assert.match(tuiSrc, /canRefreshRunSettings/)
  assert.match(tuiSrc, /scopedSessionSnapshot/)
  assert.match(tuiSrc, /pausedRunIDsFromAcks/)
  assert.match(tuiSrc, /compactRunAcks/)
  assert.match(tuiSrc, /paused: true/)
  assert.match(tuiSrc, /hydrated\.hydrated/)
  assert.doesNotMatch(tuiSrc, /pane === "settings" \? "s" : "open"/)
  assert.doesNotMatch(tuiSrc, /pauseIntent/)
  assert.match(tuiSrc, /inspectModel\(snapshot/)
  assert.match(tuiSrc, /filterSessionsForChip\(currentSessionSnapshot\(\)/)
  assert.match(tuiSrc, /runStripLines\(/)
  assert.match(tuiSrc, /toggleFollowPin\(/)
  assert.match(tuiSrc, /client\?\.permission/)
  assert.match(tuiSrc, /replyPermission\("once"\)/)
  assert.match(tuiSrc, /replyPermission\("reject"\)/)
  assert.doesNotMatch(tuiSrc, /reply:\s*"always"/)
  assert.match(tuiSrc, /includeFinished:\s*true/)
})

test("runStripLines: visible picker marks follow-latest vs pinned", () => {
  const runs: RunView[] = [
    {
      runID: "run_alpha",
      name: "alpha",
      parent: "ses_p",
      agents: [{ sessionID: "s1", status: "running", title: "t" }],
      phases: [],
      counts: { total: 1, done: 0, failed: 0 },
      startedAt: 2,
      settled: false,
    },
    {
      runID: "run_beta",
      workflowName: "beta",
      parent: "ses_p",
      agents: [{ sessionID: "s2", status: "succeeded", title: "t" }],
      phases: [],
      counts: { total: 1, done: 1, failed: 0 },
      startedAt: 1,
      settled: true,
    },
  ]
  const follow = runStripLines(runs, "run_alpha")
  assert.match(follow[0]!, /follow-latest/)
  assert.doesNotMatch(follow[0]!, /\[ \] switch/, "picker header carries view context, not key hints")
  assert.ok(follow.some((l) => l.startsWith("* ") && l.includes("run_alpha")))
  const pinned = runStripLines(runs, "run_beta", { pinned: true })
  assert.match(pinned[0]!, /pinned/)
  assert.ok(pinned.some((l) => l.startsWith("* ") && l.includes("run_beta")))
})

test("selectForOpen: pinned history sticks; unpinned follows latest after settle", () => {
  const older: RunView = {
    runID: "run_old",
    parent: "ses_p",
    agents: [{ sessionID: "s1", status: "succeeded", title: "t" }],
    phases: [],
    counts: { total: 1, done: 1, failed: 0 },
    startedAt: 1,
    settled: true,
  }
  const newer: RunView = {
    runID: "run_new",
    parent: "ses_p",
    agents: [{ sessionID: "s2", status: "running", title: "t" }],
    phases: [],
    counts: { total: 1, done: 0, failed: 0 },
    startedAt: 9,
    settled: false,
  }
  const pinned = selectForOpen(
    { parentSessionID: "ses_p", runID: "run_old", phase: "all", offset: 0, selected: 0, pinned: true },
    [older, newer],
    "ses_p",
  )
  assert.equal(pinned.runID, "run_old")
  assert.equal(pinned.pinned, true)
  const follow = selectForOpen(
    { parentSessionID: "ses_p", runID: "run_old", phase: "all", offset: 0, selected: 0, pinned: false },
    [older, newer],
    "ses_p",
  )
  assert.equal(follow.runID, "run_new")
  assert.equal(follow.pinned, false)
  const toggled = toggleFollowPin(follow)
  assert.equal(toggled.pinned, true)
})

test("inspectModel and runsForParent scope inventory to the open parent", () => {
  const sessions: SessionView[] = [
    { id: "here", title: "[uc:run_a a1 p:ses_p] x", time: { created: 1 } },
    { id: "there", title: "[uc:run_b a1 p:ses_q] y", time: { created: 2 } },
  ]
  const model = inspectModel(sessions, { offset: 0, selected: 0, parentSessionID: "ses_p" }, 10)
  assert.deepEqual(
    model.runs.map((r) => r.runID),
    ["run_a"],
  )
  const mixed: RunView[] = [
    { runID: "run_a", parent: "ses_p", agents: [], phases: [], counts: { total: 0, done: 0, failed: 0 }, startedAt: 1, settled: true },
    { runID: "run_b", parent: "ses_q", agents: [], phases: [], counts: { total: 0, done: 0, failed: 0 }, startedAt: 2, settled: true },
  ]
  assert.deepEqual(
    runsForParent(mixed, "ses_p").map((r) => r.runID),
    ["run_a"],
  )
})

test("parsePermissionList and formatPermissionLines: blocked child, never always", () => {
  const items = parsePermissionList({
    data: [
      { id: "perm_1", sessionID: "ses_child", action: "edit", resources: ["/proj/a.ts"], message: "write" },
      { id: "skip", action: "edit" },
    ],
  })
  assert.equal(items.length, 1)
  assert.equal(items[0]!.id, "perm_1")
  const run: RunView = {
    runID: "run_a",
    agents: [{ sessionID: "ses_child", status: "running", title: "t" }],
    phases: [],
    counts: { total: 1, done: 0, failed: 0 },
    startedAt: 0,
    settled: false,
  }
  const forRun = permissionsForRun(run, items)
  assert.equal(forRun.length, 1)
  const lines = formatPermissionLines(forRun)
  assert.match(lines[0]!, /awaiting permission 1/)
  assert.doesNotMatch(lines[0]!, /allow once/, "key hints live in the footer only")
  assert.match(lines[1]!, /ses_child/)
  assert.doesNotMatch(lines.join("\n"), /always/)
})
