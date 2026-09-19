/**
 * Workflow tool input validation (Builder A).
 *
 * Union input:
 *   inline: { script, name?, meta?, args?, background? }
 *   saved:  { workflow, args?, background? }
 *
 * Discriminated on the presence of "workflow" vs "script". Rejects unknown
 * keys, wrong types and oversized inputs with precise messages.
 */
import { CONTROL_ACTIONS, type ControlAction } from "./control.ts"
import { parseModelPin } from "./agent-pins.ts"
import { SCRIPT_TEMPLATES } from "./script-templates.ts"
import type {
  GraphRunInput,
  InlineRunInput,
  Json,
  PathRunInput,
  SavedRunInput,
  TemplateRunInput,
  WorkflowMeta,
  WorkflowToolInput,
} from "./types.ts"
import {
  MAX_LOOP_DEPTH,
  MAX_LOOP_ITERATIONS,
  MAX_RUN_TIMEOUT_MS,
  MIN_LOOP_DEPTH,
  MIN_LOOP_ITERATIONS,
  MIN_RUN_TIMEOUT_MS,
} from "./types.ts"

export type ToolInputResult =
  | { ok: true; input: WorkflowToolInput }
  | { ok: false; error: string }

/** Max inline script size (UTF-8 bytes). */
export const MAX_SCRIPT_BYTES = 512 * 1024
/** Max serialized `args` JSON size (UTF-8 bytes). */
export const MAX_ARGS_BYTES = 64 * 1024

const encoder = new TextEncoder()

function byteLength(s: string): number {
  return encoder.encode(s).length
}

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key)
}

function rejectExtras(raw: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      return `unexpected key "${key}" (allowed: ${[...allowed].sort().join(", ")})`
    }
  }
  return undefined
}

/** Validate `meta` (WorkflowMeta); returns an error string or the parsed meta. */
function validateMeta(rawMeta: unknown): { ok: true; meta: WorkflowMeta } | { ok: false; error: string } {
  if (!isObj(rawMeta)) return { ok: false, error: `"meta" must be an object, got ${typeOf(rawMeta)}` }
  const extra = rejectExtras(rawMeta, new Set(["name", "description", "phases", "requires"]))
  if (extra) return { ok: false, error: `meta: ${extra}` }
  const meta: WorkflowMeta = {}
  for (const key of ["name", "description"] as const) {
    const value = rawMeta[key]
    if (value === undefined) continue
    if (typeof value !== "string") {
      return { ok: false, error: `meta.${key} must be a string, got ${typeOf(value)}` }
    }
    meta[key] = value
  }
  for (const key of ["phases", "requires"] as const) {
    const value = rawMeta[key]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      return { ok: false, error: `meta.${key} must be an array of strings, got ${typeOf(value)}` }
    }
    meta[key] = value as string[]
  }
  return { ok: true, meta }
}

/**
 * Validate `args`: any JSON value whose serialization fits MAX_ARGS_BYTES.
 * Returns the serialized size (for the caller's cap check) or an error.
 */
function validateArgs(
  rawArgs: unknown,
): { ok: true; args: Json | undefined; serializedBytes: number } | { ok: false; error: string } {
  if (rawArgs === undefined) return { ok: true, args: undefined, serializedBytes: 0 }
  const serialized = JSON.stringify(rawArgs)
  if (serialized === undefined) {
    return { ok: false, error: `"args" must be a JSON value (functions/symbols/undefined are not allowed)` }
  }
  return { ok: true, args: JSON.parse(serialized) as Json, serializedBytes: byteLength(serialized) }
}

function validateBackground(
  raw: Record<string, unknown>,
): { ok: true; background?: boolean } | { ok: false; error: string } {
  if (!has(raw, "background")) return { ok: true }
  const value = raw["background"]
  if (typeof value !== "boolean") {
    return { ok: false, error: `"background" must be a boolean, got ${typeOf(value)}` }
  }
  return { ok: true, background: value }
}

/**
 * Runs are background by default (since 0.4.0): only an explicit `false`
 * blocks the tool call until the envelope. Single testable flip point.
 */
export function resolveBackground(input: { background?: boolean }): boolean {
  return input.background !== false
}

/** runIDs look like "run_" + 12 base32 chars — loose shape check for resumeFrom. */
const RUN_ID_RE = /^run_[a-z0-9]{4,32}$/i

function validateResumeFrom(
  raw: Record<string, unknown>,
): { ok: true; resumeFrom?: string } | { ok: false; error: string } {
  if (!has(raw, "resumeFrom")) return { ok: true }
  const value = raw["resumeFrom"]
  if (typeof value !== "string" || !RUN_ID_RE.test(value.trim())) {
    return {
      ok: false,
      error: `"resumeFrom" must be a run id like "run_ab12cd34ef56", got ${typeof value === "string" ? JSON.stringify(value) : typeOf(value)}`,
    }
  }
  return { ok: true, resumeFrom: value.trim() }
}

/**
 * Per-run wall-clock override. Same bounds as `/ultracode set timeoutMs`, but
 * applies to this run only — the settings overlay is never touched.
 */
function validateTimeoutMs(
  raw: Record<string, unknown>,
): { ok: true; timeoutMs?: number } | { ok: false; error: string } {
  if (!has(raw, "timeoutMs")) return { ok: true }
  const value = raw["timeoutMs"]
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: `"timeoutMs" must be an integer of milliseconds, got ${typeOf(value) === "number" ? value : typeOf(value)}` }
  }
  if (value < MIN_RUN_TIMEOUT_MS || value > MAX_RUN_TIMEOUT_MS) {
    return {
      ok: false,
      error: `"timeoutMs" must be between ${MIN_RUN_TIMEOUT_MS} and ${MAX_RUN_TIMEOUT_MS} ms (same bounds as /ultracode set timeoutMs), got ${value}`,
    }
  }
  return { ok: true, timeoutMs: value }
}

/**
 * Per-run `loop()` nesting-depth override. Same 1..16 bounds as the
 * maxLoopDepth plugin option (the runaway guard), but applies to this run
 * only — the settings overlay is never touched.
 */
function validateMaxLoopDepth(
  raw: Record<string, unknown>,
): { ok: true; maxLoopDepth?: number } | { ok: false; error: string } {
  if (!has(raw, "maxLoopDepth")) return { ok: true }
  const value = raw["maxLoopDepth"]
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: `"maxLoopDepth" must be an integer, got ${typeof value === "number" ? value : typeOf(value)}` }
  }
  if (value < MIN_LOOP_DEPTH || value > MAX_LOOP_DEPTH) {
    return {
      ok: false,
      error: `"maxLoopDepth" must be between ${MIN_LOOP_DEPTH} and ${MAX_LOOP_DEPTH} (same bounds as the maxLoopDepth plugin option), got ${value}`,
    }
  }
  return { ok: true, maxLoopDepth: value }
}

/**
 * Per-run per-loop iteration ceiling. Same 1..200 bounds as the engine's spec
 * clamp; TIGHTEN-ONLY — the worker applies min(budget.iterations, this), so
 * the input can cap a loop-shaped template at N passes but never raise an
 * authored budget.
 */
function validateMaxLoopIterations(
  raw: Record<string, unknown>,
): { ok: true; maxLoopIterations?: number } | { ok: false; error: string } {
  if (!has(raw, "maxLoopIterations")) return { ok: true }
  const value = raw["maxLoopIterations"]
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, error: `"maxLoopIterations" must be an integer, got ${typeof value === "number" ? value : typeOf(value)}` }
  }
  if (value < MIN_LOOP_ITERATIONS || value > MAX_LOOP_ITERATIONS) {
    return {
      ok: false,
      error: `"maxLoopIterations" must be between ${MIN_LOOP_ITERATIONS} and ${MAX_LOOP_ITERATIONS} (tighten-only: it caps each loop's authored budget, never raises it), got ${value}`,
    }
  }
  return { ok: true, maxLoopIterations: value }
}

/**
 * Explicit run-level model override (all run variants): "provider/id" or
 * "provider/id#variant" — the same shape agent-config pins use.
 */
function validateModelOverride(
  raw: Record<string, unknown>,
): { ok: true; model?: string; allowDisabledProviders?: boolean } | { ok: false; error: string } {
  if (has(raw, "model")) {
    const value = raw["model"]
    if (typeof value !== "string" || parseModelPin(value) === undefined) {
      return {
        ok: false,
        error: `"model" must be a "provider/id" or "provider/id#variant" string, got ${typeof value === "string" ? JSON.stringify(value) : typeOf(value)}`,
      }
    }
  }
  if (has(raw, "allowDisabledProviders")) {
    const value = raw["allowDisabledProviders"]
    if (typeof value !== "boolean") {
      return { ok: false, error: `"allowDisabledProviders" must be a boolean, got ${typeOf(value)}` }
    }
  }
  return {
    ok: true,
    ...(typeof raw["model"] === "string" ? { model: raw["model"].trim() } : {}),
    ...(typeof raw["allowDisabledProviders"] === "boolean" ? { allowDisabledProviders: raw["allowDisabledProviders"] } : {}),
  }
}

/** Common per-run option keys every variant accepts (beyond its source key). */
const RUN_OPTION_KEYS = [
  "args",
  "background",
  "resumeFrom",
  "timeoutMs",
  "maxLoopDepth",
  "maxLoopIterations",
  "model",
  "allowDisabledProviders",
] as const

export function validateToolInput(raw: unknown): ToolInputResult {
  if (!isObj(raw)) {
    return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  }

  const hasScript = has(raw, "script")
  const hasWorkflow = has(raw, "workflow")
  const hasPath = has(raw, "path")
  const hasTemplate = has(raw, "template")

  if (hasScript && hasWorkflow) {
    return { ok: false, error: `input cannot specify both "script" and "workflow" — choose one` }
  }

  const hasGraph = has(raw, "graph")
  if ((hasScript || hasWorkflow) && hasGraph) {
    return { ok: false, error: `input cannot combine "graph" with "script"/"workflow" — choose one` }
  }
  const sourceKeys = [hasScript && "script", hasWorkflow && "workflow", hasGraph && "graph", hasPath && "path", hasTemplate && "template"].filter(
    (k): k is string => typeof k === "string",
  )
  if (sourceKeys.length > 1) {
    return {
      ok: false,
      error: `input cannot combine ${sourceKeys.map((k) => `"${k}"`).join(" and ")} — choose one`,
    }
  }

  if (hasGraph) {
    // ---- graph-spec shape (deep validation happens in validateGraphSpec) ----
    const extra = rejectExtras(raw, new Set(["graph", "name", ...RUN_OPTION_KEYS]))
    if (extra) return { ok: false, error: extra }

    const graph = raw["graph"]
    if (typeof graph !== "object" || graph === null || Array.isArray(graph)) {
      return { ok: false, error: `"graph" must be an object (the DAG spec: { nodes: [...] }), got ${typeOf(graph)}` }
    }
    if (!Array.isArray((graph as { nodes?: unknown }).nodes)) {
      return { ok: false, error: `"graph".nodes must be an array of node objects` }
    }

    const name = raw["name"]
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      return { ok: false, error: `"name" must be a non-empty string, got ${typeof name === "string" ? "empty string" : typeOf(name)}` }
    }

    const args = validateArgs(raw["args"])
    if (!args.ok) return { ok: false, error: args.error }
    if (args.serializedBytes > MAX_ARGS_BYTES) {
      return {
        ok: false,
        error: `"args" is too large: ${args.serializedBytes} bytes serialized (max ${MAX_ARGS_BYTES}). Pass large data via a saved workflow or trim the payload`,
      }
    }

    const background = validateBackground(raw)
    if (!background.ok) return { ok: false, error: background.error }
    const resume = validateResumeFrom(raw)
    if (!resume.ok) return { ok: false, error: resume.error }
    const timeout = validateTimeoutMs(raw)
    if (!timeout.ok) return { ok: false, error: timeout.error }
    const loopDepth = validateMaxLoopDepth(raw)
    if (!loopDepth.ok) return { ok: false, error: loopDepth.error }
    const loopIters = validateMaxLoopIterations(raw)
    if (!loopIters.ok) return { ok: false, error: loopIters.error }
    const override = validateModelOverride(raw)
    if (!override.ok) return { ok: false, error: override.error }

    const input: GraphRunInput = { graph: graph as Record<string, unknown> }
    if (name !== undefined) input.name = name as string
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    if (timeout.timeoutMs !== undefined) input.timeoutMs = timeout.timeoutMs
    if (loopDepth.maxLoopDepth !== undefined) input.maxLoopDepth = loopDepth.maxLoopDepth
    if (loopIters.maxLoopIterations !== undefined) input.maxLoopIterations = loopIters.maxLoopIterations
    if (override.model !== undefined) input.model = override.model
    if (override.allowDisabledProviders !== undefined) input.allowDisabledProviders = override.allowDisabledProviders
    return { ok: true, input }
  }

  if (hasWorkflow) {
    // ---- saved-workflow shape ----
    const extra = rejectExtras(raw, new Set(["workflow", ...RUN_OPTION_KEYS]))
    if (extra) return { ok: false, error: extra }

    const workflow = raw["workflow"]
    if (typeof workflow !== "string" || workflow.trim() === "") {
      return { ok: false, error: `"workflow" must be a non-empty string, got ${typeOf(workflow) === "string" ? "empty string" : typeOf(workflow)}` }
    }

    const args = validateArgs(raw["args"])
    if (!args.ok) return { ok: false, error: args.error }
    if (args.serializedBytes > MAX_ARGS_BYTES) {
      return {
        ok: false,
        error: `"args" is too large: ${args.serializedBytes} bytes serialized (max ${MAX_ARGS_BYTES}). Pass large data via a saved workflow or trim the payload`,
      }
    }

    const background = validateBackground(raw)
    if (!background.ok) return { ok: false, error: background.error }
    const resume = validateResumeFrom(raw)
    if (!resume.ok) return { ok: false, error: resume.error }
    const timeout = validateTimeoutMs(raw)
    if (!timeout.ok) return { ok: false, error: timeout.error }
    const loopDepth = validateMaxLoopDepth(raw)
    if (!loopDepth.ok) return { ok: false, error: loopDepth.error }
    const loopIters = validateMaxLoopIterations(raw)
    if (!loopIters.ok) return { ok: false, error: loopIters.error }
    const override = validateModelOverride(raw)
    if (!override.ok) return { ok: false, error: override.error }

    const input: SavedRunInput = { workflow }
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    if (timeout.timeoutMs !== undefined) input.timeoutMs = timeout.timeoutMs
    if (loopDepth.maxLoopDepth !== undefined) input.maxLoopDepth = loopDepth.maxLoopDepth
    if (loopIters.maxLoopIterations !== undefined) input.maxLoopIterations = loopIters.maxLoopIterations
    if (override.model !== undefined) input.model = override.model
    if (override.allowDisabledProviders !== undefined) input.allowDisabledProviders = override.allowDisabledProviders
    return { ok: true, input }
  }

  if (hasPath) {
    // ---- project-file shape: author with the file tool, run by path ----
    const extra = rejectExtras(raw, new Set(["path", ...RUN_OPTION_KEYS]))
    if (extra) return { ok: false, error: extra }

    const path = raw["path"]
    if (typeof path !== "string" || path.trim() === "") {
      return { ok: false, error: `"path" must be a non-empty string, got ${typeOf(path) === "string" ? "empty string" : typeOf(path)}` }
    }
    if (path.startsWith("/") || path.startsWith("~")) {
      return { ok: false, error: `"path" must be relative to the project root, got an absolute/home path: ${JSON.stringify(path)}` }
    }
    if (path.includes("\\")) {
      return { ok: false, error: `"path" must use / separators (POSIX-style), got backslashes: ${JSON.stringify(path)}` }
    }
    const segments = path.split("/")
    if (segments.some((s) => s === "..")) {
      return { ok: false, error: `"path" must stay inside the project root (".." segments rejected): ${JSON.stringify(path)}` }
    }
    if (!/\.(js|mjs|cjs|ts|mts|cts)$/i.test(segments[segments.length - 1] ?? "")) {
      return { ok: false, error: `"path" must point at a JavaScript/TypeScript workflow file (.js/.mjs/.cjs/.ts), got ${JSON.stringify(path)}` }
    }

    const args = validateArgs(raw["args"])
    if (!args.ok) return { ok: false, error: args.error }
    if (args.serializedBytes > MAX_ARGS_BYTES) {
      return {
        ok: false,
        error: `"args" is too large: ${args.serializedBytes} bytes serialized (max ${MAX_ARGS_BYTES}). Pass large data via a saved workflow or trim the payload`,
      }
    }
    const background = validateBackground(raw)
    if (!background.ok) return { ok: false, error: background.error }
    const resume = validateResumeFrom(raw)
    if (!resume.ok) return { ok: false, error: resume.error }
    const timeout = validateTimeoutMs(raw)
    if (!timeout.ok) return { ok: false, error: timeout.error }
    const loopDepth = validateMaxLoopDepth(raw)
    if (!loopDepth.ok) return { ok: false, error: loopDepth.error }
    const loopIters = validateMaxLoopIterations(raw)
    if (!loopIters.ok) return { ok: false, error: loopIters.error }
    const override = validateModelOverride(raw)
    if (!override.ok) return { ok: false, error: override.error }

    const input: PathRunInput = { path }
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    if (timeout.timeoutMs !== undefined) input.timeoutMs = timeout.timeoutMs
    if (loopDepth.maxLoopDepth !== undefined) input.maxLoopDepth = loopDepth.maxLoopDepth
    if (loopIters.maxLoopIterations !== undefined) input.maxLoopIterations = loopIters.maxLoopIterations
    if (override.model !== undefined) input.model = override.model
    if (override.allowDisabledProviders !== undefined) input.allowDisabledProviders = override.allowDisabledProviders
    return { ok: true, input }
  }

  if (hasTemplate) {
    // ---- served script-template shape (args feed declared params) ----
    const extra = rejectExtras(raw, new Set(["template", ...RUN_OPTION_KEYS]))
    if (extra) return { ok: false, error: extra }

    const template = raw["template"]
    if (typeof template !== "string" || template.trim() === "") {
      return { ok: false, error: `"template" must be a non-empty string, got ${typeOf(template) === "string" ? "empty string" : typeOf(template)}` }
    }
    const known = SCRIPT_TEMPLATES.some((t) => t.name === template)
    if (!known) {
      return {
        ok: false,
        error: `unknown script template ${JSON.stringify(template)} — known: ${SCRIPT_TEMPLATES.map((t) => t.name).join(", ")}`,
      }
    }

    const args = validateArgs(raw["args"])
    if (!args.ok) return { ok: false, error: args.error }
    if (args.serializedBytes > MAX_ARGS_BYTES) {
      return {
        ok: false,
        error: `"args" is too large: ${args.serializedBytes} bytes serialized (max ${MAX_ARGS_BYTES}). Pass large data via a saved workflow or trim the payload`,
      }
    }
    const background = validateBackground(raw)
    if (!background.ok) return { ok: false, error: background.error }
    const resume = validateResumeFrom(raw)
    if (!resume.ok) return { ok: false, error: resume.error }
    const timeout = validateTimeoutMs(raw)
    if (!timeout.ok) return { ok: false, error: timeout.error }
    const loopDepth = validateMaxLoopDepth(raw)
    if (!loopDepth.ok) return { ok: false, error: loopDepth.error }
    const loopIters = validateMaxLoopIterations(raw)
    if (!loopIters.ok) return { ok: false, error: loopIters.error }
    const override = validateModelOverride(raw)
    if (!override.ok) return { ok: false, error: override.error }

    const input: TemplateRunInput = { template }
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    if (timeout.timeoutMs !== undefined) input.timeoutMs = timeout.timeoutMs
    if (loopDepth.maxLoopDepth !== undefined) input.maxLoopDepth = loopDepth.maxLoopDepth
    if (loopIters.maxLoopIterations !== undefined) input.maxLoopIterations = loopIters.maxLoopIterations
    if (override.model !== undefined) input.model = override.model
    if (override.allowDisabledProviders !== undefined) input.allowDisabledProviders = override.allowDisabledProviders
    return { ok: true, input }
  }

  if (hasScript) {
    // ---- inline-script shape ----
    const extra = rejectExtras(raw, new Set(["script", "name", "meta", ...RUN_OPTION_KEYS]))
    if (extra) return { ok: false, error: extra }

    const script = raw["script"]
    if (typeof script !== "string") {
      return { ok: false, error: `"script" must be a string, got ${typeOf(script)}` }
    }
    if (script.trim() === "") {
      return { ok: false, error: `"script" must not be empty` }
    }
    const scriptBytes = byteLength(script)
    if (scriptBytes > MAX_SCRIPT_BYTES) {
      return {
        ok: false,
        error: `"script" is too large: ${scriptBytes} bytes (max ${MAX_SCRIPT_BYTES}). Author it as .opencode/workflows/<name>.js and run { path } instead`,
      }
    }

    const name = raw["name"]
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
      return { ok: false, error: `"name" must be a non-empty string, got ${typeOf(name) === "string" ? "empty string" : typeOf(name)}` }
    }

    let meta: WorkflowMeta | undefined
    if (raw["meta"] !== undefined) {
      const parsed = validateMeta(raw["meta"])
      if (!parsed.ok) return { ok: false, error: parsed.error }
      meta = parsed.meta
    }

    const args = validateArgs(raw["args"])
    if (!args.ok) return { ok: false, error: args.error }
    if (args.serializedBytes > MAX_ARGS_BYTES) {
      return {
        ok: false,
        error: `"args" is too large: ${args.serializedBytes} bytes serialized (max ${MAX_ARGS_BYTES}). Pass large data via a saved workflow or trim the payload`,
      }
    }

    const background = validateBackground(raw)
    if (!background.ok) return { ok: false, error: background.error }
    const resume = validateResumeFrom(raw)
    if (!resume.ok) return { ok: false, error: resume.error }
    const timeout = validateTimeoutMs(raw)
    if (!timeout.ok) return { ok: false, error: timeout.error }
    const loopDepth = validateMaxLoopDepth(raw)
    if (!loopDepth.ok) return { ok: false, error: loopDepth.error }
    const loopIters = validateMaxLoopIterations(raw)
    if (!loopIters.ok) return { ok: false, error: loopIters.error }
    const override = validateModelOverride(raw)
    if (!override.ok) return { ok: false, error: override.error }

    const input: InlineRunInput = { script }
    if (name !== undefined) input.name = name as string
    if (meta !== undefined) input.meta = meta
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    if (timeout.timeoutMs !== undefined) input.timeoutMs = timeout.timeoutMs
    if (loopDepth.maxLoopDepth !== undefined) input.maxLoopDepth = loopDepth.maxLoopDepth
    if (loopIters.maxLoopIterations !== undefined) input.maxLoopIterations = loopIters.maxLoopIterations
    if (override.model !== undefined) input.model = override.model
    if (override.allowDisabledProviders !== undefined) input.allowDisabledProviders = override.allowDisabledProviders
    return { ok: true, input }
  }

  return {
    ok: false,
    error: `input must specify one of "script" (inline source), "workflow" (saved name), "path" (project file), "template" (served script template) or "graph" (DAG spec)`,
  }
}

/** Input for the read-only `ultracode_status` tool. */
export function validateStatusToolInput(
  raw: unknown,
): { ok: true; runID?: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (!isObj(raw)) return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  const extra = rejectExtras(raw, new Set(["runID"]))
  if (extra) return { ok: false, error: extra }
  if (!has(raw, "runID")) return { ok: true }
  const runID = raw["runID"]
  if (typeof runID !== "string" || runID.trim() === "") {
    return {
      ok: false,
      error: `"runID" must be a non-empty string, got ${typeOf(runID) === "string" ? "empty string" : typeOf(runID)}`,
    }
  }
  return { ok: true, runID }
}

/**
 * Input for the orchestrator `ultracode_control` tool. Resume accepts an
 * optional ask-mode answer: `model` (a "provider/id" or "provider/id#variant"
 * pin applied as the run-level fallback override) and `remember` (persist the
 * model→modelFallbacks entry through the settings path). Both are resume-only:
 * a model on stop/pause is a caller mistake, not a silent no-op.
 */
export function validateControlToolInput(
  raw: unknown,
): { ok: true; action: ControlAction; runID?: string; model?: string; remember?: boolean } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  const extra = rejectExtras(raw, new Set(["action", "runID", "model", "remember"]))
  if (extra) return { ok: false, error: extra }
  const action = raw["action"]
  if (typeof action !== "string" || !CONTROL_ACTIONS.includes(action as ControlAction)) {
    return {
      ok: false,
      error: `"action" must be one of ${CONTROL_ACTIONS.join(" | ")}, got ${typeof action === "string" ? `"${action}"` : typeOf(action)}`,
    }
  }
  let runID: string | undefined
  if (has(raw, "runID")) {
    const value = raw["runID"]
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        error: `"runID" must be a non-empty string, got ${typeOf(value) === "string" ? "empty string" : typeOf(value)}`,
      }
    }
    runID = value
  }
  let model: string | undefined
  if (has(raw, "model")) {
    const value = raw["model"]
    if (typeof value !== "string" || parseModelPin(value) === undefined) {
      return {
        ok: false,
        error: `"model" must be a "provider/id" or "provider/id#variant" string, got ${typeof value === "string" ? JSON.stringify(value) : typeOf(value)}`,
      }
    }
    if (action !== "resume") {
      return { ok: false, error: `"model" is only valid with action "resume" (got "${action}")` }
    }
    model = value.trim()
  }
  let remember: boolean | undefined
  if (has(raw, "remember")) {
    const value = raw["remember"]
    if (typeof value !== "boolean") {
      return { ok: false, error: `"remember" must be a boolean, got ${typeOf(value)}` }
    }
    if (action !== "resume" || model === undefined) {
      return { ok: false, error: `"remember" requires action "resume" with a "model" pin (got "${action}"${model === undefined ? ", no model" : ""})` }
    }
    remember = value
  }
  return {
    ok: true,
    action: action as ControlAction,
    ...(runID !== undefined ? { runID } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(remember !== undefined ? { remember } : {}),
  }
}

/** Input for the read-only `ultracode_result` tool (full-result paging). */
export function validateResultToolInput(
  raw: unknown,
): { ok: true; runID: string; offset?: number; maxLength?: number } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  const extra = rejectExtras(raw, new Set(["runID", "offset", "maxLength"]))
  if (extra) return { ok: false, error: extra }
  const runID = raw["runID"]
  if (typeof runID !== "string" || runID.trim() === "") {
    return {
      ok: false,
      error: `"runID" must be a non-empty string, got ${typeOf(runID) === "string" ? "empty string" : typeOf(runID)}`,
    }
  }
  let offset: number | undefined
  if (has(raw, "offset")) {
    const v = raw["offset"]
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return { ok: false, error: `"offset" must be a non-negative integer, got ${typeOf(v) === "number" ? v : typeOf(v)}` }
    }
    offset = v
  }
  let maxLength: number | undefined
  if (has(raw, "maxLength")) {
    const v = raw["maxLength"]
    if (typeof v !== "number" || !Number.isInteger(v) || v < 2) {
      return { ok: false, error: `"maxLength" must be an integer of at least 2 (one UTF-16 unit can be half a surrogate pair), got ${typeOf(v) === "number" ? v : typeOf(v)}` }
    }
    maxLength = v
  }
  const out: { ok: true; runID: string; offset?: number; maxLength?: number } = { ok: true, runID }
  if (offset !== undefined) out.offset = offset
  if (maxLength !== undefined) out.maxLength = maxLength
  return out
}

/** Max length of a catalog lookup name (workflow / template / script template). */
export const MAX_CATALOG_NAME_CHARS = 64

export type CatalogToolInput = {
  ok: true
  workflow?: string
  template?: string
  templates?: boolean
  scriptTemplate?: string
  scriptTemplates?: boolean
}

/**
 * Input for the read-only `ultracode_catalog` tool. Mutually exclusive
 * views: the whole catalog (no args), one saved workflow (`workflow`), graph
 * template specs (`template` / `templates`), or script template bodies
 * (`scriptTemplate` / `scriptTemplates`) — one view per call keeps the
 * payload bounded and the intent unambiguous.
 */
export function validateCatalogToolInput(raw: unknown): CatalogToolInput | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (!isObj(raw)) return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  const extra = rejectExtras(raw, new Set(["workflow", "template", "templates", "scriptTemplate", "scriptTemplates"]))
  if (extra) return { ok: false, error: extra }

  const names: string[] = []
  for (const key of ["workflow", "template", "scriptTemplate"] as const) {
    if (!has(raw, key)) continue
    const value = raw[key]
    if (typeof value !== "string" || value.trim() === "") {
      return {
        ok: false,
        error: `"${key}" must be a non-empty name, got ${typeof value === "string" ? "empty string" : typeOf(value)}`,
      }
    }
    if (value.trim().length > MAX_CATALOG_NAME_CHARS) {
      return { ok: false, error: `"${key}" is too long (${value.trim().length} chars, max ${MAX_CATALOG_NAME_CHARS})` }
    }
    names.push(key)
  }
  const wantsAllTemplates = has(raw, "templates")
  if (wantsAllTemplates) names.push("templates")
  const wantsAllScriptTemplates = has(raw, "scriptTemplates")
  if (wantsAllScriptTemplates) names.push("scriptTemplates")
  if (names.length > 1) {
    return {
      ok: false,
      error: `choose ONE view per call: { workflow }, { template }, { templates }, { scriptTemplate }, { scriptTemplates } or no input for the whole catalog (got ${names.join(" + ")})`,
    }
  }

  let templates: boolean | undefined
  if (wantsAllTemplates) {
    const value = raw["templates"]
    if (typeof value !== "boolean") {
      return { ok: false, error: `"templates" must be a boolean, got ${typeOf(value)}` }
    }
    templates = value
  }
  let scriptTemplates: boolean | undefined
  if (wantsAllScriptTemplates) {
    const value = raw["scriptTemplates"]
    if (typeof value !== "boolean") {
      return { ok: false, error: `"scriptTemplates" must be a boolean, got ${typeOf(value)}` }
    }
    scriptTemplates = value
  }

  const out: CatalogToolInput = { ok: true }
  if (has(raw, "workflow")) out.workflow = (raw["workflow"] as string).trim()
  if (has(raw, "template")) out.template = (raw["template"] as string).trim()
  if (has(raw, "scriptTemplate")) out.scriptTemplate = (raw["scriptTemplate"] as string).trim()
  if (templates !== undefined) out.templates = templates
  if (scriptTemplates !== undefined) out.scriptTemplates = scriptTemplates
  return out
}
