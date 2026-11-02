import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync } from "node:fs"
import { parseQuotaSnapshot, parseCapacitySnapshot, capacityFeed, commandQuotaFeed, DEFAULT_QUOTA_TIMEOUT_MS } from "../src/quota-command.ts"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

/** Injected clock. The checker writes `phase` before it prints a snapshot so fetchedAt can sit after the ttl armed at fetch start. */
function phaseNow(phase: string, fallback: number): () => number {
  return () => {
    try { return Number(readFileSync(phase, "utf8")) } catch { return fallback }
  }
}

const XAI_75 = '{"providers":[{"id":"xai","kind":"live","raw":{"creditUsagePercent":25}}]}'
const XAI_40 = '{"providers":[{"id":"xai","kind":"live","raw":{"creditUsagePercent":60}}]}'
const XAI_0 = '{"providers":[{"id":"xai","kind":"live","raw":{"creditUsagePercent":100}}]}'

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

test("a checker slower than 5s and faster than 20s succeeds under the default bound", async () => {
  assert.equal(DEFAULT_QUOTA_TIMEOUT_MS, 20_000)
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-slow-"))
  const script = path.join(dir, "slow-checker.mjs")
  try {
    await writeFile(script, `await new Promise((r) => setTimeout(r, 6_000));
console.log(JSON.stringify({ providers: [{ id: "xai", kind: "live", raw: { creditUsagePercent: 10 } }] }))`)
    const [underDefault, under5s] = await Promise.all([
      commandQuotaFeed([process.execPath, script])("xai"),
      commandQuotaFeed([process.execPath, script], 60_000, "check-rate", 5_000)("xai"),
    ])
    assert.equal(underDefault?.remainingPercent, 90, "default 20s bound accepts a ~6s checker")
    assert.equal(under5s, undefined, "timeoutMs 5000 still reads unknown")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("timeout reuses a snapshot younger than ttlMs, then re-probes on the 5s expiry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-reuse-"))
  const script = path.join(dir, "checker.sh")
  const count = path.join(dir, "count")
  const phase = path.join(dir, "phase")
  try {
    // /bin/sh, not node: a 30ms bound SIGTERMs node startup (~33ms) before a success can be recorded.
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 4000 > "$phase"
  printf '%s\\n' '${XAI_75}'
elif [ "$n" = "2" ]; then
  sleep 2
else
  printf '%s\\n' '${XAI_40}'
fi
`)
    const feed = commandQuotaFeed(["/bin/sh", script], 5_000, "check-rate", 200, undefined, phaseNow(phase, 0))
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    // Cache was armed at now=0 (expires 5000). fetchedAt is 4000, so now=5000 is a new fetch while last-good is still inside ttlMs.
    await writeFile(phase, "5000")
    const both = await Promise.all([feed("xai"), feed("xai")])
    assert.deepEqual(both.map((value) => value?.remainingPercent), [75, 75], "concurrent waiters share the reused pools, not unknown")
    assert.equal(readFileSync(count, "utf8").trim(), "2", "one shared timeout, not one fetch per waiter")
    assert.equal(await feed("openai"), undefined, "a pool the reused snapshot omits is unknown and does not retry")
    assert.equal(readFileSync(count, "utf8").trim(), "2", "reused timeout does not enter the missing-pool retry")
    // Immediate follow-up still sees the reused reading. The 5s re-probe is the expires write, not a sleep.
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    assert.equal(readFileSync(count, "utf8").trim(), "2")
    await writeFile(phase, "10000")
    // n=3 returns a fresh reading: last-good (4000) is now stale past ttl 5000, so this must NOT reuse 75.
    assert.equal((await feed("xai"))?.remainingPercent, 40)
    assert.equal(readFileSync(count, "utf8").trim(), "3", "advancing the injected clock by 5s starts the next probe")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a timeout re-probes within 5s, not the success ttl", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-reprobe-"))
  const script = path.join(dir, "checker.sh")
  const count = path.join(dir, "count")
  const phase = path.join(dir, "phase")
  try {
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 104000 > "$phase"
  printf '%s\\n' '${XAI_75}'
elif [ "$n" = "2" ]; then
  sleep 2
else
  printf '%s\\n' '${XAI_40}'
fi
`)
    const feed = commandQuotaFeed(["/bin/sh", script], 60_000, "check-rate", 200, undefined, phaseNow(phase, 100_000))
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    await writeFile(phase, "160000")
    assert.equal((await feed("xai"))?.remainingPercent, 75, "timeout while the snapshot is younger than 60s is not unknown")
    assert.equal(readFileSync(count, "utf8").trim(), "2")
    await writeFile(phase, "164999")
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    assert.equal(readFileSync(count, "utf8").trim(), "2", "inside the 5s expiry the reused reading is served without a probe")
    await writeFile(phase, "165000")
    // n=3 returns a fresh reading: the re-probe fires AND recovery replaces the reused value.
    assert.equal((await feed("xai"))?.remainingPercent, 40)
    assert.equal(readFileSync(count, "utf8").trim(), "3", "expires was overwritten to now+5s, not left at the 60s ttl")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a timeout after ttlMs does not reuse a stale positive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-stale-"))
  const script = path.join(dir, "checker.sh")
  const count = path.join(dir, "count")
  const phase = path.join(dir, "phase")
  try {
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 10 > "$phase"
  printf '%s\\n' '${XAI_75}'
else
  sleep 2
fi
`)
    const feed = commandQuotaFeed(["/bin/sh", script], 30, "check-rate", 30, undefined, phaseNow(phase, 0))
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    // Advance past ttlMs before the timeout fetch starts. The ~30ms kill must not be what ages the snapshot out.
    await writeFile(phase, "50")
    assert.equal(await feed("xai"), undefined)
    assert.equal(readFileSync(count, "utf8").trim(), "2")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a non-zero exit after a success is unknown, not the previous positive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-exit-"))
  const script = path.join(dir, "checker.sh")
  const phase = path.join(dir, "phase")
  const count = path.join(dir, "count")
  try {
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 4000 > "$phase"
  printf '%s\\n' '${XAI_75}'
else
  exit 3
fi
`)
    const errors: string[] = []
    const feed = commandQuotaFeed(["/bin/sh", script], 5_000, "check-rate", 30, (_err, _command, failure) => errors.push(failure.kind), phaseNow(phase, 0))
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    await writeFile(phase, "5000")
    assert.equal(await feed("xai"), undefined)
    assert.deepEqual(errors, ["exit"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a parse failure after a success is unknown, not the previous positive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-parse-"))
  const script = path.join(dir, "checker.sh")
  const phase = path.join(dir, "phase")
  const count = path.join(dir, "count")
  try {
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 4000 > "$phase"
  printf '%s\\n' '${XAI_75}'
else
  printf '%s\\n' 'not-json'
fi
`)
    const errors: string[] = []
    const feed = commandQuotaFeed(["/bin/sh", script], 5_000, "check-rate", 30, (_err, _command, failure) => errors.push(failure.kind), phaseNow(phase, 0))
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    await writeFile(phase, "5000")
    assert.equal(await feed("xai"), undefined)
    assert.deepEqual(errors, ["parse"])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a successful snapshot that omits a pool does not fill it from last-good", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-omit-"))
  const script = path.join(dir, "checker.sh")
  const phase = path.join(dir, "phase")
  const count = path.join(dir, "count")
  try {
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 4000 > "$phase"
  printf '%s\\n' '{"providers":[{"id":"xai","kind":"live","raw":{"creditUsagePercent":25}},{"id":"openai","kind":"live","raw":{"ordinaryUsageAllowed":true,"rateLimits":{"primary":{"usedPercent":20}}}}]}'
else
  printf '%s\\n' '{"providers":[{"id":"openai","kind":"live","raw":{"ordinaryUsageAllowed":true,"rateLimits":{"primary":{"usedPercent":50}}}}]}'
fi
`)
    const feed = commandQuotaFeed(["/bin/sh", script], 5_000, "check-rate", 200, undefined, phaseNow(phase, 0))
    assert.equal((await feed("xai"))?.remainingPercent, 75)
    await writeFile(phase, "5000")
    assert.equal(await feed("xai"), undefined, "omitted pool stays unknown")
    assert.equal((await feed("openai"))?.remainingPercent, 50, "the new snapshot's reading wins")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("a parsed remaining of 0 replaces an older positive and is what the next timeout reuses", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-quota-zero-"))
  const script = path.join(dir, "checker.sh")
  const phase = path.join(dir, "phase")
  const count = path.join(dir, "count")
  try {
    await writeFile(script, `#!/bin/sh
count=${JSON.stringify(count)}
phase=${JSON.stringify(phase)}
n=$(cat "$count" 2>/dev/null || echo 0)
n=$((n+1))
printf '%s\\n' "$n" > "$count"
if [ "$n" = "1" ]; then
  printf '%s\\n' 4000 > "$phase"
  printf '%s\\n' '${XAI_40}'
elif [ "$n" = "2" ]; then
  printf '%s\\n' 9000 > "$phase"
  printf '%s\\n' '${XAI_0}'
else
  sleep 2
fi
`)
    const feed = commandQuotaFeed(["/bin/sh", script], 5_000, "check-rate", 200, undefined, phaseNow(phase, 0))
    assert.equal((await feed("xai"))?.remainingPercent, 40)
    await writeFile(phase, "5000")
    assert.equal((await feed("xai"))?.remainingPercent, 0, "confirmed zero is a reading, not unknown")
    await writeFile(phase, "10000")
    assert.equal((await feed("xai"))?.remainingPercent, 0, "timeout reuses the zero, not the older positive")
    assert.equal(readFileSync(count, "utf8").trim(), "3")
  } finally { await rm(dir, { recursive: true, force: true }) }
})
