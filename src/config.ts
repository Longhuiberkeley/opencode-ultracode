/**
 * Plugin option parsing/validation (Builder A).
 *
 * Rules (CONTRACTS.md): unknown keys ignored; bad values fall back to defaults
 * and collect a human-readable warning. Never throws.
 */
import type { AgentScope, PermissionMode, UltracodeOptions } from "./types.ts"
import { DEFAULT_OPTIONS, MAX_LOOP_DEPTH, MAX_RUN_TIMEOUT_MS, MIN_LOOP_DEPTH, MIN_RUN_TIMEOUT_MS } from "./types.ts"

export interface LoadedOptions {
  options: Required<UltracodeOptions>
  warnings: string[]
}

interface NumRange {
  min: number
  max: number
}

/** Verified ranges — see CONTRACTS.md Builder A. */
const RANGES: Record<
  | "concurrency"
  | "maxAgents"
  | "timeoutMs"
  | "maxResultChars"
  | "permissionStallMs"
  | "agentRetryAttempts"
  | "agentRetryBackoffMs"
  | "childStallMs"
  | "maxLoopDepth",
  NumRange
> = {
  concurrency: { min: 1, max: 64 },
  maxAgents: { min: 1, max: 10_000 },
  // Shared with the per-run override and /ultracode set (src/types.ts).
  timeoutMs: { min: MIN_RUN_TIMEOUT_MS, max: MAX_RUN_TIMEOUT_MS },
  maxResultChars: { min: 1_000, max: 1_000_000 },
  // 0 disables the stall watchdog (noEditTools rejects immediately anyway).
  permissionStallMs: { min: 0, max: 3_600_000 },
  agentRetryAttempts: { min: 0, max: 3 },
  agentRetryBackoffMs: { min: 0, max: 120_000 },
  // 0 disables the child-liveness watchdog.
  childStallMs: { min: 0, max: 3_600_000 },
  // loop() nesting depth inside one run (engine-owned preflight; shared with
  // the per-run maxLoopDepth run input — src/types.ts).
  maxLoopDepth: { min: MIN_LOOP_DEPTH, max: MAX_LOOP_DEPTH },
}

const PERMISSION_MODES: ReadonlySet<string> = new Set(["ask", "autoEditsWorkflow", "noEditTools"])

const AGENT_SCOPES: ReadonlySet<string> = new Set(["host", "configured"])

function num(warnings: string[], raw: Record<string, unknown>, key: keyof typeof RANGES): number | undefined {
  const range = RANGES[key]
  const value = raw[key]
  if (value === undefined) return undefined // use default, no warning
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    warnings.push(
      `option "${key}" must be an integer number, got ${JSON.stringify(value) ?? String(value)} — using default ${DEFAULT_OPTIONS[key]}`,
    )
    return undefined
  }
  if (value < range.min || value > range.max) {
    warnings.push(
      `option "${key}" must be between ${range.min} and ${range.max}, got ${value} — using default ${DEFAULT_OPTIONS[key]}`,
    )
    return undefined
  }
  return value
}

/**
 * Parse `ctx.options` into validated options. Always returns a fully-populated
 * `Required<UltracodeOptions>` plus warnings for every value that was rejected.
 */
export function loadOptions(raw: unknown): LoadedOptions {
  const warnings: string[] = []
  const options: Required<UltracodeOptions> = { ...DEFAULT_OPTIONS }

  if (raw === null || raw === undefined) return { options, warnings }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`options must be an object, got ${Array.isArray(raw) ? "array" : typeof raw} — using defaults`)
    return { options, warnings }
  }
  const record = raw as Record<string, unknown>

  for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const parsed = num(warnings, record, key)
    if (parsed !== undefined) options[key] = parsed
  }

  const permissions = record["permissions"]
  if (permissions !== undefined) {
    if (typeof permissions === "string" && PERMISSION_MODES.has(permissions)) {
      options.permissions = permissions as PermissionMode
    } else {
      warnings.push(
        `option "permissions" must be one of ask | autoEditsWorkflow | noEditTools, got ${JSON.stringify(permissions) ?? String(permissions)} — using default "${DEFAULT_OPTIONS.permissions}"`,
      )
    }
  }

  const agent = record["agent"]
  if (agent !== undefined) {
    if (typeof agent === "string" && agent.trim() !== "") {
      options.agent = agent.trim()
    } else {
      warnings.push(
        `option "agent" must be a non-empty string, got ${JSON.stringify(agent) ?? String(agent)} — using default "${DEFAULT_OPTIONS.agent}"`,
      )
    }
  }

  const agentScope = record["agentScope"]
  if (agentScope !== undefined) {
    if (typeof agentScope === "string" && AGENT_SCOPES.has(agentScope)) {
      options.agentScope = agentScope as AgentScope
    } else {
      warnings.push(
        `option "agentScope" must be one of host | configured, got ${JSON.stringify(agentScope) ?? String(agentScope)} — using default "${DEFAULT_OPTIONS.agentScope}"`,
      )
    }
  }

  // Unknown keys intentionally ignored (forward compatibility).
  return { options, warnings }
}
