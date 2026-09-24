import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  clearQuarantineMarker,
  defaultProviderQuarantineDir,
  PROVIDER_QUARANTINE_ESTIMATED_CAP_MS,
  readAllQuarantineMarkers,
  readQuarantineMarker,
  writeQuarantineMarker,
} from "../src/provider-quarantine.ts"

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "uc-quarantine-"))
}

test("marker round-trip: write, read, expire, clear", async () => {
  const dir = await tmpDir()
  const now = Date.now()
  await writeQuarantineMarker({ dir, providerID: "xai", until: now + 60_000, estimated: false, now })
  const marker = await readQuarantineMarker(dir, "xai", now)
  assert.equal(marker?.providerID, "xai")
  assert.equal(marker?.estimated, false)
  // Expired marker reads as absent.
  assert.equal(await readQuarantineMarker(dir, "xai", now + 61_000), undefined)
  // Clear removes the file entirely.
  await clearQuarantineMarker(dir, "xai")
  assert.equal(await readQuarantineMarker(dir, "xai", now), undefined)
})

test("merge policy: later deadline wins; a reported reset may replace an earlier estimate", async () => {
  const dir = await tmpDir()
  const now = Date.now()
  await writeQuarantineMarker({ dir, providerID: "xai", until: now + 60_000, estimated: true, now })
  // Stale writer with an EARLIER deadline does not shorten a fresh marker.
  await writeQuarantineMarker({ dir, providerID: "xai", until: now + 30_000, estimated: true, now })
  assert.equal((await readQuarantineMarker(dir, "xai", now))?.until, now + 60_000)
  // A provider-REPORTED (non-estimated) reset replaces an estimate even earlier.
  await writeQuarantineMarker({ dir, providerID: "xai", until: now + 45_000, estimated: false, now })
  assert.equal((await readQuarantineMarker(dir, "xai", now))?.until, now + 45_000)
})

test("estimated markers are capped so a crashed writer cannot pin a provider for hours", async () => {
  const dir = await tmpDir()
  const now = Date.now()
  await writeQuarantineMarker({ dir, providerID: "xai", until: now + 6 * 3_600_000, estimated: true, now })
  const marker = await readQuarantineMarker(dir, "xai", now)
  assert.ok(marker !== undefined)
  assert.ok(marker.until <= now + PROVIDER_QUARANTINE_ESTIMATED_CAP_MS + 5)
  assert.equal(marker.estimated, true)
})

test("readAll prunes malformed files and ignores unsafe provider ids", async () => {
  const dir = await tmpDir()
  const now = Date.now()
  await writeQuarantineMarker({ dir, providerID: "openai", until: now + 60_000, estimated: false, now })
  await writeFile(path.join(dir, "bad.json"), "{not json", "utf8")
  await writeFile(path.join(dir, "../evil.json"), "{}", "utf8").catch(() => undefined)
  const all = await readAllQuarantineMarkers(dir, now)
  assert.deepEqual([...all.keys()], ["openai"])
})

test("marker file is atomic JSON with pid + observedAt diagnostics", async () => {
  const dir = await tmpDir()
  const now = Date.now()
  await writeQuarantineMarker({ dir, providerID: "zai-coding-plan", until: now + 60_000, estimated: false, now })
  const raw = JSON.parse(await readFile(path.join(dir, "zai-coding-plan.json"), "utf8")) as Record<string, unknown>
  assert.equal(raw.providerID, "zai-coding-plan")
  assert.equal(raw.until, now + 60_000)
  assert.equal(raw.pid, process.pid)
  assert.equal(raw.observedAt, now)
})

test("default dir sits beside the provider slot dir", () => {
  assert.ok(defaultProviderQuarantineDir().endsWith("provider-quarantine"))
})
