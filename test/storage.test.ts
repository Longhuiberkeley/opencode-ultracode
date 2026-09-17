/**
 * Builder A tests — src/storage.ts: project-scoped KV snapshots, script/result
 * artifacts, saved-workflow pairs + trust gate, precedence, name validation,
 * shared lstat-aware containment resolver (symlinks fail closed), KV cursor
 * pagination, fresh composition loader, and saved GRAPH workflows
 * (`<name>.graph.json` compiled fresh on load, digest over the compiled script).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  GRAPH_ARTIFACT_SUFFIX,
  StorageImpl,
  WORKFLOW_NAME_RE,
  buildGraphBody,
  normalizePath,
  readProjectWorkflowFile,
  resolveContainedPath,
} from "../src/storage.ts"
import { compileGraphSpec } from "../src/graph.ts"
import type { FsLike, Json, KvLike, RunRecord } from "../src/types.ts"
import { FakeFs, FakeKv } from "./fakes.ts"

const PROJECT = "/project"
const PERSONAL = "/home/u/.config/opencode/workflows"
const PERSONAL_ANCHOR = "/home/u/.config/opencode"
const PROJECT_WF = "/project/.opencode/workflows"
const PID = "proj-123"
const PID_KEY = `p${createHash("sha256").update(PID).digest("hex").slice(0, 16)}`
// Keys are project-scoped (hashed pid): runs/<pid>/<id>, results/<pid>/<id>, trust/<pid>/<name>.
const RUNS_KEY = (id: string) => `runs/${PID_KEY}/${id}`
const RESULTS_KEY = (id: string) => `results/${PID_KEY}/${id}`

function makeStorage(overrides: { kv?: KvLike; fs?: FsLike; projectID?: string; projectRoot?: string } = {}) {
  const kv = overrides.kv ?? new FakeKv()
  const fs = overrides.fs ?? new FakeFs()
  const projectRoot = overrides.projectRoot ?? PROJECT
  const storage = new StorageImpl({
    kv,
    fs,
    projectRoot,
    personalWorkflowDir: PERSONAL,
    projectID: overrides.projectID ?? PID,
  })
  return { storage, kv, fs: fs as FakeFs, projectRoot }
}

/** Seed the trusted anchors so the containment resolver can realpath them. */
function seedAnchors(fs: FakeFs): void {
  fs.files.set(`${PROJECT}/.anchor`, "")
  fs.files.set(`${PERSONAL_ANCHOR}/.anchor`, "")
}

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_test1",
    parentSessionID: "ses_parent",
    parentAgent: "build",
    name: "demo run",
    status: "running",
    script: "return agent('hi')",
    meta: { name: "demo", requires: ["general"] },
    args: { q: "test" },
    startedAt: 1725_000_000_000,
    agents: [
      {
        id: "a1",
        label: "scan",
        phase: "extract",
        requestedAgent: "explore",
        effectiveAgent: "explore",
        effectiveModel: { providerID: "fake", id: "fake-model" },
        sessionID: "ses_child",
        status: "succeeded",
        tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 2, write: 0 } },
      },
    ],
    ...overrides,
  }
}

/** Hand-written on-disk pair (hash recorded but trust lives in the KV). */
async function writePair(
  fs: FakeFs,
  dir: string,
  name: string,
  script: string,
  manifest: Record<string, unknown> = {},
): Promise<void> {
  await fs.writeFile(`${dir}/${name}.js`, script)
  await fs.writeFile(`${dir}/${name}.json`, JSON.stringify({ version: 1, name, hash: "", savedAt: 1, ...manifest }))
}

// ---------------------------------------------------------------------------
// Run snapshots (KV, project-scoped)
// ---------------------------------------------------------------------------

test("saveRun stores the full record under runs/<pid>/<id> and seeds loadRuns", async () => {
  const { storage, kv } = makeStorage()
  const run = makeRun()
  storage.saveRun(run)
  const stored = (await kv.get(RUNS_KEY("run_test1"))) as Json
  assert.deepEqual(stored, JSON.parse(JSON.stringify(run)))
  assert.deepEqual(Object.keys(stored as object).sort(), Object.keys(JSON.parse(JSON.stringify(run))).sort())

  const loaded = storage.loadRuns()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.id, "run_test1")

  const scanned = await storage.loadRunsAsync()
  assert.equal(scanned.length, 1)
  assert.deepEqual(scanned[0], JSON.parse(JSON.stringify(run)))
})

test("pid key segment is a stable sha256 hash (injective across project ids)", async () => {
  const kv = new FakeKv()
  const { storage } = makeStorage({ kv, projectID: "weird id/with slash+plus" })
  storage.saveRun(makeRun())
  const expected = `p${createHash("sha256").update("weird id/with slash+plus").digest("hex").slice(0, 16)}`
  assert.deepEqual([...kv.store.keys()], [`runs/${expected}/run_test1`])
})

test("KV keys are scoped by project id — no cross-project contamination", async () => {
  const kvA = new FakeKv()
  const { storage: a } = makeStorage({ kv: kvA, projectID: "project-a" })
  const { storage: b } = makeStorage({ kv: kvA, projectID: "project-b" })
  a.saveRun(makeRun({ id: "run_only_a" }))
  const aRuns = await a.loadRunsAsync()
  const bRuns = await b.loadRunsAsync()
  assert.deepEqual(aRuns.map((r) => r.id), ["run_only_a"])
  assert.deepEqual(bRuns.map((r) => r.id), []) // reconciliation sees only its own project
})

test("saveRun updates are last-write-wins and sorted by startedAt", async () => {
  const { storage } = makeStorage()
  storage.saveRun(makeRun({ id: "run_b", startedAt: 2 }))
  storage.saveRun(makeRun({ id: "run_a", startedAt: 1 }))
  storage.saveRun(makeRun({ id: "run_b", startedAt: 2, status: "succeeded", endedAt: 3 }))
  const runs = await storage.loadRunsAsync()
  assert.deepEqual(runs.map((r) => r.id), ["run_a", "run_b"])
  assert.equal(runs[1]!.status, "succeeded")
})

test("loadRunsAsync skips junk entries and other projects' records", async () => {
  const { storage, kv } = makeStorage()
  await kv.set("runs/x/not-an-object", "nope" as Json)
  await kv.set("runs/x/bad", { hello: 1 } as Json)
  await kv.set("other/run_test1", makeRun() as unknown as Json)
  storage.saveRun(makeRun())
  const runs = await storage.loadRunsAsync()
  assert.deepEqual(runs.map((r) => r.id), ["run_test1"])
})

test("loadRunsAsync follows KV scan next-cursors until exhausted", async () => {
  /** KV that pages one entry at a time with `next` cursors. */
  class PagedKv extends FakeKv {
    lastAfter: string | undefined = undefined
    async scan(options: { prefix: string; after?: string; limit?: number }): Promise<{
      entries: ReadonlyArray<{ key: string; value: Json }>
      next?: string
    }> {
      this.lastAfter = options.after
      const all = [...this.store.entries()]
        .filter(([k]) => k.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value }))
        .sort((x, y) => (x.key < y.key ? -1 : 1))
      const after = options.after
      const start = after !== undefined ? all.findIndex((e) => e.key > after) : 0
      const page = all.slice(start, start + 1)
      return { entries: page, next: page.length > 0 ? page[0]!.key : undefined }
    }
  }
  const kv = new PagedKv()
  const { storage } = makeStorage({ kv })
  storage.saveRun(makeRun({ id: "run_a", startedAt: 1 }))
  storage.saveRun(makeRun({ id: "run_b", startedAt: 2 }))
  storage.saveRun(makeRun({ id: "run_c", startedAt: 3 }))
  const runs = await storage.loadRunsAsync()
  assert.deepEqual(runs.map((r) => r.id), ["run_a", "run_b", "run_c"])
  assert.ok(kv.lastAfter !== undefined, "cursor was actually followed")
})

test("saveRun never throws when the KV backend fails", () => {
  class ThrowingKv extends FakeKv {
    async set(): Promise<void> {
      throw new Error("kv down")
    }
  }
  const { storage } = makeStorage({ kv: new ThrowingKv() })
  assert.doesNotThrow(() => storage.saveRun(makeRun()))
  assert.equal(storage.loadRuns().length, 1) // cache still updated
})

// ---------------------------------------------------------------------------
// Script artifacts (fs) + containment
// ---------------------------------------------------------------------------

test("writeScriptArtifact writes <projectRoot>/.opencode/workflows/runs/<runID>.js", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const path = await storage.writeScriptArtifact("run_abc123", "return 1")
  assert.equal(path, `${PROJECT_WF}/runs/run_abc123.js`)
  assert.equal(await fs.readFile(`${PROJECT_WF}/runs/run_abc123.js`), "return 1")
})

test("writeScriptArtifact rejects unsafe run ids", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  for (const bad of ["../evil", "a/b", "..", "run..x", ".hidden", "", "x".repeat(200)]) {
    assert.equal(await storage.writeScriptArtifact(bad, "s"), undefined, `runID ${JSON.stringify(bad)}`)
  }
  assert.equal((await fs.readdir(`${PROJECT_WF}/runs`)).length, 0)
})

test("writeScriptArtifact rejects a symlinked runs/ dir that escapes the project (fail closed)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/legit.js`, "x") // materialize the dirs
  fs.symlinks.set(`${PROJECT_WF}/runs`, "/outside-runs")
  await fs.writeFile("/outside-runs/.keep", "x") // the symlink target EXISTS (not dangling)
  assert.equal(await storage.writeScriptArtifact("run_x", "s"), undefined)
  assert.equal(await fs.exists("/outside-runs/run_x.js"), false)
})

test("writeScriptArtifact rejects a dangling runs/ symlink (fail closed)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/legit.js`, "x")
  fs.symlinks.set(`${PROJECT_WF}/runs`, "/outside-runs") // target does NOT exist
  assert.equal(await storage.writeScriptArtifact("run_x", "s"), undefined)
})

test("writeScriptArtifact swallows fs errors and returns undefined", async () => {
  const base = new FakeFs()
  seedAnchors(base)
  const failing: FsLike = {
    mkdir: (p) => base.mkdir(p),
    readFile: (p) => base.readFile(p),
    exists: (p) => base.exists(p),
    readdir: (p) => base.readdir(p),
    realpath: (p) => base.realpath(p),
    lstat: (p) => base.lstat(p),
    writeFile: async () => {
      throw new Error("disk full")
    },
  }
  const { storage } = makeStorage({ fs: failing })
  assert.equal(await storage.writeScriptArtifact("run_ok", "s"), undefined)
})

// ---------------------------------------------------------------------------
// Result artifacts (KV-backed cache, project-scoped)
// ---------------------------------------------------------------------------

test("saveResultArtifact round-trips via loadResultArtifact under results/<pid>/", async () => {
  const { storage, kv } = makeStorage()
  const key = storage.saveResultArtifact("run_big", { huge: ["x".repeat(10)] })
  assert.equal(key, RESULTS_KEY("run_big"))
  assert.deepEqual(storage.loadResultArtifact(key), { huge: ["x".repeat(10)] })
  assert.deepEqual(await kv.get(RESULTS_KEY("run_big")), { huge: ["x".repeat(10)] })
  assert.equal(storage.loadResultArtifact("runs/run_big"), undefined) // wrong prefix
  assert.equal(storage.loadResultArtifact("results/other/run_big"), undefined) // other project
  assert.equal(storage.loadResultArtifact("results/missing"), undefined)
})

test("loadResultArtifactFresh falls back to KV when the cache misses", async () => {
  const { storage } = makeStorage()
  const key = RESULTS_KEY("run_cached")
  storage.saveResultArtifact("run_cached", { from: "cache" })
  assert.deepEqual(await storage.loadResultArtifactFresh(key), { from: "cache" })
  // Fresh storage instance (empty cache), same KV => KV fallback works.
  const { storage: fresh, kv } = makeStorage()
  await kv.set(key, { from: "kv" })
  assert.deepEqual(await fresh.loadResultArtifactFresh(key), { from: "kv" })
  assert.equal(await fresh.loadResultArtifactFresh("results/nope"), undefined)
})

test("saveResultArtifact: unserializable value claims no key and counts the failure", () => {
  const { storage } = makeStorage()
  const circular: Json = { self: null } as unknown as Json
  ;(circular as { self: unknown }).self = circular
  const key = storage.saveResultArtifact("run_bad", circular)
  assert.equal(key, undefined)
  assert.equal(storage.loadResultArtifact(RESULTS_KEY("run_bad")), undefined)
  const diag = storage.kvDiagnostics()
  assert.equal(diag.artifactErrorCount, 1)
  assert.match(diag.lastArtifactError ?? "", /circular/i)
})

test("saveResultArtifact: async KV failure is counted in kvDiagnostics (doctor)", async () => {
  const kv: KvLike = new FakeKv()
  const failing: KvLike = {
    get: kv.get.bind(kv),
    set: async () => {
      throw new Error("kv quota exceeded")
    },
    ...(kv.scan ? { scan: kv.scan.bind(kv) } : {}),
  }
  const { storage } = makeStorage({ kv: failing })
  const key = storage.saveResultArtifact("run_kvfail", { ok: true })
  assert.equal(key, RESULTS_KEY("run_kvfail")) // cache still holds it
  await new Promise((r) => setTimeout(r, 10)) // let the fire-and-forget reject
  const diag = storage.kvDiagnostics()
  assert.equal(diag.artifactErrorCount, 1)
  assert.match(diag.lastArtifactError ?? "", /quota/)
  // Same-process reads still work from the cache.
  assert.deepEqual(storage.loadResultArtifact(key!), { ok: true })
})

test("resultCache is a bounded LRU: oldest entries evict, reads refresh recency", () => {
  const { storage } = makeStorage()
  const limit = StorageImpl.RESULT_CACHE_LIMIT
  for (let i = 0; i < limit; i++) {
    storage.saveResultArtifact(`run_${String(i).padStart(2, "0")}`, { i })
  }
  // Touch the oldest so it becomes most-recent.
  assert.deepEqual(storage.loadResultArtifact(RESULTS_KEY("run_00")), { i: 0 })
  storage.saveResultArtifact("run_overflow", { i: limit }) // evicts run_01 now
  assert.deepEqual(storage.loadResultArtifact(RESULTS_KEY("run_00")), { i: 0 })
  assert.equal(storage.loadResultArtifact(RESULTS_KEY("run_01")), undefined)
  assert.deepEqual(storage.loadResultArtifact(RESULTS_KEY("run_overflow")), { i: limit })
})

// ---------------------------------------------------------------------------
// Saved workflows: pairs, precedence, trust gate
// ---------------------------------------------------------------------------

test("saveWorkflow writes the js + json pair; manifest.name is the filename key", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const saved = await storage.saveWorkflow("alpha", "return 1", {
    name: "ignored-display-name", // storage forces manifest.name = key (review fix)
    description: "demo",
    phases: ["a", "b"],
    requires: ["general"],
    savedFromRunID: "run_test1",
    source: "project",
  })
  assert.equal(saved.script, "return 1")
  assert.equal(saved.manifest.version, 1)
  assert.equal(saved.manifest.source, "project")
  assert.equal(saved.manifest.name, "alpha")
  assert.equal(saved.manifest.hash, createHash("sha256").update("return 1").digest("hex"))
  assert.equal(typeof saved.manifest.savedAt, "number")

  assert.equal(await fs.readFile(`${PROJECT_WF}/alpha.js`), "return 1")
  const manifest = JSON.parse(await fs.readFile(`${PROJECT_WF}/alpha.json`)) as Record<string, unknown>
  assert.equal(manifest["name"], "alpha")
  assert.equal(manifest["hash"], saved.manifest.hash)
  assert.equal(manifest["savedFromRunID"], "run_test1")
})

test("saveWorkflow(personal) writes into the personal dir", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const saved = await storage.saveWorkflow("beta", "return 2", { name: "beta", source: "personal" })
  assert.equal(saved.manifest.source, "personal")
  assert.equal(await fs.exists(`${PERSONAL}/beta.js`), true)
  assert.equal(await fs.exists(`${PROJECT_WF}/beta.js`), false)
})

test("saveWorkflow rejects invalid names without writing files", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  for (const bad of ["UPPER", "-lead", "_lead", "a/b", "../evil", "", "x".repeat(65), "has space", "café"]) {
    await assert.rejects(() => storage.saveWorkflow(bad, "s", { name: bad, source: "project" }), /invalid workflow name/)
  }
  assert.equal(await fs.exists(`${PROJECT_WF}/alpha.js`), false) // nothing written
})

test("loadWorkflow throws on invalid names and returns undefined for unknown names", () => {
  const { storage } = makeStorage()
  assert.throws(() => storage.loadWorkflow("../evil"), /invalid workflow name/)
  assert.throws(() => storage.loadWorkflow("UPPER"), /invalid workflow name/)
  assert.equal(storage.loadWorkflow("unknown"), undefined)
})

test("trust gate: untrusted until trusted; trust -> load; edit -> blocked; re-trust -> load", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveWorkflow("gamma", "return 1", { name: "gamma", source: "project" })
  await storage.refreshWorkflows()

  // First run: not trusted yet.
  assert.throws(() => storage.loadWorkflow("gamma"), /is not trusted \(new or changed since approval\)/)
  assert.throws(() => storage.loadWorkflow("gamma"), /\/ultracode trust gamma/)

  // Approve the current version — the ack carries the COMPUTED digest.
  const trusted = await storage.trustWorkflow("gamma")
  assert.equal(trusted?.workflow.script, "return 1")
  assert.equal(trusted?.digest, createHash("sha256").update("return 1").digest("hex"))
  assert.equal(storage.loadWorkflow("gamma")?.script, "return 1")

  // Edit the script on disk -> digest differs -> blocked again.
  await fs.writeFile(`${PROJECT_WF}/gamma.js`, "return 2 // changed")
  await storage.refreshWorkflows()
  assert.throws(() => storage.loadWorkflow("gamma"), /is not trusted/)

  // Re-trust the new version -> loads again.
  await storage.trustWorkflow("gamma")
  assert.equal(storage.loadWorkflow("gamma")?.script, "return 2 // changed")
})

test("trust records are project-scoped", async () => {
  const kv = new FakeKv()
  const fsA = new FakeFs()
  seedAnchors(fsA)
  const fsB = new FakeFs()
  seedAnchors(fsB)
  const { storage: a } = makeStorage({ kv, fs: fsA, projectID: "project-a" })
  const { storage: b } = makeStorage({ kv, fs: fsB, projectID: "project-b" })
  await a.saveWorkflow("alpha", "return a", { name: "alpha", source: "project" })
  await b.saveWorkflow("alpha", "return b", { name: "alpha", source: "project" })
  await a.refreshWorkflows()
  await a.trustWorkflow("alpha")
  assert.equal(a.loadWorkflow("alpha")?.script, "return a") // trusted in project a
  await b.refreshWorkflows()
  assert.throws(() => b.loadWorkflow("alpha"), /is not trusted/) // not in project b
})

test("trustWorkflow: unknown name -> undefined; name-mismatched pair -> throws", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  assert.equal(await storage.trustWorkflow("missing"), undefined)
  await writePair(fs, PROJECT_WF, "drifted", "return 1", { name: "other-name" })
  await storage.refreshWorkflows()
  await assert.rejects(() => storage.trustWorkflow("drifted"), /does not match/)
})

test("hand-written sample pairs (empty hash) are untrusted until trusted — no bypass", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "sample", "return 'sample'")
  await storage.refreshWorkflows()
  assert.throws(() => storage.loadWorkflow("sample"), /is not trusted/)
  const trusted = await storage.trustWorkflow("sample")
  assert.equal(trusted?.digest, createHash("sha256").update("return 'sample'").digest("hex"))
  assert.equal(storage.loadWorkflow("sample")?.script, "return 'sample'")
})

test("loadWorkflow throws when manifest.name doesn't match the filename key", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "drifted", "return 1", { name: "other-name" })
  await storage.refreshWorkflows()
  assert.throws(() => storage.loadWorkflow("drifted"), /does not match filename "drifted"/)
})

test("workflowTrustState: unknown / untrusted (changed) / trusted", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  assert.equal(storage.workflowTrustState("nope"), "unknown")
  await writePair(fs, PROJECT_WF, "alpha", "return 1")
  await storage.refreshWorkflows()
  assert.equal(storage.workflowTrustState("alpha"), "untrusted")
  await storage.trustWorkflow("alpha")
  assert.equal(storage.workflowTrustState("alpha"), "trusted")
  await fs.writeFile(`${PROJECT_WF}/alpha.js`, "return 2 // changed")
  await storage.refreshWorkflows()
  assert.equal(storage.workflowTrustState("alpha"), "untrusted") // changed since approval
})

// ---------------------------------------------------------------------------
// Fresh composition loader (snapshot-per-call)
// ---------------------------------------------------------------------------

test("loadWorkflowFresh reads disk + KV directly, without prior refreshWorkflows", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "fresh", "return 1")
  // No refreshWorkflows call: the fresh path must still see the pair...
  await assert.rejects(() => storage.loadWorkflowFresh("fresh"), /is not trusted/)
  // ...and the cached path must not (cache was never warmed).
  assert.equal(storage.loadWorkflow("fresh"), undefined)
  await storage.trustWorkflow("fresh")
  const loaded = await storage.loadWorkflowFresh("fresh")
  assert.equal(loaded?.script, "return 1")
  // Success updates the caches so subsequent sync loads agree.
  assert.equal(storage.loadWorkflow("fresh")?.script, "return 1")
})

test("loadWorkflowFresh is snapshot-per-call: edits block without any refresh", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "fresh", "return 1")
  await storage.trustWorkflow("fresh")
  assert.equal((await storage.loadWorkflowFresh("fresh"))?.script, "return 1")
  await fs.writeFile(`${PROJECT_WF}/fresh.js`, "return 2 // changed")
  await assert.rejects(() => storage.loadWorkflowFresh("fresh"), /is not trusted/) // no refresh needed
  await storage.trustWorkflow("fresh")
  assert.equal((await storage.loadWorkflowFresh("fresh"))?.script, "return 2 // changed")
})

test("loadWorkflowFresh honors precedence and unknown names", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  assert.equal(await storage.loadWorkflowFresh("missing"), undefined)
  await writePair(fs, PERSONAL, "both", "personal")
  await writePair(fs, PROJECT_WF, "both", "project")
  await storage.trustWorkflow("both") // trusts the project copy (precedence)
  assert.equal((await storage.loadWorkflowFresh("both"))?.script, "project")
})

// ---------------------------------------------------------------------------
// refreshWorkflows + precedence
// ---------------------------------------------------------------------------

test("refreshWorkflows: project dir overrides personal dir on name collision", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PERSONAL, "alpha", "personal alpha")
  await writePair(fs, PERSONAL, "only-personal", "personal only")
  await writePair(fs, PROJECT_WF, "alpha", "project alpha")
  await writePair(fs, PROJECT_WF, "only-project", "project only")
  await storage.refreshWorkflows()

  const names = storage.listWorkflows().map((w) => `${w.manifest.name}:${w.manifest.source}`).sort()
  assert.deepEqual(names, ["alpha:project", "only-personal:personal", "only-project:project"])
  await storage.trustWorkflow("alpha")
  assert.equal(storage.loadWorkflow("alpha")?.script, "project alpha")
  await storage.trustWorkflow("only-personal")
  assert.equal(storage.loadWorkflow("only-personal")?.manifest.source, "personal")
})

test("refreshWorkflows skips incomplete pairs and non-workflow files", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/no-manifest.js`, "x")
  await fs.writeFile(`${PROJECT_WF}/no-script.json`, "{}")
  await fs.writeFile(`${PROJECT_WF}/notes.txt`, "not a workflow")
  await fs.writeFile(`${PROJECT_WF}/BadName.js`, "x")
  await writePair(fs, PROJECT_WF, "good", "return 1")
  await storage.refreshWorkflows()
  assert.deepEqual(storage.listWorkflows().map((w) => w.manifest.name), ["good"])
})

// ---------------------------------------------------------------------------
// Symlink containment for workflow writes (fail closed)
// ---------------------------------------------------------------------------

test("saveWorkflow rejects a symlinked workflows dir that escapes the project root", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  fs.symlinks.set(`${PROJECT}/.opencode`, "/elsewhere")
  await fs.writeFile("/elsewhere/.keep", "x") // the symlink target EXISTS
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "project" }),
    /refusing to write workflow "evil"/,
  )
})

test("saveWorkflow rejects a DANGLING symlinked workflows dir (target outside, not yet existing)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  fs.symlinks.set(`${PROJECT}/.opencode`, "/outside") // target does NOT exist
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "project" }),
    /dangling|refusing/,
  )
  assert.equal(await fs.exists("/outside/evil.js"), false)
})

test("saveWorkflow rejects a dangling <name>.js symlink pointing outside (final component)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "real", "x") // materialize dirs with a legit pair
  fs.symlinks.set(`${PROJECT_WF}/evil.js`, "/outside/target.js") // dangling outside link
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "project" }),
    /refusing to write workflow "evil"/,
  )
})

test("saveWorkflow rejects an EXISTING outside <name>.js symlink (write-through escape)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "real", "x")
  fs.symlinks.set(`${PROJECT_WF}/evil.js`, "/outside/target.js")
  await fs.writeFile("/outside/target.js", "existing") // target exists outside the anchor
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "project" }),
    /resolves outside|refusing/,
  )
  assert.equal(await fs.readFile("/outside/target.js"), "existing") // untouched
})

test("saveWorkflow(personal) rejects when the personal workflows dir is a symlink", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  fs.symlinks.set(PERSONAL, "/etc-stub")
  await fs.writeFile("/etc-stub/.keep", "x")
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "personal" }),
    /refusing to write workflow "evil"/,
  )
})

test("saveWorkflow accepts inside-the-anchor symlinks and symlinked project roots", async () => {
  // Project root itself is a symlink — anchor and target resolve consistently.
  const fs = new FakeFs()
  fs.symlinks.set("/proj", "/data/proj")
  await fs.writeFile("/data/proj/.anchor", "x")
  const { storage } = makeStorage({ fs, projectRoot: "/proj" })
  const saved = await storage.saveWorkflow("ok", "return 1", { name: "ok", source: "project" })
  assert.equal(saved.manifest.name, "ok")

  // A symlink INSIDE the anchor pointing inside the anchor is legitimate.
  const { storage: s2, fs: fs2 } = makeStorage()
  seedAnchors(fs2)
  fs2.symlinks.set(`${PROJECT}/.opencode`, `${PROJECT}/real-opencode`)
  await fs2.writeFile(`${PROJECT}/real-opencode/.keep`, "x")
  const saved2 = await s2.saveWorkflow("ok2", "return 2", { name: "ok2", source: "project" })
  assert.equal(saved2.manifest.name, "ok2")
})

// ---------------------------------------------------------------------------
// resolveContainedPath (direct)
// ---------------------------------------------------------------------------

test("resolveContainedPath: ok for existing and new paths inside the anchor", async () => {
  const fs = new FakeFs()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/alpha.js`, "x")
  assert.deepEqual(await resolveContainedPath(fs, PROJECT, `${PROJECT_WF}/alpha.js`), { ok: true, path: `${PROJECT_WF}/alpha.js` })
  const newFile = await resolveContainedPath(fs, PROJECT, `${PROJECT_WF}/new/deep/file.js`)
  assert.equal(newFile.ok, true) // new tail under a resolved-inside chain
  assert.deepEqual(await resolveContainedPath(fs, PROJECT, PROJECT), { ok: true, path: PROJECT })
})

test("resolveContainedPath: lexical escapes, unresolvable anchors and errors reject", async () => {
  const fs = new FakeFs()
  seedAnchors(fs)
  const escape = await resolveContainedPath(fs, PROJECT, "/etc/passwd")
  assert.equal(escape.ok, false)
  assert.match(escape.error, /not inside/)
  const noAnchor = await resolveContainedPath(fs, "/missing-root", "/missing-root/x")
  assert.equal(noAnchor.ok, false) // fail closed when the anchor can't be resolved
})

test("resolveContainedPath: dangling and escaping symlinks reject (no lexical fallback)", async () => {
  const fs = new FakeFs()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/real.js`, "x")
  fs.symlinks.set(`${PROJECT_WF}/dangling.js`, "/outside/missing.js")
  const dangling = await resolveContainedPath(fs, PROJECT, `${PROJECT_WF}/dangling.js`)
  assert.equal(dangling.ok, false)
  fs.symlinks.set(`${PROJECT_WF}/escape.js`, "/outside/exists.js")
  await fs.writeFile("/outside/exists.js", "x")
  const escaping = await resolveContainedPath(fs, PROJECT, `${PROJECT_WF}/escape.js`)
  assert.equal(escaping.ok, false)
  assert.match(escaping.error, /resolves outside/)
})

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

test("normalizePath matches FakeFs semantics", () => {
  assert.equal(normalizePath("/a/b/../c"), "/a/c")
  assert.equal(normalizePath("/a/./b//c"), "/a/b/c")
  assert.equal(normalizePath("a/b/../../c"), "c")
  assert.equal(normalizePath("/.."), "/")
  assert.equal(normalizePath("/x/../.."), "/")
})

test("WORKFLOW_NAME_RE accepts and rejects the right names", () => {
  for (const good of ["a", "a1", "deep-research", "code_audit-2", "0start", "x".repeat(64)]) {
    assert.equal(WORKFLOW_NAME_RE.test(good), true, good)
  }
  for (const bad of ["", "-x", "_x", "A", "a b", "a/b", "x".repeat(65), "a.b"]) {
    assert.equal(WORKFLOW_NAME_RE.test(bad), false, bad)
  }
})

test("settings overlay KV is project-scoped at settings/<pid>", async () => {
  const { storage, kv } = makeStorage()
  storage.saveSettingsOverlay({ concurrency: 3, permissions: "noEditTools" })
  const key = `settings/${PID_KEY}`
  const stored = await kv.get(key)
  assert.ok(stored && typeof stored === "object")
  const rec = stored as { concurrency?: number; permissions?: string }
  assert.equal(rec.concurrency, 3)
  assert.equal(rec.permissions, "noEditTools")
  assert.equal(storage.loadSettingsOverlay()?.concurrency, 3)
  const other = makeStorage({ projectID: "other-proj" })
  assert.equal(other.storage.loadSettingsOverlay(), undefined)
  const loaded = await storage.loadSettingsOverlayAsync()
  assert.equal(loaded?.concurrency, 3)
  assert.equal(loaded?.permissions, "noEditTools")
})

test("saveWorkflowFromFile: omitted savedFromRunID; hash matches file bytes", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const script = "return 41 + 1"
  await fs.writeFile(`${PROJECT_WF}/handoff.js`, script)
  const saved = await storage.saveWorkflowFromFile("handoff")
  assert.equal(saved.script, script)
  assert.equal(saved.manifest.hash, createHash("sha256").update(script).digest("hex"))
  assert.equal(saved.manifest.source, "project")
  assert.equal(saved.manifest.savedFromRunID, undefined)
  assert.equal("savedFromRunID" in saved.manifest, false)
  const onDisk = JSON.parse(await fs.readFile(`${PROJECT_WF}/handoff.json`)) as Record<string, unknown>
  assert.equal("savedFromRunID" in onDisk, false)
  assert.equal(onDisk["hash"], saved.manifest.hash)
})

test("saveWorkflowFromFile invalid names fail closed without writing", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  for (const bad of ["UPPER", "-lead", "../evil", "", "has space"]) {
    await assert.rejects(() => storage.saveWorkflowFromFile(bad), /invalid workflow name/)
  }
  assert.equal(await fs.exists(`${PROJECT_WF}/UPPER.js`), false)
})

test("saveWorkflowFromFile missing js errors before write", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await assert.rejects(() => storage.saveWorkflowFromFile("nope"), /not found/)
  assert.equal(await fs.exists(`${PROJECT_WF}/nope.json`), false)
})

test("saveWorkflowFromFile reads resolved.path not the lexical scriptPath", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "real", "x")
  await fs.writeFile(`${PROJECT}/inside.js`, "return 9")
  fs.symlinks.set(`${PROJECT_WF}/handoff.js`, `${PROJECT}/inside.js`)
  const saved = await storage.saveWorkflowFromFile("handoff")
  assert.equal(saved.script, "return 9")
})

test("saveWorkflowFromFile and saveWorkflow use resolved.path for read/write", () => {
  const src = readFileSync(new URL("../src/storage.ts", import.meta.url), "utf8")
  assert.match(src, /readFile\(resolved\.path\)/)
  assert.match(src, /writeFile\(resolvedScript\.path/)
  assert.match(src, /writeFile\(resolvedManifest\.path/)
})

test("saveWorkflowFromFile symlink escapes fail closed on source read", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "real", "x")
  fs.symlinks.set(`${PROJECT_WF}/evil.js`, "/outside/target.js")
  await fs.writeFile("/outside/target.js", "return 1")
  await assert.rejects(() => storage.saveWorkflowFromFile("evil"), /refusing to read workflow "evil"/)
  assert.equal(await fs.exists(`${PROJECT_WF}/evil.json`), false)
  assert.equal(await fs.readFile("/outside/target.js"), "return 1")
})

test("saveWorkflowFromFile changed-script trust rejection until re-trust", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveWorkflow("gamma", "return 1", { name: "gamma", source: "project" })
  await storage.trustWorkflow("gamma")
  assert.equal(storage.workflowTrustState("gamma"), "trusted")
  await fs.writeFile(`${PROJECT_WF}/gamma.js`, "return 2 // changed")
  await storage.saveWorkflowFromFile("gamma")
  await storage.refreshWorkflows()
  assert.equal(storage.workflowTrustState("gamma"), "untrusted")
  assert.throws(() => storage.loadWorkflow("gamma"), /is not trusted \(new or changed since approval\)/)
  const trusted = await storage.trustWorkflow("gamma")
  assert.equal(trusted?.digest, createHash("sha256").update("return 2 // changed").digest("hex"))
  assert.equal(storage.loadWorkflow("gamma")?.script, "return 2 // changed")
})

// ---------------------------------------------------------------------------
// Saved GRAPH workflows (<name>.graph.json + <name>.json, compiled fresh)
// ---------------------------------------------------------------------------

const GRAPH_SPEC = {
  name: "lane-review",
  description: "scout, partition, review",
  nodes: [
    {
      id: "scout",
      kind: "agent",
      agent: "explore",
      prompt: "Inventory {{args.area}}. Per file: name + line count.",
      schema: {
        type: "object",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "lines"],
              properties: { name: { type: "string" }, lines: { type: "number" } },
            },
          },
        },
      },
    },
    { id: "lanes", kind: "partition", from: "$scout.items", budgetTokens: 100 },
    {
      id: "review",
      kind: "fanout",
      over: "$lanes",
      agent: "explore",
      max: 4,
      prompt: "Review exactly these files (ranged reads only):\n{{item}}",
    },
  ],
  returns: { report: "$review" },
}

function compiledScript(spec: unknown): string {
  return compileGraphSpec(spec as never).script
}

function scriptDigest(spec: unknown): string {
  return createHash("sha256").update(compiledScript(spec), "utf8").digest("hex")
}

/** Deep JSON copy — persisted specs are normalized through a JSON round-trip. */
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function bodyError(body: ReturnType<typeof buildGraphBody>): string {
  return body.ok ? "" : body.error
}

/** Hand-authored graph pair (the manifest hash is a placeholder, like the samples). */
async function writeGraphPair(
  fs: FakeFs,
  dir: string,
  name: string,
  spec: unknown,
  manifest: Record<string, unknown> = {},
): Promise<void> {
  await fs.writeFile(`${dir}/${name}${GRAPH_ARTIFACT_SUFFIX}`, JSON.stringify(spec, null, 2))
  await fs.writeFile(
    `${dir}/${name}.json`,
    JSON.stringify({ version: 1, name, hash: "", savedAt: 1, kind: "graph", ...manifest }),
  )
}

test("saveGraphWorkflow writes spec + manifest; load compiles fresh and stays trust-gated", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const saved = await storage.saveGraphWorkflow("lane-review", jsonCopy(GRAPH_SPEC) as Json, {
    name: "lane-review",
    source: "project",
  })
  assert.equal(saved.manifest.kind, "graph")
  assert.equal(saved.manifest.hash, scriptDigest(GRAPH_SPEC), "hash is over the COMPILED script")
  assert.deepEqual(saved.manifest.phases, ["scout", "review"], "compiler-synthesized phases")
  assert.deepEqual(saved.manifest.requires, ["explore"], "compiler-synthesized agent preflight")
  assert.equal(saved.manifest.description, "scout, partition, review", "spec description becomes the manifest's")
  assert.deepEqual(JSON.parse(await fs.readFile(`${PROJECT_WF}/lane-review${GRAPH_ARTIFACT_SUFFIX}`)), jsonCopy(GRAPH_SPEC))
  assert.equal((JSON.parse(await fs.readFile(`${PROJECT_WF}/lane-review.json`)) as Record<string, unknown>).kind, "graph")

  await storage.refreshWorkflows()
  const listed = storage.listWorkflows()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.manifest.kind, "graph")
  assert.equal(storage.workflowTrustState("lane-review"), "untrusted")
  assert.throws(() => storage.loadWorkflow("lane-review"), /is not trusted \(new or changed since approval\)/)

  const trusted = await storage.trustWorkflow("lane-review")
  assert.equal(trusted?.digest, scriptDigest(GRAPH_SPEC))
  assert.equal(storage.workflowTrustState("lane-review"), "trusted")
  const loaded = storage.loadWorkflow("lane-review")
  assert.equal(loaded?.script, compiledScript(GRAPH_SPEC))
  assert.deepEqual(loaded?.graphSpec, jsonCopy(GRAPH_SPEC))
  assert.equal(loaded?.graphError, undefined)
})

test("graph trust follows the compiled output: editing the spec blocks until re-trust", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveGraphWorkflow("lane-review", jsonCopy(GRAPH_SPEC) as Json, { name: "lane-review", source: "project" })
  await storage.trustWorkflow("lane-review")
  assert.equal(storage.workflowTrustState("lane-review"), "trusted")

  const edited = jsonCopy(GRAPH_SPEC)
  edited.nodes[0]!.prompt = "Inventory {{args.area}} and report module boundaries too."
  await fs.writeFile(`${PROJECT_WF}/lane-review${GRAPH_ARTIFACT_SUFFIX}`, JSON.stringify(edited, null, 2))
  await storage.refreshWorkflows()
  assert.equal(storage.workflowTrustState("lane-review"), "untrusted")
  assert.throws(() => storage.loadWorkflow("lane-review"), /is not trusted/)
  await assert.rejects(() => storage.loadWorkflowFresh("lane-review"), /is not trusted/)

  await storage.trustWorkflow("lane-review")
  assert.equal(storage.loadWorkflow("lane-review")?.script, compiledScript(edited))
  assert.deepEqual(storage.loadWorkflow("lane-review")?.graphSpec, jsonCopy(edited))
})

test("loadWorkflowFresh recompiles the CURRENT spec per call (no stale graph cache)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveGraphWorkflow("fresh", jsonCopy(GRAPH_SPEC) as Json, { name: "fresh", source: "project" })
  await storage.trustWorkflow("fresh")
  assert.equal((await storage.loadWorkflowFresh("fresh"))?.script, compiledScript(GRAPH_SPEC))
  const edited = jsonCopy(GRAPH_SPEC)
  edited.nodes[2]!.prompt = "Review {{item}} with fresh eyes."
  await fs.writeFile(`${PROJECT_WF}/fresh${GRAPH_ARTIFACT_SUFFIX}`, JSON.stringify(edited, null, 2))
  // Snapshot-per-call: the edit is visible without any refreshWorkflows, and it
  // invalidates trust because the compiled script moved.
  await assert.rejects(() => storage.loadWorkflowFresh("fresh"), /is not trusted/)
  await storage.trustWorkflow("fresh")
  assert.equal((await storage.loadWorkflowFresh("fresh"))?.script, compiledScript(edited))
})

test("an invalid graph spec is LISTED with its validator errors — never trustable, never 'not found'", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writeGraphPair(fs, PROJECT_WF, "broken", { nodes: [{ id: "a", kind: "agent" }] })
  await storage.refreshWorkflows()
  const listed = storage.listWorkflows()
  assert.equal(listed.length, 1, "a broken graph is listed, not silently dropped")
  assert.match(listed[0]!.graphError ?? "", /prompt is required for kind agent/)
  assert.equal(listed[0]!.script, "", "an unloadable graph has no executable script")
  assert.equal(listed[0]!.manifest.kind, "graph")
  assert.equal(storage.workflowTrustState("broken"), "untrusted")
  assert.throws(() => storage.loadWorkflow("broken"), /cannot run: the graph spec failed validation/)
  // The fail-open this ordering prevents: trusting sha256("") of a broken spec.
  await assert.rejects(() => storage.trustWorkflow("broken"), /cannot run: the graph spec failed validation/)
  await assert.rejects(() => storage.loadWorkflowFresh("broken"), /cannot run/)
})

test("a malformed graph spec file reports a JSON error instead of vanishing", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/junk${GRAPH_ARTIFACT_SUFFIX}`, "{ not json at all")
  await fs.writeFile(`${PROJECT_WF}/junk.json`, JSON.stringify({ version: 1, name: "junk", hash: "", savedAt: 1 }))
  await storage.refreshWorkflows()
  const listed = storage.listWorkflows()
  assert.equal(listed.length, 1)
  assert.match(listed[0]!.graphError ?? "", /is not valid JSON/)
  assert.throws(() => storage.loadWorkflow("junk"), /cannot run/)
})

test("artifact precedence is explicit: <name>.js wins over <name>.graph.json", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "dual", "return 1")
  await writeGraphPair(fs, PROJECT_WF, "dual", GRAPH_SPEC)
  await storage.refreshWorkflows()
  const found = storage.listWorkflows().filter((w) => w.manifest.name === "dual")
  assert.equal(found.length, 1, "one name, one workflow — never both artifacts")
  assert.equal(found[0]!.manifest.kind, "script", "the artifact present decides the kind, not the manifest")
  assert.equal(found[0]!.script, "return 1")
  assert.equal(found[0]!.graphSpec, undefined)
})

test("saving the other artifact kind over an existing name is refused (no silent shadow)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveWorkflow("alpha", "return 1", { name: "alpha", source: "project" })
  await assert.rejects(
    () => storage.saveGraphWorkflow("alpha", jsonCopy(GRAPH_SPEC) as Json, { name: "alpha", source: "project" }),
    /already exists and would shadow it/,
  )
  assert.equal(await fs.exists(`${PROJECT_WF}/alpha${GRAPH_ARTIFACT_SUFFIX}`), false)
  await storage.refreshWorkflows()
  assert.deepEqual(storage.listWorkflows().map((w) => w.manifest.name), ["alpha"], "the refused save changed nothing")
  assert.equal(storage.listWorkflows()[0]!.script, "return 1", "the original pair still loads")

  await storage.saveGraphWorkflow("beta", jsonCopy(GRAPH_SPEC) as Json, { name: "beta", source: "project" })
  await assert.rejects(
    () => storage.saveWorkflow("beta", "return 2", { name: "beta", source: "project" }),
    /already exists and would shadow it/,
  )
  assert.equal(await fs.exists(`${PROJECT_WF}/beta.js`), false)
})

test("saveGraphWorkflow rejects an invalid spec before writing anything", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await assert.rejects(
    () => storage.saveGraphWorkflow("nope", { nodes: [{ id: "a", kind: "agent" }] } as Json, { name: "nope", source: "project" }),
    /refusing to save graph workflow "nope": the graph spec failed validation/,
  )
  await assert.rejects(
    () => storage.saveGraphWorkflow("nope2", "{ json string" as unknown as Json, { name: "nope2", source: "project" }),
    /refusing to save graph workflow "nope2"/,
  )
  assert.equal(await fs.exists(`${PROJECT_WF}/nope${GRAPH_ARTIFACT_SUFFIX}`), false)
  assert.equal(await fs.exists(`${PROJECT_WF}/nope.json`), false)
})

test("saveWorkflowFromFile: a hand-authored .graph.json is preserved byte-for-byte; only the manifest is written", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  // Deliberately odd key order + formatting: the handoff must not reformat it.
  const authored = '{\n  "nodes": [\n    { "kind": "agent", "id": "only", "prompt": "Say hi about {{args.topic}}." }\n  ]\n}\n'
  await fs.writeFile(`${PROJECT_WF}/hand.graph.json`, authored)
  await fs.writeFile(
    `${PROJECT_WF}/hand.json`,
    JSON.stringify({
      version: 1,
      name: "hand",
      hash: "",
      savedAt: 0,
      description: "hand-authored graph",
      params: { args: [{ name: "topic" }] },
    }),
  )
  const saved = await storage.saveWorkflowFromFile("hand")
  assert.equal(await fs.readFile(`${PROJECT_WF}/hand.graph.json`), authored, "authored spec file untouched")
  assert.equal(saved.manifest.kind, "graph")
  assert.equal(saved.manifest.description, "hand-authored graph", "a hand-written manifest is preserved, not clobbered")
  assert.deepEqual(saved.manifest.params, { args: [{ name: "topic" }] })
  assert.equal(saved.manifest.hash, scriptDigest(JSON.parse(authored)))
  assert.equal("savedFromRunID" in saved.manifest, false)
  assert.equal(saved.script, compiledScript(JSON.parse(authored)))
  await storage.refreshWorkflows()
  assert.equal(storage.workflowTrustState("hand"), "untrusted", "the handoff never auto-trusts")
})

test("saveWorkflowFromFile preserves hand-written metadata for script workflows too", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "authored", "return 1", {
    description: "authored by hand",
    phases: ["one"],
    requires: ["general"],
  })
  const saved = await storage.saveWorkflowFromFile("authored")
  assert.equal(saved.manifest.description, "authored by hand")
  assert.deepEqual(saved.manifest.phases, ["one"])
  assert.deepEqual(saved.manifest.requires, ["general"])
  assert.equal(saved.script, "return 1")
})

test("saveWorkflowFromFile refuses an invalid graph spec before writing a manifest", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/bad.graph.json`, JSON.stringify({ nodes: [{ id: "x", kind: "nope" }] }))
  await assert.rejects(
    () => storage.saveWorkflowFromFile("bad"),
    /refusing to save workflow "bad": the graph spec failed validation/,
  )
  assert.equal(await fs.exists(`${PROJECT_WF}/bad.json`), false)
})

test("saveWorkflowFromFile names both artifacts when nothing is found", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await assert.rejects(() => storage.saveWorkflowFromFile("ghost"), /not found \(ghost\.js or ghost\.graph\.json\)/)
})

test("saveWorkflowFromFile refuses when both .js and .graph.json exist (no silent shadow)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const script = "return 'from-js'"
  const specRaw = JSON.stringify(GRAPH_SPEC)
  await fs.writeFile(`${PROJECT_WF}/dual.js`, script)
  await fs.writeFile(`${PROJECT_WF}/dual${GRAPH_ARTIFACT_SUFFIX}`, specRaw)
  const before = new Map(fs.files)
  await assert.rejects(() => storage.saveWorkflowFromFile("dual"), /already exists and would shadow/)
  assert.deepEqual([...fs.files.entries()], [...before.entries()], "the refused save wrote nothing")
  assert.equal(await fs.readFile(`${PROJECT_WF}/dual.js`), script)
  assert.equal(await fs.readFile(`${PROJECT_WF}/dual${GRAPH_ARTIFACT_SUFFIX}`), specRaw)
  assert.equal(await fs.exists(`${PROJECT_WF}/dual.json`), false, "no manifest pair was created")
})

test("graph workflows load from the personal dir; project still wins a name collision", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveGraphWorkflow("shared", jsonCopy(GRAPH_SPEC) as Json, { name: "shared", source: "personal" })
  await storage.refreshWorkflows()
  assert.deepEqual(
    storage.listWorkflows().map((w) => `${w.manifest.name}:${w.manifest.source}:${w.manifest.kind ?? "script"}`),
    ["shared:personal:graph"],
  )
  await storage.saveWorkflow("shared", "return 'project script'", { name: "shared", source: "project" })
  await storage.refreshWorkflows()
  assert.deepEqual(
    storage.listWorkflows().map((w) => `${w.manifest.name}:${w.manifest.source}:${w.manifest.kind ?? "script"}`),
    ["shared:project:script"],
  )
  assert.equal(await fs.exists(`${PERSONAL}/shared${GRAPH_ARTIFACT_SUFFIX}`), true, "the personal graph file is left alone")
})

test("refreshWorkflows skips a graph artifact without a manifest and dotted names", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await fs.writeFile(`${PROJECT_WF}/lonely.graph.json`, JSON.stringify(GRAPH_SPEC))
  await fs.writeFile(`${PROJECT_WF}/a.b.graph.json`, JSON.stringify(GRAPH_SPEC))
  await writeGraphPair(fs, PROJECT_WF, "good-graph", GRAPH_SPEC)
  await storage.refreshWorkflows()
  assert.deepEqual(storage.listWorkflows().map((w) => w.manifest.name), ["good-graph"])
})

test("an empty saved script is reported, never trusted", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await writePair(fs, PROJECT_WF, "blank", "   ")
  await storage.refreshWorkflows()
  assert.equal(storage.workflowTrustState("blank"), "untrusted")
  assert.throws(() => storage.loadWorkflow("blank"), /cannot run: the saved script is empty/)
  await assert.rejects(() => storage.trustWorkflow("blank"), /cannot run: the saved script is empty/)
})

test("saveGraphWorkflow rejects a symlinked workflows dir that escapes the project root", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  fs.symlinks.set(`${PROJECT}/.opencode`, "/elsewhere")
  await fs.writeFile("/elsewhere/.keep", "x")
  await assert.rejects(
    () => storage.saveGraphWorkflow("evil", jsonCopy(GRAPH_SPEC) as Json, { name: "evil", source: "project" }),
    /refusing to write workflow "evil"/,
  )
  assert.equal(await fs.exists(`/elsewhere/evil${GRAPH_ARTIFACT_SUFFIX}`), false)
})

test("graph writes and reads use resolved.path, not the lexical target", () => {
  const src = readFileSync(new URL("../src/storage.ts", import.meta.url), "utf8")
  assert.match(src, /writeFile\(resolvedSpec\.path/)
  assert.match(src, /readFile\(resolvedGraph\.path\)/)
})

test("buildGraphBody: precise errors for parse, validation and compile failures", () => {
  assert.match(bodyError(buildGraphBody("{ nope")), /is not valid JSON/)
  assert.match(bodyError(buildGraphBody(JSON.stringify({ nodes: [{ id: "a", kind: "agent" }] }))), /prompt is required/)
  assert.match(bodyError(buildGraphBody(JSON.stringify([]))), /must be a JSON object/)
  assert.match(bodyError(buildGraphBody(JSON.stringify({ nodes: [] }))), /at least one node/)
  const ok = buildGraphBody(JSON.stringify(GRAPH_SPEC))
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.script, compiledScript(GRAPH_SPEC))
    assert.deepEqual(ok.phases, ["scout", "review"])
    assert.deepEqual(ok.requires, ["explore"])
    assert.equal(ok.description, "scout, partition, review")
    assert.deepEqual(ok.spec, jsonCopy(GRAPH_SPEC))
  }
  // Truncated validator output stays quotable (MAX_GRAPH_ERRORS).
  const many = buildGraphBody(
    JSON.stringify({
      nodes: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, kind: "agent" })),
    }),
  )
  assert.match(bodyError(many), /\(\+3 more\)/)
})

test("RunRecord.graphSpec survives the KV round-trip (a restarted server can still render it)", async () => {
  const { kv } = makeStorage()
  const run = makeRun({
    id: "run_graph1",
    script: "const G_args = args",
    graphSpec: { nodes: [{ id: "a", kind: "agent", prompt: "p {{args.x}}" }] },
  })
  const first = makeStorage({ kv })
  first.storage.saveRun(run)
  const second = makeStorage({ kv })
  await second.storage.loadRunsAsync()
  const loaded = second.storage.loadRuns().find((r) => r.id === "run_graph1")
  assert.deepEqual(loaded?.graphSpec, run.graphSpec)
})

// ---------------------------------------------------------------------------
// readProjectWorkflowFile ({ path } runs — symlink-aware containment)
// ---------------------------------------------------------------------------

test("readProjectWorkflowFile: reads content, derives stem name", async () => {
  const fs = new FakeFs()
  await fs.writeFile("/proj/.opencode/workflows/audit.js", "return 1")
  const r = await readProjectWorkflowFile(fs, "/proj", ".opencode/workflows/audit.js")
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.content, "return 1")
    assert.equal(r.name, "audit")
  }
})

test("readProjectWorkflowFile: symlink escaping the project root is refused (fail closed)", async () => {
  const fs = new FakeFs()
  await fs.writeFile("/outside/secret.js", "steal()")
  fs.symlinks.set("/proj/.opencode/workflows/evil.js", "/outside/secret.js")
  const r = await readProjectWorkflowFile(fs, "/proj", ".opencode/workflows/evil.js")
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.error, /refusing|not inside/)
})

test("readProjectWorkflowFile: missing and empty files are precise errors", async () => {
  const fs = new FakeFs()
  await fs.writeFile("/proj/.opencode/workflows/.anchor", "") // project tree exists
  const missing = await readProjectWorkflowFile(fs, "/proj", ".opencode/workflows/nope.js")
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /not found/)
  await fs.writeFile("/proj/.opencode/workflows/empty.js", "   ")
  const empty = await readProjectWorkflowFile(fs, "/proj", ".opencode/workflows/empty.js")
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.error, /empty/)
})

// ---------------------------------------------------------------------------
// modelsUsed trust surfacing on save
// ---------------------------------------------------------------------------

test("saveWorkflow records explicit model literals as manifest modelsUsed", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const saved = await storage.saveWorkflow(
    "modeluser",
    'await agent("a", { model: "google/gemini-3.7-flash" })\nawait agent("b", { model: "openai/gpt-6#high" })\nawait agent("c")',
    { name: "modeluser", source: "project" },
  )
  assert.deepEqual(saved.manifest.modelsUsed, ["google/gemini-3.7-flash", "openai/gpt-6#high"])

  const noModels = await storage.saveWorkflow("nomodels", "return 1", { name: "nomodels", source: "project" })
  assert.equal(noModels.manifest.modelsUsed, undefined, "no literals -> no modelsUsed key")
})

test("saveGraphWorkflow records per-node model overrides as modelsUsed", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  const spec = {
    nodes: [
      { id: "a", kind: "agent", model: "openai/gpt-6", prompt: "hi" },
      { id: "b", kind: "fanout", over: "$a", max: 2, model: "openai/gpt-6", prompt: "go {{item}}" },
    ],
  }
  const saved = await storage.saveGraphWorkflow("gmodel", spec, { name: "gmodel", source: "project" })
  assert.deepEqual(saved.manifest.modelsUsed, ["openai/gpt-6"], "deduped across nodes")
})

test("modelsUsed survives a reload (refreshWorkflows reads it back from disk)", async () => {
  const { storage, fs } = makeStorage()
  seedAnchors(fs)
  await storage.saveWorkflow("reloadme", 'await agent("a", { model: "openai/gpt-6" })', {
    name: "reloadme",
    source: "project",
  })
  // The catalog refreshes from disk on every call — the reload path must not
  // drop modelsUsed (parseManifest whitelist).
  await storage.refreshWorkflows()
  const listed = storage.listWorkflows().find((w) => w.manifest.name === "reloadme")
  assert.deepEqual(listed?.manifest.modelsUsed, ["openai/gpt-6"], "modelsUsed read back from disk")

  const { storage: fresh } = makeStorage({ fs, kv: undefined })
  await fresh.refreshWorkflows()
  const relisted = fresh.listWorkflows().find((w) => w.manifest.name === "reloadme")
  assert.deepEqual(relisted?.manifest.modelsUsed, ["openai/gpt-6"], "fresh instance sees it too")
})

test("runDirFor: run scaffold dir for loop artifacts, rejects path-shaped ids", () => {
  const { storage } = makeStorage()
  const dir = storage.runDirFor("run_0123456789abcdef")
  assert.ok(dir, "valid run id returns a dir")
  assert.match(dir!, /workflows[\\/]runs[\\/]run_0123456789abcdef$/)
  assert.equal(storage.runDirFor("../escape"), undefined)
  assert.equal(storage.runDirFor("a/b"), undefined)
  assert.equal(storage.runDirFor(""), undefined)
})
