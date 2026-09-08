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
  formatCounts,
  groupRuns,
  nextSettlePrev,
  outcomeToStatus,
  paginate,
  phaseColumns,
  runFingerprint,
  runningRunCount,
  settleCandidate,
  shouldEnableTui,
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
    { id: "ses_a2", title: "[uc:run_abc a2 extract] judge", outcome: "failed", time: { created: 200 } },
    { id: "ses_a1", title: "[uc:run_abc a1 research] seeker", outcome: undefined, time: { created: 100 }, tokens: TOKENS_42_6K },
    { id: "ses_b", title: "[uc:run_other a1] other", outcome: "succeeded", time: 50 },
    { id: "ses_a3", title: "[uc:run_abc a3 research] retry", outcome: "succeeded", time: { created: 150 } },
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
        title: "[uc:run_abc123def456 a3 extract] seeker",
      },
      {
        sessionID: "ses_2",
        ord: "a1",
        phase: "verify",
        label: undefined,
        status: "pending",
        title: "[uc:run_abc123def456 a1 verify] a1",
      },
      {
        sessionID: "ses_3",
        ord: "a2",
        phase: "verify",
        label: "judge",
        status: "failed",
        title: "[uc:run_abc123def456 a2 verify] judge",
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
  }
  const sparse: AgentRecord = {
    id: "a1",
    phase: "verify",
    status: "pending",
    sessionID: "ses_2",
  }
  const failed: AgentRecord = {
    id: "a2",
    label: "judge",
    phase: "verify",
    status: "failed",
    sessionID: "ses_3",
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

  // Explicit golden strings (D11 columns 1–6 + status dots).
  assert.deepEqual(expectedFull, ["●", "a3 seeker", "extract", "-", "-", "42.6k", "-"])
  assert.deepEqual(expectedSparse, ["○", "a1", "verify", "-", "-", "-", "-"])
  assert.deepEqual(expectedFailed, ["✗", "a2 judge", "verify", "-", "-", "-", "-"])
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
