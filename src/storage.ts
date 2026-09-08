/**
 * Storage (Builder A) — implements `Storage` from types.ts.
 *
 * Backends:
 *  - plugin KV (KvLike, from ctx.storage): run snapshots `runs/<pid>/<id>`,
 *    result artifacts `results/<pid>/<id>`, script-trust records
 *    `trust/<pid>/<name>` — all scoped by the stable project id so multiple
 *    locations/projects never cross-contaminate.
 *  - filesystem (FsLike): script artifacts
 *    `<projectRoot>/.opencode/workflows/runs/<runID>.js`, saved workflows as
 *    `<name>.js` + `<name>.json` (sha256 manifest via node:crypto).
 *
 * Trust model (review fix): a saved workflow loads only when the KV trust
 * record for its name matches the sha256 of the CURRENT script. `/ultracode
 * trust <name>` approves. There is no hash bypass — sample workflows are
 * trusted the same honest way, once.
 *
 * The `Storage` interface exposes `loadRuns()/listWorkflows()/loadWorkflow()`
 * synchronously (they read in-memory caches); the async warm-up methods
 * `loadRunsAsync()/refreshWorkflows()` populate those caches and are awaited
 * at plugin setup and on every saved-workflow invocation.
 *
 * Path safety: workflow names must match /^[a-z0-9][a-z0-9-_]{0,63}$/, run ids
 * are restricted to a safe segment charset, constructed paths are normalized
 * (FakeFs semantics: ".." pops, "." and "" dropped) and asserted to stay inside
 * their base directory, and workflow-file writes realpath-resolve the existing
 * ancestor chain against the project root (symlink escape => fail closed).
 */
import { createHash } from "node:crypto"
import type { FsLike, Json, KvLike, RunRecord, SavedWorkflow, SavedWorkflowManifest, Storage } from "./types.ts"

export interface StorageInit {
  kv: KvLike
  fs: FsLike
  projectRoot: string
  personalWorkflowDir: string
  /** Stable project id (ctx.location.project.id) — scopes every KV key. */
  projectID: string
}

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/
const RUN_ID_RE = /^[\w][\w.-]{0,127}$/
const MANIFEST_VERSION = 1
/** Safety cap for KV scan cursor loops. */
const MAX_SCAN_PAGES = 1000

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

function dirnameNormalized(path: string): string {
  const n = normalizePath(path)
  const idx = n.lastIndexOf("/")
  return idx <= 0 ? "/" : n.slice(0, idx)
}

function joinInside(base: string, segment: string, what: string): string {
  const resolved = normalizePath(`${base}/${segment}`)
  const normalizedBase = normalizePath(base)
  if (resolved !== normalizedBase && !resolved.startsWith(normalizedBase + "/")) {
    throw new StorageError(`${what} escapes ${normalizedBase}: ${segment}`)
  }
  return resolved
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

// ---------------------------------------------------------------------------
// Shared lstat-aware containment resolver (review fix C-High)
// ---------------------------------------------------------------------------

export type ResolveResult = { ok: true; path: string } | { ok: false; error: string }

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Walk `target`'s components from the trusted `anchor`, lstat'ing each
 * existing one:
 *  - symlink component => resolve via realpath; reject when it dangles or
 *    resolves outside the anchor;
 *  - first missing component => the remaining tail is a NEW path, allowed
 *    only because every ancestor up to here resolved inside the anchor;
 *  - any fs error => reject (fail closed — never fall back to lexical paths).
 *
 * Used by saveWorkflow, run script-artifact writes and the permission
 * containment check (index.ts).
 */
export async function resolveContainedPath(fs: FsLike, anchor: string, target: string): Promise<ResolveResult> {
  const anchorLex = normalizePath(anchor)
  const targetLex = normalizePath(target)
  if (targetLex !== anchorLex && !targetLex.startsWith(anchorLex + "/")) {
    return { ok: false, error: `target ${targetLex} is not inside ${anchorLex}` }
  }
  let anchorReal: string
  try {
    anchorReal = normalizePath(await fs.realpath(anchorLex))
  } catch (err) {
    return { ok: false, error: `cannot resolve anchor ${anchorLex}: ${errText(err)}` }
  }
  const parts = targetLex.slice(anchorLex.length).split("/").filter((p) => p !== "")
  let current = anchorReal
  for (let i = 0; i < parts.length; i++) {
    const next = `${current}/${parts[i]}`
    let stat: { isSymbolicLink(): boolean } | undefined
    try {
      stat = await fs.lstat(next)
    } catch (err) {
      return { ok: false, error: `lstat failed for ${next}: ${errText(err)}` }
    }
    if (stat === undefined) {
      // Missing from here on: a NEW path whose resolved ancestor chain (up to
      // `current`) is verified-inside by construction.
      return { ok: true, path: normalizePath(`${current}/${parts.slice(i).join("/")}`) }
    }
    if (stat.isSymbolicLink()) {
      let real: string
      try {
        real = normalizePath(await fs.realpath(next))
      } catch (err) {
        return { ok: false, error: `dangling or unresolvable symlink ${next}: ${errText(err)}` }
      }
      if (real !== anchorReal && !real.startsWith(anchorReal + "/")) {
        return { ok: false, error: `symlink ${next} resolves outside ${anchorLex}: ${real}` }
      }
      current = real
      continue
    }
    current = next
  }
  return { ok: true, path: current }
}

export class StorageError extends Error {}

function requireValidWorkflowName(name: string): void {
  if (typeof name !== "string" || !WORKFLOW_NAME_RE.test(name)) {
    throw new StorageError(
      `invalid workflow name ${JSON.stringify(name)}: must match /^[a-z0-9][a-z0-9-_]{0,63}$/ (lowercase alphanumerics, "-" and "_", max 64 chars)`,
    )
  }
}

/** KV key segment for a project id: hashed (injective), short, stable. */
function pidSegment(projectID: string): string {
  // Old (sanitized-string) keys are intentionally orphaned — runs are history.
  return `p${sha256(projectID).slice(0, 16)}`
}

/** Deep JSON round-trip (drops undefined props, guarantees JSON-safe value). */
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

interface CachedWorkflow {
  workflow: SavedWorkflow
  /** manifest.name !== filename key — loadWorkflow throws (name/key drift). */
  nameMismatch: boolean
}

export class StorageImpl implements Storage {
  private readonly kv: KvLike
  private readonly fs: FsLike
  private readonly projectRoot: string
  private readonly projectWorkflowDir: string
  private readonly personalWorkflowDir: string
  private readonly runsArtifactDir: string
  private readonly runsPrefix: string
  private readonly resultsPrefix: string
  private readonly trustPrefix: string
  private runsCache: RunRecord[] = []
  private workflowCache = new Map<string, CachedWorkflow>()
  private resultCache = new Map<string, Json>()
  /** name -> approved sha256 digest of the script (KV-backed, cache-loaded). */
  private trustDigests = new Map<string, string>()

  constructor(init: StorageInit) {
    this.kv = init.kv
    this.fs = init.fs
    this.projectRoot = normalizePath(init.projectRoot)
    this.projectWorkflowDir = joinInside(this.projectRoot, ".opencode/workflows", "project workflow dir")
    this.personalWorkflowDir = normalizePath(init.personalWorkflowDir)
    this.runsArtifactDir = joinInside(this.projectWorkflowDir, "runs", "runs artifact dir")
    const pid = pidSegment(init.projectID)
    this.runsPrefix = `runs/${pid}`
    this.resultsPrefix = `results/${pid}`
    this.trustPrefix = `trust/${pid}`
  }

  // ------------------------------------------------------------------
  // Run snapshots (KV, project-scoped)
  // ------------------------------------------------------------------

  /** Persist a run snapshot. Fire-and-forget; throw-safe. */
  saveRun(record: RunRecord): void {
    this.upsertRunsCache(record)
    try {
      void this.kv.set(`${this.runsPrefix}/${record.id}`, toJson(record)).catch(() => {})
    } catch {
      // throw-safe by contract
    }
  }

  /** Scan the KV (following `next` cursors) and refresh the run cache. */
  async loadRunsAsync(): Promise<RunRecord[]> {
    const entries = await this.scanAll(this.runsPrefix + "/")
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
  // Result artifacts (KV-backed cache, project-scoped)
  // ------------------------------------------------------------------

  saveResultArtifact(runID: string, result: Json): string {
    const key = `${this.resultsPrefix}/${runID}`
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
    if (typeof key !== "string" || !key.startsWith(this.resultsPrefix + "/")) return undefined
    return this.resultCache.get(key)
  }

  /** Cache-first, KV-fallback read (used by `/ultracode result`). */
  async loadResultArtifactFresh(key: string): Promise<Json | undefined> {
    const cached = this.loadResultArtifact(key)
    if (cached !== undefined) return cached
    if (typeof key !== "string" || !key.startsWith(this.resultsPrefix + "/")) return undefined
    try {
      return await this.kv.get(key)
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------------
  // Script artifacts (fs)
  // ------------------------------------------------------------------

  /** Write `<projectRoot>/.opencode/workflows/runs/<runID>.js`; returns the absolute path. */
  async writeScriptArtifact(runID: string, script: string): Promise<string | undefined> {
    if (typeof runID !== "string" || !RUN_ID_RE.test(runID) || runID.includes("..")) return undefined
    const path = joinInside(this.runsArtifactDir, `${runID}.js`, "script artifact")
    try {
      // Symlink-aware containment (a symlinked runs/ dir fails closed).
      const resolved = await resolveContainedPath(this.fs, this.projectRoot, path)
      if (!resolved.ok) return undefined
      await this.mkdir(this.runsArtifactDir)
      await this.fs.writeFile(path, script)
      return path
    } catch {
      return undefined // fs errors swallowed by contract
    }
  }

  // ------------------------------------------------------------------
  // Saved workflows (fs pairs + KV trust, cached for sync interface methods)
  // ------------------------------------------------------------------

  /** Rescan personal + project workflow dirs and the trust store into the caches. */
  async refreshWorkflows(): Promise<void> {
    const found = new Map<string, CachedWorkflow>()
    // Personal first so project entries override same-name workflows.
    for (const source of ["personal", "project"] as const) {
      const dir = source === "personal" ? this.personalWorkflowDir : this.projectWorkflowDir
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
    await this.refreshTrust()
  }

  listWorkflows(): SavedWorkflow[] {
    return [...this.workflowCache.values()]
      .map((c) => c.workflow)
      .sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : 1))
  }

  /**
   * Load a saved workflow by name. Throws when the manifest name doesn't match
   * the filename key, or when the current script is not trusted (KV trust
   * record missing or differing) — approve with `trustWorkflow()`.
   */
  loadWorkflow(name: string): SavedWorkflow | undefined {
    requireValidWorkflowName(name)
    const cached = this.workflowCache.get(name)
    if (!cached) return undefined
    if (cached.nameMismatch) throwMismatch(name, cached.workflow.manifest.name)
    this.assertTrusted(name, cached.workflow.script, this.trustDigests.get(name))
    return cached.workflow
  }

  /** Trust state for listings — same digest comparison as loadWorkflow. */
  workflowTrustState(name: string): "trusted" | "untrusted" | "unknown" {
    const cached = this.workflowCache.get(name)
    if (!cached) return "unknown"
    return this.trustDigests.get(name) === sha256(cached.workflow.script) ? "trusted" : "untrusted"
  }

  /**
   * Snapshot-per-call load for the workflow() composition path: reads the pair
   * from disk directly (project wins) and checks the trust record straight
   * from the KV — never the possibly-stale caches. Updates both caches on
   * success so subsequent sync loads agree. Throws on name/trust violations
   * exactly like loadWorkflow; undefined when not found.
   */
  async loadWorkflowFresh(name: string): Promise<SavedWorkflow | undefined> {
    requireValidWorkflowName(name)
    const entry =
      (await this.readWorkflowPair(this.projectWorkflowDir, name, "project")) ??
      (await this.readWorkflowPair(this.personalWorkflowDir, name, "personal"))
    if (!entry) return undefined
    if (entry.nameMismatch) throwMismatch(name, entry.workflow.manifest.name)
    let trusted: string | undefined
    try {
      trusted = (await this.kv.get(`${this.trustPrefix}/${name}`)) as string | undefined
    } catch {
      trusted = undefined // fail closed
    }
    if (typeof trusted !== "string") trusted = undefined
    this.assertTrusted(name, entry.workflow.script, trusted)
    this.trustDigests.set(name, sha256(entry.workflow.script))
    this.workflowCache.set(name, entry)
    return entry.workflow
  }

  /**
   * Approve the CURRENT on-disk version of a workflow: fresh-reads the pair by
   * precedence (project wins), computes the digest and writes the trust record.
   * Returns the approved workflow AND the computed digest (manifest.hash may
   * be empty/stale for hand-written pairs), or undefined when not found.
   */
  async trustWorkflow(name: string): Promise<{ workflow: SavedWorkflow; digest: string } | undefined> {
    requireValidWorkflowName(name)
    const entry =
      (await this.readWorkflowPair(this.projectWorkflowDir, name, "project")) ??
      (await this.readWorkflowPair(this.personalWorkflowDir, name, "personal"))
    if (!entry) return undefined
    if (entry.nameMismatch) throwMismatch(name, entry.workflow.manifest.name)
    const digest = sha256(entry.workflow.script)
    await this.kv.set(`${this.trustPrefix}/${name}`, digest)
    this.trustDigests.set(name, digest)
    this.workflowCache.set(name, entry)
    return { workflow: entry.workflow, digest }
  }

  /**
   * Delete the KV trust record for `name`. Unknown (not currently trusted)
   * names throw, listing the workflows that are trusted.
   */
  async revokeTrust(name: string): Promise<void> {
    requireValidWorkflowName(name)
    const digest = this.trustDigests.get(name)
    if (digest === undefined) {
      const names = [...this.trustDigests.keys()].sort()
      throw new StorageError(
        `workflow "${name}" is not trusted.` +
          (names.length > 0 ? ` Trusted workflows: ${names.join(", ")}.` : " No workflows are trusted."),
      )
    }
    this.trustDigests.delete(name)
    try {
      if (this.kv.remove) await this.kv.remove(`${this.trustPrefix}/${name}`)
    } catch (err) {
      this.trustDigests.set(name, digest)
      throw err
    }
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
    const dir = source === "personal" ? this.personalWorkflowDir : this.projectWorkflowDir
    // manifest.name is ALWAYS the lookup key (review fix: save-name correctness).
    const full: SavedWorkflowManifest = {
      version: MANIFEST_VERSION,
      name,
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
    // Shared lstat-aware containment (symlink escapes and dangling links fail
    // closed). Trusted anchor: project root for project saves, the personal
    // config dir's parent for personal saves.
    const anchor = source === "project" ? this.projectRoot : dirnameNormalized(this.personalWorkflowDir)
    for (const target of [scriptPath, manifestPath]) {
      const resolved = await resolveContainedPath(this.fs, anchor, target)
      if (!resolved.ok) {
        throw new StorageError(`refusing to write workflow "${name}": ${resolved.error}`)
      }
    }
    await this.mkdir(dir)
    await this.fs.writeFile(scriptPath, script)
    await this.fs.writeFile(manifestPath, JSON.stringify(full, null, 2) + "\n")
    const workflow: SavedWorkflow = { manifest: full, script }
    this.workflowCache.set(name, { workflow, nameMismatch: false })
    return workflow
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Scan a KV prefix, following `next` cursors until exhausted. */
  private async scanAll(prefix: string): Promise<ReadonlyArray<{ key: string; value: Json }>> {
    const out: Array<{ key: string; value: Json }> = []
    if (!this.kv.scan) return out
    let after: string | undefined
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      let result: { entries: ReadonlyArray<{ key: string; value: Json }>; next?: string }
      try {
        result = await this.kv.scan({ prefix, after, limit: 1000 })
      } catch {
        break
      }
      for (const entry of result?.entries ?? []) out.push(entry)
      if (!result?.next) break
      after = result.next
    }
    return out
  }

  private async refreshTrust(): Promise<void> {
    const entries = await this.scanAll(this.trustPrefix + "/")
    const digests = new Map<string, string>()
    for (const entry of entries) {
      const name = entry.key.slice(this.trustPrefix.length + 1)
      if (!name || !WORKFLOW_NAME_RE.test(name)) continue
      if (typeof entry.value === "string") digests.set(name, entry.value)
    }
    this.trustDigests = digests
  }

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
      return { workflow: { manifest, script }, nameMismatch: manifest.name !== name }
    } catch {
      return undefined // unreadable pair — skip
    }
  }

  /** Trust gate: throw unless `trusted` matches the current script digest. */
  private assertTrusted(name: string, script: string, trusted: string | undefined): void {
    if (trusted === sha256(script)) return
    throw new StorageError(
      `workflow "${name}" is not trusted (new or changed since approval). ` +
        `Run /ultracode trust ${name} to approve the current version.`,
    )
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

function throwMismatch(name: string, manifestName: string): never {
  throw new StorageError(
    `workflow "${name}": manifest name ${JSON.stringify(manifestName)} does not match ` +
      `filename "${name}" — re-save the workflow`,
  )
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
