/**
 * opencode-ultracode plugin entry (Builder A).
 *
 * The ONLY module allowed to import `@opencode/plugin` (CONTRACTS.md); every
 * other module receives capabilities via plain interfaces for testability.
 *
 * Hard rules honored here (docs/SPIKE-FINDINGS.md):
 *  - never await ctx.session.prompt/create/get inside setup (admission deadlock)
 *  - every ctx.*.transform / ctx.session.hook / ctx.permission.hook wrapped in
 *    try/catch — a throwing transform disables the whole plugin
 *  - ctx.agent.list() returns { location, data } — unwrap .data
 *  - tool executor 2nd arg: { sessionID, agent, messageID, id, progress }
 */
import { Plugin, Rpc } from "@opencode/plugin"
import type { Skill } from "@opencode/plugin"
import { promises as fsp } from "node:fs"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  D2_VERBS,
  PLUGIN_VERSION,
  TOOL_DESCRIPTION,
  buildResultChunk,
  enrichStatusPayload,
  executeWorkflowLaunch,
  feedToolEvent,
  formatDoctorReport,
  formatSettleNotice,
  handleUltracodeCommand,
  matchesUltracodeKeyword,
  prepareRunLaunch,
  resolveRunStatus,
  type StatusChildView,
} from "./command.ts"
import { loadOptions } from "./config.ts"
import { CATALOG_RUN_LIMIT, CATALOG_RUN_SCAN, buildCatalog } from "./catalog.ts"
import { controlToolContent } from "./control.ts"
import {
  applyOverlay,
  capturedFromRecord,
  panelSettingsFrom,
  evaluateOwnedPermission,
  NO_EDIT_TOOLS_MESSAGE,
  permissionStallAction,
  type SettingsOverlay,
} from "./settings.ts"
import { ULTRACODE_RPC } from "./rpc-definition.ts"
import { steerRun } from "./steer.ts"
import {
  agentStatusKey,
  collectRunStatus,
  hasRpcRegister,
  isFinalRunStatus,
  runStateTransition,
  settingsPayload,
} from "./run-status.ts"
import { agentUsable, lookupAgentPin, normalizeModelRef, parseModelPin, readDisabledProviders } from "./agent-pins.ts"
import { RegistryImpl } from "./registry.ts"
import { emptyToolEventState } from "./run-events.ts"
import { EMPTY_CATALOG, SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, buildSkillContent } from "./skill-content.ts"
import { compileGraphSpec, validateGraphSpec } from "./graph.ts"
import type { GraphSpec } from "./graph.ts"
import { SCRIPT_TEMPLATES, scriptTemplate } from "./script-templates.ts"
import { StorageImpl, normalizePath, readProjectWorkflowFile, resolveContainedPath, sha256 } from "./storage.ts"
import { resolveBackground, validateCatalogToolInput, validateControlToolInput, validateResultToolInput, validateStatusToolInput, validateToolInput } from "./tool-input.ts"
import type {
  FsLike,
  Json,
  KvLike,
  ParentContext,
  SessionCtx,
  Supervisor,
  WorkflowMeta,
} from "./types.ts"
import {
  isActiveRunStatus,
  MAX_LOOP_DEPTH,
  MAX_LOOP_ITERATIONS,
  MAX_RUN_TIMEOUT_MS,
  MIN_LOOP_DEPTH,
  MIN_LOOP_ITERATIONS,
  MIN_RUN_TIMEOUT_MS,
} from "./types.ts"

/** Minimal shape of a plugin hook/transform registration (for cleanup). */
interface RegistrationLike {
  dispose(): Promise<void> | void
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const loadedByProject = new Map<string, string[]>()

function randomBootID(): string {
  return `boot_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

function pluginInstallDir(): string {
  try {
    return fileURLToPath(new URL("..", import.meta.url))
  } catch {
    return "(unknown)"
  }
}

function warn(message: string, err?: unknown): void {
  try {
    const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[ultracode] ${message}${detail}`)
  } catch {
    // never throw from logging
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

/** Unwrap a list response that is either a bare array or a { location, data } envelope. */
function unwrapList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === "object") {
    const data = (result as { data?: unknown }).data
    if (Array.isArray(data)) return data
  }
  return []
}

/** Shared per-run wall-clock override property (all three run forms). */
const RUN_TIMEOUT_MS_PROPERTY: Record<string, unknown> = {
  type: "integer",
  minimum: MIN_RUN_TIMEOUT_MS,
  maximum: MAX_RUN_TIMEOUT_MS,
  description:
    "Optional wall-clock limit for THIS run in ms (10 s–24 h, same bounds as /ultracode set timeoutMs). Pass it when your budgeted waves × stages exceed the configured default — it applies to this run only, never changes the project default, and is recorded on the run and shown in ultracode_status.",
}

/** Shared explicit model-override property (all run forms). */
const MODEL_OVERRIDE_PROPERTY: Record<string, unknown> = {
  type: "string",
  description:
    'Optional explicit model override for THIS run: "provider/id" or "provider/id#variant". Beats the user\'s agent-config pins for every child without a per-call agent(prompt, { model }) override. A provider the user disabled (disabled_providers) stays blocked unless allowDisabledProviders: true. Routing by agent id remains the default — use this only when the user explicitly asks for a model.',
}

/** Shared disabled-provider escape hatch (companion to MODEL_OVERRIDE_PROPERTY). */
const ALLOW_DISABLED_PROVIDERS_PROPERTY: Record<string, unknown> = {
  type: "boolean",
  description:
    "Default false. Pass true only when the user explicitly wants overrides to run on providers they disabled (disabled_providers) — it unlocks ALL disabled providers for THIS run only (run-wide), not just the one named in model.",
}

/** Shared per-run loop nesting-depth override property (all run forms). */
const MAX_LOOP_DEPTH_PROPERTY: Record<string, unknown> = {
  type: "integer",
  minimum: MIN_LOOP_DEPTH,
  maximum: MAX_LOOP_DEPTH,
  description:
    "Optional per-run cap on loop() nesting depth (1-16, same bounds as the maxLoopDepth plugin option). Pass it when an authored design legitimately nests deeper than the configured default — e.g. loop({unit}) composition shares ONE depth stack, so a trusted workflow containing loops called per-iteration can need depth 3+. This run only; recorded on the run and shown in ultracode_status. Graphs compile to flat waves (no loop nesting), so this applies to script/template/saved-workflow loops.",
}

/** Shared per-run loop iteration ceiling property (all run forms). */
const MAX_LOOP_ITERATIONS_PROPERTY: Record<string, unknown> = {
  type: "integer",
  minimum: MIN_LOOP_ITERATIONS,
  maximum: MAX_LOOP_ITERATIONS,
  description:
    "Optional per-run ceiling on loop() iterations (1-200, TIGHTEN-ONLY): each loop's effective bound becomes min(its budget.iterations, this value) — cap a long-running template at N passes without editing it; it can never RAISE an authored budget. Per loop, not a run-wide total (the shared agent ledger and wall clock bound totals); it also binds loops inside composed loop({unit}) workflows. Loops that stop early because of it report budget: { requested, effective } in their result. This run only; recorded on the run and shown in ultracode_status.",
}

/** JSON Schema for the workflow tool input union (inline script vs saved workflow). */
const WORKFLOW_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["script"],
      properties: {
        script: {
          type: "string",
          description:
            "Workflow source: a plain-JS async function body (no import/export). Injected globals: agent(prompt, opts?) -> {text, data?, tokens}, parallel(thunks), pipeline(items, ...stages), phase(name), progress(text), workflow(name, args), loop(spec, iterate) (engine-owned iteration: budgets, auto-keys, checkpoints, verdict+skeptic), queue(items) (worklist), sleep(ms), console.log, args, meta. Return a small JSON value.",
        },
        name: { type: "string", description: "Optional run name shown in /ultracode summaries." },
        meta: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            phases: { type: "array", items: { type: "string" } },
            requires: {
              type: "array",
              items: { type: "string" },
              description: "Agent ids that must exist before the run starts (preflight, fail-fast).",
            },
          },
        },
        args: { description: "JSON value exposed to the script as `args` (max 64 KB serialized)." },
        background: {
          type: "boolean",
          description:
            "Default true: return immediately after admission with { runID, status: \"running\", hint }. Pass false to block until the envelope. On completion a one-line settle notice lands in the parent session and wakes the calling agent; poll ultracode_status for detail.",
        },
        resumeFrom: {
          type: "string",
          description:
            "Warm-start from a prior run id (run_…): keyed succeeded agents replay from that run's cache instead of respawning, so an interrupted long run costs only its unfinished tail.",
        },
        timeoutMs: RUN_TIMEOUT_MS_PROPERTY,
        maxLoopDepth: MAX_LOOP_DEPTH_PROPERTY,
        maxLoopIterations: MAX_LOOP_ITERATIONS_PROPERTY,
        model: MODEL_OVERRIDE_PROPERTY,
        allowDisabledProviders: ALLOW_DISABLED_PROVIDERS_PROPERTY,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["workflow"],
      properties: {
        workflow: {
          type: "string",
          description: "Saved workflow name (see /ultracode for the list; project dir beats personal dir). Trusted via /ultracode trust <name>.",
        },
        args: { description: "JSON value exposed to the script as `args` (max 64 KB serialized)." },
        background: {
          type: "boolean",
          description:
            "Default true: return immediately after admission with { runID, status: \"running\", hint }. Pass false to block until the envelope. On completion a one-line settle notice lands in the parent session and wakes the calling agent; poll ultracode_status for detail.",
        },
        resumeFrom: {
          type: "string",
          description:
            "Warm-start from a prior run id (run_…): keyed succeeded agents replay from that run's cache instead of respawning, so an interrupted long run costs only its unfinished tail.",
        },
        timeoutMs: RUN_TIMEOUT_MS_PROPERTY,
        maxLoopDepth: MAX_LOOP_DEPTH_PROPERTY,
        maxLoopIterations: MAX_LOOP_ITERATIONS_PROPERTY,
        model: MODEL_OVERRIDE_PROPERTY,
        allowDisabledProviders: ALLOW_DISABLED_PROVIDERS_PROPERTY,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["graph"],
      properties: {
        graph: {
          type: "object",
          description:
            "Graph-authored workflow DAG (preferred for standard shapes — cheaper and safer than hand-writing JS). " +
            "{ nodes: [{ id, kind, ... }], returns?: { key: \"$node.path\" } }. Kinds: agent (one child: prompt template with {{args.x}}/{{nodeId}}), " +
            "fanout (over: \"$ref\", one child per item, {{item}}/{{index}}, max caps items), partition (from: \"$scout.files\", token-budgeted lanes), " +
            "merge (from: \"$fanout\", batched join), gate (one QC reviewer, aborts on fail), checkpoint, workflow (compose by name). " +
            "Node ids are phases; every call is auto-keyed for warm rerun. The runtime validates the DAG (refs, cycles, budgets) and compiles it — zero tokens spent on invalid graphs.",
        },
        name: { type: "string", description: "Optional run name shown in /ultracode summaries." },
        args: { description: "JSON value exposed to templates as {{args.x}} and to the compiled script as `args`." },
        background: {
          type: "boolean",
          description:
            "Default true: return immediately after admission. Pass false to block until the envelope.",
        },
        resumeFrom: {
          type: "string",
          description:
            "Warm-start from a prior run id (run_…). Graph calls are auto-keyed per node, so every finished child replays from cache and only the unfinished tail respawns.",
        },
        timeoutMs: RUN_TIMEOUT_MS_PROPERTY,
        maxLoopDepth: MAX_LOOP_DEPTH_PROPERTY,
        maxLoopIterations: MAX_LOOP_ITERATIONS_PROPERTY,
        model: MODEL_OVERRIDE_PROPERTY,
        allowDisabledProviders: ALLOW_DISABLED_PROVIDERS_PROPERTY,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description:
            "Project-root-relative workflow file (e.g. \".opencode/workflows/audit.js\"). PREFERRED for scripts longer than ~30 lines: author the file with your file-write tool, then run it by path — never embed long scripts as strings in tool input (generic execute sandboxes mangle escapes). Read at call time; trust level equals an inline { script }.",
        },
        args: { description: "JSON value exposed to the script as `args` (max 64 KB serialized)." },
        background: {
          type: "boolean",
          description:
            "Default true: return immediately after admission with { runID, status: \"running\", hint }. Pass false to block until the envelope.",
        },
        resumeFrom: {
          type: "string",
          description: "Warm-start from a prior run id (run_…): keyed succeeded agents replay from cache.",
        },
        timeoutMs: RUN_TIMEOUT_MS_PROPERTY,
        maxLoopDepth: MAX_LOOP_DEPTH_PROPERTY,
        maxLoopIterations: MAX_LOOP_ITERATIONS_PROPERTY,
        model: MODEL_OVERRIDE_PROPERTY,
        allowDisabledProviders: ALLOW_DISABLED_PROVIDERS_PROPERTY,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["template"],
      properties: {
        template: {
          type: "string",
          description:
            "Served script-template name (staged-delivery, verify-fix — see ultracode_catalog { scriptTemplates: true }): run it directly without copying the body.",
        },
        args: { description: "JSON value feeding the template's declared params (see ultracode_catalog for each template's args)." },
        background: {
          type: "boolean",
          description: "Default true: return immediately after admission. Pass false to block until the envelope.",
        },
        resumeFrom: {
          type: "string",
          description: "Warm-start from a prior run id (run_…): keyed succeeded agents replay from cache.",
        },
        timeoutMs: RUN_TIMEOUT_MS_PROPERTY,
        maxLoopDepth: MAX_LOOP_DEPTH_PROPERTY,
        maxLoopIterations: MAX_LOOP_ITERATIONS_PROPERTY,
        model: MODEL_OVERRIDE_PROPERTY,
        allowDisabledProviders: ALLOW_DISABLED_PROVIDERS_PROPERTY,
      },
    },
  ],
}

const STATUS_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    runID: {
      type: "string",
      description: "Run id to inspect. Omit to use the single active run; none or many active runs is an error listing ids.",
    },
  },
}

const RESULT_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["runID"],
  properties: {
    runID: {
      type: "string",
      description: "Settled run id (must belong to this conversation).",
    },
    offset: {
      type: "integer",
      minimum: 0,
      description: "Start offset into the compact-JSON serialization. Start at 0; follow nextOffset from previous calls.",
    },
    maxLength: {
      type: "integer",
      minimum: 2,
      maximum: 131072,
      description: "Max chars for this chunk (min 2 — one UTF-16 unit can be half a surrogate pair; default 24000, max 131072). Chunks concatenate; parse after the complete chunk.",
    },
  },
}

const CATALOG_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    workflow: {
      type: "string",
      description:
        "One saved workflow name → detail view: params (names always; JSON types only when declared — explicit params, a // Tool input: header, or a saved run's real args; graph-derived params are names only), phases, required agents, trust state, the full graph spec (graph kind) or the script head (script kind), and last-run stats from this conversation.",
    },
    template: {
      type: "string",
      description: "One graph template name → its complete spec, ready to adapt (edit prompts, caps, schemas).",
    },
    templates: {
      type: "boolean",
      description: "true → every graph template's complete spec. Larger payload; prefer `template` for one.",
    },
    scriptTemplate: {
      type: "string",
      description:
        "One script template name → its complete body, ready to adapt (edit prompts, args, caps) and run as { script }. For shapes graphs cannot express: staged-delivery (sequential write stages with verify-fix gates), verify-fix (bounded fix loop).",
    },
    scriptTemplates: {
      type: "boolean",
      description: "true → every script template's complete body. Larger payload; prefer `scriptTemplate` for one.",
    },
  },
}

const CONTROL_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["stop", "pause", "resume"],
      description: "stop: graceful (no new agent calls, in-flight children interrupted). pause: close admission of new agent() calls. resume: reopen a paused run.",
    },
    runID: {
      type: "string",
      description: "Target run. Omit to use the single active run owned by this conversation; an error listing ids when 0 or several.",
    },
  },
}

/** ~500ms-throttled, never-throwing wrapper over tool.progress({ status }). */
function makeReporter(progress: (update: Record<string, unknown>) => Promise<void>): (status: string) => void {
  const INTERVAL = 500
  let last = 0
  let latest = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const emit = (status: string): void => {
    last = Date.now()
    try {
      void progress({ status }).catch(() => {})
    } catch {
      // never throw
    }
  }
  return (status: string) => {
    latest = status
    const elapsed = Date.now() - last
    if (elapsed >= INTERVAL) {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      emit(latest)
      return
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        emit(latest)
      }, INTERVAL - elapsed)
      timer.unref?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "ultracode",
  async setup(ctx) {
    // ---- options ----
    const loaded = loadOptions(ctx.options)
    const baseOptions = loaded.options
    for (const w of loaded.warnings) warn(`config warning — ${w}`)

    let disposed = false
    // Instance-local skill state: the prompt hook must never push an
    // unregistered skill id into prompts (it can break admission). Never
    // inherited across plugin reloads.
    let skillInstalled = false
    let catalogInjected = false

    // ---- capabilities (plain interfaces; everything stays node-testable) ----
    const projectRoot = normalizePath(String(ctx.location?.project?.directory ?? process.cwd()))
    const projectID = String(ctx.location?.project?.id ?? projectRoot)
    const installDir = pluginInstallDir()
    const bootID = randomBootID()
    const personalWorkflowDir = normalizePath(
      `${process.env["HOME"] ?? homedir()}/.config/opencode/workflows`,
    )
    const prevLoads = loadedByProject.get(projectID) ?? []
    let duplicateWarning: string | undefined
    if (prevLoads.length > 0) {
      duplicateWarning = `duplicate ultracode setup() for project ${projectID}: already loaded from ${prevLoads.join(", ")}; now ${installDir}`
      warn(duplicateWarning)
    }
    let rpcRegistered = false
    loadedByProject.set(projectID, [...prevLoads, installDir])
    warn(
      `loaded v${PLUGIN_VERSION} installDir=${installDir} projectRoot=${projectRoot} projectID=${projectID} bootID=${bootID}`,
    )

    const kv: KvLike = {
      get: async (key) => (await ctx.storage.get(key)) as Json | undefined,
      set: async (key, value) => {
        await ctx.storage.set(key, value as unknown as Parameters<typeof ctx.storage.set>[1])
      },
      remove: async (key) => {
        await ctx.storage.remove(key)
      },
      scan: async (scanOptions) =>
        (await ctx.storage.scan(scanOptions)) as unknown as {
          entries: ReadonlyArray<{ key: string; value: Json }>
          next?: string
        },
    }

    const fs: FsLike = {
      mkdir: async (path, _recursive) => {
        await fsp.mkdir(path, { recursive: true })
      },
      writeFile: async (path, content) => {
        await fsp.writeFile(path, content, "utf8")
      },
      readFile: async (path) => await fsp.readFile(path, "utf8"),
      exists: async (path) => {
        try {
          await fsp.stat(path)
          return true
        } catch {
          return false
        }
      },
      readdir: async (path) => {
        try {
          return (await fsp.readdir(path)) as string[]
        } catch {
          return []
        }
      },
      realpath: async (path) => await fsp.realpath(path),
      lstat: async (path) => {
        try {
          const stats = await fsp.lstat(path)
          return { isSymbolicLink: () => stats.isSymbolicLink() }
        } catch (err) {
          if (err instanceof Error && (err as { code?: string }).code === "ENOENT") return undefined
          throw err
        }
      },
    }

    const sessions: SessionCtx = {
      create: async (input) =>
        (await ctx.session.create({
          title: input.title,
          agent: input.agent,
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.metadata ? { metadata: input.metadata as { readonly [k: string]: never } } : {}),
        })) as unknown as {
          id: string
          agent?: string
        },
      get: async (input) =>
        (await ctx.session.get({ sessionID: input.sessionID })) as unknown as Awaited<ReturnType<SessionCtx["get"]>>,
      prompt: async (input) =>
        (await ctx.session.prompt({ sessionID: input.sessionID, text: input.text })) as unknown as { id: string },
      wait: async (input) => {
        await ctx.session.wait({ sessionID: input.sessionID })
      },
      context: async (input) =>
        (await ctx.session.context({ sessionID: input.sessionID })) as unknown as ReadonlyArray<
          import("./types.ts").ContextMessage
        >,
      interrupt: async (input) => {
        await ctx.session.interrupt({ sessionID: input.sessionID, continue: false })
      },
    }

    const storage = new StorageImpl({ kv, fs, projectRoot, personalWorkflowDir, projectID })
    const emitPrev = new Map<string, { status: string; agentKey: string }>()
    let emitRunState:
      | ((
          name: "runState",
          data: {
            runID: string
            status: string
            reason?: string
            parentSessionID?: string
            projectID?: string
            directory?: string
            runningCount?: number
          },
        ) => Promise<void>)
      | undefined
    const registry = new RegistryImpl({
      persist: (record) => {
        storage.saveRun(record)
        const prev = emitPrev.get(record.id)
        const event = runStateTransition(prev, record)
        if (isFinalRunStatus(record.status)) emitPrev.delete(record.id)
        else emitPrev.set(record.id, { status: record.status, agentKey: agentStatusKey(record.agents) })
        const emit = emitRunState
        if (event && emit) {
          let runningCount = 0
          for (const agent of record.agents) if (agent.status === "running") runningCount++
          void emit("runState", {
            ...event,
            parentSessionID: record.parentSessionID,
            projectID,
            directory: record.directory ?? ctx.location.directory,
            runningCount,
          }).catch(() => {})
        }
      },
      loader: () => storage.loadRuns(),
      bootID,
    })

    const controller = new AbortController()
    const registrations: RegistrationLike[] = []

    // Async warm-up (never blocks setup on session admission; kv only).
    const runsReconciled = storage
      .loadRunsAsync()
      .then(() => {
        const flipped = registry.reconcileOrphans()
        if (flipped > 0) warn(`marked ${flipped} orphaned run(s) as interrupted (server restart)`)
      })
      .catch((err) => warn("failed to reconcile persisted runs", err))

    void (async () => {
      try {
        const hbKey = `instance/${sha256(projectID).slice(0, 16)}`
        const prev = await kv.get(hbKey)
        if (prev && typeof prev === "object" && !Array.isArray(prev)) {
          const rec = prev as { installDir?: unknown; bootID?: unknown; startedAt?: unknown }
          const otherDir = typeof rec.installDir === "string" ? rec.installDir : undefined
          const startedAt = typeof rec.startedAt === "number" ? rec.startedAt : 0
          const fresh = Date.now() - startedAt < 15 * 60 * 1000
          if (fresh && otherDir && otherDir !== installDir) {
            const msg = `another ultracode instance is live for this project (installDir=${otherDir} bootID=${String(rec.bootID)}; this load is ${installDir} bootID=${bootID})`
            duplicateWarning = duplicateWarning ? `${duplicateWarning}; ${msg}` : msg
            warn(msg)
          }
        }
        await kv.set(hbKey, { installDir, bootID, startedAt: Date.now(), projectRoot })
      } catch (err) {
        warn("instance heartbeat write failed", err)
      }
    })()

    // ---- agent availability (fresh per invocation; failures fail the run) ----
    async function listAgents(): Promise<
      | { ok: true; agents: Array<{ id: string; description?: string }> }
      | { ok: false; error: string }
    > {
      try {
        const result = (await ctx.agent.list()) as unknown
        const agents: Array<{ id: string; description?: string }> = []
        for (const a of unwrapList(result)) {
          if (!a || typeof a !== "object") continue
          const id = (a as { id?: unknown }).id
          if (typeof id !== "string" || id === "") continue
          const description = (a as { description?: unknown }).description
          const name = (a as { name?: unknown }).name
          const desc =
            typeof description === "string"
              ? description
              : typeof name === "string" && name !== id
                ? name
                : undefined
          agents.push(desc ? { id, description: desc } : { id })
        }
        // agentScope "configured": only agents the user actually manages
        // (agents/*.md in project or global config — the subagent-config
        // set), not disabled, and not pinned to a provider the user took
        // offline. Shipped file-less agents (build, plan, …) are excluded
        // until the user creates their file; filter failures fail open to
        // the host list.
        if (options.agentScope === "configured") {
          const home = process.env["HOME"] ?? homedir()
          let disabledProviders: ReadonlySet<string> = new Set()
          try {
            disabledProviders = await readDisabledProviders(fs, projectRoot, home)
          } catch {
            // best-effort — empty set fails open
          }
          const filtered: typeof agents = []
          for (const a of agents) {
            try {
              if (await agentUsable(fs, projectRoot, home, a.id, disabledProviders)) filtered.push(a)
            } catch {
              filtered.push(a)
            }
          }
          return { ok: true, agents: filtered }
        }
        return { ok: true, agents }
      } catch (err) {
        return { ok: false, error: describeError(err) }
      }
    }

    /** D1: first non-empty agent.list() rebuilds the in-memory skill (never the shipped file). */
    async function maybeInjectCatalog(agents: Array<{ id: string; description?: string }>): Promise<void> {
      if (catalogInjected || !skillInstalled || agents.length === 0) return
      const prior = skillInstalled
      try {
        await storage.refreshWorkflows()
        const workflows = storage.listWorkflows().map((w) => ({
          name: w.manifest.name,
          description: w.manifest.description,
          phases: w.manifest.phases,
          trusted: storage.workflowTrustState(w.manifest.name) === "trusted",
        }))
        const content = buildSkillContent({ agents, workflows })
        await ctx.skill.transform((editor) => {
          try {
            editor.update("ultracode", (skill) => {
              skill.content = content
            })
          } catch (err) {
            warn("skill editor.update failed during catalog injection", err)
            throw err
          }
        })
        catalogInjected = true
      } catch (err) {
        skillInstalled = prior
        warn("live catalog injection failed — skill left at prior content", err)
      }
    }

    let overlay: SettingsOverlay = {}
    try {
      overlay = (await storage.loadSettingsOverlayAsync()) ?? {}
    } catch {
      overlay = {}
    }
    let options = applyOverlay(baseOptions, overlay)

    // ---- supervisor (Builder B module; guarded dynamic import) ----
    let supervisor: Supervisor | undefined
    let supervisorError: string | undefined

    const refreshDefaults = (nextOverlay: SettingsOverlay): typeof options => {
      overlay = nextOverlay
      options = applyOverlay(baseOptions, overlay)
      supervisor?.updateDefaults(options)
      return options
    }
    try {
      const mod = await import("./supervisor.ts")
      // Composition seam (Builder B): workflow() bridge calls go through this
      // async loader — snapshot-per-call fresh disk reads, trust-checked.
      supervisor = new mod.SupervisorImpl({
        registry,
        storage,
        sessions,
        options,
        loadWorkflowFresh: (name: string) => storage.loadWorkflowFresh(name),
        // Agent model pins: server-side session.create does not apply global
        // agent pins (live-verified 2026-09-09 — children fell back to the
        // free location default). Resolve the pin from the same documented
        // config the client reads and apply it at create time. Per-call, so
        // re-pinning applies to the next spawned child.
        pinForAgent: async (agentId: string) => {
          const home = process.env["HOME"] ?? homedir()
          const pin = await lookupAgentPin(fs, projectRoot, home, agentId)
          if (pin === undefined) return undefined
          const parsed = parseModelPin(pin)
          if (parsed === undefined) return undefined
          // Offline provider (subagent-config provider off): skip the pin —
          // AgentRunner falls back to the default agent's pin (also guarded
          // here) rather than spawning on a provider the user turned off.
          try {
            const disabled = await readDisabledProviders(fs, projectRoot, home)
            if (disabled.has(parsed.providerID)) return undefined
          } catch {
            // best-effort check — fail open
          }
          return parsed
        },
        // Explicit model overrides (call-site opts.model or the run input
        // model) on a provider the user took offline are rejected by the
        // supervisor preflight/dispatch gate — same config the pin path reads,
        // per-call so re-disabling applies to the next child.
        isProviderDisabled: async (providerID: string) => {
          const home = process.env["HOME"] ?? homedir()
          try {
            const disabled = await readDisabledProviders(fs, projectRoot, home)
            return disabled.has(providerID)
          } catch {
            return false // best-effort check — fail open
          }
        },
      })
    } catch (err) {
      supervisorError =
        "workflow tool unavailable: the supervisor module failed to load " +
        `(${describeError(err)}). Reinstall the plugin or check src/supervisor.ts.`
      warn("supervisor module unavailable — workflow tool disabled", err)
    }

    // ---- session access from executors only (deadlock rule) ----
    async function say(sessionID: string, text: string): Promise<void> {
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch (err) {
        warn(`failed to deliver message to session ${sessionID}`, err)
      }
    }

    /** Best-effort pending-permission summary for a child session. */
    async function pendingPermissions(sessionID: string): Promise<string | undefined> {
      try {
        const result = (await ctx.permission.list({ sessionID })) as unknown
        const items = unwrapList(result) as Array<{ action?: string; resources?: unknown; message?: string }>
        if (items.length === 0) return undefined
        return items
          .map((p) => {
            const resources = Array.isArray(p.resources) ? p.resources.join(", ") : "?"
            return `${p.action ?? "?"} on ${resources}`
          })
          .join("; ")
      } catch {
        return undefined
      }
    }

    // ---- ultracode_run tool (namespaced: unique vs future opencode/plugin tools) ----
    try {
      await ctx.tool.transform((editor) => {
        try {
          editor.namespace({ name: "ultracode", description: "Dynamic workflow orchestration (ultracode)" })
          editor.add({
            name: "run",
            options: { namespace: "ultracode" },
            description: TOOL_DESCRIPTION,
            input: WORKFLOW_TOOL_INPUT_SCHEMA,
            execute: async (rawInput: unknown, tool) => {
              if (supervisor?.isOwnedSession(tool.sessionID)) {
                return { content: "nested workflow runs are not allowed" }
              }
              try {
                if (disposed) return { content: "error: the ultracode plugin is shutting down" }
                if (!supervisor) {
                  return { content: `error: ${supervisorError ?? "workflow tool unavailable"}` }
                }
                const parsed = validateToolInput(rawInput)
                if (!parsed.ok) {
                  return { content: `error: invalid workflow input — ${parsed.error}` }
                }
                const input = parsed.input

                let script: string
                let meta: WorkflowMeta | undefined
                let name: string | undefined
                let workflowName: string | undefined
                let args: Json | undefined
                let graphSpec: Json | undefined

                if ("graph" in input) {
                  // Graph-authored run: validate the DAG, compile to a plain
                  // async-body script, then proceed down the inline path. The
                  // spec is recorded on the run so `/ultracode graph`,
                  // `/ultracode save` and rerun keep working with the source of
                  // truth instead of the compiled artifact.
                  const graphCheck = validateGraphSpec(input.graph)
                  if (!graphCheck.ok) {
                    return {
                      content:
                        `error: invalid graph spec — ${graphCheck.errors.slice(0, 5).join("; ")}` +
                        (graphCheck.errors.length > 5 ? ` (+${graphCheck.errors.length - 5} more)` : ""),
                    }
                  }
                  const compiled = compileGraphSpec(input.graph as unknown as GraphSpec)
                  script = compiled.script
                  graphSpec = input.graph as Json
                  workflowName = undefined
                  name = input.name ?? compiled.meta.name
                  meta = {
                    ...(name !== undefined ? { name } : {}),
                    ...(compiled.meta.description !== undefined
                      ? { description: compiled.meta.description }
                      : {}),
                    phases: compiled.meta.phases,
                    requires: compiled.meta.requires,
                  }
                  args = input.args
                } else if ("workflow" in input) {
                  // Fresh disk scan so edits made while the server runs are seen.
                  await storage.refreshWorkflows()
                  await runsReconciled
                  let saved: ReturnType<StorageImpl["loadWorkflow"]>
                  try {
                    saved = storage.loadWorkflow(input.workflow)
                  } catch (err) {
                    const message = describeError(err)
                    // Model-facing reroute guard, appended ONLY at the tool
                    // boundary (humans see the bare storage message via /ultracode).
                    const trustHint = /is not trusted/.test(message)
                      ? " Trust is user-only: relay the /ultracode trust command to the user and wait — do not silently reroute to an inline script."
                      : ""
                    return { content: `error: ${message}${trustHint}` }
                  }
                  if (!saved) {
                    const available = storage
                      .listWorkflows()
                      .map((w) => w.manifest.name)
                      .join(", ")
                    return {
                      content:
                        `error: workflow "${input.workflow}" not found.` +
                        (available
                          ? ` Saved workflows: ${available}.`
                          : " No saved workflows exist yet — author `.opencode/workflows/<name>.js` (or `<name>.graph.json` for a graph) then `/ultracode save <name>` (or `/ultracode save <runID> <name>` after a run).") +
                        ` Alternatively call ultracode_run directly with { graph } or { script } for an inline run — never wrap this call in a generic execute/JS sandbox.`,
                    }
                  }
                  script = saved.script
                  // A saved GRAPH workflow keeps its spec on the run record, so
                  // re-saving or re-rendering the run works with the DAG.
                  graphSpec = saved.graphSpec
                  workflowName = input.workflow
                  name = saved.manifest.name
                  meta = {
                    name: saved.manifest.name,
                    description: saved.manifest.description,
                    phases: saved.manifest.phases,
                    requires: saved.manifest.requires,
                  }
                  args = input.args
                } else if ("path" in input) {
                  // Project-file run: the authoring agent writes the file with
                  // its file tool, then runs it by path — no string embedding.
                  // Trust equals an inline { script }: the user's own agent
                  // wrote the file deliberately. Read at call time (edits
                  // apply on the next run) through the SAME fail-closed,
                  // symlink-aware containment every other workflow-file access
                  // uses — a link escaping the project root is refused.
                  const read = await readProjectWorkflowFile(fs, projectRoot, input.path)
                  if (!read.ok) {
                    return {
                      content:
                        `error: ${read.error}. ` +
                        'Write it first (e.g. .opencode/workflows/<name>.js), then run { path: ".opencode/workflows/<name>.js" }.',
                    }
                  }
                  script = read.content
                  name = read.name
                  meta = { name: read.name }
                  args = input.args
                } else if ("template" in input) {
                  const t = scriptTemplate(input.template)
                  if (!t) {
                    return {
                      content:
                        `error: unknown script template "${input.template}" — known: ${SCRIPT_TEMPLATES.map((x) => x.name).join(", ")}. ` +
                        "Inspect one with ultracode_catalog { scriptTemplate: \"<name>\" }.",
                    }
                  }
                  script = t.script
                  name = t.name
                  meta = { name: t.name, description: t.description }
                  args = input.args
                } else {
                  script = input.script
                  meta = input.meta
                  name = input.name
                  args = input.args
                }

                const prep = await prepareRunLaunch({
                  listAgents,
                  defaultAgent: options.agent,
                  requires: meta?.requires,
                })
                if (!prep.ok) return { content: prep.error }
                await maybeInjectCatalog(prep.agents)

                const parent: ParentContext = {
                  directory: ctx.location.directory,
                  projectID,
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  messageID: tool.messageID,
                  report: makeReporter(tool.progress as (update: Record<string, unknown>) => Promise<void>),
                  availableAgents: prep.availableAgents,
                }
                const background = resolveBackground(input)
                // Explicit run-level model override (all run variants share the
                // field): shape-validated at tool input; parsed here into the
                // object the runner applies. An offline provider fails inside
                // the supervisor preflight (before any child spawns).
                let runModel:
                  | { providerID: string; id: string; variant?: string }
                  | undefined
                if (input.model !== undefined) {
                  const normalized = normalizeModelRef(input.model)
                  if (!normalized.ok) {
                    return { content: `error: "model" — ${normalized.error}` }
                  }
                  runModel = normalized.model
                }
                return await executeWorkflowLaunch(
                  supervisor,
                  {
                    script,
                    meta,
                    args,
                    name,
                    workflowName,
                    graphSpec,
                    resumeFrom: input.resumeFrom,
                    timeoutMs: input.timeoutMs,
                    ...(input.maxLoopDepth !== undefined ? { maxLoopDepth: input.maxLoopDepth } : {}),
                    ...(input.maxLoopIterations !== undefined
                      ? { maxLoopIterations: input.maxLoopIterations }
                      : {}),
                    ...(runModel !== undefined ? { model: runModel } : {}),
                    ...(input.allowDisabledProviders !== undefined
                      ? { allowDisabledProviders: input.allowDisabledProviders }
                      : {}),
                  },
                  parent,
                  background,
                  background
                    ? (outcome) => {
                        if (disposed) return // shutting down — no late synthetic messages
                        void say(tool.sessionID, formatSettleNotice(outcome.envelope))
                      }
                    : undefined,
                )
              } catch (err) {
                return { content: `error: workflow run failed — ${describeError(err)}` }
              }
            },
          })
        } catch (err) {
          warn("failed to register the ultracode_run tool", err)
        }
        try {
          editor.add({
            name: "status",
            options: { namespace: "ultracode" },
            description:
              "Read-only status of an ultracode run owned by this conversation. Input { runID? } (omit → single active owned run). Returns { runID, status, agents: { done, total, failed }, startedAt, elapsedMs, children: [{ agentID, sessionID?, label?, phase?, status, tokens?: { input, output, reasoning }, toolCalls?, waitingForPermission? }] } and, once settled, the full result inline when it fits the size cap, else resultPreview + resultTruncated + resultChars (fetch the rest with ultracode_result). Per-child tokens expose which lane blew its budget.",
            input: STATUS_TOOL_INPUT_SCHEMA,
            execute: async (rawInput: unknown, tool) => {
              try {
                const parsed = validateStatusToolInput(rawInput)
                if (!parsed.ok) return { content: `error: ${parsed.error}` }
                // Persisted-run warm-up (same rationale as ultracode_result).
                await runsReconciled
                const active = (supervisor?.activeRuns() ?? registry.activeRuns()).filter((r) => r.parentSessionID === tool.sessionID)
                if (parsed.runID && registry.get(parsed.runID)?.parentSessionID !== tool.sessionID) {
                  return { content: "error: run does not belong to this conversation" }
                }
                const resolved = resolveRunStatus(registry, parsed.runID ?? "", active)
                if (!resolved.ok) return { content: `error: ${resolved.error}` }
                const record = registry.get(resolved.payload.runID)
                const payload = enrichStatusPayload(resolved.payload, record, Date.now(), options.maxResultChars)
                const children = await Promise.all(
                  (payload.children as Array<StatusChildView & { sessionID?: string }>).map(async (c) =>
                    c.status === "running" && c.sessionID
                      ? { ...c, waitingForPermission: await pendingPermissions(c.sessionID) }
                      : c,
                  ),
                )
                return { content: JSON.stringify({ ...payload, children }) }
              } catch (err) {
                return { content: `error: ${describeError(err)}` }
              }
            },
          })
        } catch (err) {
          warn("failed to register the ultracode_status tool", err)
        }
        try {
          editor.add({
            name: "result",
            options: { namespace: "ultracode" },
            description:
              "Fetch the FULL settled result of an ultracode run owned by this conversation (the piece missing from truncated previews). Input { runID, offset?, maxLength? }. Returns { source, totalChars, offset, chunk, complete, nextOffset, resultArtifactKey? } where chunk is a substring of the compact JSON serialization — request offset 0 first, follow nextOffset, concatenate, then parse once.",
            input: RESULT_TOOL_INPUT_SCHEMA,
            execute: async (rawInput: unknown, tool) => {
              try {
                const parsed = validateResultToolInput(rawInput)
                if (!parsed.ok) return { content: `error: ${parsed.error}` }
                // Wait for the persisted-run warm-up: this tool's primary use
                // case is fetching a truncated result from a run recorded by a
                // previous process (server restart) — a cold registry would
                // otherwise report it as "not found".
                await runsReconciled
                // Ownership before existence (matches ultracode_status — no
                // runID existence oracle for foreign sessions).
                if (registry.get(parsed.runID)?.parentSessionID !== tool.sessionID) {
                  return { content: "error: run does not belong to this conversation" }
                }
                const run = registry.get(parsed.runID)
                if (!run) {
                  return { content: `error: run "${parsed.runID}" not found. See /ultracode for known runs.` }
                }
                if (isActiveRunStatus(run.status)) {
                  return {
                    content: `error: run "${parsed.runID}" is still ${run.status} — the result exists only after it settles. Poll ultracode_status.`,
                  }
                }
                const artifact = run.resultArtifactKey
                  ? await storage.loadResultArtifactFresh(run.resultArtifactKey)
                  : undefined
                const chunk = buildResultChunk(run, artifact, {
                  ...(parsed.offset !== undefined ? { offset: parsed.offset } : {}),
                  ...(parsed.maxLength !== undefined ? { maxLength: parsed.maxLength } : {}),
                })
                if (!chunk.ok) return { content: `error: ${chunk.error}` }
                return { content: JSON.stringify(chunk.view) }
              } catch (err) {
                return { content: `error: ${describeError(err)}` }
              }
            },
          })
        } catch (err) {
          warn("failed to register the ultracode_result tool", err)
        }
        editor.add({
          name: "catalog",
          options: { namespace: "ultracode" },
          description:
            "Read-only discovery of what this project can run: saved workflows (kind, params (names always; JSON types only when declared — explicit params, a // Tool input: header, or a saved run's real args; graph-derived params are names only), phases, required agents, trust state, last-run stats from THIS conversation), the available agent ids, the live caps (concurrency, maxAgents, timeoutMs, maxLoopDepth, maxLoopIterations), graph templates to adapt, and script templates (staged-delivery, verify-fix) for loop-shaped work graphs cannot express. Call it BEFORE choosing a saved workflow or authoring from a blank page — cheaper than reading workflow files, and it executes nothing. Input { workflow? | template? | templates? | scriptTemplate? | scriptTemplates? }: no input returns the whole bounded catalog; one view per call. A workflow listed as trusted can be run immediately; an untrusted one needs the user's /ultracode trust first (relay that, never work around it).",
          input: CATALOG_TOOL_INPUT_SCHEMA,
          execute: async (rawInput: unknown, tool) => {
            try {
              const parsed = validateCatalogToolInput(rawInput)
              if (!parsed.ok) return { content: `error: ${parsed.error}` }
              // Fresh scans: workflows may have been saved or edited while the
              // server ran, and persisted runs may predate this process.
              await runsReconciled
              await storage.refreshWorkflows()
              const listed = await listAgents()
              // Ownership FIRST, then the cap: listRecent is process-wide, so
              // capping before filtering would let 50 other sessions' runs push
              // this conversation's stats out of the view entirely. Run history
              // is per-conversation provenance (same rule as status/result).
              const runs = registry
                .listRecent(CATALOG_RUN_SCAN)
                .filter((r) => r.parentSessionID === tool.sessionID)
                .slice(0, CATALOG_RUN_LIMIT)
              const catalog = buildCatalog({
                ...(listed.ok ? { agents: listed.agents } : { agentsUnavailable: listed.error }),
                workflows: storage.listWorkflows().map((workflow) => ({
                  workflow,
                  trusted: storage.workflowTrustState(workflow.manifest.name) === "trusted",
                })),
                runs,
                caps: {
                  concurrency: options.concurrency,
                  maxAgents: options.maxAgents,
                  timeoutMs: options.timeoutMs,
                  // Loop caps: the current nesting default (per-run input may
                  // set 1..16) and the per-loop iteration ceiling a per-run
                  // input may tighten below (never raise).
                  maxLoopDepth: options.maxLoopDepth,
                  maxLoopIterations: MAX_LOOP_ITERATIONS,
                },
                ...(parsed.templates !== undefined ? { templates: parsed.templates } : {}),
                ...(parsed.template !== undefined ? { template: parsed.template } : {}),
                ...(parsed.scriptTemplates !== undefined ? { scriptTemplates: parsed.scriptTemplates } : {}),
                ...(parsed.scriptTemplate !== undefined ? { scriptTemplate: parsed.scriptTemplate } : {}),
                ...(parsed.workflow !== undefined ? { workflow: parsed.workflow } : {}),
              })
              return { content: JSON.stringify(catalog) }
            } catch (err) {
              return { content: `error: ${describeError(err)}` }
            }
          },
        })
        editor.add({
          name: "control",
          options: { namespace: "ultracode" },
          description:
            "Orchestrator control of runs owned by this conversation. Input { action: \"stop\"|\"pause\"|\"resume\", runID? }. stop is graceful (no new agent calls, children interrupted) and is recorded as the run's stop reason; pause closes admission of new agent() calls; resume reopens a paused run. Implicit target only when exactly one active owned run.",
          input: CONTROL_TOOL_INPUT_SCHEMA,
          execute: async (raw: unknown, tool) =>
            controlToolContent(validateControlToolInput(raw), tool.sessionID, {
              getRun: (runID) => registry.get(runID),
              activeRuns: () => supervisor?.activeRuns() ?? registry.activeRuns(),
              supervisor: supervisor ?? undefined,
              supervisorError,
              reconciled: runsReconciled,
            }),
        })
        editor.add({
          name: "steer",
          options: { namespace: "ultracode" },
          description: "Send a user adjustment to a running workflow child without stopping the workflow. Only runs owned by this conversation. Specify agentID when several children are running. Does not restart completed children. Runs are background by default, so this conversation stays available.",
          input: {
            type: "object", additionalProperties: false, required: ["runID", "text"],
            properties: { runID: { type: "string" }, agentID: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 65536 } },
          },
          execute: async (raw, tool) => {
            try {
              const input = raw as { runID: string; text: string; agentID?: string }
              const target = await steerRun(registry.get(input.runID), tool.sessionID, input, (request) => ctx.session.prompt(request))
              return { content: JSON.stringify({ ...target, accepted: true, delivery: "steer" }) }
            } catch (error) {
              return { content: `error: ${describeError(error)}` }
            }
          },
        })
      })
    } catch (err) {
      warn("tool transform failed — ultracode_run not registered", err)
    }

    // ---- /ultracode command (no /workflow aliases — avoid OpenCode name collisions) ----
    const commandHandler = async (invocation: { sessionID: string; prompt: { text?: string } }): Promise<void> => {
      try {
        if (disposed) return
        await handleUltracodeCommand(invocation, {
          registry,
          supervisor,
          supervisorError,
          storage,
          say,
          projectRoot,
          personalWorkflowDir,
          pendingPermissions,
          prepare: async () => {
            await runsReconciled
            await storage.refreshWorkflows()
          },
          listAgents,
          defaultAgent: options.agent,
          nextRunSettings: () => panelSettingsFrom(options),
          persistAndRefreshSettings: async (nextOverlay) => {
            storage.saveSettingsOverlay(nextOverlay)
            const next = refreshDefaults(nextOverlay)
            return panelSettingsFrom(next)
          },
          doctor: async () => {
            const diag = storage.kvDiagnostics()
            let marker: { v?: number; version?: string; tui?: number } | undefined
            try {
              const raw = JSON.parse(
                await fsp.readFile(`${installDir}/.ultracode-install`, "utf8"),
              ) as { v?: unknown; version?: unknown; tui?: unknown }
              marker = {
                ...(typeof raw.v === "number" ? { v: raw.v } : {}),
                ...(typeof raw.version === "string" ? { version: raw.version } : {}),
                ...(typeof raw.tui === "number" ? { tui: raw.tui } : {}),
              }
            } catch {
              marker = undefined // not an installer tree — reported as missing
            }
            const entry = async (p: string): Promise<boolean> => {
              try {
                await fsp.stat(p)
                return true
              } catch {
                return false
              }
            }
            return formatDoctorReport({
              version: PLUGIN_VERSION,
              installDir,
              projectRoot,
              projectID,
              marker,
              entryFiles: {
                index: await entry(`${installDir}/index.ts`),
                srcIndex: await entry(`${installDir}/src/index.ts`),
                tui: await entry(`${installDir}/tui.tsx`),
                srcTui: await entry(`${installDir}/src/tui.tsx`),
              },
              rpc: rpcRegistered,
              supervisor: supervisor !== undefined,
              liveRuns: registry.activeRuns().length,
              persistedRuns: diag.persistedRunCount,
              kvErrorCount: diag.kvErrorCount,
              ...(diag.lastKvError ? { lastKvError: diag.lastKvError } : {}),
              artifactErrorCount: diag.artifactErrorCount,
              ...(diag.lastArtifactError ? { lastArtifactError: diag.lastArtifactError } : {}),
              ...(duplicateWarning ? { duplicateWarning } : {}),
            })
          },
        })
      } catch (err) {
        warn("/ultracode command failed", err)
      }
    }

    try {
      await ctx.command.transform((editor) => {
        try {
          editor.add({
            name: "ultracode",
            description: `Inspect and manage ultracode workflow runs (${D2_VERBS.join(", ")})`,
            execute: commandHandler,
          })
        } catch (err) {
          warn("failed to register commands", err)
        }
      })
    } catch (err) {
      warn("command transform failed — /ultracode not registered", err)
    }

    // ---- optional RPC channel (capability-gated; unconfirmed on pinned probe) ----
    try {
      const rpc = (ctx as { rpc?: { register?: unknown } }).rpc
      if (hasRpcRegister(rpc)) {
        const defined = typeof Rpc.define === "function" ? Rpc.define(ULTRACODE_RPC as never) : ULTRACODE_RPC
        const registration = await (
          rpc as {
            register: (
              definition: unknown,
              handlers: unknown,
            ) => Promise<{ events?: { emit?: (...args: unknown[]) => unknown }; dispose?: () => void }>
          }
        ).register(defined, {
          runStatus: async (input: {
            runID?: string
            sessionID?: string
            limit?: number
            includeFinished?: boolean
          } | undefined) => {
            await runsReconciled
            const runID = typeof input?.runID === "string" && input.runID !== "" ? input.runID : undefined
            const sessionID = typeof input?.sessionID === "string" && input.sessionID !== "" ? input.sessionID : undefined
            const limit = typeof input?.limit === "number" && Number.isFinite(input.limit) ? input.limit : undefined
            const includeFinished = typeof input?.includeFinished === "boolean" ? input.includeFinished : undefined
            return {
              runs: collectRunStatus({
                runID,
                sessionID,
                limit,
                includeFinished,
                liveGet: (id) => registry.get(id),
                liveList: () => registry.listRecent(100),
                persistedList: () => storage.loadRuns(),
                projectID,
                directory: ctx.location.directory,
              }),
            }
          },
          settings: async (input: { runID?: string } | undefined) => {
            const overlayNow = panelSettingsFrom(options)
            const runID = typeof input?.runID === "string" && input.runID !== "" ? input.runID : undefined
            const live = runID ? registry.get(runID) : undefined
            const persisted = runID ? storage.loadRuns().find((r) => r.id === runID) : undefined
            return settingsPayload(overlayNow, runID, capturedFromRecord(live ?? persisted))
          },
        })
        const emit = registration?.events?.emit
        if (typeof emit === "function") {
          emitRunState = (name, data) => Promise.resolve(emit(name, data)).then(() => undefined)
        }
        if (registration && typeof registration.dispose === "function") {
          registrations.push(registration as RegistrationLike)
        }
        rpcRegistered = true
      }
    } catch (err) {
      warn("rpc register failed — TUI uses session heuristics", err)
    }

    // ---- prompt hook: attach the authoring skill on a standalone "ultracode" keyword ----
    try {
      const reg = await ctx.session.hook("prompt", (event) => {
        try {
          if (!skillInstalled) return // never push an unregistered skill id
          const ev = event as unknown as {
            sessionID?: string
            prompt?: { text?: string; skills?: Array<{ id: string }> }
          }
          // Standalone keyword anywhere: "ultracode: do X" / "please ultracode this".
          // Paths like opencode-ultracode and ids like ultracode_run do not fire.
          if (!matchesUltracodeKeyword(ev.prompt?.text ?? "")) return
          // sessionID must be present; without it we cannot check ownership —
          // don't mutate the prompt at all.
          const sessionID = ev.sessionID
          if (typeof sessionID !== "string" || sessionID === "") return
          // Don't re-attach inside workflow-owned child sessions.
          if (supervisor?.isOwnedSession(sessionID) || registry.isOwnedActive(sessionID)) return
          const prompt = ev.prompt
          if (!prompt || typeof prompt !== "object") return
          prompt.skills ??= []
          if (!prompt.skills.some((s) => s?.id === "ultracode")) {
            prompt.skills.push({ id: "ultracode" })
          }
        } catch {
          // never throw from a hook
        }
      })
      registrations.push(reg as unknown as RegistrationLike)
    } catch (err) {
      warn("prompt hook registration failed — keyword skill attach disabled", err)
    }

    // ---- skill registration (Builder C content; static file in the plugin package) ----
    try {
      // The skill markdown ships inside the plugin package (skills/ultracode.md).
      // Derive the plugin dir from this module's URL; never write into the
      // user's project. Catalog injection later updates in-memory content only.
      const skillPath = fileURLToPath(new URL("../skills/ultracode.md", import.meta.url))
      let filePresent = false
      try {
        filePresent = await fs.exists(skillPath)
      } catch {
        filePresent = false
      }
      if (!filePresent) {
        // Best effort: materialize it inside the PLUGIN dir (not the project).
        // Read-only installs simply skip skill registration.
        try {
          await fs.mkdir(normalizePath(`${skillPath}/..`), true)
          await fs.writeFile(skillPath, SKILL_CONTENT)
          filePresent = true
        } catch (err) {
          warn(`skill file ${skillPath} is missing and could not be created`, err)
        }
      }
      if (filePresent) {
        await ctx.skill.transform((editor) => {
          try {
            const existing = editor.get("ultracode") as { location?: string } | undefined
            if (existing && existing.location !== skillPath) {
              warn(`skill id "ultracode" is already registered at ${String(existing.location)} — not overriding it`)
              return
            }
            if (existing) {
              // Replay of this transform (late catalog inject / reload): keep ours.
              skillInstalled = true
              return
            }
            editor.add({
              id: "ultracode",
              name: SKILL_NAME,
              description: SKILL_DESCRIPTION,
              location: skillPath,
              content: buildSkillContent(EMPTY_CATALOG),
            } as unknown as Skill.Info)
            skillInstalled = true
          } catch (err) {
            warn("skill editor.add failed", err)
          }
        })
      } else {
        warn("skill not registered — its location file is unavailable")
      }
    } catch (err) {
      warn("skill registration failed — keyword skill attach will not resolve", err)
    }

    // ---- permission stall watchdog (owned children never hang on hidden prompts) ----
    /**
     * Run children never surface a host permission dialog: the user cannot see
     * (or answer) an "ask" a child triggered, so the run would silently block
     * until timeoutMs. When a `permission.asked` event arrives for a session
     * owned by an ACTIVE run we therefore:
     *   - noEditTools: reject immediately (mode contract: children never block)
     *   - other modes: reject after effective.permissionStallMs (0 = never)
     * A rejection is visible in the child transcript (denied tool call) and the
     * agent adapts — instead of the whole run hanging invisibly.
     */
    const stallTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const replyReject = (ctx.permission as { reply?: unknown } | undefined)?.reply as unknown as
      | ((input: { sessionID: string; requestID: string; reply: "reject"; message?: string }) => Promise<void>)
      | undefined
    const rejectPending = async (sessionID: string, requestID: string, why: string) => {
      if (typeof replyReject !== "function") return
      try {
        await replyReject({
          sessionID,
          requestID,
          reply: "reject",
          message: `ultracode auto-reject: ${why}`,
        })
      } catch {
        // already answered or gone — nothing to do
      }
    }
    const handlePermissionAsked = (data: unknown) => {
      try {
        const d = data as { id?: string; sessionID?: string }
        if (typeof d?.id !== "string" || typeof d?.sessionID !== "string") return
        const requestID = d.id
        const sessionID = d.sessionID
        if (!registry.isOwnedActive(sessionID)) return
        const effective = registry.runForActiveSession(sessionID)?.effective
        const action = permissionStallAction(effective?.permissions, effective?.permissionStallMs)
        if (action === "wait") return
        if (action === "reject-now") {
          warn(`auto-rejecting permission request ${requestID} on owned child ${sessionID} (noEditTools)`)
          void rejectPending(sessionID, requestID, "workflow run is in noEditTools mode")
          return
        }
        const delay = effective?.permissionStallMs ?? 0
        if (delay <= 0 || stallTimers.has(requestID)) return
        const timer = setTimeout(() => {
          stallTimers.delete(requestID)
          // Only reject while the run still owns the session.
          if (!registry.isOwnedActive(sessionID)) return
          warn(`permission stall: auto-rejecting request ${requestID} on owned child ${sessionID} after ${delay}ms unanswered`)
          void rejectPending(sessionID, requestID, `permission prompt unanswered for ${delay}ms (permissionStallMs)`)
        }, delay)
        stallTimers.set(requestID, timer)
      } catch {
        // never throw from the event loop
      }
    }
    const handlePermissionReplied = (data: unknown) => {
      try {
        const d = data as { requestID?: string }
        if (typeof d?.requestID !== "string") return
        const timer = stallTimers.get(d.requestID)
        if (timer) {
          clearTimeout(timer)
          stallTimers.delete(d.requestID)
        }
      } catch {
        // never throw from the event loop
      }
    }

    // ---- session.tool.* event stream → AgentRecord.toolCalls (D6/A2) ----
    try {
      const subscribe = (ctx.event as { subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<unknown> })
        .subscribe
      if (typeof subscribe !== "function") {
        warn("event.subscribe unavailable — tool-call counts disabled")
      } else {
        const stream = subscribe({ signal: controller.signal })
        void (async () => {
          let state = emptyToolEventState()
          try {
            for await (const raw of stream) {
              if (controller.signal.aborted) break
              const ev = raw as { type?: string; created?: number; data?: { sessionID?: string; id?: string } }
              if (typeof ev?.type !== "string") continue
              // Child-liveness feed FIRST: any event carrying a child
              // sessionID — including permission.asked, so a child legitimately
              // waiting on a user-visible ask never accrues stall time — bumps
              // its last-activity timestamp (childStallMs watchdog consumes
              // it; non-children are a cheap map miss).
              const sid = (ev.data as { sessionID?: string } | undefined)?.sessionID
              if (typeof sid === "string" && supervisor) {
                try {
                  supervisor.noteChildActivity(sid)
                } catch {
                  // never throw from the event loop
                }
              }
              if (ev.type === "permission.asked") handlePermissionAsked(ev.data)
              else if (ev.type === "permission.replied") handlePermissionReplied(ev.data)
              state = feedToolEvent(
                state,
                { type: ev.type, created: ev.created, data: ev.data },
                registry,
              )
            }
          } catch (err) {
            if (!controller.signal.aborted) warn("event subscription ended", err)
          }
        })()
      }
    } catch (err) {
      warn("event subscribe failed — tool-call counts disabled", err)
    }

    // ---- permission hook (always registered; ask delegates to the host) ----
    /**
     * Symlink-aware containment via the shared lstat resolver: file: URLs
     * parsed with fileURLToPath (no string slicing), components walked with
     * lstat, symlinks realpath'd. Resolution failure (dangling link, fs
     * error, unclassifiable resource) FAILS CLOSED — no auto-allow.
     */
    const resourceInsideProject = async (resource: string): Promise<boolean> => {
      try {
        let path: string | undefined
        if (resource.startsWith("file:")) {
          path = fileURLToPath(new URL(resource))
        } else if (resource.startsWith("/")) {
          path = resource
        } else {
          return false // relative/opaque — unclassifiable => fail closed
        }
        const resolved = await resolveContainedPath(fs, projectRoot, path)
        return resolved.ok
      } catch {
        return false
      }
    }
    try {
      const reg = await ctx.permission.hook("evaluate", async (event) => {
        try {
          const ev = event as unknown as {
            sessionID?: string
            action?: string
            resources?: ReadonlyArray<string>
            effect?: string
            message?: string
          }
          const sessionID = ev.sessionID
          const decision = evaluateOwnedPermission(ev, registry)
          if (decision === "skip" || decision === "delegate" || decision === "ignore") return

          if (decision === "contain") {
            const resources = Array.isArray(ev.resources) ? ev.resources : []
            if (resources.length === 0) return
            const inside = await Promise.all(resources.map((r) => (typeof r === "string" ? resourceInsideProject(r) : Promise.resolve(false))))
            if (!inside.every(Boolean)) return
            // The async fs checks above open a window where the run could
            // have finalized — re-verify active ownership immediately
            // before allowing.
            if (typeof sessionID !== "string" || !registry.isOwnedActive(sessionID)) return
            ev.effect = "allow"
            return
          }
          // noEditTools: workflow children never edit, regardless of path.
          // (evaluateOwnedPermission may already have set a more specific
          // message, e.g. the shell-write one — don't clobber it.)
          ev.effect = "deny"
          if (!ev.message) ev.message = NO_EDIT_TOOLS_MESSAGE
        } catch {
          // never throw from a permission hook
        }
      })
      registrations.push(reg as unknown as RegistrationLike)
    } catch (err) {
      warn("permission hook registration failed — child edits will use normal permission flow", err)
    }

    // ---- cleanup ----
    return () => {
      disposed = true
      skillInstalled = false
      controller.abort()
      for (const timer of stallTimers.values()) clearTimeout(timer)
      stallTimers.clear()
      for (const reg of registrations) {
        try {
          void reg.dispose()
        } catch {
          // best effort
        }
      }
      registry.dispose()
      if (supervisor) void supervisor.dispose()
    }
  },
})
