/**
 * Owner-liveness markers — src/owner-liveness.ts: machine-wide boot liveness
 * for reconcileOrphans. Round-trips a temp dir; the default-dir helpers are
 * thin wrappers not worth touching $HOME in tests.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  isSafeBootID,
  maybeRefreshOwnerLiveness,
  ownerAliveProbe,
  ownerLivenessProbe,
  pidAlive,
  removeOwnerLiveness,
  writeOwnerLiveness,
  type OwnerBootLiveness,
} from "../src/owner-liveness.ts"

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-owner-liveness-"))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitFor(file: string, present: boolean): Promise<void> {
  for (let i = 0; i < 100 && existsSync(file) !== present; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test("writeOwnerLiveness writes a marker the probe reads as alive", async () => {
  await withTempDir(async (dir) => {
    writeOwnerLiveness("boot_a", dir, 1_000)
    await waitFor(path.join(dir, "boot_a.json"), true)
    const raw = JSON.parse(await readFile(path.join(dir, "boot_a.json"), "utf8")) as { bootID: string; at: number }
    assert.equal(raw.bootID, "boot_a")
    assert.equal(raw.at, 1_000)

    const probe = ownerAliveProbe(dir, 60_000, 5_000)
    assert.equal(probe("boot_a"), true)
    // Another boot with no marker: dead.
    assert.equal(probe("boot_b"), false)
    // Probe caches per boot — second read stays consistent.
    assert.equal(probe("boot_a"), true)
  })
})

test("ownerAliveProbe: marker older than the TTL reads as dead; malformed marker reads as dead", async () => {
  await withTempDir(async (dir) => {
    writeOwnerLiveness("boot_old", dir, 1_000)
    writeOwnerLiveness("boot_junk", dir, 1_000)
    await waitFor(path.join(dir, "boot_junk.json"), true)
    await writeFile(path.join(dir, "boot_junk.json"), "{not json", "utf8")
    // now=70_000, ttl=60_000: at=1_000 is 69s old → dead.
    const probe = ownerAliveProbe(dir, 60_000, 70_000)
    assert.equal(probe("boot_old"), false)
    assert.equal(probe("boot_junk"), false)
  })
})

test("ownerAliveProbe default TTL: an 11-minute marker (idle live child) is alive; 36 minutes is dead", async () => {
  await withTempDir(async (dir) => {
    writeOwnerLiveness("boot_idle", dir, 1_000)
    await waitFor(path.join(dir, "boot_idle.json"), true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // Reviewer repro: marker 11 min old, owner heartbeat well inside the
    // 30-min orphan window — must read ALIVE (default TTL 35 min).
    const aliveProbe = ownerAliveProbe(dir, 35 * 60_000, 1_000 + 11 * 60_000)
    assert.equal(aliveProbe("boot_idle"), true)
    const deadProbe = ownerAliveProbe(dir, 35 * 60_000, 1_000 + 36 * 60_000)
    assert.equal(deadProbe("boot_idle"), false)
  })
})

test("removeOwnerLiveness gates later writes: no marker resurrection after dispose", async () => {
  await withTempDir(async (dir) => {
    writeOwnerLiveness("boot_gone", dir, 1_000)
    await waitFor(path.join(dir, "boot_gone.json"), true)
    removeOwnerLiveness("boot_gone", dir)
    await waitFor(path.join(dir, "boot_gone.json"), false)
    // A refresh racing after disposal must not resurrect the marker.
    writeOwnerLiveness("boot_gone", dir, 2_000)
    maybeRefreshOwnerLiveness("boot_gone", dir, 3_000)
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(existsSync(path.join(dir, "boot_gone.json")), false)
  })
})

test("removeOwnerLiveness deletes the marker; unsafe boot ids never reach the disk", async () => {
  await withTempDir(async (dir) => {
    writeOwnerLiveness("boot_x", dir, 1_000)
    await waitFor(path.join(dir, "boot_x.json"), true)
    removeOwnerLiveness("boot_x", dir)
    await waitFor(path.join(dir, "boot_x.json"), false)
    assert.equal(existsSync(path.join(dir, "boot_x.json")), false)

    // Path traversal / unsafe ids are rejected up front.
    assert.equal(isSafeBootID("../escape"), false)
    assert.equal(isSafeBootID("boot_ok-1"), true)
  })
})

test("maybeRefreshOwnerLiveness throttles same-boot refreshes", async () => {
  await withTempDir(async (dir) => {
    maybeRefreshOwnerLiveness("boot_t", dir, 1_000)
    // Inside the 30s throttle window: skipped (would lose to the async write
    // of the first call anyway, but the contract is "no disk work").
    maybeRefreshOwnerLiveness("boot_t", dir, 1_010)
    // Past the window: refreshes.
    maybeRefreshOwnerLiveness("boot_t", dir, 31_000)
    await waitFor(path.join(dir, "boot_t.json"), true)
    // Let both async writes settle before reading.
    await new Promise((resolve) => setTimeout(resolve, 100))
    const raw = JSON.parse(await readFile(path.join(dir, "boot_t.json"), "utf8")) as { at: number }
    assert.notEqual(raw.at, 1_010)
  })
})

// ---------------------------------------------------------------------------
// pidAlive + ownerLivenessProbe (pid-aware verdicts)
// ---------------------------------------------------------------------------

test("pidAlive: own pid alive; exited pid dead; invalid pid unknown", async () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(0), undefined)
  assert.equal(pidAlive(-1), undefined)
  assert.equal(pidAlive(1.5), undefined)
  assert.equal(pidAlive("7"), undefined)
  assert.equal(pidAlive(undefined), undefined)
  // A genuinely exited process reads dead (ESRCH). PID reuse in the test
  // window is vanishingly unlikely.
  const child = spawn(process.execPath, ["-e", ""])
  const deadPid = child.pid
  await new Promise<void>((resolve) => child.on("exit", () => resolve()))
  assert.equal(typeof deadPid, "number")
  assert.equal(pidAlive(deadPid), false)
})

/** Write a marker file directly so tests control its pid field exactly. */
async function writeMarker(
  dir: string,
  bootID: string,
  body: Record<string, unknown>,
): Promise<void> {
  await writeFile(path.join(dir, `${bootID}.json`), JSON.stringify(body), "utf8")
}

test("ownerLivenessProbe: fresh marker with live pid reads alive-pid", async () => {
  await withTempDir(async (dir) => {
    await writeMarker(dir, "boot_live", { bootID: "boot_live", pid: process.pid, at: 1_000 })
    const probe = ownerLivenessProbe(dir, 60_000, () => 10_000)
    const verdict: OwnerBootLiveness = probe("boot_live")
    assert.equal(verdict, "alive-pid")
    // Boolean wrapper agrees.
    assert.equal(ownerAliveProbe(dir, 60_000, 10_000)("boot_live"), true)
  })
})

test("ownerLivenessProbe: fresh marker with a DEAD pid reads dead-pid immediately (the SIGKILL case)", async () => {
  await withTempDir(async (dir) => {
    const child = spawn(process.execPath, ["-e", ""])
    const deadPid = child.pid
    await new Promise<void>((resolve) => child.on("exit", () => resolve()))
    // Marker and heartbeat both look fresh — only the pid exposes the death.
    await writeMarker(dir, "boot_killed", { bootID: "boot_killed", pid: deadPid, at: 1_000 })
    const probe = ownerLivenessProbe(dir, 60_000, () => 2_000)
    assert.equal(probe("boot_killed"), "dead-pid")
    assert.equal(ownerAliveProbe(dir, 60_000, 2_000)("boot_killed"), false)
  })
})

test("ownerLivenessProbe: fresh marker with uncheckable pid reads alive-marker; stale/malformed/missing read dead", async () => {
  await withTempDir(async (dir) => {
    await writeMarker(dir, "boot_nopid", { bootID: "boot_nopid", at: 90_000 })
    await writeMarker(dir, "boot_junkpid", { bootID: "boot_junkpid", pid: "not-a-pid", at: 90_000 })
    // at=1_000 with now=100_000 and ttl=60_000: 99s old, past the TTL.
    await writeMarker(dir, "boot_stale", { bootID: "boot_stale", pid: process.pid, at: 1_000 })
    await writeFile(path.join(dir, "boot_broken.json"), "{not json", "utf8")
    const probe = ownerLivenessProbe(dir, 60_000, () => 100_000)
    assert.equal(probe("boot_nopid"), "alive-marker")
    assert.equal(probe("boot_junkpid"), "alive-marker")
    assert.equal(probe("boot_stale"), "dead")
    assert.equal(probe("boot_broken"), "dead")
    assert.equal(probe("boot_missing"), "dead")
    assert.equal(probe("../escape"), "dead")
  })
})

test("ownerLivenessProbe verdicts expire from cache so a periodic reconciler sees deaths", async () => {
  await withTempDir(async (dir) => {
    await writeMarker(dir, "boot_flip", { bootID: "boot_flip", pid: process.pid, at: 1_000 })
    let now = 10_000
    const probe = ownerLivenessProbe(dir, 60_000, () => now)
    assert.equal(probe("boot_flip"), "alive-pid")
    // Marker disappears (graceful dispose); inside the cache window the verdict holds.
    await rm(path.join(dir, "boot_flip.json"), { force: true })
    assert.equal(probe("boot_flip"), "alive-pid")
    // Past the cache window the fresh read wins.
    now = 10_000 + 6_000
    assert.equal(probe("boot_flip"), "dead")
  })
})
