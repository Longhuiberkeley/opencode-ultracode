/**
 * Instance + machine provider concurrency slots.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, stat, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  isSafeProviderID,
  ProviderConcurrencyGate,
  ProviderSlotPool,
} from "../src/provider-slots.ts"

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function tempSlotsDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "uc-slots-"))
}

async function listSlots(baseDir: string, providerID: string): Promise<string[]> {
  try {
    return (await readdir(path.join(baseDir, providerID))).filter((n) => n.startsWith("slot-")).sort()
  } catch (err) {
    if (err !== null && typeof err === "object" && "code" in err && (err as { code: unknown }).code === "ENOENT") {
      return []
    }
    throw err
  }
}

test("isSafeProviderID: charset plus defensive slash/dot-dot reject", () => {
  assert.equal(isSafeProviderID("anthropic"), true)
  assert.equal(isSafeProviderID("open-ai"), true)
  assert.equal(isSafeProviderID("xai.v2"), true)
  assert.equal(isSafeProviderID(""), false)
  assert.equal(isSafeProviderID("foo/bar"), false)
  assert.equal(isSafeProviderID(".."), false)
  assert.equal(isSafeProviderID("foo..bar"), false)
  assert.equal(isSafeProviderID("a\\b"), false)
})

test("machine slot: claim / release / hold.json round-trip", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0 })
    const hold = await pool.claim("anthropic", 2)
    assert.equal(hold.providerID, "anthropic")
    assert.equal(hold.index, 0)
    assert.deepEqual(await listSlots(dir, "anthropic"), ["slot-0"])
    const meta = JSON.parse(await readFile(path.join(hold.dir, "hold.json"), "utf8")) as {
      pid: number
      claimedAt: number
    }
    assert.equal(meta.pid, process.pid)
    assert.equal(typeof meta.claimedAt, "number")
    await hold.release()
    assert.deepEqual(await listSlots(dir, "anthropic"), [])
    await hold.release() // idempotent
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("machine slot: cap N admits N then waits; abort of waiter leaves holders intact", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0, rand: () => 0 })
    const a = await pool.claim("openai", 2)
    const b = await pool.claim("openai", 2)
    assert.deepEqual(await listSlots(dir, "openai"), ["slot-0", "slot-1"])
    const ctrl = new AbortController()
    const waiting = pool.claim("openai", 2, ctrl.signal)
    await tick(30)
    ctrl.abort()
    await assert.rejects(waiting, /run stopping/)
    assert.deepEqual(await listSlots(dir, "openai"), ["slot-0", "slot-1"])
    await a.release()
    await b.release()
    assert.deepEqual(await listSlots(dir, "openai"), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("machine slot: stale dir is reclaimable", async () => {
  const dir = await tempSlotsDir()
  try {
    const clock = { t: 1_000 }
    const pool = new ProviderSlotPool({
      baseDir: dir,
      heartbeatMs: 0,
      staleMs: 100,
      now: () => clock.t,
    })
    const dead = await pool.claim("xai", 1)
    dead.abandon()
    assert.deepEqual(await listSlots(dir, "xai"), ["slot-0"])
    const past = new Date(clock.t - 1_000)
    await utimes(dead.dir, past, past)
    clock.t = 1_000 + 200
    const live = await pool.claim("xai", 1)
    assert.equal(live.index, 0)
    const meta = JSON.parse(await readFile(path.join(live.dir, "hold.json"), "utf8")) as { claimedAt: number }
    assert.equal(meta.claimedAt, 1_200)
    await live.release()
    assert.deepEqual(await listSlots(dir, "xai"), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("machine slot: unsafe provider id never creates a path", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0 })
    await assert.rejects(pool.claim("foo/bar", 1), /safe slot path/)
    await assert.rejects(pool.claim("..", 1), /safe slot path/)
    const names = await readdir(dir)
    assert.deepEqual(names, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gate: cap 1 serializes two acquires; abort of waiter holds nothing extra", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0, rand: () => 0 })
    const gate = new ProviderConcurrencyGate({ slotPool: pool })
    const first = await gate.acquire("anthropic", 1)
    assert.equal(gate.running("anthropic"), 1)
    let secondGot = false
    const secondP = gate.acquire("anthropic", 1).then((p) => {
      secondGot = true
      return p
    })
    await tick()
    assert.equal(secondGot, false)
    assert.equal(gate.queued("anthropic"), 1)
    assert.deepEqual(await listSlots(dir, "anthropic"), ["slot-0"])

    const ctrl = new AbortController()
    const aborted = gate.acquire("anthropic", 1, ctrl.signal)
    await tick()
    assert.equal(gate.queued("anthropic"), 2)
    ctrl.abort()
    await assert.rejects(aborted, /run stopping/)
    assert.equal(gate.queued("anthropic"), 1)
    assert.equal(gate.running("anthropic"), 1)
    assert.deepEqual(await listSlots(dir, "anthropic"), ["slot-0"])

    await first.release()
    const second = await secondP
    assert.equal(secondGot, true)
    assert.equal(gate.running("anthropic"), 1)
    await second.release()
    assert.equal(gate.running("anthropic"), 0)
    assert.deepEqual(await listSlots(dir, "anthropic"), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("machine slot: heartbeat updates mtime", async () => {
  const dir = await tempSlotsDir()
  const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 25, staleMs: 30_000 })
  const hold = await pool.claim("google", 1)
  try {
    const before = (await stat(hold.dir)).mtimeMs
    const deadline = Date.now() + 500
    let after = before
    while (Date.now() < deadline && after <= before) {
      await tick(30)
      after = (await stat(hold.dir)).mtimeMs
    }
    assert.ok(after > before, "heartbeat should bump slot-dir mtime")
  } finally {
    await hold.release()
    await rm(dir, { recursive: true, force: true })
  }
})
