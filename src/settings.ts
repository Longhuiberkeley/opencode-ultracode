/**
 * Panel settings overlay, per-run snapshots, and permission-mode decisions.
 * Host-free: command/TUI/supervisor/tests share this module.
 */
import type { PermissionMode, UltracodeOptions } from "./types.ts"
import { CONCURRENCY_CAP, DEFAULT_OPTIONS, MAX_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS, clampConcurrency } from "./types.ts"

export type PanelSettings = {
  concurrency: number
  maxAgents: number
  timeoutMs: number
  permissions: PermissionMode
}

export type SettingsOverlay = {
  concurrency?: number
  maxAgents?: number
  timeoutMs?: number
  permissions?: PermissionMode
}

export type SettingsKey = keyof PanelSettings

export const SETTINGS_KEYS: readonly SettingsKey[] = ["concurrency", "maxAgents", "timeoutMs", "permissions"]

export const TIMEOUT_PRESETS = [600_000, 1_800_000, 3_600_000] as const

export const PERMISSION_CYCLE: readonly PermissionMode[] = ["ask", "autoEditsWorkflow", "noEditTools"]

export const EDIT_ACTIONS: ReadonlySet<string> = new Set(["edit", "write"])

export const SETTINGS_ACK_PREFIX = "ultracode-settings"

export const MAX_AGENTS_STEP = 10
export const MAX_AGENTS_MIN = 1
export const MAX_AGENTS_MAX = 10_000

export type SettingsAck = {
  overlay: PanelSettings
  runID?: string
  effective?: PanelSettings
}

export function panelSettingsFrom(options: Required<UltracodeOptions>): PanelSettings {
  return {
    concurrency: clampConcurrency(options.concurrency),
    maxAgents: options.maxAgents,
    timeoutMs: options.timeoutMs,
    permissions: options.permissions,
  }
}

export function freezeEffective(options: Required<UltracodeOptions>): Required<UltracodeOptions> {
  return Object.freeze({
    agent: options.agent,
    concurrency: clampConcurrency(options.concurrency),
    maxAgents: options.maxAgents,
    timeoutMs: options.timeoutMs,
    permissions: options.permissions,
    permissionStallMs: options.permissionStallMs,
    maxResultChars: options.maxResultChars,
    agentScope: options.agentScope,
    agentRetryAttempts: options.agentRetryAttempts,
    agentRetryBackoffMs: options.agentRetryBackoffMs,
    childStallMs: options.childStallMs,
    maxLoopDepth: options.maxLoopDepth,
  })
}

export function applyOverlay(
  base: Required<UltracodeOptions>,
  overlay: SettingsOverlay | undefined,
): Required<UltracodeOptions> {
  const next: Required<UltracodeOptions> = { ...base }
  if (!overlay) return next
  if (overlay.concurrency !== undefined) next.concurrency = overlay.concurrency
  if (overlay.maxAgents !== undefined) next.maxAgents = overlay.maxAgents
  if (overlay.timeoutMs !== undefined) next.timeoutMs = overlay.timeoutMs
  if (overlay.permissions !== undefined) next.permissions = overlay.permissions
  return next
}

function intInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return undefined
  if (value < min || value > max) return undefined
  return value
}

const PERMISSION_MODES: ReadonlySet<string> = new Set(PERMISSION_CYCLE)

/** Parse a KV overlay. Unknown keys ignored; bad values omitted (config rule). */
export function parseSettingsOverlay(raw: unknown): SettingsOverlay {
  const overlay: SettingsOverlay = {}
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return overlay
  const record = raw as Record<string, unknown>
  const concurrency = intInRange(record.concurrency, 1, 64)
  if (concurrency !== undefined) overlay.concurrency = concurrency
  const maxAgents = intInRange(record.maxAgents, MAX_AGENTS_MIN, MAX_AGENTS_MAX)
  if (maxAgents !== undefined) overlay.maxAgents = maxAgents
  const timeoutMs = intInRange(record.timeoutMs, MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS)
  if (timeoutMs !== undefined) overlay.timeoutMs = timeoutMs
  const permissions = record.permissions
  if (typeof permissions === "string" && PERMISSION_MODES.has(permissions)) {
    overlay.permissions = permissions as PermissionMode
  }
  return overlay
}

export function parseSetArgs(rest: string): { key: string; value: string } | undefined {
  const trimmed = rest.trim()
  if (!trimmed) return undefined
  const m = /^(\S+)\s+(\S+)\s*$/.exec(trimmed)
  if (!m) return undefined
  return { key: m[1]!.toLowerCase(), value: m[2]! }
}

function parseSetNumber(raw: string): number | undefined {
  if (!/^-?\d+$/.test(raw)) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) return undefined
  return n
}

/**
 * Apply `/ultracode set <key> <value>`. Unknown keys and bad values are ignored.
 */
export function applySetValue(current: PanelSettings, key: string, raw: string): PanelSettings | "ignored" {
  if (key === "concurrency") {
    const n = parseSetNumber(raw)
    if (n === undefined) return "ignored"
    return { ...current, concurrency: clampConcurrency(n) }
  }
  if (key === "maxagents" || key === "maxAgents") {
    const n = parseSetNumber(raw)
    if (n === undefined) return "ignored"
    return { ...current, maxAgents: Math.min(MAX_AGENTS_MAX, Math.max(MAX_AGENTS_MIN, n)) }
  }
  if (key === "timeoutms" || key === "timeoutMs") {
    const n = parseSetNumber(raw)
    if (n === undefined) return "ignored"
    if (n < MIN_RUN_TIMEOUT_MS || n > MAX_RUN_TIMEOUT_MS) return "ignored"
    return { ...current, timeoutMs: n }
  }
  if (key === "permissions") {
    if (!PERMISSION_MODES.has(raw)) return "ignored"
    return { ...current, permissions: raw as PermissionMode }
  }
  return "ignored"
}

export function stepPanelSetting(current: PanelSettings, key: SettingsKey, dir: 1 | -1): PanelSettings {
  if (key === "concurrency") {
    return { ...current, concurrency: clampConcurrency(current.concurrency + dir) }
  }
  if (key === "maxAgents") {
    const next = current.maxAgents + dir * MAX_AGENTS_STEP
    return { ...current, maxAgents: Math.min(MAX_AGENTS_MAX, Math.max(MAX_AGENTS_MIN, next)) }
  }
  if (key === "timeoutMs") {
    const idx = TIMEOUT_PRESETS.indexOf(current.timeoutMs as (typeof TIMEOUT_PRESETS)[number])
    const start = idx >= 0 ? idx : TIMEOUT_PRESETS[0] === current.timeoutMs ? 0 : 2
    const nextIdx = (start + dir + TIMEOUT_PRESETS.length) % TIMEOUT_PRESETS.length
    return { ...current, timeoutMs: TIMEOUT_PRESETS[nextIdx]! }
  }
  const pidx = PERMISSION_CYCLE.indexOf(current.permissions)
  const start = pidx >= 0 ? pidx : 0
  const nextIdx = (start + dir + PERMISSION_CYCLE.length) % PERMISSION_CYCLE.length
  return { ...current, permissions: PERMISSION_CYCLE[nextIdx]! }
}

export function overlayFromPanel(panel: PanelSettings): SettingsOverlay {
  return {
    concurrency: panel.concurrency,
    maxAgents: panel.maxAgents,
    timeoutMs: panel.timeoutMs,
    permissions: panel.permissions,
  }
}

export function panelSettingsEqual(a: PanelSettings | undefined, b: PanelSettings | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.concurrency === b.concurrency &&
    a.maxAgents === b.maxAgents &&
    a.timeoutMs === b.timeoutMs &&
    a.permissions === b.permissions
  )
}

export function remainingTimeoutMs(
  timeoutMs: number,
  startedAt: number,
  pausedMs: number,
  paused: boolean,
  pausedAt: number | undefined,
  now = Date.now(),
): number {
  const pausedNow = paused && pausedAt !== undefined ? now - pausedAt : 0
  const elapsed = now - startedAt - pausedMs - pausedNow
  return timeoutMs - elapsed
}

export function formatSettingsAck(payload: SettingsAck): string {
  const body: Record<string, unknown> = { overlay: payload.overlay }
  if (payload.runID) body.runID = payload.runID
  if (payload.effective) body.effective = payload.effective
  return `${SETTINGS_ACK_PREFIX} ${JSON.stringify(body)}`
}

export function parseSettingsAckPayload(text: string): SettingsAck | undefined {
  const t = text.trim()
  if (!t.startsWith(SETTINGS_ACK_PREFIX)) return undefined
  const json = t.slice(SETTINGS_ACK_PREFIX.length).trim()
  try {
    const raw = JSON.parse(json) as unknown
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const rec = raw as Record<string, unknown>
    const overlay = parsePanelSettings(rec.overlay)
    if (!overlay) return undefined
    const ack: SettingsAck = { overlay }
    if (typeof rec.runID === "string") ack.runID = rec.runID
    const effective = parsePanelSettings(rec.effective)
    if (effective) ack.effective = effective
    return ack
  } catch {
    return undefined
  }
}

export function parsePanelSettings(raw: unknown): PanelSettings | undefined {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  const concurrency = intInRange(rec.concurrency, 1, CONCURRENCY_CAP) ?? intInRange(rec.concurrency, 1, 64)
  const maxAgents = intInRange(rec.maxAgents, MAX_AGENTS_MIN, MAX_AGENTS_MAX)
  const timeoutMs = intInRange(rec.timeoutMs, MIN_RUN_TIMEOUT_MS, MAX_RUN_TIMEOUT_MS)
  const permissions = rec.permissions
  if (concurrency === undefined || maxAgents === undefined || timeoutMs === undefined) return undefined
  if (typeof permissions !== "string" || !PERMISSION_MODES.has(permissions)) return undefined
  return {
    concurrency: clampConcurrency(concurrency),
    maxAgents,
    timeoutMs,
    permissions: permissions as PermissionMode,
  }
}

export type PermissionHookDecision = "delegate" | "contain" | "deny" | "ignore"

/**
 * Per-run permission decision. `ask` and missing mode delegate to the host
 * (do not set effect). Never read setup-time shared options here.
 */
export function permissionHookDecision(
  mode: PermissionMode | undefined,
  action: string,
): PermissionHookDecision {
  if (mode === undefined || mode === "ask") return "delegate"
  if (!EDIT_ACTIONS.has(action)) return "ignore"
  if (mode === "autoEditsWorkflow") return "contain"
  return "deny"
}

export const NO_EDIT_TOOLS_MESSAGE = "workflow run is in noEditTools mode"

export const NO_SHELL_WRITE_MESSAGE =
  "workflow run is in noEditTools mode — this shell command looks like a file write (best-effort detection)"

/**
 * The interactive question tool: its dialog only renders inside the focused
 * session (Ctrl+G). A workflow child asking one is an invisible hang — the
 * user is never notified. Denied for owned children in every mode.
 */
export const QUESTION_ACTIONS: ReadonlySet<string> = new Set(["question"])

export const CHILD_QUESTION_MESSAGE =
  "workflow child agents run unattended — the user cannot see or answer this question. Decide autonomously and state the decision in your result."

/** Host action names for shell command execution across builds. */
export const SHELL_ACTIONS: ReadonlySet<string> = new Set(["shell", "bash"])

/** Shell commands that create/modify/delete files — best-effort, token-level. */
const FILE_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "tee", "sponge", "truncate", "shred", "install", "patch",
  "rm", "mv", "cp", "ln", "mkdir", "rmdir", "touch", "chmod", "chown", "chflags", "rsync",
])

/** Mutating git subcommands (read-only ones like status/diff/log/show are absent). */
const MUTATING_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "am", "apply", "bisect", "cherry-pick", "clean", "commit", "config",
  "filter-branch", "gc", "init", "merge", "mv", "notes", "prune", "pull", "push",
  "rebase", "replace", "reset", "restore", "revert", "rm", "stash", "switch",
  "tag", "worktree", "checkout", "clone", "submodule", "update-ref",
  "symbolic-ref", "fast-import", "lfs", "maintenance", "repack", "send-email",
])

/** `sh -c '…'` payloads are opaque after quote-stripping — treated as unverifiable. */
const NESTED_SHELL_INTERPRETERS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "ksh", "dash"])

/** Strip quoted segments so operators/flags inside quotes don't trip detection. */
function stripQuotedSegments(cmd: string): string {
  let out = ""
  let quote: string | undefined
  for (const ch of cmd) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    out += ch
  }
  return out
}

/**
 * True when an unquoted output redirection writes a real target.
 * `/dev/null` and fd duplicates (`2>&1`, `>&3`) don't count.
 */
function hasFileWriteRedirect(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ">") continue
    let j = i + 1
    if (s[j] === ">") j++
    while (s[j] === " ") j++
    if (s.startsWith("/dev/null", j)) {
      i = j
      continue
    }
    if (s[j] === "&" && /[0-9-]/.test(s[j + 1] ?? "")) {
      i = j
      continue
    }
    return true
  }
  return false
}

/** Skip leading var assignments and `env`/`command`/`builtin` wrappers. */
function commandTokens(stripped: string): string[] {
  const tokens = stripped.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++
      continue
    }
    if (t === "env" || t === "command" || t === "builtin") {
      i++
      while (i < tokens.length && tokens[i]!.startsWith("-") && tokens[i] !== "--") i++
      if (tokens[i] === "--") i++
      continue
    }
    break
  }
  return tokens.slice(i)
}

const FIND_MUTATING = /^-{1,2}(delete|exec|execdir|ok|okdir|fprint|fls)/

/**
 * Best-effort detection of write-shaped shell commands (one parsed command
 * string, as delivered in the permission event's `resources`). NOT a sandbox:
 * purpose-built for the noEditTools mode so a workflow child cannot sneak an
 * edit past the edit-tool deny via `sed -i`, `tee`, redirections, `git commit`
 * or an opaque `sh -c`. Unverifiable constructs fail closed.
 */
export function isShellWriteCommand(cmd: string): boolean {
  if (typeof cmd !== "string" || cmd.length === 0) return false
  const stripped = stripQuotedSegments(cmd)
  if (hasFileWriteRedirect(stripped)) return true
  const tokens = commandTokens(stripped)
  if (tokens.length === 0) return false
  const base = tokens[0]!
  const rest = tokens.slice(1)
  if (FILE_WRITE_COMMANDS.has(base)) return true
  if (base === "sed" || base === "gsed") {
    return rest.some((t) => t.startsWith("-i") || t.startsWith("--in-place"))
  }
  if (base === "perl") {
    return rest.some((t) => /^-[A-Za-z]*i/.test(t))
  }
  if (base === "awk" || base === "gawk") {
    return rest.includes("-i") && rest.includes("inplace")
  }
  if (base === "dd") {
    return rest.some((t) => t.startsWith("of="))
  }
  if (base === "find") {
    return rest.some((t) => FIND_MUTATING.test(t))
  }
  if (base === "sort") {
    return rest.some((t) => t === "-o" || t.startsWith("--output"))
  }
  if (base === "git") {
    let i = 0
    while (i < rest.length) {
      const t = rest[i]!
      if (t === "-C") {
        i += 2
        continue
      }
      if (t.startsWith("-")) {
        i++
        continue
      }
      break
    }
    const sub = rest[i]
    return sub !== undefined && MUTATING_GIT_SUBCOMMANDS.has(sub)
  }
  if (base === "xargs") {
    return rest.some((t) => FILE_WRITE_COMMANDS.has(t) || MUTATING_GIT_SUBCOMMANDS.has(t))
  }
  if (NESTED_SHELL_INTERPRETERS.has(base) && rest.includes("-c")) return true
  return false
}

export type PermissionLookup = {
  isOwnedActive(sessionID: string): boolean
  runForActiveSession(sessionID: string): { effective?: { permissions?: PermissionMode; permissionStallMs?: number } } | undefined
}

/**
 * Hook-level evaluate for an owned child. `ask` / missing mode → delegate
 * (caller must leave `effect` unset). `noEditTools` → deny edit-class tools
 * and best-effort write-shaped shell commands.
 */
export function evaluateOwnedPermission(
  event: { sessionID?: string; action?: string; resources?: ReadonlyArray<unknown>; effect?: string; message?: string },
  lookup: PermissionLookup,
): PermissionHookDecision | "skip" {
  const sessionID = event.sessionID
  if (typeof sessionID !== "string" || !lookup.isOwnedActive(sessionID)) return "skip"
  const action = event.action
  if (typeof action !== "string") return "skip"
  // Children are unattended: a question dialog only renders inside the child
  // session, so asking one is an invisible hang. Deny in every mode.
  if (QUESTION_ACTIONS.has(action)) {
    event.effect = "deny"
    event.message = CHILD_QUESTION_MESSAGE
    return "deny"
  }
  const mode = lookup.runForActiveSession(sessionID)?.effective?.permissions
  // noEditTools: the edit-tool deny alone leaks shell-mediated writes
  // (`sed -i`, `tee`, redirections, `git commit`, `sh -c '… > f'`).
  if (mode === "noEditTools" && SHELL_ACTIONS.has(action)) {
    const resources = Array.isArray(event.resources) ? event.resources : []
    if (resources.some((r) => typeof r === "string" && isShellWriteCommand(r))) {
      event.effect = "deny"
      event.message = NO_SHELL_WRITE_MESSAGE
      return "deny"
    }
    return "ignore"
  }
  const decision = permissionHookDecision(mode, action)
  if (decision === "deny") {
    event.effect = "deny"
    event.message = NO_EDIT_TOOLS_MESSAGE
  }
  return decision
}

export type PermissionStallAction = "reject-now" | "reject-after-stall" | "wait"

/**
 * What to do with a pending permission request on an owned active child.
 * `noEditTools` rejects immediately (children never block on prompts the user
 * cannot see); other modes wait for the user and only reject after
 * `permissionStallMs` (0 or missing = wait forever, the old behavior).
 */
export function permissionStallAction(
  mode: PermissionMode | undefined,
  permissionStallMs: number | undefined,
): PermissionStallAction {
  if (mode === "noEditTools") return "reject-now"
  if (permissionStallMs === undefined || permissionStallMs <= 0) return "wait"
  return "reject-after-stall"
}

export function capturedFromRecord(
  run: { effective?: PanelSettings | Required<UltracodeOptions> } | undefined,
): PanelSettings | undefined {
  if (!run?.effective) return undefined
  const e = run.effective
  if (
    typeof e.concurrency === "number" &&
    typeof e.maxAgents === "number" &&
    typeof e.timeoutMs === "number" &&
    (e.permissions === "ask" || e.permissions === "autoEditsWorkflow" || e.permissions === "noEditTools")
  ) {
    return panelSettingsFrom({ ...DEFAULT_OPTIONS, ...e })
  }
  return undefined
}
