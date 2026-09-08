/**
 * Builder A tests — src/storage.ts: project-scoped KV snapshots, script/result
 * artifacts, saved-workflow pairs + trust gate, precedence, name validation,
 * path/symlink safety, KV cursor pagination.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { StorageImpl, WORKFLOW_NAME_RE, normalizePath } from "../src/storage.ts"
import type { FsLike, Json, KvLike, RunRecord } from "../src/types.ts"
import { FakeFs, FakeKv } from "./fakes.ts"

const PROJECT = "/project"
const PERSONAL = "/home/u/.config/opencode/workflows"
const PROJECT_WF = "/project/.opencode/workflows"
const PID = "proj-123"
// Keys are project-scoped: runs/<pid>/<id>, results/<pid>/<id>, trust/<pid>/<name>.
const RUNS_KEY = (id: string) => `runs/${PID}/${id}`
const RESULTS_KEY = (id: string) => `results/${PID}/${id}`
const TRUST_KEY = (name: string) => `trust/${PID}/${name}`

function makeStorage(overrides: { kv?: KvLike; fs?: FsLike; projectID?: string } = {}) {
  const kv = overrides.kv ?? new FakeKv()
  const fs = overrides.fs ?? new FakeFs()
  const storage = new StorageImpl({
    kv,
    fs,
    projectRoot: PROJECT,
    personalWorkflowDir: PERSONAL,
    projectID: overrides.projectID ?? PID,
  })
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
  // nothing omitted
  assert.deepEqual(Object.keys(stored as object).sort(), Object.keys(JSON.parse(JSON.stringify(run))).sort())

  const loaded = storage.loadRuns()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.id, "run_test1")

  const scanned = await storage.loadRunsAsync()
  assert.equal(scanned.length, 1)
  assert.deepEqual(scanned[0], JSON.parse(JSON.stringify(run)))
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

test("project ids are sanitized into safe key segments", async () => {
  const kv = new FakeKv()
  const { storage } = makeStorage({ kv, projectID: "weird id/with slash+plus" })
  storage.saveRun(makeRun())
  const keys = [...kv.store.keys()]
  assert.deepEqual(keys, ["runs/weird-id-with-slash-plus/run_test1"])
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
    realpath: (p) => base.realpath(p),
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

// ---------------------------------------------------------------------------
// Saved workflows: pairs, precedence, trust gate
// ---------------------------------------------------------------------------

test("saveWorkflow writes the js + json pair; manifest.name is the filename key", async () => {
  const { storage, fs } = makeStorage()
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
  const saved = await storage.saveWorkflow("beta", "return 2", { name: "beta", source: "personal" })
  assert.equal(saved.manifest.source, "personal")
  assert.equal(await fs.exists(`${PERSONAL}/beta.js`), true)
  assert.equal(await fs.exists(`${PROJECT_WF}/beta.js`), false)
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

test("trust gate: untrusted until trusted; trust -> load; edit -> blocked; re-trust -> load", async () => {
  const { storage, fs } = makeStorage()
  await storage.saveWorkflow("gamma", "return 1", { name: "gamma", source: "project" })
  await storage.refreshWorkflows()

  // First run: not trusted yet.
  assert.throws(() => storage.loadWorkflow("gamma"), /is not trusted \(new or changed since approval\)/)
  assert.throws(() => storage.loadWorkflow("gamma"), /\/ultracode trust gamma|\/workflow trust gamma/)

  // Approve the current version.
  const trusted = await storage.trustWorkflow("gamma")
  assert.equal(trusted?.script, "return 1")
  assert.deepEqual(storage.loadWorkflow("gamma")?.script, "return 1")

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
  const { storage: a } = makeStorage({ kv, projectID: "project-a" })
  const { storage: b } = makeStorage({ kv, projectID: "project-b" })
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
  assert.equal(await storage.trustWorkflow("missing"), undefined)
  await writePair(fs, PROJECT_WF, "drifted", "return 1", { name: "other-name" })
  await storage.refreshWorkflows()
  await assert.rejects(() => storage.trustWorkflow("drifted"), /does not match/)
})

test("hand-written sample pairs (empty hash) are untrusted until trusted — no bypass", async () => {
  const { storage, fs } = makeStorage()
  await writePair(fs, PROJECT_WF, "sample", "return 'sample'")
  await storage.refreshWorkflows()
  assert.throws(() => storage.loadWorkflow("sample"), /is not trusted/)
  await storage.trustWorkflow("sample")
  assert.equal(storage.loadWorkflow("sample")?.script, "return 'sample'")
})

test("loadWorkflow throws when manifest.name doesn't match the filename key", async () => {
  const { storage, fs } = makeStorage()
  await writePair(fs, PROJECT_WF, "drifted", "return 1", { name: "other-name" })
  await storage.refreshWorkflows()
  assert.throws(() => storage.loadWorkflow("drifted"), /does not match filename "drifted"/)
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
  // Listing shows what's on disk; loading anything still requires trust.
  await storage.trustWorkflow("alpha")
  assert.equal(storage.loadWorkflow("alpha")?.script, "project alpha")
  await storage.trustWorkflow("only-personal")
  assert.equal(storage.loadWorkflow("only-personal")?.manifest.source, "personal")
})

test("refreshWorkflows skips incomplete pairs and non-workflow files", async () => {
  const { storage, fs } = makeStorage()
  await fs.writeFile(`${PROJECT_WF}/no-manifest.js`, "x")
  await fs.writeFile(`${PROJECT_WF}/no-script.json`, "{}")
  await fs.writeFile(`${PROJECT_WF}/notes.txt`, "not a workflow")
  await fs.writeFile(`${PROJECT_WF}/BadName.js`, "x")
  await writePair(fs, PROJECT_WF, "good", "return 1")
  await storage.refreshWorkflows()
  assert.deepEqual(storage.listWorkflows().map((w) => w.manifest.name), ["good"])
})

// ---------------------------------------------------------------------------
// Symlink containment (fail closed)
// ---------------------------------------------------------------------------

/** FakeFs with "symlinks": each link path exists and realpath-resolves elsewhere. */
class SymlinkFs extends FakeFs {
  private readonly links: Map<string, string>
  constructor(links: Map<string, string>) {
    super()
    this.links = links
  }
  override async exists(path: string): Promise<boolean> {
    if (this.links.has(this.normalize(path))) return true
    return super.exists(path)
  }
  async realpath(path: string): Promise<string> {
    return this.links.get(this.normalize(path)) ?? this.normalize(path)
  }
}

test("saveWorkflow rejects when the workflows dir symlink-escapes the project root", async () => {
  // /project/.opencode "exists" and realpath-resolves to /elsewhere (symlink).
  const fs = new SymlinkFs(new Map([["/project/.opencode", "/elsewhere"]]))
  const { storage } = makeStorage({ fs })
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "project" }),
    /refusing to write outside/,
  )
})

test("saveWorkflow accepts when the project root itself is a symlink (resolved consistently)", async () => {
  // Whole project viewed through a symlink: /proj -> /data/proj. Both the
  // anchor and the target resolve through it, so writes proceed.
  const fs = new SymlinkFs(new Map([["/proj", "/data/proj"]]))
  const storage = new StorageImpl({
    kv: new FakeKv(),
    fs,
    projectRoot: "/proj",
    personalWorkflowDir: PERSONAL,
    projectID: PID,
  })
  const saved = await storage.saveWorkflow("ok", "return 1", { name: "ok", source: "project" })
  assert.equal(saved.manifest.name, "ok")
})

test("saveWorkflow(personal) rejects when the personal workflows dir is a symlink", async () => {
  const fs = new SymlinkFs(new Map([[PERSONAL, "/etc"]]))
  const { storage } = makeStorage({ fs })
  await assert.rejects(
    () => storage.saveWorkflow("evil", "return 1", { name: "evil", source: "personal" }),
    /refusing to write outside/,
  )
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
