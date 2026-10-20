import assert from "node:assert/strict"
import { test } from "node:test"
import { parseQuotaSnapshot, parseCapacitySnapshot, capacityFeed, commandQuotaFeed } from "../src/quota-command.ts"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("quota feed honors tightest window, monthly Alibaba, and unknown status", () => {
  const quota = parseQuotaSnapshot({ providers: [
    { id: "openai", kind: "live", raw: { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 20 }, secondary: { usedPercent: 82 } } } },
    { id: "alibaba-token-plan", kind: "live", raw: { monthly: { pct: 97 }, weekly: { pct: 50 } } },
    { id: "xai", kind: "live", raw: { creditUsagePercent: 100 } },
    { id: "xiaomi", kind: "static", raw: {} },
  ] })
  assert.equal(quota.get("openai")?.remainingPercent, 18)
  assert.equal(quota.get("alibaba-token-plan")?.remainingPercent, 3)
  assert.equal(quota.get("xai")?.remainingPercent, 0)
  assert.equal(quota.get("xiaomi"), undefined)
})

test("portable capacity source has named pools, multiple windows and unknown fail-closed", async () => {
  const snapshot = parseCapacitySnapshot({ pools: [
    { id: "team-monthly", windows: [{ remainingPercent: 70 }, { remainingPercent: 12 }] },
    { id: "other-weekly", windows: [{ remainingPercent: 80 }] },
    { id: "broken", windows: [{ remainingPercent: "100" }] },
    { id: "stale", status: "unknown", windows: [{ remainingPercent: 100 }] },
    { id: "expired", expiresAt: "2020-01-01T00:00:00Z", windows: [{ remainingPercent: 100 }] },
  ] })
  assert.equal(snapshot.get("team-monthly")?.remainingPercent, 12)
  assert.equal(snapshot.get("other-weekly")?.remainingPercent, 80)
  assert.equal(snapshot.has("broken"), false)
  assert.equal(snapshot.has("stale"), false)
  assert.equal(snapshot.has("expired"), false)
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-capacity-"))
  const script = path.join(dir, "checker.mjs")
  try {
    await writeFile(script, 'console.log(JSON.stringify({ pools: [{ id: "team-monthly", windows: [{ remainingPercent: 37 }] }] }))')
    const quota = capacityFeed({ quotaSources: { "team-monthly": { command: [process.execPath, script], format: "capacity-v1" } } })
    assert.equal((await quota("team-monthly"))?.remainingPercent, 37)
    assert.equal(await quota("other-weekly"), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("missing quota readings get one shared retry; a confirmed zero overrides unknown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-retry-"))
  const script = path.join(dir, "checker.mjs")
  const count = path.join(dir, "count")
  try {
    await writeFile(script, `import fs from "node:fs";
const n = Number(fs.existsSync(${JSON.stringify(count)}) ? fs.readFileSync(${JSON.stringify(count)}, "utf8") : 0) + 1;
fs.writeFileSync(${JSON.stringify(count)}, String(n));
console.log(JSON.stringify({ providers: n === 1 ? [] : [{ id: "openai", kind: "live", raw: {
  ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 100 } } } }] }));`)
    const feed = commandQuotaFeed([process.execPath, script])
    const readings = await Promise.all(Array.from({ length: 7 }, () => feed("openai")))
    assert.deepEqual(readings.map((value) => value?.remainingPercent), Array(7).fill(0))
    assert.equal(await (await import("node:fs/promises")).readFile(count, "utf8"), "2")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("still-unknown quota stays unknown after retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-unknown-"))
  const script = path.join(dir, "checker.mjs")
  try {
    await writeFile(script, 'console.log(JSON.stringify({ providers: [] }))')
    const feed = commandQuotaFeed([process.execPath, script])
    assert.equal(await feed("openai"), undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("quota command timeout is configurable and a failed probe is reported, not silent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-timeout-"))
  const script = path.join(dir, "slow-checker.mjs")
  try {
    await writeFile(script, `await new Promise((r) => setTimeout(r, 400));
console.log(JSON.stringify({ providers: [{ id: "xai", kind: "live", raw: { creditUsagePercent: 25 } }] }))`)
    const errors: Array<{ kind: string }> = []
    const tight = commandQuotaFeed([process.execPath, script], 60_000, "check-rate", 50, (_err, _command, failure) => errors.push(failure))
    assert.equal(await tight("xai"), undefined, "a probe slower than the bound reads unknown")
    assert.equal(await tight("openai"), undefined, "a second pool on the same failed snapshot does not re-run the command")
    assert.deepEqual(errors.map((f) => f.kind), ["timeout"], "exactly one report per failed snapshot, classified")
    const relaxed = commandQuotaFeed([process.execPath, script], 60_000, "check-rate", 5_000)
    assert.equal((await relaxed("xai"))?.remainingPercent, 75)
    const viaOptions = capacityFeed({ quotaCommand: [process.execPath, script], quotaTimeoutMs: 50 })
    assert.equal(await viaOptions("xai"), undefined, "capacityFeed forwards quotaTimeoutMs")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a failed command is not retried within the snapshot; one checker serves many pools once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-shared-"))
  const script = path.join(dir, "checker.mjs")
  const count = path.join(dir, "count")
  const { readFile } = await import("node:fs/promises")
  try {
    await writeFile(script, `import fs from "node:fs";
const n = Number(fs.existsSync(${JSON.stringify(count)}) ? fs.readFileSync(${JSON.stringify(count)}, "utf8") : 0) + 1;
fs.writeFileSync(${JSON.stringify(count)}, String(n));
if (process.argv.includes("--fail")) process.exit(3);
console.log(JSON.stringify({ pools: [{ id: "a", windows: [{ remainingPercent: 40 }] }, { id: "b", windows: [{ remainingPercent: 70 }] }] }));`)
    const failures: Array<{ kind: string; pool?: string; emitted?: string[] }> = []
    const failing = capacityFeed({ quotaSources: {
      a: { command: [process.execPath, script, "--fail"], format: "capacity-v1" },
      b: { command: [process.execPath, script, "--fail"], format: "capacity-v1" },
    } }, (_err, _command, failure) => failures.push(failure))
    assert.equal(await failing("a"), undefined)
    assert.equal(await failing("b"), undefined)
    assert.equal(await readFile(count, "utf8"), "1", "a non-zero exit runs the command once per snapshot, not once per pool and not twice")
    assert.deepEqual(failures.map((f) => f.kind), ["exit"])

    await writeFile(count, "0")
    const ok = capacityFeed({ quotaSources: {
      a: { command: [process.execPath, script], format: "capacity-v1" },
      b: { command: [process.execPath, script], format: "capacity-v1" },
      c: { command: [process.execPath, script], format: "capacity-v1" },
    } }, (_err, _command, failure) => failures.push(failure))
    assert.equal((await ok("a"))?.remainingPercent, 40)
    assert.equal((await ok("b"))?.remainingPercent, 70)
    assert.equal(await readFile(count, "utf8"), "1", "three pool ids bound to one command share one process per snapshot")
    assert.equal(await ok("c"), undefined, "a key the checker never emits is unknown")
    assert.equal(await readFile(count, "utf8"), "2", "a missing pool gets the one shared retry")
    const missing = failures.find((f) => f.kind === "missing-pool")
    assert.ok(missing, "a configured pool the checker does not emit is reported, not silent")
    assert.equal(missing?.pool, "c")
    assert.deepEqual(missing?.emitted, ["a", "b"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})
