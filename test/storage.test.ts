/**
 * Builder A tests — src/storage.ts: KV snapshots, script/result artifacts,
 * saved-workflow pairs, precedence, name validation, path safety.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { StorageImpl, WORKFLOW_NAME_RE, normalizePath } from "../src/storage.ts"
import type { FsLike, Json, RunRecord } from "../src/types.ts"
import { FakeFs, FakeKv } from "./fakes.ts"

const PROJECT = "/project"
const PERSONAL = "/home/u/.config/opencode/workflows"
const PROJECT_WF = "/project/.opencode/workflows"

function makeStorage(overrides: { kv?: FakeKv; fs?: FsLike } = {}) {
  const kv = overrides.kv ?? new FakeKv()
  const fs = overrides.fs ?? new FakeFs()
  const storage = new StorageImpl({ kv, fs, projectRoot: PROJECT, personalWorkflowDir: PERSONAL })
  return { storage, kv, fs: fs as FakeFs }
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

/** Minimal valid manifest JSON for hand-written pairs (empty hash = sample tolerance). */
function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, name: "alpha", hash: "", savedAt: 1, ...overrides })
}

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
// Run snapshots (KV)
// ---------------------------------------------------------------------------

test("saveRun stores the full record under runs/<id> and seeds loadRuns", async () => {
  const { storage, kv } = makeStorage()
  const run = makeRun()
  storage.saveRun(run)
  const stored = (await kv.get("runs/run_test1")) as Json
  assert.deepEqual(stored, JSON.parse(JSON.stringify(run)))
  // nothing omitted
  assert.deepEqual(Object.keys(stored as object).sort(), Object.keys(JSON.parse(JSON.stringify(run))).sort())

  const loaded = storage.loadRuns()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.id, "run_test1")

  const scanned = await storage.loadRunsAsync()
  assert.equal(scanned.length, 1)
  assert.deepEqual(scanned[0], JSON.parse(JSON.stringify(run)))
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

test("loadRunsAsync skips junk entries", async () => {
  const { storage, kv } = makeStorage()
  await kv.set("runs/not-an-object", "nope" as Json)
  await kv.set("runs/bad", { hello: 1 } as Json)
  await kv.set("other/run_test1", makeRun() as unknown as Json)
  storage.saveRun(makeRun())
  const runs = await storage.loadRunsAsync()
  assert.deepEqual(runs.map((r) => r.id), ["run_test1"])
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
// Script artifacts (fs)
// ---------------------------------------------------------------------------

test("writeScriptArtifact writes <projectRoot>/.opencode/workflows/runs/<runID>.js", async () => {
  const { storage, fs } = makeStorage()
  const path = await storage.writeScriptArtifact("run_abc123", "return 1")
  assert.equal(path, `${PROJECT_WF}/runs/run_abc123.js`)
  assert.equal(await fs.readFile(`${PROJECT_WF}/runs/run_abc123.js`), "return 1")
})

test("writeScriptArtifact rejects unsafe run ids", async () => {
  const { storage, fs } = makeStorage()
  for (const bad of ["../evil", "a/b", "..", "run..x", ".hidden", "", "x".repeat(200)]) {
    assert.equal(await storage.writeScriptArtifact(bad, "s"), undefined, `runID ${JSON.stringify(bad)}`)
  }
  assert.equal((await fs.readdir(`${PROJECT_WF}/runs`)).length, 0)
})

test("writeScriptArtifact swallows fs errors and returns undefined", async () => {
  const base = new FakeFs()
  const failing: FsLike = {
    mkdir: (p) => base.mkdir(p),
    readFile: (p) => base.readFile(p),
    exists: (p) => base.exists(p),
    readdir: (p) => base.readdir(p),
    writeFile: async () => {
      throw new Error("disk full")
    },
  }
  const { storage } = makeStorage({ fs: failing })
  assert.equal(await storage.writeScriptArtifact("run_ok", "s"), undefined)
})

// ---------------------------------------------------------------------------
// Result artifacts (KV-backed cache)
// ---------------------------------------------------------------------------

test("saveResultArtifact round-trips via loadResultArtifact", async () => {
  const { storage, kv } = makeStorage()
  const key = storage.saveResultArtifact("run_big", { huge: ["x".repeat(10)] })
  assert.equal(key, "results/run_big")
  assert.deepEqual(storage.loadResultArtifact(key), { huge: ["x".repeat(10)] })
  assert.deepEqual(await kv.get("results/run_big"), { huge: ["x".repeat(10)] })
  assert.equal(storage.loadResultArtifact("runs/run_big"), undefined) // wrong prefix
  assert.equal(storage.loadResultArtifact("results/missing"), undefined)
})

// ---------------------------------------------------------------------------
// Saved workflows
// ---------------------------------------------------------------------------

test("saveWorkflow writes the js + json pair with a sha256 manifest", async () => {
  const { storage, fs } = makeStorage()
  const saved = await storage.saveWorkflow("alpha", "return 1", {
    name: "alpha",
    description: "demo",
    phases: ["a", "b"],
    requires: ["general"],
    savedFromRunID: "run_test1",
    source: "project",
  })
  assert.equal(saved.script, "return 1")
  assert.equal(saved.manifest.version, 1)
  assert.equal(saved.manifest.source, "project")
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
  const saved = await storage.saveWorkflow("beta", "return 2", { name: "beta", source: "personal" })
  assert.equal(saved.manifest.source, "personal")
  assert.equal(await fs.exists(`${PERSONAL}/beta.js`), true)
  assert.equal(await fs.exists(`${PROJECT_WF}/beta.js`), false)
})

test("saveWorkflow updates the cache so loadWorkflow works immediately", async () => {
  const { storage } = makeStorage()
  await storage.saveWorkflow("alpha", "return 1", { name: "alpha", source: "project" })
  const loaded = storage.loadWorkflow("alpha")
  assert.equal(loaded?.script, "return 1")
  assert.deepEqual(storage.listWorkflows().map((w) => w.manifest.name), ["alpha"])
})

test("saveWorkflow rejects invalid names without writing files", async () => {
  const { storage, fs } = makeStorage()
  for (const bad of ["UPPER", "-lead", "_lead", "a/b", "../evil", "", "x".repeat(65), "has space", "café"]) {
    await assert.rejects(() => storage.saveWorkflow(bad, "s", { name: bad, source: "project" }), /invalid workflow name/)
  }
  assert.equal(await fs.exists(PROJECT_WF), false) // nothing created
})

test("loadWorkflow throws on invalid names and returns undefined for unknown names", () => {
  const { storage } = makeStorage()
  assert.throws(() => storage.loadWorkflow("../evil"), /invalid workflow name/)
  assert.throws(() => storage.loadWorkflow("UPPER"), /invalid workflow name/)
  assert.equal(storage.loadWorkflow("unknown"), undefined)
})

test("refreshWorkflows: project dir overrides personal dir on name collision", async () => {
  const { storage, fs } = makeStorage()
  await writePair(fs, PERSONAL, "alpha", "personal alpha")
  await writePair(fs, PERSONAL, "only-personal", "personal only")
  await writePair(fs, PROJECT_WF, "alpha", "project alpha")
  await writePair(fs, PROJECT_WF, "only-project", "project only")
  await storage.refreshWorkflows()

  const names = storage.listWorkflows().map((w) => `${w.manifest.name}:${w.manifest.source}`).sort()
  assert.deepEqual(names, ["alpha:project", "only-personal:personal", "only-project:project"])
  assert.equal(storage.loadWorkflow("alpha")?.script, "project alpha")
  assert.equal(storage.loadWorkflow("only-personal")?.manifest.source, "personal")
})

test("refreshWorkflows: empty hash (samples) is tolerated", async () => {
  const { storage, fs } = makeStorage()
  await writePair(fs, PROJECT_WF, "sample", "return 'sample'")
  await storage.refreshWorkflows()
  const loaded = storage.loadWorkflow("sample")
  assert.equal(loaded?.script, "return 'sample'")
  assert.equal(loaded?.manifest.hash, "")
})

test("hash mismatch throws with a re-save/confirm hint; tolerant load proceeds", async () => {
  const { storage, fs } = makeStorage()
  const saved = await storage.saveWorkflow("gamma", "return 1", { name: "gamma", source: "project" })
  await fs.writeFile(`${PROJECT_WF}/gamma.js`, "return 2 // tampered")
  await storage.refreshWorkflows()

  assert.throws(() => storage.loadWorkflow("gamma"), /failed integrity check[\s\S]*confirm: true/)
  const tolerant = storage.loadWorkflowTolerant("gamma")
  assert.equal(tolerant?.script, "return 2 // tampered")
  assert.equal(tolerant?.manifest.hash, saved.manifest.hash)
})

test("refreshWorkflows skips incomplete pairs and non-workflow files", async () => {
  const { storage, fs } = makeStorage()
  await fs.writeFile(`${PROJECT_WF}/no-manifest.js`, "x")
  await fs.writeFile(`${PROJECT_WF}/no-script.json`, manifestJson())
  await fs.writeFile(`${PROJECT_WF}/notes.txt`, "not a workflow")
  await fs.writeFile(`${PROJECT_WF}/BadName.js`, "x")
  await writePair(fs, PROJECT_WF, "good", "return 1")
  await storage.refreshWorkflows()
  assert.deepEqual(storage.listWorkflows().map((w) => w.manifest.name), ["good"])
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

test("skillMarkdownPath stays inside the project workflows dir", () => {
  const { storage } = makeStorage()
  assert.equal(storage.skillMarkdownPath(), `${PROJECT_WF}/ultracode-skill.md`)
})
