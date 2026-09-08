/**
 * Workflow tool input validation (Builder A).
 *
 * Union input:
 *   inline: { script, name?, meta?, args? }
 *   saved:  { workflow, args?, confirm? }
 *
 * Discriminated on the presence of "workflow" vs "script". Rejects unknown
 * keys, wrong types and oversized inputs with precise messages.
 */
import type { InlineRunInput, Json, SavedRunInput, WorkflowMeta, WorkflowToolInput } from "./types.ts"

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

export function validateToolInput(raw: unknown): ToolInputResult {
  if (!isObj(raw)) {
    return { ok: false, error: `input must be an object, got ${typeOf(raw)}` }
  }

  const hasScript = has(raw, "script")
  const hasWorkflow = has(raw, "workflow")

  if (hasScript && hasWorkflow) {
    return { ok: false, error: `input cannot specify both "script" and "workflow" — choose one` }
  }

  if (hasWorkflow) {
    // ---- saved-workflow shape ----
    const extra = rejectExtras(raw, new Set(["workflow", "args", "confirm"]))
    if (extra) return { ok: false, error: extra }

    const workflow = raw["workflow"]
    if (typeof workflow !== "string" || workflow.trim() === "") {
      return { ok: false, error: `"workflow" must be a non-empty string, got ${typeOf(workflow) === "string" ? "empty string" : typeOf(workflow)}` }
    }

    const confirm = raw["confirm"]
    if (confirm !== undefined && typeof confirm !== "boolean") {
      return { ok: false, error: `"confirm" must be a boolean, got ${typeOf(confirm)}` }
    }

    const args = validateArgs(raw["args"])
    if (!args.ok) return { ok: false, error: args.error }
    if (args.serializedBytes > MAX_ARGS_BYTES) {
      return {
        ok: false,
        error: `"args" is too large: ${args.serializedBytes} bytes serialized (max ${MAX_ARGS_BYTES}). Pass large data via a saved workflow or trim the payload`,
      }
    }

    const input: SavedRunInput = { workflow }
    if (raw["args"] !== undefined) input.args = args.args
    if (confirm !== undefined) input.confirm = confirm
    return { ok: true, input }
  }

  if (hasScript) {
    // ---- inline-script shape ----
    const extra = rejectExtras(raw, new Set(["script", "name", "meta", "args"]))
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

    const input: InlineRunInput = { script }
    if (name !== undefined) input.name = name as string
    if (meta !== undefined) input.meta = meta
    if (raw["args"] !== undefined) input.args = args.args
    return { ok: true, input }
  }

  return {
    ok: false,
    error: `input must specify either "script" (inline workflow source) or "workflow" (saved workflow name)`,
  }
}
