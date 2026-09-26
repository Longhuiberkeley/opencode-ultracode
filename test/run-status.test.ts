/**
 * Authoritative status merge, fallback expiry window, rpc-unavailable path.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  FALLBACK_STALE_MS,
  agentStatusKey,
  authoritativeFromRecord,
  collectRemoteRunChanges,
  collectRunStatus,
  hasRpcClientFactory,
  hasRpcRegister,
  isFallbackExpired,
  parseRunStatusResponse,
  parseSettingsResponse,
  runLivenessSuffix,
  runStateTransition,
  selectAuthoritative,
  sessionActivityMs,
} from "../src/run-status.ts"
import { agentDetailLines, chipCounts, filterSnapshotsForChip, inspectModel, mergeAuthoritativeRuns, parsePermissionList, permissionsForRun, sessionToStatus, wrapPaneLines, type RunView } from "../src/tui-render.ts"
import { RUNS_SCAN_TTL_MS, refreshRunsIfStale } from "../src/storage.ts"
import type { RunRecord } from "../src/types.ts"
import { RegistryImpl } from "../src/registry.ts"

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_live1",
    parentSessionID: "ses_p",
    status: "running",
    script: "return 1",
    startedAt: 1000,
    agents: [{ id: "a1", status: "running" }],
    ...overrides,
  }
}

function heuristicRun(overrides: Partial<RunView> = {}): RunView {
  return {
    runID: "run_h",
    agents: [{ sessionID: "ses_a", status: "running", title: "[uc:run_h a1] x" }],
    phases: ["do"],
    counts: { total: 1, done: 0, failed: 0 },
    startedAt: 50,
    settled: false,
    ...overrides,
  }
}

test("cached (warm-replayed) children keep agent/model/tool provenance in panel details", () => {
  const r = record({
    agents: [{
      id: "a1",
      status: "succeeded",
      sessionID: "ses_source",
      label: "scout",
      phase: "scout",
      cached: true,
      requestedAgent: "explore",
      effectiveAgent: "explore",
      effectiveModel: { providerID: "xai", id: "grok-4.6" },
      tokens: { input: 53200, output: 2100, reasoning: 3000, cache: { read: 37200, write: 5 } },
      toolCalls: 7,
    }],
  })
  // Round-trip through the RPC parse: the widened agentDetails must survive
  // serialization AND the defensive parse of the wire shape.
  const snapshots = parseRunStatusResponse(JSON.parse(JSON.stringify({ runs: [authoritativeFromRecord(r, "persisted")] })))!
  const snap = snapshots[0]!
  assert.equal(snap.agentDetails?.[0]?.effectiveAgent, "explore")
  assert.equal(snap.agentDetails?.[0]?.effectiveModel?.id, "grok-4.6")
  assert.equal(snap.agentDetails?.[0]?.toolCalls, 7)
  // No session heuristic at all (the cached child's session belongs to the
  // SOURCE run): the panel must still render provenance, not dashes.
  const [view] = mergeAuthoritativeRuns([], [], [snap])
  const lines = agentDetailLines(view!.agents[0]!)
  assert.ok(lines.some((l) => l.startsWith("agent   explore")), `agent row missing: ${lines.join(" | ")}`)
  assert.ok(lines.some((l) => l.startsWith("model   xai/grok-4.6")), `model row missing: ${lines.join(" | ")}`)
  assert.ok(lines.some((l) => l.startsWith("tools   7")), `tools row missing: ${lines.join(" | ")}`)
})

test("cold-client inventory preserves child identity and permission routing without session titles", () => {
  const r = record({ directory: "/repo", agents: [{ id: "a1", sessionID: "ses_child", status: "running", label: "A complete long task label", phase: "build" }] })
  const snapshots = parseRunStatusResponse(JSON.parse(JSON.stringify({ runs: [authoritativeFromRecord(r, "live")] })))!
  const model = inspectModel([], { offset: 0, selected: 0, parentSessionID: "ses_p" }, 2000, { live: snapshots })
  assert.equal(model.run?.agents[0]?.sessionID, "ses_child")
  assert.equal(model.run?.agents[0]?.label, r.agents[0]?.label)
  const permissions = parsePermissionList({ data: [{ id: "per_1", sessionID: "ses_child", action: "read", resources: ["/external/path"] }] })
  assert.equal(permissionsForRun(model.run, permissions).length, 1)
  assert.equal(filterSnapshotsForChip(snapshots, { directory: "/other" }).length, 0)
})

test("authoritative workflow remains visible between phases with zero running agents", () => {
  const runs = mergeAuthoritativeRuns([], [authoritativeFromRecord(record({ agents: [] }), "live")])
  assert.equal(chipCounts(runs).running, 1)
  assert.equal(chipCounts(runs).agents, 0)
  assert.equal(runs[0]?.agents.length, 0, "never invent a child with runID as sessionID")
})

test("fast restart interrupts recently persisted runs even when the owner timestamp is fresh", () => {
  const recent = record({ owner: { bootID: "dead-boot", updatedAt: 9999 } })
  const registry = new RegistryImpl({ bootID: "new-boot", loader: () => [recent], persist: () => {}, now: () => 10000 })
  try {
    assert.equal(registry.reconcileOrphans(), 1)
    assert.equal(registry.get(recent.id)?.status, "interrupted")
    assert.equal(registry.activeRuns().length, 0)
  } finally { registry.dispose() }
})

test("same-process location loads follow the real owner record through completion", () => {
  const owner = new RegistryImpl({ bootID: "live-owner", persist: () => {}, throttleMs: 0 })
  const run = owner.create({ parentSessionID: "ses_p", script: "return 1" })
  const mirror = new RegistryImpl({ bootID: "other-location", persist: () => {}, loader: () => [JSON.parse(JSON.stringify(run))] })
  try {
    assert.equal(mirror.reconcileOrphans(), 0)
    assert.equal(mirror.get(run.id), run)
    owner.finish(run.id, { status: "succeeded" })
    assert.equal(mirror.get(run.id)?.status, "succeeded")
    assert.equal(mirror.activeRuns().length, 0)
  } finally { owner.dispose(); mirror.dispose() }
})

test("detail wrapping preserves the whole label and long resource without ellipsis", () => {
  const label = "a1 Finish session UX and permission visibility with readable controls"
  const path = "/very/long/external/directory/that/must/be/readable"
  for (const text of [label, path]) {
    const lines = wrapPaneLines([text], 20)
    assert.equal(lines.join(""), text)
    assert.ok(lines.every((line) => line.length <= 20))
  }
})

test("FALLBACK_STALE_MS is a 15-minute named window", () => {
  assert.equal(FALLBACK_STALE_MS, 15 * 60 * 1000)
})

test("sessionActivityMs prefers updated, then idle, then created", () => {
  assert.equal(sessionActivityMs(42), 42)
  assert.equal(sessionActivityMs({ created: 10, updated: 20 }), 20)
  assert.equal(sessionActivityMs({ created: 10, idle: 15 }), 15)
  assert.equal(sessionActivityMs({ created: 10, updated: 20, idle: 30 }), 20)
  assert.equal(sessionActivityMs({ idle: 15 }), 15)
  assert.equal(sessionActivityMs({ created: 10 }), 10)
  assert.equal(sessionActivityMs(undefined), undefined)
})

test("isFallbackExpired: empty outcome, no execution, stale activity", () => {
  const now = 1_000_000
  assert.equal(
    isFallbackExpired({ activityMs: now - FALLBACK_STALE_MS - 1 }, now),
    true,
  )
  assert.equal(isFallbackExpired({ activityMs: now - 1000 }, now), false)
  assert.equal(isFallbackExpired({ activityMs: now - FALLBACK_STALE_MS - 1, outcome: "succeeded" }, now), false)
  assert.equal(isFallbackExpired({ activityMs: now - FALLBACK_STALE_MS - 1, lastExecution: "started" }, now), false)
  assert.equal(isFallbackExpired({}, now), false)
})

test("sessionToStatus: stale empty-outcome child is pending, not running", () => {
  const now = 2_000_000
  const stale = now - FALLBACK_STALE_MS - 5
  assert.equal(
    sessionToStatus({ id: "a", title: "[uc:run_x a1] x", time: { updated: stale } }, now),
    "pending",
  )
  assert.equal(
    sessionToStatus({ id: "a", title: "[uc:run_x a1] x", time: { created: stale } }, now),
    "pending",
  )
  assert.equal(
    sessionToStatus({ id: "a", title: "[uc:run_x a1] x", time: { updated: now - 1000 } }, now),
    "running",
  )
  assert.equal(sessionToStatus({ id: "a", title: "[uc:run_x a1] x" }, now), "running")
})

test("selectAuthoritative: live over persisted over missing", () => {
  const live = authoritativeFromRecord(record({ id: "run_x", status: "running" }), "live")
  const persisted = authoritativeFromRecord(record({ id: "run_x", status: "succeeded", agents: [] }), "persisted")
  assert.equal(selectAuthoritative(live, persisted)?.source, "live")
  assert.equal(selectAuthoritative(undefined, persisted)?.source, "persisted")
  assert.equal(selectAuthoritative(undefined, undefined), undefined)
})

test("collectRunStatus: live registry first, then persisted historical", () => {
  const live = record({ id: "run_a", status: "running" })
  const old = record({ id: "run_b", status: "succeeded", agents: [{ id: "a1", status: "succeeded" }] })
  const snaps = collectRunStatus({
    runID: "run_b",
    liveGet: (id) => (id === "run_a" ? live : undefined),
    liveList: () => [live],
    persistedList: () => [old],
  })
  assert.equal(snaps.length, 1)
  assert.equal(snaps[0]!.source, "persisted")
  assert.equal(snaps[0]!.status, "succeeded")

  const liveHit = collectRunStatus({
    runID: "run_a",
    liveGet: (id) => (id === "run_a" ? live : undefined),
    liveList: () => [live],
    persistedList: () => [record({ id: "run_a", status: "failed" })],
  })
  assert.equal(liveHit[0]!.source, "live")
  assert.equal(liveHit[0]!.status, "running")

  const listed = collectRunStatus({
    liveGet: () => undefined,
    liveList: () => [live],
    persistedList: () => [old],
  })
  assert.deepEqual(
    listed.map((s) => s.runID),
    ["run_b", "run_a"],
  )
  assert.equal(listed.find((s) => s.runID === "run_b")?.source, "persisted")
})

test("collectRunStatus: parent session and location scope the inventory", () => {
  const mine = record({ id: "run_mine", parentSessionID: "ses_p", startedAt: 30 })
  const other = record({ id: "run_other", parentSessionID: "ses_q", startedAt: 20 })
  const scoped = collectRunStatus({
    sessionID: "ses_p",
    projectID: "proj-a",
    directory: "/proj/a",
    liveGet: () => undefined,
    liveList: () => [mine, other],
    persistedList: () => [],
  })
  assert.deepEqual(
    scoped.map((s) => s.runID),
    ["run_mine"],
  )
  assert.equal(scoped[0]!.projectID, "proj-a")
  assert.equal(scoped[0]!.directory, "/proj/a")

  const activeOnly = collectRunStatus({
    includeFinished: false,
    liveGet: () => undefined,
    liveList: () => [mine],
    persistedList: () => [record({ id: "run_old", status: "succeeded", agents: [] })],
  })
  assert.deepEqual(
    activeOnly.map((s) => s.runID),
    ["run_mine"],
  )
})

test("mergeAuthoritativeRuns: live over persisted over heuristic", () => {
  const heuristic = [
    heuristicRun({ runID: "run_live", counts: { total: 1, done: 0, failed: 0 } }),
    heuristicRun({ runID: "run_old", counts: { total: 1, done: 0, failed: 0 } }),
    heuristicRun({ runID: "run_only_h" }),
  ]
  const live = [authoritativeFromRecord(record({ id: "run_live", status: "succeeded", agents: [{ id: "a1", status: "succeeded" }] }), "live")]
  const persisted = [
    authoritativeFromRecord(
      record({ id: "run_old", status: "failed", agents: [{ id: "a1", status: "failed" }] }),
      "persisted",
    ),
    authoritativeFromRecord(record({ id: "run_live", status: "failed" }), "persisted"),
  ]
  const merged = mergeAuthoritativeRuns(heuristic, live, persisted)
  const byID = Object.fromEntries(merged.map((r) => [r.runID, r]))
  assert.equal(byID.run_live?.source, "live")
  assert.equal(byID.run_live?.settled, true)
  assert.equal(byID.run_old?.source, "persisted")
  assert.equal(byID.run_old?.settled, true)
  assert.equal(byID.run_old?.counts.failed, 1)
  assert.equal(byID.run_only_h?.source, "heuristic")
  assert.equal(byID.run_only_h?.settled, false)
})

test("rpc-unavailable fallback: empty snapshots leave heuristic intact", () => {
  const heuristic = [heuristicRun()]
  const merged = mergeAuthoritativeRuns(heuristic, [], [])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.runID, "run_h")
  assert.equal(merged[0]!.source, "heuristic")
  assert.equal(merged[0]!.settled, false)
  assert.equal(merged[0]!.agents[0]!.status, "running")
  assert.equal(parseRunStatusResponse(undefined), undefined)
  assert.equal(parseRunStatusResponse({ error: "nope" }), undefined)
  assert.equal(hasRpcRegister(undefined), false)
  assert.equal(hasRpcRegister({}), false)
  assert.equal(hasRpcClientFactory(undefined), false)
  assert.equal(hasRpcRegister({ register: async () => ({}) }), true)
  const callable = Object.assign(function rpc() {}, { register: async () => ({}) })
  assert.equal(typeof callable, "function")
  assert.equal(hasRpcRegister(callable), true)
})

test("parseRunStatusResponse and parseSettingsResponse", () => {
  const parsed = parseRunStatusResponse({
    runs: [
      {
        runID: "run_z",
        status: "paused",
        startedAt: 9,
        source: "live",
        agents: { done: 1, total: 2, failed: 0 },
      },
    ],
  })
  assert.equal(parsed?.[0]?.runID, "run_z")
  assert.equal(parsed?.[0]?.status, "paused")
  const settings = parseSettingsResponse({
    overlay: { concurrency: 4, maxAgents: 200, timeoutMs: 600000, permissions: "ask" },
    runID: "run_z",
    effective: { concurrency: 8, maxAgents: 200, timeoutMs: 3600000, permissions: "ask" },
  })
  assert.equal(settings?.runID, "run_z")
  assert.equal(settings?.overlay.concurrency, 4)
  assert.equal(settings?.effective?.concurrency, 8)
})

test("runStateTransition: agent finished, run completed, run failed", () => {
  const running = { id: "run_t", status: "running", agents: [{ id: "a1", status: "running" }] }
  assert.equal(runStateTransition(undefined, running), undefined)
  const afterAgent = {
    id: "run_t",
    status: "running",
    agents: [{ id: "a1", status: "succeeded" }],
  }
  assert.deepEqual(
    runStateTransition({ status: "running", agentKey: agentStatusKey(running.agents) }, afterAgent),
    { runID: "run_t", status: "running", reason: "agent-finished" },
  )
  assert.deepEqual(
    runStateTransition({ status: "running", agentKey: "a1:succeeded" }, { id: "run_t", status: "succeeded", agents: afterAgent.agents }),
    { runID: "run_t", status: "succeeded", reason: "run-completed" },
  )
  assert.deepEqual(
    runStateTransition({ status: "running", agentKey: "a1:running" }, { id: "run_t", status: "failed", agents: [{ id: "a1", status: "failed" }] }),
    { runID: "run_t", status: "failed", reason: "run-failed" },
  )
})

test("runStatus refresh flow: TTL-gated re-scan emits only a changed non-owned run", async () => {
  const local = record({ id: "run_local", status: "running", agents: [] })
  const remoteBefore = record({
    id: "run_remote",
    status: "running",
    parentSessionID: "ses_remote",
    agents: [{ id: "a1", status: "running" }],
  })
  const remoteAfter = record({
    id: "run_remote",
    status: "succeeded",
    endedAt: 5_000,
    parentSessionID: "ses_remote",
    directory: "/repo",
    agents: [{ id: "a1", status: "succeeded" }],
  })
  let cache: RunRecord[] = [local, remoteBefore]
  let lastScan = 0
  const source = {
    loadRuns: () => cache,
    async loadRunsAsync(): Promise<RunRecord[]> {
      lastScan = 10_000
      cache = [local, remoteAfter]
      return cache
    },
    lastScanAt: () => lastScan,
  }
  const emitted: ReturnType<typeof collectRemoteRunChanges> = []
  // Mirrors the runStatus RPC refresh closure in index.ts.
  const handlerRefresh = async (now: number): Promise<void> => {
    const before = source.loadRuns()
    if (!(await refreshRunsIfStale(source, RUNS_SCAN_TTL_MS, now))) return
    emitted.push(
      ...collectRemoteRunChanges({
        before,
        after: source.loadRuns(),
        isLive: (id) => id === "run_local",
        projectID: "proj-1",
        directory: "/fallback",
      }),
    )
  }
  await handlerRefresh(9_000) // never scanned → scan + emit
  assert.equal(emitted.length, 1)
  assert.deepEqual({ ...emitted[0] }, {
    runID: "run_remote",
    status: "succeeded",
    reason: "run-completed",
    parentSessionID: "ses_remote",
    runningCount: 0,
    projectID: "proj-1",
    directory: "/repo",
  })
  await handlerRefresh(10_500) // inside the TTL → no second scan
  assert.equal(emitted.length, 1)
  await handlerRefresh(15_000) // past the TTL, nothing moved → no emit
  assert.equal(emitted.length, 1)
  // A locally-owned run never emits (its persist callback owns that push).
  assert.deepEqual(
    collectRemoteRunChanges({
      before: [local],
      after: [{ ...local, status: "succeeded" }],
      isLive: (id) => id === "run_local",
    }),
    [],
  )
})

test("collectRemoteRunChanges: moves runStateTransition does not model still emit (state-changed fallback)", () => {
  const isLive = (id: string): boolean => id === "run_local"
  // running -> paused with identical agents: no transition event, but a real move.
  const paused = collectRemoteRunChanges({
    before: [record({ id: "run_r1", status: "running", agents: [{ id: "a1", status: "running" }] })],
    after: [record({ id: "run_r1", status: "paused", agents: [{ id: "a1", status: "running" }] })],
    isLive,
  })
  assert.equal(paused.length, 1)
  assert.equal(paused[0]!.reason, "state-changed")
  assert.equal(paused[0]!.status, "paused")
  // paused -> running: same.
  const resumed = collectRemoteRunChanges({
    before: [record({ id: "run_r1", status: "paused", agents: [{ id: "a1", status: "running" }] })],
    after: [record({ id: "run_r1", status: "running", agents: [{ id: "a1", status: "running" }] })],
    isLive,
  })
  assert.equal(resumed.length, 1)
  assert.equal(resumed[0]!.reason, "state-changed")
  // A pending agent appearing with status unchanged: agentKey moved — emit.
  const grew = collectRemoteRunChanges({
    before: [record({ id: "run_r1", status: "running", agents: [{ id: "a1", status: "running" }] })],
    after: [record({ id: "run_r1", status: "running", agents: [{ id: "a1", status: "running" }, { id: "a2", status: "pending" }] })],
    isLive,
  })
  assert.equal(grew.length, 1)
  assert.equal(grew[0]!.reason, "state-changed")
  // Nothing moved: silence.
  const still = collectRemoteRunChanges({
    before: [record({ id: "run_r1", status: "running", agents: [{ id: "a1", status: "running" }] })],
    after: [record({ id: "run_r1", status: "running", agents: [{ id: "a1", status: "running" }] })],
    isLive,
  })
  assert.deepEqual(still, [])
})

test("collectRunStatus: an EXPLICIT runID drops the session filter (subagent-owned runs resolve); the list keeps it", () => {
  // Regression (2026-09-24): runs spawned by a subagent session never matched
  // the panel session, so the TUI could not overlay authoritative state and
  // rendered "✗ failed / finished" from heuristics while children worked.
  const subagentRun = record({ id: "run_sub", parentSessionID: "ses_build_child" })
  const targeted = collectRunStatus({
    runID: "run_sub",
    sessionID: "ses_panel_main",
    liveGet: (id) => (id === "run_sub" ? subagentRun : undefined),
    liveList: () => [subagentRun],
    persistedList: () => [],
  })
  assert.equal(targeted.length, 1)
  assert.equal(targeted[0]!.runID, "run_sub")

  // The no-runID inventory still honors session scoping.
  const listed = collectRunStatus({
    sessionID: "ses_panel_main",
    liveGet: () => undefined,
    liveList: () => [subagentRun],
    persistedList: () => [],
  })
  assert.equal(listed.length, 0)

  // Location scoping applies to the targeted path too (cross-project stays empty).
  const crossProject = collectRunStatus({
    runID: "run_sub",
    sessionID: "ses_panel_main",
    directory: "/other/project",
    liveGet: (id) =>
      id === "run_sub" ? record({ id: "run_sub", parentSessionID: "ses_build_child", directory: "/this/project" }) : undefined,
    liveList: () => [],
    persistedList: () => [],
  })
  assert.equal(crossProject.length, 0)
})

test("collectRunStatus: activityFor stamps stalledMs on running children only", () => {
  const now = Date.now()
  const run = record({
    agents: [
      { id: "a1", status: "running", sessionID: "ses_1" },
      { id: "a2", status: "running", sessionID: "ses_unknown" },
      { id: "a3", status: "succeeded", sessionID: "ses_3" },
    ],
  })
  const snaps = collectRunStatus({
    runID: run.id,
    liveGet: () => run,
    liveList: () => [run],
    persistedList: () => [],
    activityFor: (sid) => (sid === "ses_1" ? now - 120_000 : undefined),
  })
  const details = snaps[0]!.agentDetails!
  assert.equal(details[0]!.stalledMs, 120_000)
  assert.equal(details[1]!.stalledMs, undefined)
  assert.equal(details[2]!.stalledMs, undefined)
})

test("collectRunStatus: external/ownerUpdatedAt ownership honesty (and wire parse)", () => {
  const foreign = record({ id: "run_ext", owner: { bootID: "boot-other", updatedAt: 5_000 } })
  const foreignSnap = collectRunStatus({
    runID: "run_ext",
    bootID: "boot-me",
    liveGet: () => undefined,
    liveList: () => [],
    persistedList: () => [foreign],
  })[0]!
  assert.equal(foreignSnap.external, true)
  assert.equal(foreignSnap.ownerUpdatedAt, 5_000)

  // Our own bootID but no live registry entry: still external, never "ours".
  const orphan = record({ id: "run_orphan", owner: { bootID: "boot-me", updatedAt: 6_000 } })
  const orphanSnap = collectRunStatus({
    runID: "run_orphan",
    bootID: "boot-me",
    liveGet: () => undefined,
    liveList: () => [],
    persistedList: () => [orphan],
  })[0]!
  assert.equal(orphanSnap.external, true)

  // Live record owned by this process: not external, heartbeat still rides along.
  const mine = record({ id: "run_mine", owner: { bootID: "boot-me", updatedAt: 7_000 } })
  const mineSnap = collectRunStatus({
    runID: "run_mine",
    bootID: "boot-me",
    liveGet: (id) => (id === "run_mine" ? mine : undefined),
    liveList: () => [mine],
    persistedList: () => [],
  })[0]!
  assert.equal(mineSnap.external, undefined)
  assert.equal(mineSnap.ownerUpdatedAt, 7_000)

  // Owner-less records keep both fields absent.
  const bare = record({ id: "run_bare" })
  const bareSnap = collectRunStatus({
    runID: "run_bare",
    bootID: "boot-me",
    liveGet: () => undefined,
    liveList: () => [],
    persistedList: () => [bare],
  })[0]!
  assert.equal(bareSnap.external, undefined)
  assert.equal(bareSnap.ownerUpdatedAt, undefined)

  // Wire round-trip: undefined-valued keys drop, parse restores the fields.
  const parsed = parseRunStatusResponse(JSON.parse(JSON.stringify({ runs: [foreignSnap, bareSnap] })))!
  assert.equal(parsed[0]!.external, true)
  assert.equal(parsed[0]!.ownerUpdatedAt, 5_000)
  assert.equal(parsed[1]!.external, undefined)
  assert.equal(parsed[1]!.ownerUpdatedAt, undefined)

  // Backward compatible: absent fields parse clean; wrong-typed values are ignored.
  const tolerant = parseRunStatusResponse({
    runs: [
      {
        runID: "run_z",
        status: "running",
        startedAt: 9,
        source: "live",
        agents: { done: 0, total: 0, failed: 0 },
        external: "yes",
        ownerUpdatedAt: "soon",
      },
    ],
  })!
  assert.equal(tolerant[0]!.external, undefined)
  assert.equal(tolerant[0]!.ownerUpdatedAt, undefined)
})

test("runLivenessSuffix: running-only ext/stale at the 60s heartbeat boundary", () => {
  const base = { status: "running", external: true, ownerUpdatedAt: 1_000 }
  assert.equal(runLivenessSuffix(base, 60_000), " ext", "59s heartbeat stays fresh")
  assert.equal(runLivenessSuffix(base, 61_000), " ext", "exactly 60s is not stale")
  assert.equal(runLivenessSuffix(base, 62_000), " ext stale", "61s heartbeat goes stale")
  assert.equal(runLivenessSuffix({ ...base, external: false }, 62_000), " stale")
  assert.equal(runLivenessSuffix({ status: "succeeded", external: true, ownerUpdatedAt: 1_000 }, 1_000_000), "")
  assert.equal(runLivenessSuffix({ status: "running" }, 1_000_000), "")
})

// ---------------------------------------------------------------------------
// rpc.invalid_output regression (observed 2026-09-26): every field the
// runStatus payload emits MUST be declared in the RPC output schema, or the
// host rejects the WHOLE call with HTTP 500 once any record carries the field
// (200k+ failed polls in production before this guard existed).
// ---------------------------------------------------------------------------

test("runStatus RPC output schema declares every field the payload emits", async () => {
  const { ULTRACODE_RPC } = await import("../src/rpc-definition.ts")
  const output = ULTRACODE_RPC.methods.runStatus.output as {
    properties: { runs: { items: { properties: Record<string, unknown> } } }
  }
  const runProps = output.properties.runs!.items.properties!
  const agentProps = (runProps.agentDetails as { items: { properties: Record<string, unknown> } }).items.properties
  const tokenProps = (agentProps.tokens as { properties: Record<string, unknown> }).properties

  // Build a record with EVERY optional agent field set (the richest payload).
  const snaps = collectRunStatus({
    runID: "run_rpc1",
    liveGet: (id) =>
      id === "run_rpc1"
        ? record({
            id: "run_rpc1",
            owner: { bootID: "b2", updatedAt: 123 },
            agents: [
              {
                id: "a1",
                status: "running",
                sessionID: "ses_rpc1",
                phase: "scan",
                label: "seeker",
                requestedAgent: "explore",
                effectiveAgent: "explore",
                effectiveModel: { providerID: "openrouter", id: "kimi" },
                spawnModel: { providerID: "openrouter", id: "kimi" },
                tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 40, write: 50 } },
                contextTokens: 100,
                toolCalls: 7,
              },
            ],
          })
        : undefined,
    liveList: () => [],
    persistedList: () => [],
    bootID: "b1",
    activityFor: () => 456,
  })
  const agent = snaps[0]!.agentDetails![0]!

  // Top-level run fields.
  for (const key of Object.keys(snaps[0]!)) {
    if (key === "agentDetails" || key === "agents") continue
    assert.ok(key in runProps, `payload run field "${key}" missing from runStatus output schema`)
  }
  // agentDetails item fields.
  for (const key of Object.keys(agent)) {
    assert.ok(key in agentProps, `payload agentDetails field "${key}" missing from runStatus output schema`)
  }
  // tokens sub-object fields (cache caused the same 500 class when undeclared).
  for (const key of Object.keys(agent.tokens!)) {
    assert.ok(key in tokenProps, `payload tokens field "${key}" missing from runStatus output schema`)
  }
})

test("stepEventContext: session.step.ended usage becomes the live context number", async () => {
  const { stepEventContext } = await import("../src/run-status.ts")
  // Real shape: input + cache read + write sum to the statusline context.
  assert.deepEqual(
    stepEventContext({
      type: "session.step.ended",
      data: { sessionID: "ses_a", tokens: { input: 1000, output: 9, reasoning: 0, cache: { read: 74000, write: 2000 } } },
    }),
    { sessionID: "ses_a", contextTokens: 77_000 },
  )
  // Other events, missing session, or zero/no usage are ignored.
  assert.equal(stepEventContext({ type: "session.usage.updated", data: { sessionID: "s", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }), undefined)
  assert.equal(stepEventContext({ type: "session.step.ended", data: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } }), undefined)
  assert.equal(
    stepEventContext({ type: "session.step.ended", data: { sessionID: "ses_a", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }),
    undefined,
    "all-zero usage exposes no request context",
  )
  assert.equal(stepEventContext(undefined), undefined)
  assert.equal(stepEventContext("nope"), undefined)
})
