/**
 * Instance + machine provider concurrency slots.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { utimesSync } from "node:fs"
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  isSafeProviderID,
  ProviderConcurrencyGate,
  ProviderSlotPool,
} from "../src/provider-slots.ts"
import { Semaphore } from "../src/primitives.ts"

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

test("gate: a later larger cap raises the live limit (latest cap wins)", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0, rand: () => 0 })
    const gate = new ProviderConcurrencyGate({ slotPool: pool })
    const first = await gate.acquire("anthropic", 2)
    const second = await gate.acquire("anthropic", 2)
    assert.equal(gate.running("anthropic"), 2)
    let thirdGot = false
    const thirdP = gate.acquire("anthropic", 4).then((p) => {
      thirdGot = true
      return p
    })
    await tick()
    assert.equal(thirdGot, true, "cap 4 admits a third child while two cap-2 permits are held")
    const third = await thirdP
    assert.equal(gate.running("anthropic"), 3)
    await first.release()
    await second.release()
    await third.release()
    assert.equal(gate.running("anthropic"), 0)
    assert.deepEqual(await listSlots(dir, "anthropic"), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gate: a later smaller cap queues future admissions and never preempts holders", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0, rand: () => 0 })
    const gate = new ProviderConcurrencyGate({ slotPool: pool })
    const held: Awaited<ReturnType<ProviderConcurrencyGate["acquire"]>>[] = []
    for (let i = 0; i < 3; i++) held.push(await gate.acquire("openai", 4))
    assert.equal(gate.running("openai"), 3)
    let fourthGot = false
    const fourthP = gate.acquire("openai", 2).then((p) => {
      fourthGot = true
      return p
    })
    await tick(30)
    assert.equal(fourthGot, false, "cap 2 with 3 live holders must queue the fourth child")
    assert.equal(gate.queued("openai"), 1)
    assert.equal(gate.running("openai"), 3, "a shrink never preempts permit holders")
    await held[0]!.release()
    const fourth = await fourthP
    assert.equal(fourthGot, true, "one release transfers the slot to the queued child")
    assert.equal(gate.running("openai"), 3)
    await held[1]!.release()
    await held[2]!.release()
    await fourth.release()
    assert.equal(gate.running("openai"), 0)
    assert.deepEqual(await listSlots(dir, "openai"), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("gate: setLimit growth drains the FIFO queue in arrival order", async () => {
  const sem = new Semaphore(1)
  await sem.acquire()
  const order: string[] = []
  for (const id of ["a", "b", "c"]) {
    void sem.acquire().then(() => {
      order.push(id)
    })
  }
  await tick()
  assert.deepEqual(order, [])
  sem.setLimit(3) // room for exactly two more
  await tick()
  assert.deepEqual(order, ["a", "b"], "new headroom resolves waiters FIFO")
  assert.equal(sem.queued, 1)
  assert.equal(sem.running, 3)
  sem.setLimit(4)
  await tick()
  assert.deepEqual(order, ["a", "b", "c"])
  assert.equal(sem.queued, 0)
  assert.equal(sem.running, 4)
  for (let i = 0; i < 4; i++) sem.release()
  assert.equal(sem.running, 0)
})

test("machine slot: release after foreign re-claim does not delete the foreign dir", async () => {
  const dir = await tempSlotsDir()
  try {
    const pool = new ProviderSlotPool({ baseDir: dir, heartbeatMs: 0, pid: 111 })
    const hold = await pool.claim("anthropic", 1)
    await writeFile(path.join(hold.dir, "hold.json"), JSON.stringify({ pid: 222, claimedAt: Date.now() }))
    await hold.release()
    assert.deepEqual(await listSlots(dir, "anthropic"), ["slot-0"])
    const meta = JSON.parse(await readFile(path.join(hold.dir, "hold.json"), "utf8")) as { pid: number }
    assert.equal(meta.pid, 222)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("machine slot: stale reclaim does not steal a dir whose mtime was just refreshed", async () => {
  const dir = await tempSlotsDir()
  try {
    const clock = { t: 1_000 }
    const holder = new ProviderSlotPool({
      baseDir: dir,
      heartbeatMs: 0,
      staleMs: 100,
      now: () => clock.t,
      pid: 1,
    })
    const live = await holder.claim("xai", 1)
    const past = new Date(800)
    await utimes(live.dir, past, past)
    let nowCalls = 0
    const racing = new ProviderSlotPool({
      baseDir: dir,
      heartbeatMs: 0,
      staleMs: 100,
      pid: 2,
      now: () => {
        nowCalls++
        if (nowCalls === 1) {
          queueMicrotask(() => {
            const fresh = new Date(950)
            utimesSync(live.dir, fresh, fresh)
          })
        }
        return clock.t
      },
      rand: () => 0,
    })
    const ctrl = new AbortController()
    const claiming = racing.claim("xai", 1, ctrl.signal)
    await tick(40)
    ctrl.abort()
    await assert.rejects(claiming, /run stopping/)
    assert.deepEqual(await listSlots(dir, "xai"), ["slot-0"])
    const meta = JSON.parse(await readFile(path.join(live.dir, "hold.json"), "utf8")) as { pid: number }
    assert.equal(meta.pid, 1, "the refreshed dir must not have been reclaimed")
    await live.release()
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
