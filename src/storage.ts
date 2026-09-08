/**
 * Storage (Builder A) — implements `Storage` from types.ts.
 *
 * Two backends:
 *  - plugin KV (KvLike, from ctx.storage): run snapshots `runs/<id>`, result
 *    artifacts `results/<runID>`.
 *  - filesystem (FsLike): script artifacts `<projectRoot>/.opencode/workflows/runs/<runID>.js`,
 *    saved workflows as `<name>.js` + `<name>.json` (sha256 manifest via node:crypto).
 *
 * The `Storage` interface exposes `loadRuns()/listWorkflows()/loadWorkflow()`
 * synchronously (they read in-memory caches); the async warm-up methods
 * `loadRunsAsync()/refreshWorkflows()` populate those caches and are awaited
 * once at plugin setup (and after every saveWorkflow, which updates the cache).
 *
 * Path safety: workflow names must match /^[a-z0-9][a-z0-9-_]{0,63}$/, run ids
 * are restricted to a safe segment charset, and every constructed path is
 * normalized (FakeFs semantics: ".." pops, "." and "" dropped) and asserted to
 * stay inside its base directory.
 */
import { createHash } from "node:crypto"
import type { FsLike, Json, KvLike, RunRecord, SavedWorkflow, SavedWorkflowManifest, Storage } from "./types.ts"

export interface StorageInit {
  kv: KvLike
  fs: FsLike
  projectRoot: string
  personalWorkflowDir: string
}

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/
const RUN_ID_RE = /^[\w][\w.-]{0,127}$/
const MANIFEST_VERSION = 1

/** Normalize a path with FakeFs.normalize semantics (".." pops, "." dropped). */
export function normalizePath(path: string): string {
  const isAbs = path.startsWith("/")
  const parts: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return (isAbs ? "/" : "") + parts.join("/")
}

function joinInside(base: string, segment: string, what: string): string {
  const resolved = normalizePath(`${base}/${segment}`)
  const normalizedBase = normalizePath(base)
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + "/")) {
    throw new Error(`${what} escapes ${normalizedBase}: ${segment}`)
  }
  return resolved
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export class StorageError extends Error {}

function requireValidWorkflowName(name: string): void {
  if (typeof name !== "string" || !WORKFLOW_NAME_RE.test(name)) {
    throw new StorageError(
      `invalid workflow name ${JSON.stringify(name)}: must match /^[a-z0-9][a-z0-9-_]{0,63}$/ (lowercase alphanumerics, "-" and "_", max 64 chars)`,
    )
  }
}

/** Deep JSON round-trip (drops undefined props, guarantees JSON-safe value). */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

interface CachedWorkflow {
  workflow: SavedWorkflow
  /** manifest.hash === "" (samples) or hash matched at scan time. */
  hashOk: boolean
}

interface WorkflowDirs {
  /** "personal" | "project" -> absolute dir */
  bySource: { personal: string; project: string }
}

export class StorageImpl implements Storage {
  private readonly kv: KvLike
  private readonly fs: FsLike
  private readonly projectRoot: string
  private readonly projectWorkflowDir: string
  private readonly personalWorkflowDir: string
  private readonly runsArtifactDir: string
  private runsCache: RunRecord[] = []
  private workflowCache = new Map<string, CachedWorkflow>()
  private resultCache = new Map<string, Json>()
  private readonly dirs: WorkflowDirs

  constructor(init: StorageInit) {
    this.kv = init.kv
    this.fs = init.fs
    this.projectRoot = normalizePath(init.projectRoot)
    this.projectWorkflowDir = joinInside(this.projectRoot, ".opencode/workflows", "project workflow dir")
    this.personalWorkflowDir = normalizePath(init.personalWorkflowDir)
    this.runsArtifactDir = joinInside(this.projectWorkflowDir, "runs", "runs artifact dir")
    this.dirs = { bySource: { personal: this.personalWorkflowDir, project: this.projectWorkflowDir } }
  }

  // ------------------------------------------------------------------
  // Run snapshots (KV)
  // ------------------------------------------------------------------

  /** Persist a run snapshot. Fire-and-forget; throw-safe. */
  saveRun(record: RunRecord): void {
    this.upsertRunsCache(record)
    try {
      const key = `runs/${record.id}`
      void this.kv.set(key, toJson(record)).catch(() => {})
    } catch {
      // throw-safe by contract
    }
  }

  /** Scan the KV for run snapshots and refresh the cache. */
  async loadRunsAsync(): Promise<RunRecord[]> {
    let entries: ReadonlyArray<{ key: string; value: Json }> = []
    try {
      if (this.kv.scan) {
        const result = await this.kv.scan({ prefix: "runs/" })
        entries = result?.entries ?? []
      }
    } catch {
      entries = []
    }
    const byID = new Map<string, RunRecord>()
    // Newest persisted state wins; seed with anything already cached (fresh saves).
    for (const record of this.runsCache) byID.set(record.id, record)
    for (const entry of entries) {
      const record = parseRunRecord(entry.value)
      if (record) byID.set(record.id, record)
    }
    this.runsCache = [...byID.values()].sort((a, b) => a.startedAt - b.startedAt)
    return [...this.runsCache]
  }

  /** Snapshot of runs known to this process (after loadRunsAsync / saveRun). */
  loadRuns(): RunRecord[] {
    return [...this.runsCache]
  }

  // ------------------------------------------------------------------
  // Result artifacts (KV)
  // ------------------------------------------------------------------

  saveResultArtifact(runID: string, result: Json): string {
    const key = `results/${runID}`
    this.resultCache.set(key, result)
    try {
      void this.kv.set(key, toJson(result)).catch(() => {})
    } catch {
      // Best effort — the envelope preview still describes the run.
    }
    return key
  }

  /**
   * Sync by interface contract — reads the in-memory artifact cache (same
   * process). Artifacts are additionally mirrored to the KV for durability.
   */
  loadResultArtifact(key: string): Json | undefined {
    if (typeof key !== "string" || !key.startsWith("results/")) return undefined
    return this.resultCache.get(key)
  }

  // ------------------------------------------------------------------
  // Script artifacts (fs)
  // ------------------------------------------------------------------

  /** Write `<projectRoot>/.opencode/workflows/runs/<runID>.js`; returns the absolute path. */
  async writeScriptArtifact(runID: string, script: string): Promise<string | undefined> {
    if (typeof runID !== "string" || !RUN_ID_RE.test(runID) || runID.includes("..")) return undefined
    const path = joinInside(this.runsArtifactDir, `${runID}.js`, "script artifact")
    try {
      await this.mkdir(this.runsArtifactDir)
      await this.fs.writeFile(path, script)
      return path
    } catch {
      return undefined // fs errors swallowed by contract
    }
  }

  /** Path of the skill markdown file index.ts registers (also written there). */
  skillMarkdownPath(): string {
    return joinInside(this.projectWorkflowDir, "ultracode-skill.md", "skill file")
  }

  // ------------------------------------------------------------------
  // Saved workflows (fs, cached for the sync interface methods)
  // ------------------------------------------------------------------

  /** Rescan personal + project workflow dirs into the cache (project wins). */
  async refreshWorkflows(): Promise<void> {
    const found = new Map<string, CachedWorkflow>()
    // Personal first so project entries override same-name workflows.
    for (const source of ["personal", "project"] as const) {
      const dir = this.dirs.bySource[source]
      let names: string[] = []
      try {
        names = await this.fs.readdir(dir)
      } catch {
        continue // dir missing — fine
      }
      for (const file of names) {
        if (!file.endsWith(".js")) continue
        const name = file.slice(0, -3)
        if (!WORKFLOW_NAME_RE.test(name)) continue
        const cached = await this.readWorkflowPair(dir, name, source)
        if (cached) found.set(name, cached)
      }
    }
    this.workflowCache = found
  }

  listWorkflows(): SavedWorkflow[] {
    return [...this.workflowCache.values()]
      .map((c) => c.workflow)
      .sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))
  }

  loadWorkflow(name: string): SavedWorkflow | undefined {
    requireValidWorkflowName(name)
    const cached = this.workflowCache.get(name)
    if (!cached) return undefined
    if (!cached.hashOk) {
      const actual = sha256(cached.workflow.script)
      throw new StorageError(
        `workflow "${name}" failed integrity check: script changed since it was saved ` +
          `(manifest hash ${cached.workflow.manifest.hash}, actual ${actual}). ` +
          `Re-save the workflow, or pass { workflow: ${JSON.stringify(name)}, confirm: true } to run it anyway`,
      )
    }
    return cached.workflow
  }

  /** Like loadWorkflow but ignores hash mismatches (executor's confirm: true path). */
  loadWorkflowTolerant(name: string): SavedWorkflow | undefined {
    requireValidWorkflowName(name)
    return this.workflowCache.get(name)?.workflow
  }

  async saveWorkflow(
    name: string,
    script: string,
    manifest: Omit<SavedWorkflowManifest, "version" | "hash" | "savedAt" | "source"> & {
      source: "project" | "personal"
    },
  ): Promise<SavedWorkflow> {
    requireValidWorkflowName(name)
    const source = manifest.source === "personal" ? "personal" : "project"
    const dir = this.dirs.bySource[source]
    const full: SavedWorkflowManifest = {
      version: MANIFEST_VERSION,
      name: manifest.name ?? name,
      description: manifest.description,
      phases: manifest.phases,
      requires: manifest.requires,
      hash: sha256(script),
      source,
      savedAt: Date.now(),
      savedFromRunID: manifest.savedFromRunID,
    }
    const scriptPath = joinInside(dir, `${name}.js`, "workflow script")
    const manifestPath = joinInside(dir, `${name}.json`, "workflow manifest")
    await this.mkdir(dir)
    await this.fs.writeFile(scriptPath, script)
    await this.fs.writeFile(manifestPath, JSON.stringify(full, null, 2) + "\n")
    const workflow: SavedWorkflow = { manifest: full, script }
    this.workflowCache.set(name, { workflow, hashOk: true })
    return workflow
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private async mkdir(dir: string): Promise<void> {
    try {
      await this.fs.mkdir(dir, true)
    } catch {
      // FakeFs/real fs tolerate existing dirs; failures surface on writeFile.
    }
  }

  private async readWorkflowPair(
    dir: string,
    name: string,
    source: "project" | "personal",
  ): Promise<CachedWorkflow | undefined> {
    const scriptPath = joinInside(dir, `${name}.js`, "workflow script")
    const manifestPath = joinInside(dir, `${name}.json`, "workflow manifest")
    try {
      if (!(await this.fs.exists(scriptPath))) return undefined
      if (!(await this.fs.exists(manifestPath))) return undefined
      const script = await this.fs.readFile(scriptPath)
      const rawManifest = JSON.parse(await this.fs.readFile(manifestPath)) as unknown
      const manifest = parseManifest(rawManifest, source)
      if (!manifest) return undefined
      const hashOk = manifest.hash === "" || sha256(script) === manifest.hash
      return { workflow: { manifest, script }, hashOk }
    } catch {
      return undefined // unreadable pair — skip
    }
  }

  private upsertRunsCache(record: RunRecord): void {
    const idx = this.runsCache.findIndex((r) => r.id === record.id)
    const copy: RunRecord = { ...record, agents: record.agents.map((a) => ({ ...a })) }
    if (idx === -1) this.runsCache.push(copy)
    else this.runsCache[idx] = copy
    this.runsCache.sort((a, b) => a.startedAt - b.startedAt)
  }
}

function parseRunRecord(value: unknown): RunRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (typeof v["id"] !== "string" || typeof v["status"] !== "string" || typeof v["startedAt"] !== "number") {
    return undefined
  }
  return {
    ...(v as unknown as RunRecord),
    agents: Array.isArray(v["agents"]) ? (v["agents"] as RunRecord["agents"]) : [],
  }
}

function parseManifest(raw: unknown, source: "project" | "personal"): SavedWorkflowManifest | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const v = raw as Record<string, unknown>
  if (v["version"] !== MANIFEST_VERSION) return undefined
  if (typeof v["name"] !== "string") return undefined
  const manifest: SavedWorkflowManifest = {
    version: MANIFEST_VERSION,
    name: v["name"],
    description: typeof v["description"] === "string" ? v["description"] : undefined,
    phases: Array.isArray(v["phases"]) && v["phases"].every((p) => typeof p === "string") ? (v["phases"] as string[]) : undefined,
    requires:
      Array.isArray(v["requires"]) && v["requires"].every((r) => typeof r === "string")
        ? (v["requires"] as string[])
        : undefined,
    hash: typeof v["hash"] === "string" ? v["hash"] : "",
    source,
    savedAt: typeof v["savedAt"] === "number" ? v["savedAt"] : 0,
    savedFromRunID: typeof v["savedFromRunID"] === "string" ? v["savedFromRunID"] : undefined,
  }
  return manifest
}
