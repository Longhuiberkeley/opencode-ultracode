/**
 * Catalog builder (workstream C): read-only discovery for the model.
 *
 * Why a tool and not the skill appendix: the live catalog injected into the skill
 * is built ONCE per plugin instance, from inside the `ultracode_run` executor —
 * so before the first run of a server session the attached skill carries an empty
 * catalog and the model cannot see which saved workflows exist, whether they are
 * trusted, or what `args` they take. Its only recourse was reading
 * `.opencode/workflows/*` itself: a context cost, and for a graph workflow the
 * file it would read is generated plumbing.
 *
 * This module is pure (no plugin imports, no I/O): the caller supplies agents,
 * workflows with their trust state, and ALREADY ownership-filtered runs; the
 * builder returns a bounded JSON view. Every list is capped, free text is sliced,
 * and the two payloads that are inherently unbounded — a script body and a graph
 * spec — are cut to a head/size cap with the overflow reported rather than
 * dumped, because the output lands in a context window. Same discipline the
 * envelope and status payloads follow.
 */
import { graphNodeCount, graphNodeIds } from "./graph.ts"
import { GRAPH_TEMPLATES, graphTemplate, graphTemplateSummaries } from "./graph-templates.ts"
import { paramsLine, parseParams } from "./params.ts"
import { safeSlice, compactStringify } from "./serialize.ts"
import type { Json, RunRecord, SavedWorkflow, WorkflowKind } from "./types.ts"
import { countAgents } from "./types.ts"

/** Hard caps — a catalog is a menu, not a dump. */
export const MAX_CATALOG_WORKFLOWS = 40
export const MAX_CATALOG_DESCRIPTION_CHARS = 200
export const MAX_CATALOG_AGENTS = 60
/** Head of a script workflow shown in the detail view (the `// Tool input:` header lives here). */
export const MAX_DETAIL_SCRIPT_HEAD = 1200
/**
 * Cap on the serialized graph spec inlined by the detail view. A spec is bounded
 * in NODE count (MAX_GRAPH_NODES) but not in bytes — a prompt can carry pasted
 * source — so past this the detail view returns the structure and points at the
 * file instead of dumping text into a context window.
 */
export const MAX_DETAIL_GRAPH_CHARS = 24_000
/** Runs the tool executor scans before ownership filtering (see index.ts). */
export const CATALOG_RUN_SCAN = 200
/** Runs kept for last-run stats after filtering to the calling conversation. */
export const CATALOG_RUN_LIMIT = 50

export interface CatalogAgent {
  id: string
  description?: string
}

export interface CatalogWorkflow {
  workflow: SavedWorkflow
  trusted: boolean
}

export interface CatalogCaps {
  concurrency: number
  maxAgents: number
  timeoutMs: number
}

export interface CatalogInput {
  agents?: readonly CatalogAgent[]
  /** Error text when the host could not list agents (surfaced, never swallowed). */
  agentsUnavailable?: string
  workflows?: readonly CatalogWorkflow[]
  /**
   * Runs to draw last-run stats from. MUST be pre-filtered to the requesting
   * conversation: run history is per-session provenance, not project-wide data.
   */
  runs?: readonly RunRecord[]
  caps?: CatalogCaps
  /** Full template specs instead of summaries. */
  templates?: boolean
  /** One template by name (full spec). */
  template?: string
  /** One workflow by name (detail view). */
  workflow?: string
}

function kindOf(workflow: SavedWorkflow): WorkflowKind {
  return workflow.manifest.kind === "graph" ? "graph" : "script"
}

function lastRunFor(runs: readonly RunRecord[], name: string): RunRecord | undefined {
  let best: RunRecord | undefined
  for (const run of runs) {
    if (run.workflowName !== name) continue
    if (best === undefined || run.startedAt > best.startedAt) best = run
  }
  return best
}

function lastRunView(run: RunRecord | undefined): Json | undefined {
  if (!run) return undefined
  const counts = countAgents(run)
  const out: Record<string, Json> = {
    runID: run.id,
    status: run.status,
    at: run.startedAt,
    agents: { total: counts.total, succeeded: counts.succeeded, failed: counts.failed },
  }
  if (run.endedAt !== undefined) out["durationMs"] = run.endedAt - run.startedAt
  if (run.totalTokens) out["tokens"] = { input: run.totalTokens.input, output: run.totalTokens.output }
  if (run.error) out["error"] = safeSlice(run.error, MAX_CATALOG_DESCRIPTION_CHARS)
  return out as Json
}

function runCount(runs: readonly RunRecord[], name: string): number {
  let n = 0
  for (const run of runs) if (run.workflowName === name) n++
  return n
}

/** The listing row for one saved workflow (no spec bodies, no script text). */
function workflowRow(entry: CatalogWorkflow, runs: readonly RunRecord[]): Json {
  const { workflow, trusted } = entry
  const manifest = workflow.manifest
  const kind = kindOf(workflow)
  const row: Record<string, Json> = {
    name: manifest.name,
    kind,
    trusted,
    source: manifest.source,
  }
  if (manifest.description !== undefined) row["description"] = safeSlice(manifest.description, MAX_CATALOG_DESCRIPTION_CHARS)
  const params = paramsLine(manifest.params)
  if (params !== "") row["params"] = params
  if (manifest.phases !== undefined && manifest.phases.length > 0) row["phases"] = manifest.phases
  if (manifest.requires !== undefined && manifest.requires.length > 0) row["requires"] = manifest.requires
  if (kind === "graph") row["nodes"] = graphNodeCount(workflow.graphSpec)
  if (workflow.graphError !== undefined) {
    row["broken"] = safeSlice(workflow.graphError, MAX_CATALOG_DESCRIPTION_CHARS)
    row["trusted"] = false
  }
  const runs_n = runCount(runs, manifest.name)
  if (runs_n > 0) {
    row["runs"] = runs_n
    const last = lastRunView(lastRunFor(runs, manifest.name))
    if (last !== undefined) row["lastRun"] = last
  }
  return row as Json
}

/** Full detail for one workflow: params as data, plus the graph spec or script head. */
function workflowDetail(entry: CatalogWorkflow, runs: readonly RunRecord[]): Json {
  const { workflow, trusted } = entry
  const manifest = workflow.manifest
  const kind = kindOf(workflow)
  const detail: Record<string, Json> = {
    name: manifest.name,
    kind,
    trusted: workflow.graphError !== undefined ? false : trusted,
    source: manifest.source,
  }
  if (manifest.description !== undefined) detail["description"] = safeSlice(manifest.description, MAX_CATALOG_DESCRIPTION_CHARS)
  if (manifest.phases !== undefined) detail["phases"] = manifest.phases
  if (manifest.requires !== undefined) detail["requires"] = manifest.requires
  if (manifest.savedFromRunID !== undefined) detail["savedFromRunID"] = manifest.savedFromRunID
  const params = parseParams(manifest.params)
  if (params && params.args.length > 0) detail["params"] = params.args as unknown as Json
  if (workflow.graphError !== undefined) detail["broken"] = safeSlice(workflow.graphError, MAX_CATALOG_DESCRIPTION_CHARS)
  if (kind === "graph") {
    detail["nodeIds"] = graphNodeIds(workflow.graphSpec)
    if (workflow.graphSpec !== undefined) {
      // The spec is the thing worth adapting, so hand it over whole — but it is
      // bounded in NODE count only, and a prompt can carry pasted source. Past
      // the cap, describe the structure and point at the file instead.
      const chars = compactStringify(workflow.graphSpec).length
      if (chars <= MAX_DETAIL_GRAPH_CHARS) detail["graph"] = workflow.graphSpec
      else {
        detail["graphChars"] = chars
        detail["graphOmitted"] =
          `spec is ${chars} chars, over the ${MAX_DETAIL_GRAPH_CHARS} inline cap — ` +
          `read ${manifest.name}.graph.json in the workflows directory (or /ultracode graph ${manifest.name} for the structure)`
      }
    }
  } else {
    detail["scriptChars"] = workflow.script.length
    detail["scriptHead"] = safeSlice(workflow.script, MAX_DETAIL_SCRIPT_HEAD)
  }
  const runs_n = runCount(runs, manifest.name)
  if (runs_n > 0) {
    detail["runs"] = runs_n
    const last = lastRunView(lastRunFor(runs, manifest.name))
    if (last !== undefined) detail["lastRun"] = last
  }
  detail["invoke"] =
    workflow.graphError !== undefined
      ? `unusable until the spec is fixed: ${workflow.graphError}`
      : trusted
        ? `ultracode_run { workflow: "${manifest.name}", args: { … } }`
        : `needs one user approval first: /ultracode trust ${manifest.name}`
  return detail as Json
}

/**
 * Build the bounded catalog view. Never throws: a malformed entry is skipped
 * rather than failing the whole discovery call.
 */
export function buildCatalog(input: CatalogInput): Json {
  const runs = input.runs ?? []
  const workflows = [...(input.workflows ?? [])].sort((a, b) =>
    a.workflow.manifest.name < b.workflow.manifest.name ? -1 : 1,
  )

  // ---- detail view: one workflow, everything about it ----
  if (input.workflow !== undefined) {
    const match = workflows.find((w) => w.workflow.manifest.name === input.workflow)
    const out: Record<string, Json> = {}
    if (match) out["workflow"] = workflowDetail(match, runs)
    else {
      out["error"] = `no saved workflow named ${JSON.stringify(input.workflow)}`
      out["available"] = workflows.slice(0, MAX_CATALOG_WORKFLOWS).map((w) => w.workflow.manifest.name)
    }
    return out as Json
  }

  const out: Record<string, Json> = {}

  // ---- agents ----
  if (input.agentsUnavailable !== undefined) {
    out["agentsUnavailable"] = safeSlice(input.agentsUnavailable, MAX_CATALOG_DESCRIPTION_CHARS)
  } else if (input.agents !== undefined) {
    out["agents"] = input.agents.slice(0, MAX_CATALOG_AGENTS).map((a) => {
      const row: Record<string, Json> = { id: a.id }
      if (a.description !== undefined) row["description"] = safeSlice(a.description, 120)
      return row as Json
    })
    if (input.agents.length > MAX_CATALOG_AGENTS) out["moreAgents"] = input.agents.length - MAX_CATALOG_AGENTS
  }

  // ---- saved workflows ----
  const shown = workflows.slice(0, MAX_CATALOG_WORKFLOWS)
  out["workflows"] = shown.map((w) => {
    try {
      return workflowRow(w, runs)
    } catch {
      return { name: w.workflow.manifest.name, broken: "unreadable entry" } as Json
    }
  })
  if (workflows.length > shown.length) out["moreWorkflows"] = workflows.length - shown.length
  const trustedCount = workflows.filter((w) => w.trusted && w.workflow.graphError === undefined).length
  out["trustedCount"] = trustedCount

  // ---- graph templates ----
  if (input.template !== undefined) {
    const found = graphTemplate(input.template)
    if (found) out["template"] = { name: found.name, description: found.description, args: found.args, graph: found.graph } as unknown as Json
    else {
      out["templateError"] = `no graph template named ${JSON.stringify(input.template)}`
      out["templates"] = graphTemplateSummaries()
    }
  } else if (input.templates === true) {
    out["templates"] = GRAPH_TEMPLATES.map((t) => ({
      name: t.name,
      description: t.description,
      args: t.args,
      graph: t.graph,
    })) as unknown as Json
  } else {
    out["templates"] = graphTemplateSummaries()
  }

  // ---- caps + how to drill in ----
  if (input.caps) out["caps"] = { ...input.caps }
  out["hint"] =
    "drill in with { workflow: \"<name>\" } for one workflow's params, spec or script head; " +
    "{ templates: true } returns complete graph specs to adapt; { template: \"<name>\" } returns one. " +
    "Nothing here executes — a saved workflow still needs a user's /ultracode trust before it can run."
  return out as Json
}
