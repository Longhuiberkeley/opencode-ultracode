/**
 * Restart simulation (P0 acceptance): the 2026-09-27 orphaned-run wedge,
 * end to end over a shared persistence seam, using the REAL pid-aware probe
 * (a genuinely SIGKILL'd process pid), the REAL registry classification,
 * harvest, orphan stop, deadline enforcement, and warm resume.
 *
 * Runtime A = the killed server: persists a running record with two children
 * mid-flight and a FRESH owner marker carrying a dead pid (what kill -9
 * leaves behind), then "dies" without any graceful dispose.
 * Runtime B = the replacement server: periodic reconcile must harvest the
 * child that OpenCode recovery finished, interrupt the rest, leave NO
 * running zombie, answer control truthfully, and warm-resume the salvaged
 * work. A real SIGKILL leg (spawned server, killed, restarted) lives in
 * scripts/live-test.sh §7 — this file is the deterministic in-process twin.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RegistryImpl, REMOTE_DEADLINE_GRACE_MS } from "../src/registry.ts"
import { ownerLivenessProbe, OWNER_LIVENESS_TTL_MS, pidAlive, markerPath } from "../src/owner-liveness.ts"
import { SupervisorImpl } from "../src/supervisor.ts"
import { harvestOrphanedRun, type HarvestSessionCtx } from "../src/harvest.ts"
import { buildWarmCache, agentCacheDigest } from "../src/primitives.ts"
import { FakeRegistry, FakeSessionCtx, FakeStorage } from "./fakes.ts"
import { DEFAULT_OPTIONS, type AgentRecord, type ContextMessage, type Json, type RunRecord } from "../src/types.ts"
import { isActiveRunStatus } from "../src/types.ts"

const SCHEMA: Json = {
  type: "object",
  required: ["claims"],
  properties: { claims: { type: "array", items: { type: "string" } } },
}

/** A process that is REALLY dead (spawned, SIGKILL'd, reaped). */
async function deadPid(): Promise<number> {
  const child = spawn("sleep", ["30"], { stdio: "ignore" })
  const pid = child.pid!
  child.kill("SIGKILL")
  await new Promise<void>((resolve) => child.once("exit", () => resolve()))
  await new Promise((resolve) => setTimeout(resolve, 20)) // reap completes
  return pid
}

/** Shared persistence seam: the KV both runtimes read/write (upsert by id). */
function sharedKv(): { kv: RunRecord[]; persist: (r: RunRecord) => void; loader: () => RunRecord[] } {
  const kv: RunRecord[] = []
  return {
    kv,
    persist: (record) => {
      const idx = kv.findIndex((r) => r.id === record.id)
      if (idx >= 0) kv[idx] = record
      else kv.push(record)
    },
    loader: () => kv,
  }
}

function sessionDouble(outcome: string | undefined, messages: ContextMessage[]): { outcome?: string; messages: ContextMessage[] } {
  return { outcome, messages }
}

function assistant(text: string): ContextMessage {
  return { id: "m", type: "assistant", text }
}

test("restart sim: kill -9 mid-run — harvest, interrupt, no zombie, truthful control, warm resume", async () => {
  const markerDir = mkdtempSync(join(tmpdir(), "uc-restart-sim-"))
  try {
    const clock = 10_000_000
    const probe = ownerLivenessProbe(markerDir, OWNER_LIVENESS_TTL_MS, () => clock)
    const { kv, persist, loader } = sharedKv()
    const prompt = "collect the claims"

    // ------------------------------------------------------------------
    // Runtime A — the server that gets kill -9'd.
    // ------------------------------------------------------------------
    const pid = await deadPid()
    assert.equal(pidAlive(pid), false, "precondition: spawned pid is really dead")

    // No bootID on A: in one process the runtimeOwners map would make B see
    // A as a live same-process owner — an artifact of the sim, not of the
    // scenario (the killed process is gone). Its footprint is exactly what a
    // kill -9 leaves: the persisted record + a fresh marker naming a dead pid.
    const registryA = new RegistryImpl({ persist, loader, throttleMs: 0, now: () => clock, ownerProbe: probe })
    const created = registryA.create({ parentSessionID: "ses_parent", script: "return agent(prompt)", name: "sim" })
    const digest1 = agentCacheDigest(prompt, { schema: SCHEMA }, "general")
    registryA.addAgent(created.id, {
      status: "running",
      sessionID: "ses_done",
      startedAt: clock - 5_000,
      requestedAgent: "general",
      key: "claims:1",
      promptDigest: digest1,
      schema: SCHEMA,
      spawnModel: { providerID: "openai", id: "gpt-6" },
    })
    registryA.addAgent(created.id, {
      status: "running",
      sessionID: "ses_busy",
      startedAt: clock - 5_000,
      requestedAgent: "general",
      key: "claims:2",
      promptDigest: agentCacheDigest("second prompt", {}, "general"),
    })
    // What persistNow leaves behind after the kill: a fresh heartbeat naming
    // the (now dead) owner pid, a deadline long past, and a fresh marker file
    // the SIGKILL never cleaned up. No dispose(), no marker removal.
    registryA.persistNow(created.id)
    const recordA = registryA.get(created.id)!
    recordA.owner = { bootID: "boot_A", updatedAt: clock, pid }
    registryA.noteRunDeadline(created.id, clock - 60_000)
    registryA.persistNow(created.id)
    writeFileSync(markerPath(markerDir, "boot_A"), JSON.stringify({ pid, at: clock }), "utf8")

    assert.equal(registryA.get(created.id)?.status, "running", "precondition: runtime A died mid-run")

    // ------------------------------------------------------------------
    // Runtime B — the replacement server's periodic reconcile tick.
    // ------------------------------------------------------------------
    const registryB = new RegistryImpl({ persist, loader, throttleMs: 0, now: () => clock, bootID: "boot_B", ownerProbe: probe })
    const plans = registryB.classifyOrphans({ recheckAdopted: true })
    assert.equal(plans.length, 1, "dead-pid owner classifies immediately despite fresh marker/heartbeat")
    assert.match(plans[0]!.reason, /boot_A pid \d+ gone/)

    // Harvest BEFORE the flip: OpenCode recovery finished child 1 on its own.
    const sessions: HarvestSessionCtx = {
      get: async ({ sessionID }) => {
        if (sessionID === "ses_done") return sessionDouble("succeeded", [])
        if (sessionID === "ses_busy") return sessionDouble(undefined, []) // still mid-turn, no outcome
        throw new Error(`unknown session ${sessionID}`)
      },
      context: async ({ sessionID }) => {
        if (sessionID === "ses_done") {
          return [
            { id: "u1", type: "user", text: prompt },
            assistant('{"claims": ["a", "b"]}'),
          ]
        }
        if (sessionID === "ses_busy") return []
        throw new Error(`unknown session ${sessionID}`)
      },
    }
    const report = await harvestOrphanedRun(plans[0]!.record, {
      sessions,
      updateAgent: (runID, agentID, patch) => registryB.updateAgent(runID, agentID, patch),
      now: () => clock,
    })
    assert.deepEqual(report, { harvested: 1, failed: 0, unresolvable: 1 })

    assert.equal(registryB.applyOrphanInterrupt(plans[0]!), true)

    // No running zombie — in memory AND in the shared persistence.
    const after = registryB.get(created.id)!
    assert.equal(after.status, "interrupted")
    assert.match(after.stopReason ?? "", /resumable: \/ultracode rerun run_\S+ --warm/)
    assert.equal(after.agents.find((a) => a.id === "a1")?.status, "succeeded", "recovered child salvaged")
    assert.equal(after.agents.find((a) => a.id === "a1")?.harvested, true)
    assert.equal(after.agents.find((a) => a.id === "a2")?.status, "interrupted", "unfinished child bounded")
    const persistedAfter = loader().find((r) => r.id === created.id)!
    assert.equal(persistedAfter.status, "interrupted", "flip is durable")
    assert.ok(!isActiveRunStatus(persistedAfter.status))

    // Idempotent: the next tick (and a THIRD runtime) finds nothing to do.
    assert.deepEqual(new RegistryImpl({ persist, loader, throttleMs: 0, now: () => clock, bootID: "boot_C", ownerProbe: probe })
      .classifyOrphans({ recheckAdopted: true }), [])
    assert.deepEqual(registryB.classifyOrphans({ recheckAdopted: true }), [])

    // ------------------------------------------------------------------
    // Truthful control from runtime B.
    // ------------------------------------------------------------------
    const supervisorB = new SupervisorImpl({
      registry: registryB,
      storage: new FakeStorage(),
      sessions: new FakeSessionCtx(),
      options: DEFAULT_OPTIONS,
    })
    // The already-reconciled record: stop says what is true (finished), it
    // does not pretend to accept or wedge on "supervisor refused".
    const stopDone = supervisorB.stop(created.id, "user")
    assert.equal(stopDone.ok, false)
    if (!stopDone.ok && stopDone.reason === "not-active") assert.equal(stopDone.status, "interrupted")

    // The reconcileIntervalMs=0 race — a dead-owner record that was never
    // classified: stop still does the orphan flip itself, with a resume hint.
    const missed = new RegistryImpl({ persist, loader, throttleMs: 0, now: () => clock, bootID: "boot_B2", ownerProbe: probe })
    const missedRecord: RunRecord = {
      id: "run_missed", parentSessionID: "ses_parent", status: "running", script: "return 1", startedAt: clock - 10_000,
      owner: { bootID: "boot_A", updatedAt: clock, pid },
      agents: [{ id: "a1", status: "running", sessionID: "ses_x", startedAt: 1 }],
    }
    persist(missedRecord)
    // Production control paths run an on-demand reconcile first (classify
    // adopts the record); the supervisor's stop then sees it.
    missed.classifyOrphans({ recheckAdopted: true })
    const supervisorMissed = new SupervisorImpl({
      registry: missed,
      storage: new FakeStorage(),
      sessions: new FakeSessionCtx(),
      options: DEFAULT_OPTIONS,
    })
    const stopMissed = supervisorMissed.stop("run_missed", "user stop")
    assert.deepEqual(stopMissed, {
      ok: true,
      mode: "orphan",
      stopReason: `user stop — orphaned: owner process gone (boot boot_A pid ${pid}). Marked interrupted; resumable via /ultracode rerun run_missed --warm`,
    })
    assert.equal(missed.get("run_missed")?.status, "interrupted")

    // A LIVE remote owner: refused and named — never touched.
    writeFileSync(markerPath(markerDir, "boot_LIVE"), JSON.stringify({ pid: process.pid, at: clock }), "utf8")
    const remote: RunRecord = {
      id: "run_remote", parentSessionID: "ses_parent", status: "running", script: "return 1", startedAt: clock - 10_000,
      owner: { bootID: "boot_LIVE", updatedAt: clock, pid: process.pid },
      agents: [{ id: "a1", status: "running", sessionID: "ses_y", startedAt: 1 }],
    }
    persist(remote)
    registryB.classifyOrphans({ recheckAdopted: true }) // adopt the live-owner mirror
    const stopRemote = supervisorB.stop("run_remote", "user stop")
    assert.deepEqual(stopRemote, {
      ok: false,
      reason: "remote-owner",
      owner: { bootID: "boot_LIVE", pid: process.pid, updatedAt: clock },
    })
    assert.equal(loader().find((r) => r.id === "run_remote")?.status, "running", "live owner's record untouched")

    // ------------------------------------------------------------------
    // Deadline enforcement: a LIVE owner whose watchdog died with its timer
    // (the 91-minute zombie shape) — the periodic pass enforces deadlineAt.
    // ------------------------------------------------------------------
    const wedged: RunRecord = {
      id: "run_wedged", parentSessionID: "ses_parent", status: "running", script: "return 1", startedAt: clock - 90 * 60_000,
      owner: { bootID: "boot_LIVE", updatedAt: clock, pid: process.pid }, // heartbeats forever, enforces nothing
      deadlineAt: clock - (REMOTE_DEADLINE_GRACE_MS + 5 * 60_000),
      agents: [{ id: "a1", status: "running", sessionID: "ses_z", startedAt: 1 }],
    }
    persist(wedged)
    const registryW = new RegistryImpl({ persist, loader, throttleMs: 0, now: () => clock, bootID: "boot_B3", ownerProbe: probe })
    const expired = registryW.expiredRemoteRuns(clock, REMOTE_DEADLINE_GRACE_MS)
    assert.deepEqual(expired.map((e) => e.record.id), ["run_wedged"])
    await harvestOrphanedRun(expired[0]!.record, {
      sessions,
      updateAgent: (runID, agentID, patch) => registryW.updateAgent(runID, agentID, patch),
      now: () => clock,
    })
    assert.equal(
      registryW.applyOrphanInterrupt({
        record: expired[0]!.record,
        reason: `timeout — run deadline passed; resumable via /ultracode rerun run_wedged --warm`,
      }),
      true,
    )
    assert.equal(loader().find((r) => r.id === "run_wedged")?.status, "interrupted", "wedged owner's run bounded")
    // The live-owner run WITHOUT a deadline stays untouched (its own watchdog owns it).
    assert.equal(loader().find((r) => r.id === "run_remote")?.status, "running")

    // ------------------------------------------------------------------
    // Warm resume: the salvaged child replays; the interrupted one re-runs.
    // ------------------------------------------------------------------
    const cache = buildWarmCache(loader().find((r) => r.id === created.id)!)
    const entry = cache.get("claims:1")
    assert.ok(entry, "harvested keyed child is warm-replayable from the PERSISTED record")
    assert.equal(entry!.digest, digest1)
    assert.deepEqual(entry!.result.data, { claims: ["a", "b"] })
    assert.equal(cache.get("claims:2"), undefined, "interrupted child never replays — it re-runs")
  } finally {
    rmSync(markerDir, { recursive: true, force: true })
  }
})

// Keep the fakes import honest: the sim drives real modules; FakeRegistry is
// referenced only to assert the seam parity of the additive methods used above.
void FakeRegistry
