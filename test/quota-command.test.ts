import assert from "node:assert/strict"
import { test } from "node:test"
import { parseQuotaSnapshot, parseCapacitySnapshot, capacityFeed } from "../src/quota-command.ts"
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
