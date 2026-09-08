/**
 * JSON schema validation, tolerant JSON extraction, and result envelopes.
 *
 * Builder B module. Pure functions only — no plugin imports, no IO.
 */
import type { Json, RunEnvelope, RunRecord } from "./types.ts"
import { countAgents } from "./types.ts"

// ---------------------------------------------------------------------------
// Tiny JSON-Schema-ish validator
// ---------------------------------------------------------------------------

export type SchemaCheck = { ok: true } | { ok: false; error: string }

function isPlainObject(v: Json): v is { [key: string]: Json | undefined } {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function typeMatches(type: string, value: Json): boolean {
  switch (type) {
    case "string":
      return typeof value === "string"
    case "number":
      // JS quirk guard: booleans are NOT numbers, and vice versa.
      return typeof value === "number" && Number.isFinite(value)
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    case "object":
      return isPlainObject(value)
    case "array":
      return Array.isArray(value)
    default:
      // Unknown type keyword — be lenient (we cannot validate what we don't know).
      return true
  }
}

function sameJson(a: Json, b: Json): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function typeName(value: Json): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Validate `value` against a small subset of JSON Schema:
 * type / required / properties / items / enum / minimum / maximum,
 * nested objects and arrays. `additionalProperties` is ignored (extra keys
 * allowed). Boolean schemas: `true` accepts anything, `false` accepts nothing.
 */
export function validateJsonSchemaValue(schema: Json | undefined, value: Json): SchemaCheck {
  return validateAt(schema, value, "$")
}

function validateAt(schema: Json | undefined, value: Json, path: string): SchemaCheck {
  if (schema === undefined || schema === null) return { ok: true }
  if (typeof schema === "boolean") {
    return schema ? { ok: true } : { ok: false, error: `${path}: schema forbids any value` }
  }
  if (!isPlainObject(schema)) return { ok: true }

  // type ------------------------------------------------------------------
  const typeField = schema["type"]
  if (typeField !== undefined) {
    const types = Array.isArray(typeField) ? typeField : [typeField]
    const ok = types.some((t) => typeof t === "string" && typeMatches(t, value))
    if (!ok) {
      const expected = types.map((t) => String(t)).join(" | ")
      return { ok: false, error: `${path}: expected type ${expected}, got ${typeName(value)}` }
    }
  }

  // enum -------------------------------------------------------------------
  const enumField = schema["enum"]
  if (Array.isArray(enumField)) {
    const match = enumField.some((candidate) => candidate !== undefined && sameJson(candidate, value))
    if (!match) return { ok: false, error: `${path}: value not in enum` }
  }

  // numeric bounds -----------------------------------------------------------
  if (typeof value === "number") {
    const min = schema["minimum"]
    if (typeof min === "number" && value < min) {
      return { ok: false, error: `${path}: expected >= ${min}, got ${value}` }
    }
    const max = schema["maximum"]
    if (typeof max === "number" && value > max) {
      return { ok: false, error: `${path}: expected <= ${max}, got ${value}` }
    }
  }

  // object rules -------------------------------------------------------------
  if (isPlainObject(value)) {
    const required = schema["required"]
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          return { ok: false, error: `${path}: missing required property "${key}"` }
        }
      }
    }
    const properties = schema["properties"]
    if (properties !== undefined && isPlainObject(properties)) {
      for (const key of Object.keys(properties)) {
        const has = Object.hasOwn(value, key)
        const present = has && value[key] !== undefined
        if (!present) continue
        const sub = validateAt(properties[key], value[key] as Json, `${path}.${key}`)
        if (!sub.ok) return sub
      }
    }
    // additionalProperties intentionally ignored.
  }

  // array rules ----------------------------------------------------------------
  if (Array.isArray(value)) {
    const items = schema["items"]
    if (items !== undefined && !Array.isArray(items)) {
      for (let i = 0; i < value.length; i++) {
        const sub = validateAt(items as Json, value[i], `${path}[${i}]`)
        if (!sub.ok) return sub
      }
    }
  }

  return { ok: true }
}

// ---------------------------------------------------------------------------
// Tolerant JSON extraction (NO eval — JSON.parse only)
// ---------------------------------------------------------------------------

export type ExtractResult = { ok: true; value: Json } | { ok: false; error: string }

/**
 * Extraction precedence:
 *  1. the whole trimmed response parses as JSON;
 *  2. exactly one ```json fenced block parses;
 *  3. exactly one balanced {...} or [...] span (string-aware scan) parses.
 * Multiple disjoint candidates => ambiguous => rejected.
 */
export function extractJson(text: string): ExtractResult {
  const trimmed = text.trim()
  if (trimmed !== "") {
    const direct = tryParse(trimmed)
    if (direct.ok) return direct
  }

  // Fenced ```json blocks ----------------------------------------------------
  const fences: string[] = []
  const fenceRe = /```[ \t]*json[ \t]*\r?\n?([\s\S]*?)[ \t]*```/g
  let m: RegExpExecArray | null
  while ((m = fenceRe.exec(text)) !== null) {
    fences.push(m[1].trim())
  }
  if (fences.length > 1) {
    return { ok: false, error: `ambiguous JSON: ${fences.length} fenced blocks in reply` }
  }
  if (fences.length === 1) {
    const parsed = tryParse(fences[0])
    if (parsed.ok) return parsed
  }

  // Balanced span scan ---------------------------------------------------------
  const spans = collectBalancedSpans(text)
  if (spans.length === 0) {
    return { ok: false, error: trimmed === "" ? "empty reply" : "no JSON value found in reply" }
  }
  if (spans.length > 1) {
    return { ok: false, error: `ambiguous JSON: ${spans.length} candidate values in reply` }
  }
  return tryParse(spans[0])
}

function tryParse(candidate: string): ExtractResult {
  if (candidate === "") return { ok: false, error: "empty candidate" }
  try {
    return { ok: true, value: JSON.parse(candidate) as Json }
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` }
  }
}

/**
 * Scan for top-level balanced {...} / [...] spans, skipping JSON string bodies
 * so braces inside string values do not confuse the matcher. Nested spans are
 * consumed by their outer span (not reported separately).
 */
export function collectBalancedSpans(text: string): string[] {
  const spans: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    // Only double quotes delimit JSON strings; single quotes in prose
    // ("here's the value") must not swallow a following JSON span.
    if (c === '"') {
      i = skipString(text, i, c)
      continue
    }
    if (c === "{" || c === "[") {
      const end = findBalancedEnd(text, i)
      if (end === -1) {
        // Unterminated span — no candidate from here on.
        return spans
      }
      spans.push(text.slice(i, end + 1))
      i = end + 1
      continue
    }
    i++
  }
  return spans
}

function skipString(text: string, start: number, quote: string): number {
  let i = start + 1
  while (i < text.length) {
    const c = text[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return i
}

function findBalancedEnd(text: string, start: number): number {
  const open = text[start]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let i = start
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      i = skipString(text, i, '"')
      continue
    }
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0 && close === "}") return i
    } else if (c === "[") depth++
    else if (c === "]") {
      depth--
      if (depth === 0 && close === "]") return i
    }
    i++
  }
  return -1
}

// ---------------------------------------------------------------------------
// Envelope assembly + bounded stringify
// ---------------------------------------------------------------------------

/** Compact JSON.stringify that never returns undefined (falls back to "null"). */
export function boundedStringify(value: Json | undefined, maxChars = Number.MAX_SAFE_INTEGER): string {
  let s: string
  try {
    s = JSON.stringify(value) ?? "null"
  } catch {
    s = '"[unserializable]"'
  }
  return s.length <= maxChars ? s : s.slice(0, maxChars)
}

/** Pretty JSON sliced to maxChars (used for envelope previews). */
export function boundedPrettyStringify(value: Json | undefined, maxChars: number): string {
  let s: string
  try {
    s = JSON.stringify(value, null, 2) ?? "null"
  } catch {
    s = '"[unserializable]"'
  }
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars)
}

/** True when the compact serialization of `value` fits within `maxChars`. */
export function resultFits(value: Json | undefined, maxChars: number): boolean {
  if (value === undefined) return true
  try {
    const s = JSON.stringify(value)
    return s === undefined ? false : s.length <= maxChars
  } catch {
    return false
  }
}

/**
 * Build the tool-result envelope from a (final) run record.
 * `result` is included when its compact serialization fits `maxChars`;
 * otherwise `preview` (first maxChars chars of pretty JSON) + truncated: true.
 */
export function buildEnvelope(run: RunRecord, maxChars: number): RunEnvelope {
  const counts = countAgents(run)
  const durationMs = Math.max(0, (run.endedAt ?? Date.now()) - run.startedAt)
  const envelope: RunEnvelope = {
    runID: run.id,
    status: run.status,
    durationMs,
    agents: counts,
    truncated: false,
  }
  if (run.name !== undefined) envelope.name = run.name
  if (run.workflowName !== undefined) envelope.workflowName = run.workflowName
  if (run.scriptPath !== undefined) envelope.scriptPath = run.scriptPath
  if (run.error !== undefined) envelope.error = run.error
  if (run.stopReason !== undefined) envelope.stopReason = run.stopReason
  if (run.totalTokens !== undefined) envelope.tokens = run.totalTokens

  if (run.result !== undefined) {
    if (resultFits(run.result, maxChars)) {
      envelope.result = run.result
    } else {
      envelope.preview = boundedPrettyStringify(run.result, maxChars)
      envelope.truncated = true
      // Give consumers (e.g. `/ultracode result`) a handle on the full artifact.
      if (run.resultArtifactKey !== undefined) envelope.resultArtifactKey = run.resultArtifactKey
    }
  }
  return envelope
}
