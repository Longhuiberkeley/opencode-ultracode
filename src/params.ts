/**
 * Workflow `args` discovery (workstream C).
 *
 * Why this exists: nothing in a saved workflow says what `args` it takes, so a
 * caller had to read the script to find out — a context cost, and for a graph
 * workflow the compiled script is generated noise. Params are therefore DERIVED
 * from the artifact at save time and stored on the manifest, where
 * `ultracode_catalog` can serve them without reading any code.
 *
 * Sources, in decreasing authority:
 *  1. an explicit `params` on the manifest (hand-authored pairs),
 *  2. the actual `args` of the run being saved (real keys, real JSON types),
 *  3. the artifact itself: a `// Tool input:` header (declares optional markers
 *     and example types) or, failing that, every `args.x` reference in the code
 *     — including the `const input = args && …` alias idiom the samples use —
 *     or, for a graph spec, its `{{args.x}}` templates and `$args.x` refs.
 *
 * Pure module: no plugin imports, no I/O. Derivation is best-effort by design —
 * a missed name costs a doc gap, never a wrong run (args are not enforced).
 */
import { graphParamNames } from "./graph.ts"
import type { Json } from "./types.ts"

export interface WorkflowParam {
  name: string
  /** JSON type name when it could be inferred ("string", "number", "array", …). */
  type?: string
  /** False when the source explicitly marked it optional (`budget?: 35000`). */
  required?: boolean
  description?: string
}

export interface WorkflowParams {
  args: WorkflowParam[]
}

/** Param names that are property access on the object itself, not workflow args. */
const STOP_NAMES: ReadonlySet<string> = new Set([
  "length",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
])

const NAME_RE = /^[A-Za-z_$][\w$]{0,63}$/
/** Cap: a workflow reading 60 distinct args is a symptom, not a catalog entry. */
export const MAX_PARAMS = 40

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function addName(into: Map<string, WorkflowParam>, name: string, extra?: Partial<WorkflowParam>): void {
  if (!NAME_RE.test(name) || STOP_NAMES.has(name)) return
  const prev = into.get(name)
  into.set(name, { ...prev, name, ...extra })
}

/** JSON type name of a value, as a caller would describe it in a catalog. */
export function jsonTypeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Params from the actual `args` of a run: top-level object keys with their real
 * JSON types. Non-object args yield nothing (a workflow taking a bare string has
 * no named params to advertise). Required-ness is deliberately NOT inferred: one
 * run passing an optional arg does not make it required.
 */
export function paramsFromArgs(args: Json | undefined): WorkflowParam[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return []
  const out = new Map<string, WorkflowParam>()
  for (const [key, value] of Object.entries(args as Record<string, Json | undefined>)) {
    addName(out, key, { type: jsonTypeName(value) })
  }
  return limit([...out.values()])
}

/** Params from a graph spec's templates and refs (names only). */
export function paramsFromGraph(spec: unknown): WorkflowParam[] {
  return limit(graphParamNames(spec).map((name) => ({ name })))
}

/**
 * Find the balanced `{…}` span that starts at the first `{` at or after `from`.
 * String- and comment-agnostic on purpose: headers are prose, not code.
 */
function balancedSpan(text: string, from: number): string | undefined {
  const start = text.indexOf("{", from)
  if (start === -1) return undefined
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start + 1, i)
    }
  }
  return undefined
}

/** Type name implied by an example value in a `// Tool input:` header. */
function typeFromExample(example: string): string | undefined {
  const value = example.trim()
  if (value === "") return undefined
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith("`")) return "string"
  if (value.startsWith("[")) return "array"
  if (value.startsWith("{")) return "object"
  if (value === "true" || value === "false") return "boolean"
  if (value === "null") return "null"
  if (/^-?\d+(\.\d+)?$/.test(value)) return "number"
  return undefined
}

/**
 * Depth-1 `key:` / `key?:` scan of an object-body string, so nested examples do
 * not leak in as top-level params.
 */
function scanObjectKeys(body: string): Array<{ name: string; required: boolean; type?: string }> {
  const found: Array<{ name: string; required: boolean; type?: string }> = []
  let depth = 0
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === "{" || ch === "[") {
      depth++
      i++
      continue
    }
    if (ch === "}" || ch === "]") {
      depth--
      i++
      continue
    }
    if (depth > 0) {
      i++
      continue
    }
    const m = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*:/.exec(body.slice(i))
    if (!m) {
      i++
      continue
    }
    // The value runs to the next depth-0 comma; only its first token is read.
    const valueStart = i + m[0].length
    let j = valueStart
    let inner = 0
    while (j < body.length) {
      const c = body[j]!
      if (c === "{" || c === "[") inner++
      else if (c === "}" || c === "]") inner--
      else if (c === "," && inner === 0) break
      j++
    }
    const type = typeFromExample(body.slice(valueStart, j))
    found.push({ name: m[1]!, required: m[2] === undefined, ...(type !== undefined ? { type } : {}) })
    i = j + 1
  }
  return found
}

/**
 * Params declared by a `// Tool input: { …, args: { … } }` header comment — the
 * convention the shipped samples and docs/AUTHORING.md use.
 */
export function paramsFromToolInputHeader(script: string): WorkflowParam[] {
  const header = /\/\/[^\n]*Tool input:[^\n{]*(\{[\s\S]*)/.exec(script)
  if (!header) return []
  const outer = balancedSpan(script, header.index)
  if (outer === undefined) return []
  const argsAt = /(?:^|[{,])\s*args\s*:/.exec(outer)
  if (!argsAt) return []
  const argsBody = balancedSpan(outer, argsAt.index + argsAt[0].length - 1)
  if (argsBody === undefined) return []
  const out = new Map<string, WorkflowParam>()
  for (const entry of scanObjectKeys(argsBody)) {
    addName(out, entry.name, { required: entry.required, ...(entry.type !== undefined ? { type: entry.type } : {}) })
  }
  return limit([...out.values()])
}

/**
 * Params referenced in code: `args.x`, `args?.x`, `args["x"]`, the same through
 * a local alias assigned from `args` (the samples' `const input = args && …`
 * idiom), and `const { a, b } = args` destructuring.
 */
export function paramsFromScriptCode(script: string): WorkflowParam[] {
  const out = new Map<string, WorkflowParam>()
  const roots = new Set<string>(["args"])
  for (const m of script.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]*\bargs\b[^\n;]*)/g)) {
    if (m[1] !== "args") roots.add(m[1]!)
  }
  for (const root of roots) {
    const id = escapeRe(root)
    for (const m of script.matchAll(new RegExp(`\\b${id}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))) {
      addName(out, m[1]!)
    }
    for (const m of script.matchAll(new RegExp(`\\b${id}\\s*\\[\\s*["'\`]([^"'\`]+)["'\`]\\s*\\]`, "g"))) {
      addName(out, m[1]!)
    }
    for (const m of script.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${id}\\b`, "g"))) {
      for (const part of (m[1] ?? "").split(",")) {
        const name = /^\s*([A-Za-z_$][\w$]*)/.exec(part)?.[1]
        if (name) addName(out, name)
      }
    }
  }
  return limit([...out.values()])
}

/** Header first (it declares optionality and types), then code references. */
export function paramsFromScript(script: string): WorkflowParam[] {
  const out = new Map<string, WorkflowParam>()
  for (const p of paramsFromToolInputHeader(script)) addName(out, p.name, p)
  for (const p of paramsFromScriptCode(script)) if (!out.has(p.name)) addName(out, p.name, p)
  return limit([...out.values()])
}

function limit(params: WorkflowParam[]): WorkflowParam[] {
  // Insertion order is preserved deliberately: a header declares required args
  // before optional ones, and a spec reads args in the order the workflow uses
  // them. Alphabetizing would throw that away for no determinism gain (insertion
  // order is already deterministic for a given artifact).
  return params.slice(0, MAX_PARAMS)
}

/** Defensive read of a persisted `manifest.params` value. */
export function parseParams(value: unknown): WorkflowParams | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  const raw = (value as { args?: unknown }).args
  if (!Array.isArray(raw)) return undefined
  const args: WorkflowParam[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue
    const p = entry as Record<string, unknown>
    if (typeof p["name"] !== "string" || !NAME_RE.test(p["name"])) continue
    const param: WorkflowParam = { name: p["name"] }
    if (typeof p["type"] === "string") param.type = p["type"]
    if (typeof p["required"] === "boolean") param.required = p["required"]
    if (typeof p["description"] === "string") param.description = p["description"]
    args.push(param)
  }
  return { args: limit(args) }
}

/** Normalize a param list into the persisted `manifest.params` value. */
export function paramsValue(params: readonly WorkflowParam[]): Json | undefined {
  const args = limit([...params]).map(stripUndefined)
  return args.length > 0 ? { args } : undefined
}

/**
 * Merge an explicit (caller- or author-supplied) params value over the derived
 * list, field by field: explicit wins where it speaks, derived fills the gaps.
 * Returns undefined when nothing is known — no empty `params: { args: [] }`
 * noise on manifests.
 */
export function mergeParams(explicit: Json | undefined, derived: readonly WorkflowParam[]): Json | undefined {
  const byName = new Map<string, WorkflowParam>()
  for (const p of derived) byName.set(p.name, { ...p })
  const parsed = parseParams(explicit)
  for (const p of parsed?.args ?? []) byName.set(p.name, { ...byName.get(p.name), ...p })
  return paramsValue([...byName.values()])
}

function stripUndefined(param: WorkflowParam): Json {
  const out: Record<string, Json> = { name: param.name }
  if (param.type !== undefined) out["type"] = param.type
  if (param.required !== undefined) out["required"] = param.required
  if (param.description !== undefined) out["description"] = param.description
  return out as Json
}

/** Compact one-line rendering for the catalog: `area: string, budget?: number`. */
export function paramsLine(value: Json | undefined): string {
  const parsed = parseParams(value)
  if (!parsed || parsed.args.length === 0) return ""
  return parsed.args
    .map((p) => `${p.name}${p.required === false ? "?" : ""}${p.type !== undefined ? `: ${p.type}` : ""}`)
    .join(", ")
}
