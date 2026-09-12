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
 *    `<name>.js` + `<name>.json` (sha256 manifest via node:crypto), and saved
 *    GRAPH workflows as `<name>.graph.json` + `<name>.json` — the spec is the
 *    stored artifact and the script is compiled fresh on every load.
 *
 * Trust model (review fix): a saved workflow loads only when the KV trust
 * record for its name matches the sha256 of the CURRENT script. For a graph
 * workflow "current script" means the freshly compiled output, so approving a
 * graph approves what will actually execute and a compiler change fails closed
 * (re-trust required). `/ultracode trust <name>` approves. There is no hash
 * bypass — sample workflows are trusted the same honest way, once. A spec that
 * fails to parse, validate or compile is never trustable and never runnable:
 * it surfaces as `graphError` with the validator's own messages.
 *
 * The `Storage` interface exposes `loadRuns()/listWorkflows()/loadWorkflow()`
 * synchronously (they read in-memory caches); the async warm-up methods
 * `loadRunsAsync()/refreshWorkflows()` populate those caches and are awaited
 * at plugin setup and on every saved-workflow invocation.
 *
 * Artifact policy: one name is EITHER `<name>.js` OR `<name>.graph.json`, never
 * both — saving one kind while the other exists is REFUSED, because a silent
 * shadow would make the save a no-op while the listing kept showing the old
 * workflow. If both somehow exist on disk, the script wins (explicit
 * precedence, never readdir order).
 *
 * Path safety: workflow names must match /^[a-z0-9][a-z0-9-_]{0,63}$/, run ids
 * are restricted to a safe segment charset, constructed paths are normalized
 * (FakeFs semantics: ".." pops, "." and "" dropped) and asserted to stay inside
 * their base directory, and workflow-file writes realpath-resolve the existing
 * ancestor chain against the project root (symlink escape => fail closed).
 */
import { createHash } from "node:crypto"
import { compileGraphSpec, validateGraphSpec } from "./graph.ts"
import type { GraphSpec } from "./graph.ts"
import { mergeParams, paramsFromGraph, paramsFromScript } from "./params.ts"
import type {
  FsLike,
  Json,
  KvLike,
  RunRecord,
  SaveWorkflowManifestInput,
  SavedWorkflow,
  SavedWorkflowManifest,
  SettingsOverlayLike,
  Storage,
} from "./types.ts"
import { parseSettingsOverlay } from "./settings.ts"

export interface StorageInit {
  kv: KvLike
  fs: FsLike
  projectRoot: string
  personalWorkflowDir: string
  /** Stable project id (ctx.location.project.id) — scopes every KV key. */
  projectID: string
}

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/
/** Saved graph-spec artifact suffix (the manifest stays `<name>.json`). */
export const GRAPH_ARTIFACT_SUFFIX = ".graph.json"
/** Validator errors surfaced in a `graphError` before truncation. */
const MAX_GRAPH_ERRORS = 5
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
  private readonly projectID: string
  private readonly projectWorkflowDir: string
  private readonly personalWorkflowDir: string
  private readonly runsArtifactDir: string
  private readonly runsPrefix: string
  private readonly resultsPrefix: string
  private readonly trustPrefix: string
  private readonly settingsKey: string
  private settingsCache: SettingsOverlayLike | undefined
  private runsCache: RunRecord[] = []
  private persistFailures = 0
  private scanFailures = 0
  private lastPersistError: string | undefined
  private lastScanError: string | undefined
  private workflowCache = new Map<string, CachedWorkflow>()
  private resultCache = new Map<string, Json>()
  private artifactFailures = 0
  private lastArtifactError: string | undefined
  /** name -> approved sha256 digest of the script (KV-backed, cache-loaded). */
  private trustDigests = new Map<string, string>()

  constructor(init: StorageInit) {
    this.kv = init.kv
    this.fs = init.fs
    this.projectRoot = normalizePath(init.projectRoot)
    this.projectID = init.projectID
    this.projectWorkflowDir = joinInside(this.projectRoot, ".opencode/workflows", "project workflow dir")
    this.personalWorkflowDir = normalizePath(init.personalWorkflowDir)
    this.runsArtifactDir = joinInside(this.projectWorkflowDir, "runs", "runs artifact dir")
    const pid = pidSegment(init.projectID)
    this.runsPrefix = `runs/${pid}`
    this.resultsPrefix = `results/${pid}`
    this.trustPrefix = `trust/${pid}`
    this.settingsKey = `settings/${pid}`
  }

  // ------------------------------------------------------------------
  // Run snapshots (KV, project-scoped)
  // ------------------------------------------------------------------

  /** Persist a run snapshot. Fire-and-forget; throw-safe. Failures are counted for /ultracode doctor. */
  saveRun(record: RunRecord): void {
    this.upsertRunsCache(record)
    try {
      void this.kv.set(`${this.runsPrefix}/${record.id}`, toJson(record)).catch((err) => {
        this.notePersistError(err)
      })
    } catch (err) {
      this.notePersistError(err)
    }
  }

  kvDiagnostics(): {
    projectRoot: string
    projectID: string
    persistedRunCount: number
    kvErrorCount: number
    lastKvError?: string
    /** Result-artifact KV write failures (previously swallowed silently). */
    artifactErrorCount: number
    lastArtifactError?: string
    runsPrefix: string
  } {
    const lastKvError = this.lastPersistError ?? this.lastScanError
    return {
      projectRoot: this.projectRoot,
      projectID: this.projectID,
      persistedRunCount: this.runsCache.length,
      kvErrorCount: this.persistFailures + this.scanFailures,
      lastKvError,
      artifactErrorCount: this.artifactFailures,
      lastArtifactError: this.lastArtifactError,
      runsPrefix: this.runsPrefix,
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

  loadSettingsOverlay(): SettingsOverlayLike | undefined {
    return this.settingsCache
  }

  async loadSettingsOverlayAsync(): Promise<SettingsOverlayLike | undefined> {
    try {
      const raw = await this.kv.get(this.settingsKey)
      const overlay = parseSettingsOverlay(raw)
      this.settingsCache = overlay
      return overlay
    } catch {
      return this.settingsCache
    }
  }

  saveSettingsOverlay(overlay: SettingsOverlayLike): void {
    this.settingsCache = { ...overlay }
    try {
      void this.kv.set(this.settingsKey, toJson(overlay)).catch(() => {})
    } catch {
      // throw-safe by contract
    }
  }

  // ------------------------------------------------------------------
  // Result artifacts (KV-backed cache, project-scoped)
  // ------------------------------------------------------------------

  /** Max full-result artifacts kept in the in-memory cache (LRU eviction). */
  static readonly RESULT_CACHE_LIMIT = 32

  /**
   * Persist the full result for a truncated run. The KV write is
   * fire-and-forget but failures are COUNTED (visible via kvDiagnostics /
   * `/ultracode doctor`), unlike the old silent swallow. Returns the storage
   * key, or `undefined` when the value cannot be serialized — in that case no
   * key is claimed and callers must not mark the run as having an artifact.
   */
  saveResultArtifact(runID: string, result: Json): string | undefined {
    let json: Json
    try {
      json = toJson(result)
    } catch (err) {
      this.noteArtifactError(err)
      return undefined
    }
    const key = `${this.resultsPrefix}/${runID}`
    // Map.set on an existing key does NOT move it — fine today (one save per
    // runID); if saves can ever repeat, re-delete first to refresh recency.
    this.resultCache.set(key, json)
    if (this.resultCache.size > StorageImpl.RESULT_CACHE_LIMIT) {
      const oldest = this.resultCache.keys().next().value
      if (oldest !== undefined) this.resultCache.delete(oldest)
    }
    try {
      void this.kv.set(key, json).then(
        undefined,
        (err: unknown) => this.noteArtifactError(err),
      )
    } catch (err) {
      this.noteArtifactError(err)
    }
    return key
  }

  /**
   * Sync by interface contract — reads the in-memory artifact cache (same
   * process). Artifacts are additionally mirrored to the KV for durability.
   * Cache hits re-insert (LRU refresh) so eviction order follows recency.
   */
  loadResultArtifact(key: string): Json | undefined {
    if (typeof key !== "string" || !key.startsWith(this.resultsPrefix + "/")) return undefined
    const hit = this.resultCache.get(key)
    if (hit !== undefined) {
      this.resultCache.delete(key)
      this.resultCache.set(key, hit)
    }
    return hit
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
      // Candidate names from BOTH artifact kinds. readWorkflowPair applies the
      // explicit `.js`-wins precedence, so readdir order never decides anything.
      const candidates = new Set<string>()
      for (const file of names) {
        if (file.endsWith(".js")) candidates.add(file.slice(0, -".js".length))
        else if (file.endsWith(GRAPH_ARTIFACT_SUFFIX)) {
          candidates.add(file.slice(0, -GRAPH_ARTIFACT_SUFFIX.length))
        }
      }
      for (const name of [...candidates].sort()) {
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
   * the filename key, when the artifact cannot produce a runnable script (an
   * invalid graph spec), or when the current script is not trusted (KV trust
   * record missing or differing) — approve with `trustWorkflow()`.
   */
  loadWorkflow(name: string): SavedWorkflow | undefined {
    requireValidWorkflowName(name)
    const cached = this.workflowCache.get(name)
    if (!cached) return undefined
    this.assertLoadable(name, cached)
    this.assertTrusted(name, this.digestFor(cached), this.trustDigests.get(name))
    return cached.workflow
  }

  /** Trust state for listings — same digest comparison as loadWorkflow. */
  workflowTrustState(name: string): "trusted" | "untrusted" | "unknown" {
    const cached = this.workflowCache.get(name)
    if (!cached) return "unknown"
    // An unloadable entry (name drift, invalid graph spec) can never be trusted.
    if (cached.nameMismatch || this.contentBlocker(cached) !== undefined) return "untrusted"
    return this.trustDigests.get(name) === this.digestFor(cached) ? "trusted" : "untrusted"
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
    this.assertLoadable(name, entry)
    let trusted: string | undefined
    try {
      trusted = (await this.kv.get(`${this.trustPrefix}/${name}`)) as string | undefined
    } catch {
      trusted = undefined // fail closed
    }
    if (typeof trusted !== "string") trusted = undefined
    const digest = this.digestFor(entry)
    this.assertTrusted(name, digest, trusted)
    this.trustDigests.set(name, digest)
    this.workflowCache.set(name, entry)
    return entry.workflow
  }

  /**
   * Approve the CURRENT on-disk version of a workflow: fresh-reads the pair by
   * precedence (project wins), computes the digest and writes the trust record.
   * Refuses an unloadable artifact (invalid graph spec, name drift) — approving
   * one would record a digest for a workflow that can never run.
   * Returns the approved workflow AND the computed digest (manifest.hash may
   * be empty/stale for hand-written pairs), or undefined when not found.
   */
  async trustWorkflow(name: string): Promise<{ workflow: SavedWorkflow; digest: string } | undefined> {
    requireValidWorkflowName(name)
    const entry =
      (await this.readWorkflowPair(this.projectWorkflowDir, name, "project")) ??
      (await this.readWorkflowPair(this.personalWorkflowDir, name, "personal"))
    if (!entry) return undefined
    this.assertLoadable(name, entry)
    const digest = this.digestFor(entry)
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

  async saveWorkflow(name: string, script: string, manifest: SaveWorkflowManifestInput): Promise<SavedWorkflow> {
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
      kind: "script",
    }
    if (typeof manifest.savedFromRunID === "string" && manifest.savedFromRunID.length > 0) {
      full.savedFromRunID = manifest.savedFromRunID
    }
    // Params: caller-supplied wins field-by-field; the rest is derived from the
    // artifact, so `ultracode_catalog` can serve it without reading any code.
    const scriptParams = mergeParams(manifest.params, paramsFromScript(script))
    if (scriptParams !== undefined) full.params = scriptParams
    await this.assertNoShadowingArtifact(name, source, dir, "script")
    const scriptPath = joinInside(dir, `${name}.js`, "workflow script")
    const manifestPath = joinInside(dir, `${name}.json`, "workflow manifest")
    // Shared lstat-aware containment (symlink escapes and dangling links fail
    // closed). Trusted anchor: project root for project saves, the personal
    // config dir's parent for personal saves. Write resolved.path (not the
    // lexical target) so a symlink swapped after the check is not followed.
    const anchor = this.anchorFor(source)
    const resolvedScript = await resolveContainedPath(this.fs, anchor, scriptPath)
    if (!resolvedScript.ok) {
      throw new StorageError(`refusing to write workflow "${name}": ${resolvedScript.error}`)
    }
    const resolvedManifest = await resolveContainedPath(this.fs, anchor, manifestPath)
    if (!resolvedManifest.ok) {
      throw new StorageError(`refusing to write workflow "${name}": ${resolvedManifest.error}`)
    }
    await this.mkdir(dir)
    await this.fs.writeFile(resolvedScript.path, script)
    await this.fs.writeFile(resolvedManifest.path, JSON.stringify(full, null, 2) + "\n")
    const workflow: SavedWorkflow = { manifest: full, script }
    this.workflowCache.set(name, { workflow, nameMismatch: false })
    return workflow
  }

  /**
   * Save a GRAPH spec as `<name>.graph.json` + `<name>.json`. The spec is
   * validated and compiled BEFORE any write (an invalid spec is never
   * persisted), the compiled script is the trust digest basis, and phases /
   * requires / description default to what the compiler synthesized.
   *
   * `opts.rewriteSpec: false` writes ONLY the manifest — the Plan→Build handoff
   * (`saveWorkflowFromFile`) must not reformat or reorder a file the user
   * authored by hand.
   */
  async saveGraphWorkflow(
    name: string,
    spec: Json,
    manifest: SaveWorkflowManifestInput,
    opts?: { rewriteSpec?: boolean },
  ): Promise<SavedWorkflow> {
    requireValidWorkflowName(name)
    const source = manifest.source === "personal" ? "personal" : "project"
    const dir = source === "personal" ? this.personalWorkflowDir : this.projectWorkflowDir
    const body = buildGraphBody(JSON.stringify(spec ?? null))
    if (!body.ok) {
      throw new StorageError(`refusing to save graph workflow "${name}": ${body.error}`)
    }
    const full: SavedWorkflowManifest = {
      version: MANIFEST_VERSION,
      name,
      description: manifest.description ?? body.description,
      phases: manifest.phases ?? body.phases,
      requires: manifest.requires ?? body.requires,
      hash: sha256(body.script),
      source,
      savedAt: Date.now(),
      kind: "graph",
    }
    if (typeof manifest.savedFromRunID === "string" && manifest.savedFromRunID.length > 0) {
      full.savedFromRunID = manifest.savedFromRunID
    }
    const graphParams = mergeParams(manifest.params, paramsFromGraph(body.spec))
    if (graphParams !== undefined) full.params = graphParams
    await this.assertNoShadowingArtifact(name, source, dir, "graph")
    const specPath = joinInside(dir, `${name}${GRAPH_ARTIFACT_SUFFIX}`, "workflow graph spec")
    const manifestPath = joinInside(dir, `${name}.json`, "workflow manifest")
    const anchor = this.anchorFor(source)
    const resolvedSpec = await resolveContainedPath(this.fs, anchor, specPath)
    if (!resolvedSpec.ok) {
      throw new StorageError(`refusing to write workflow "${name}": ${resolvedSpec.error}`)
    }
    const resolvedManifest = await resolveContainedPath(this.fs, anchor, manifestPath)
    if (!resolvedManifest.ok) {
      throw new StorageError(`refusing to write workflow "${name}": ${resolvedManifest.error}`)
    }
    await this.mkdir(dir)
    if (opts?.rewriteSpec !== false) {
      await this.fs.writeFile(resolvedSpec.path, JSON.stringify(body.spec, null, 2) + "\n")
    }
    await this.fs.writeFile(resolvedManifest.path, JSON.stringify(full, null, 2) + "\n")
    const workflow: SavedWorkflow = { manifest: full, script: body.script, graphSpec: body.spec }
    this.workflowCache.set(name, { workflow, nameMismatch: false })
    return workflow
  }

  /**
   * Contained source read of `<project>/.opencode/workflows/<name>.js` (or
   * `<name>.graph.json` when there is no script) before any write, then the
   * manifest pair. Manifest omits `savedFromRunID`. Does not auto-trust; a
   * changed hash leaves `workflowTrustState` untrusted.
   *
   * A hand-written `<name>.json` next to the artifact is PRESERVED (description,
   * phases, requires, params) instead of being clobbered by a bare manifest —
   * that is how an authored workflow declares its `args`. A graph spec file is
   * never rewritten: only its manifest is (re)generated.
   */
  async saveWorkflowFromFile(name: string): Promise<SavedWorkflow> {
    requireValidWorkflowName(name)
    const scriptPath = joinInside(this.projectWorkflowDir, `${name}.js`, "workflow script")
    const resolved = await resolveContainedPath(this.fs, this.projectRoot, scriptPath)
    if (!resolved.ok) {
      throw new StorageError(`refusing to read workflow "${name}": ${resolved.error}`)
    }
    const preserved = await this.readManifestForSave(name)
    if (await this.fs.exists(resolved.path)) {
      let script: string
      try {
        script = await this.fs.readFile(resolved.path)
      } catch (err) {
        throw new StorageError(`workflow "${name}" not found (${name}.js): ${errText(err)}`)
      }
      return this.saveWorkflow(name, script, { name, source: "project", ...preserved })
    }
    const graphPath = joinInside(this.projectWorkflowDir, `${name}${GRAPH_ARTIFACT_SUFFIX}`, "workflow graph spec")
    const resolvedGraph = await resolveContainedPath(this.fs, this.projectRoot, graphPath)
    if (!resolvedGraph.ok) {
      throw new StorageError(`refusing to read workflow "${name}": ${resolvedGraph.error}`)
    }
    if (await this.fs.exists(resolvedGraph.path)) {
      let raw: string
      try {
        raw = await this.fs.readFile(resolvedGraph.path)
      } catch (err) {
        throw new StorageError(`workflow "${name}" not found (${name}${GRAPH_ARTIFACT_SUFFIX}): ${errText(err)}`)
      }
      const body = buildGraphBody(raw)
      if (!body.ok) {
        throw new StorageError(`refusing to save workflow "${name}": ${body.error}`)
      }
      return this.saveGraphWorkflow(name, body.spec, { name, source: "project", ...preserved }, { rewriteSpec: false })
    }
    throw new StorageError(
      `workflow "${name}" not found (${name}.js or ${name}${GRAPH_ARTIFACT_SUFFIX}) in ${this.projectWorkflowDir}`,
    )
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
      } catch (err) {
        this.noteScanError(err)
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

  private notePersistError(err: unknown): void {
    this.persistFailures++
    this.lastPersistError = err instanceof Error ? err.message : String(err)
  }

  private noteScanError(err: unknown): void {
    this.scanFailures++
    this.lastScanError = err instanceof Error ? err.message : String(err)
  }

  private noteArtifactError(err: unknown): void {
    this.artifactFailures++
    this.lastArtifactError = err instanceof Error ? err.message : String(err)
  }

  private async mkdir(dir: string): Promise<void> {
    try {
      await this.fs.mkdir(dir, true)
    } catch {
      // FakeFs/real fs tolerate existing dirs; failures surface on writeFile.
    }
  }

  /**
   * Read one saved-workflow pair. Artifact precedence is explicit: `<name>.js`
   * wins over `<name>.graph.json` (never readdir order). A graph pair is
   * compiled FRESH here — the spec is the stored artifact, the script is never
   * persisted. fs errors skip the entry; a spec that fails to parse, validate
   * or compile is KEPT with `graphError` so the caller can report the real
   * reason instead of a bare "not found".
   */
  private async readWorkflowPair(
    dir: string,
    name: string,
    source: "project" | "personal",
  ): Promise<CachedWorkflow | undefined> {
    const scriptPath = joinInside(dir, `${name}.js`, "workflow script")
    const graphPath = joinInside(dir, `${name}${GRAPH_ARTIFACT_SUFFIX}`, "workflow graph spec")
    const manifestPath = joinInside(dir, `${name}.json`, "workflow manifest")
    let hasScript: boolean
    let hasGraph: boolean
    let manifest: SavedWorkflowManifest | undefined
    let script = ""
    let rawSpec: string | undefined
    try {
      hasScript = await this.fs.exists(scriptPath)
      hasGraph = !hasScript && (await this.fs.exists(graphPath))
      if (!hasScript && !hasGraph) return undefined
      if (!(await this.fs.exists(manifestPath))) return undefined
      manifest = parseManifest(JSON.parse(await this.fs.readFile(manifestPath)) as unknown, source)
      if (!manifest) return undefined
      if (hasScript) script = await this.fs.readFile(scriptPath)
      else rawSpec = await this.fs.readFile(graphPath)
    } catch {
      return undefined // unreadable pair — skip
    }
    if (hasScript) {
      return { workflow: { manifest: { ...manifest, kind: "script" }, script }, nameMismatch: manifest.name !== name }
    }
    const body = buildGraphBody(rawSpec ?? "")
    if (!body.ok) {
      const broken: SavedWorkflow = { manifest: { ...manifest, kind: "graph" }, script: "", graphError: body.error }
      return { workflow: broken, nameMismatch: manifest.name !== name }
    }
    const graphManifest: SavedWorkflowManifest = {
      ...manifest,
      kind: "graph",
      // Compiler-synthesized metadata fills in what a hand-written manifest lacks.
      description: manifest.description ?? body.description,
      phases: manifest.phases ?? body.phases,
      requires: manifest.requires ?? body.requires,
    }
    return {
      workflow: { manifest: graphManifest, script: body.script, graphSpec: body.spec },
      nameMismatch: manifest.name !== name,
    }
  }

  /** Trust anchor for containment resolution of a saved-workflow write. */
  private anchorFor(source: "project" | "personal"): string {
    return source === "project" ? this.projectRoot : dirnameNormalized(this.personalWorkflowDir)
  }

  /**
   * Refuse to save one artifact kind while the other exists for the same name.
   * The loader's `.js`-wins precedence would silently shadow the new file, so
   * the save would look successful while runs kept using the old workflow.
   * An unresolvable path is not an error here — the write below fails closed.
   */
  private async assertNoShadowingArtifact(
    name: string,
    source: "project" | "personal",
    dir: string,
    writing: "script" | "graph",
  ): Promise<void> {
    const other = writing === "script" ? `${name}${GRAPH_ARTIFACT_SUFFIX}` : `${name}.js`
    const resolved = await resolveContainedPath(this.fs, this.anchorFor(source), joinInside(dir, other, "workflow artifact"))
    if (!resolved.ok) return
    if (!(await this.fs.exists(resolved.path))) return
    throw new StorageError(
      `refusing to save workflow "${name}" as a ${writing} workflow: ${resolved.path} already exists and would shadow it. ` +
        `A name is either a script (${name}.js) or a graph (${name}${GRAPH_ARTIFACT_SUFFIX}) — remove the other artifact first.`,
    )
  }

  /**
   * The single trust-digest basis: the script that will actually execute. Graph
   * workflows compile fresh on load, so editing the spec OR upgrading the
   * compiler moves the digest and requires re-approval (fail closed).
   */
  private digestFor(cached: CachedWorkflow): string {
    return sha256(cached.workflow.script)
  }

  /** Why this entry must never run or be trusted (undefined = loadable). */
  private contentBlocker(cached: CachedWorkflow): string | undefined {
    if (cached.workflow.graphError !== undefined) return cached.workflow.graphError
    if (cached.workflow.script.trim() === "") return "the saved script is empty"
    return undefined
  }

  /**
   * Ordered load gate: manifest/name drift, then unloadable content, then trust.
   * The order matters — an invalid graph spec must never reach the digest
   * comparison, or `/ultracode trust` could approve sha256("") and make a
   * broken workflow look trusted.
   */
  private assertLoadable(name: string, cached: CachedWorkflow): void {
    if (cached.nameMismatch) throwMismatch(name, cached.workflow.manifest.name)
    const blocker = this.contentBlocker(cached)
    if (blocker !== undefined) {
      throw new StorageError(`workflow "${name}" cannot run: ${blocker}`)
    }
  }

  /**
   * Metadata from a hand-written `<project>/.opencode/workflows/<name>.json`,
   * carried across a from-file save. Unreadable or invalid => nothing preserved.
   */
  private async readManifestForSave(name: string): Promise<Partial<SaveWorkflowManifestInput>> {
    try {
      const manifestPath = joinInside(this.projectWorkflowDir, `${name}.json`, "workflow manifest")
      const resolved = await resolveContainedPath(this.fs, this.projectRoot, manifestPath)
      if (!resolved.ok || !(await this.fs.exists(resolved.path))) return {}
      const parsed = parseManifest(JSON.parse(await this.fs.readFile(resolved.path)) as unknown, "project")
      if (!parsed) return {}
      const out: Partial<SaveWorkflowManifestInput> = {}
      if (parsed.description !== undefined) out.description = parsed.description
      if (parsed.phases !== undefined) out.phases = parsed.phases
      if (parsed.requires !== undefined) out.requires = parsed.requires
      if (parsed.params !== undefined) out.params = parsed.params
      return out
    } catch {
      return {}
    }
  }

  /** Trust gate: throw unless `trusted` matches the current executable digest. */
  private assertTrusted(name: string, digest: string, trusted: string | undefined): void {
    if (trusted === digest) return
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
  const kind = v["kind"] === "graph" || v["kind"] === "script" ? v["kind"] : undefined
  const params = asJson(v["params"])
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
    ...(kind !== undefined ? { kind } : {}),
    ...(params !== undefined ? { params } : {}),
  }
  return manifest
}

/** JSON-safe copy of a parsed manifest value (undefined stays absent). */
function asJson(value: unknown): Json | undefined {
  if (value === undefined) return undefined
  try {
    return toJson(value)
  } catch {
    return undefined // not JSON-safe (circular, BigInt) — drop the field
  }
}

export type GraphBody =
  | { ok: true; spec: Json; script: string; phases: string[]; requires: string[]; description?: string }
  | { ok: false; error: string }

/**
 * Parse + validate + compile a graph spec text. Never throws: a spec that fails
 * any stage comes back as a precise, user-quotable error (the validator's own
 * messages) so an unloadable graph is never reported as merely "not found".
 */
export function buildGraphBody(raw: string): GraphBody {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `the graph spec is not valid JSON: ${errText(err)}` }
  }
  const check = validateGraphSpec(parsed)
  if (!check.ok) {
    const shown = check.errors.slice(0, MAX_GRAPH_ERRORS).join("; ")
    const more = check.errors.length > MAX_GRAPH_ERRORS ? ` (+${check.errors.length - MAX_GRAPH_ERRORS} more)` : ""
    return { ok: false, error: `the graph spec failed validation: ${shown}${more}` }
  }
  let script: string
  let phases: string[]
  let requires: string[]
  let description: string | undefined
  try {
    const compiled = compileGraphSpec(parsed as GraphSpec)
    script = compiled.script
    phases = compiled.meta.phases
    requires = compiled.meta.requires
    description = compiled.meta.description
  } catch (err) {
    return { ok: false, error: `the graph spec failed to compile: ${errText(err)}` }
  }
  if (script.trim() === "") return { ok: false, error: "the graph spec compiled to an empty script" }
  return {
    ok: true,
    spec: toJson(parsed),
    script,
    phases,
    requires,
    ...(description !== undefined ? { description } : {}),
  }
}
