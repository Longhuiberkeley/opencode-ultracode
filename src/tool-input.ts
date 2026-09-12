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
import type { GraphRunInput, InlineRunInput, Json, SavedRunInput, WorkflowMeta, WorkflowToolInput } from "./types.ts"

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

export function validateToolInput(raw: unknown): ToolInputResult {
  if (!isObj(raw)) {
    return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  }

  const hasScript = has(raw, "script")
  const hasWorkflow = has(raw, "workflow")

  if (hasScript && hasWorkflow) {
    return { ok: false, error: `input cannot specify both "script" and "workflow" — choose one` }
  }

  const hasGraph = has(raw, "graph")
  if ((hasScript || hasWorkflow) && hasGraph) {
    return { ok: false, error: `input cannot combine "graph" with "script"/"workflow" — choose one` }
  }

  if (hasGraph) {
    // ---- graph-spec shape (deep validation happens in validateGraphSpec) ----
    const extra = rejectExtras(raw, new Set(["graph", "name", "args", "background", "resumeFrom"]))
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

    const input: GraphRunInput = { graph: graph as Record<string, unknown> }
    if (name !== undefined) input.name = name as string
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    return { ok: true, input }
  }

  if (hasWorkflow) {
    // ---- saved-workflow shape ----
    const extra = rejectExtras(raw, new Set(["workflow", "args", "background", "resumeFrom"]))
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

    const input: SavedRunInput = { workflow }
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    return { ok: true, input }
  }

  if (hasScript) {
    // ---- inline-script shape ----
    const extra = rejectExtras(raw, new Set(["script", "name", "meta", "args", "background", "resumeFrom"]))
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
        error: `"script" is too large: ${scriptBytes} bytes (max ${MAX_SCRIPT_BYTES}). Move long workflows into a saved workflow file`,
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

    const input: InlineRunInput = { script }
    if (name !== undefined) input.name = name as string
    if (meta !== undefined) input.meta = meta
    if (raw["args"] !== undefined) input.args = args.args
    if (background.background !== undefined) input.background = background.background
    if (resume.resumeFrom !== undefined) input.resumeFrom = resume.resumeFrom
    return { ok: true, input }
  }

  return {
    ok: false,
    error: `input must specify either "script" (inline workflow source) or "workflow" (saved workflow name)`,
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

/** Input for the orchestrator `ultracode_control` tool. */
export function validateControlToolInput(
  raw: unknown,
): { ok: true; action: ControlAction; runID?: string } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  const extra = rejectExtras(raw, new Set(["action", "runID"]))
  if (extra) return { ok: false, error: extra }
  const action = raw["action"]
  if (typeof action !== "string" || !CONTROL_ACTIONS.includes(action as ControlAction)) {
    return {
      ok: false,
      error: `"action" must be one of ${CONTROL_ACTIONS.join(" | ")}, got ${typeof action === "string" ? `"${action}"` : typeOf(action)}`,
    }
  }
  if (!has(raw, "runID")) return { ok: true, action: action as ControlAction }
  const runID = raw["runID"]
  if (typeof runID !== "string" || runID.trim() === "") {
    return {
      ok: false,
      error: `"runID" must be a non-empty string, got ${typeOf(runID) === "string" ? "empty string" : typeOf(runID)}`,
    }
  }
  return { ok: true, action: action as ControlAction, runID }
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

/** Max length of a catalog lookup name (workflow / template). */
export const MAX_CATALOG_NAME_CHARS = 64

export type CatalogToolInput = {
  ok: true
  workflow?: string
  template?: string
  templates?: boolean
}

/**
 * Input for the read-only `ultracode_catalog` tool. Three mutually exclusive
 * views: the whole catalog (no args), one saved workflow (`workflow`), or graph
 * template specs (`template` / `templates`) — one view per call keeps the
 * payload bounded and the intent unambiguous.
 */
export function validateCatalogToolInput(raw: unknown): CatalogToolInput | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true }
  if (!isObj(raw)) return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  const extra = rejectExtras(raw, new Set(["workflow", "template", "templates"]))
  if (extra) return { ok: false, error: extra }

  const names: string[] = []
  for (const key of ["workflow", "template"] as const) {
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
  if (names.length > 1) {
    return {
      ok: false,
      error: `choose ONE view per call: { workflow }, { template }, { templates } or no input for the whole catalog (got ${names.join(" + ")})`,
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

  const out: CatalogToolInput = { ok: true }
  if (has(raw, "workflow")) out.workflow = (raw["workflow"] as string).trim()
  if (has(raw, "template")) out.template = (raw["template"] as string).trim()
  if (templates !== undefined) out.templates = templates
  return out
}
