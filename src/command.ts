/**
 * Slash-command parsing, /ultracode verb surface, tool-description contract,
 * and session.tool.* → toolCalls wiring. Plugin-free so unit tests cover it.
 */
import { agentCells, compactCount, compactElapsed, compactTokens, runHeaderCells } from "./run-format.ts"
import { reduceToolEvent, toolCallsFor, type ToolEvent, type ToolEventState } from "./run-events.ts"
import { normalizePath, sha256 } from "./storage.ts"
import type {
  Json,
  ParentContext,
  Registry,
  RunEnvelope,
  RunOutcome,
  RunRecord,
  RunStatus,
  SavedWorkflow,
  Supervisor,
  UltracodeOptions,
  WorkflowMeta,
} from "./types.ts"
import { countAgents, isActiveRunStatus } from "./types.ts"
import {
  applySetValue,
  capturedFromRecord,
  formatSettingsAck,
  overlayFromPanel,
  parseSetArgs,
  type PanelSettings,
} from "./settings.ts"

/**
 * Standalone keyword anywhere in the prompt: whitespace-delimited, optionally
 * followed by a colon. Rejects path/id substrings (`opencode-ultracode`,
 * `ultracode_run`, `ultracode.js`, `/path/ultracode`).
 */
const KEYWORD = /(?:^|\s)ultracode(?=\s|:|$)/i

export function matchesUltracodeKeyword(text: string): boolean {
  return KEYWORD.test(text)
}

/** Strip a leading `/ultracode` token; remaining text is returned trimmed. */
export function commandArgs(promptText: string | undefined): string {
  const text = (promptText ?? "").trim()
  const token = /^\/ultracode\b/i.exec(text)
  return (token ? text.slice(token[0].length) : text).trim()
}

/** First token is the subcommand (lowercased); the rest is unparsed args. */
export function parseSubcommand(argsText: string): { sub: string; rest: string } {
  const trimmed = argsText.trim()
  if (trimmed === "") return { sub: "", rest: "" }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  return { sub: (m?.[1] ?? "").toLowerCase(), rest: (m?.[2] ?? "").trim() }
}

/** D2 verb set (13; bare dashboard is not a verb). */
export const D2_VERBS = [
  "show",
  "status",
  "result",
  "stop",
  "pause",
  "resume",
  "rerun",
  "save",
  "trust",
  "untrust",
  "set",
  "settings",
  "doctor",
  "help",
] as const

export type D2Verb = (typeof D2_VERBS)[number]

/** Verbs that spawn a new run — rejected when the invocation session is owned (R15). */
export const RUN_STARTING_VERBS: ReadonlySet<string> = new Set(["rerun"])

export const NO_ACTIVE_RUN = "no active run — pass a runID (/ultracode shows recent)"
export const SOURCE_STILL_ACTIVE = "source run is still active — stop it first or pass a final runID"
export const NESTED_RUN_REFUSED =
  "cannot start a run from inside an active workflow session — use /ultracode from the parent"

/** Plugin package version shown on the bare /ultracode dashboard. */
export const PLUGIN_VERSION = "0.3.3"
/** Oldest OpenCode binary build the inspect TUI is gated on (A7 / D7). */
export const MIN_SUPPORTED_BUILD = 19271

export function helpText(): string {
  return [
    "Usage: /ultracode — inspect and manage workflow runs",
    "- `/ultracode` — dashboard (active including paused, recent, saved workflows)",
    "- `/ultracode show [runID]` — full run report (agents, sessions, tokens, script)",
    "- `/ultracode status [runID]` — compact run state (runID, status, agents done/total, elapsed)",
    "- `/ultracode result [runID]` — print a truncated run's full result",
    "- `/ultracode stop [runID]` — stop an active run (explicit runID required when several are active)",
    "- `/ultracode pause [runID]` — pause an active run (close admission of new agent() calls)",
    "- `/ultracode resume [runID]` — resume a paused run",
    "- `/ultracode rerun [runID] [argsJSON]` — start a new run from a finished run's script",
    "- `/ultracode save` `<name>` (from a project `<name>.js` file) or `<runID> <name>` (from a run)",
    "- `/ultracode trust <name>` — approve the current version of a saved workflow",
    "- `/ultracode untrust <name>` — revoke trust for a saved workflow",
    "- `/ultracode settings [runID]` — next-run defaults and a run's captured settings",
    "- `/ultracode set <key> <value>` — persist overlay (concurrency, maxAgents, timeoutMs, permissions); applies next run",
    "- `/ultracode doctor` — install/load diagnostics (marker, entries, rpc, live vs persisted runs, last KV error)",
    "- `/ultracode help` — this text",
    "",
    "To author a run, send a normal message containing the keyword `ultracode` (no leading slash), e.g. `please ultracode this` or `ultracode: audit src/auth`.",
  ].join("\n")
}

/** Verb tokens listed in helpText (for D2 set-equality tests). */
export function verbsListedInHelp(): string[] {
  return [...helpText().matchAll(/`\/ultracode ([a-z]+)/g)].map((m) => m[1]!)
}

/**
 * Condensed authoring contract for the ultracode_run tool description (D1).
 * Full patterns + live catalogs live in the Ultracode skill.
 */
export const TOOL_DESCRIPTION: string = [
  "Run an ultracode workflow (invoke this tool as ultracode_run).",
  "",
  "WHEN: the task outgrows one context window, needs fan-out, needs structural verification, or should be a repeatable orchestration.",
  "NOT: one reply answers it, or a single subagent is enough.",
  "",
  "Input: { script, name?, meta?, args?, background? } (inline) or { workflow: name, args?, background? } (saved; trust first via /ultracode trust <name>).",
  "Script = plain-JS async function body (no import/export). Return a small JSON value.",
  "",
  "Injected globals:",
  "- agent(prompt, opts?) — spawn one subagent; opts: agent, label, phase, schema",
  "- parallel(thunks) — barrier; a thrown thunk resolves null",
  "- pipeline(items, ...stages) — per-item stages; a failing item becomes null",
  "- phase(name) — ambient phase label for progress grouping",
  "- progress(text) — emit a line into the run log",
  "- workflow(name, args?) — run a saved workflow (depth 1 only)",
  "- sleep(ms) — pause, capped at 60000 ms per call",
  "- console.log(x) — buffered into the run log",
  "- args — tool-input JSON (from the tool call, not the script)",
  "- meta — tool-input metadata: name, description, phases, requires",
  "",
  "Route by agent, never by model: pass opts.agent; the user's agent config picks the model. Never name provider/model ids.",
  "",
  "Caps: 8 concurrent agents (default), 200 agent() calls per run, 60 minutes wall clock, 512 KB max script, results truncated after 64 KB.",
  "Default / background: runs are background by default — the tool returns immediately after admission with { runID, status: \"running\", hint } (inspect panel via ctrl+g, or /ultracode status / ultracode_status). The host cannot deliver a late tool result after execute returns — the calling agent is not auto-woken on completion.",
  "background: false (opt-in) blocks until every agent settles, then returns { runID, status, agents, tokens, result | preview }.",
  "",
  "Full patterns + live catalogs load with the Ultracode skill (auto-attaches on the standalone keyword 'ultracode').",
].join("\n")

export const TOOL_DESCRIPTION_MAX_LINES = 60

// ---------------------------------------------------------------------------
// Implicit target (D3)
// ---------------------------------------------------------------------------

export function multipleActiveMessage(ids: readonly string[]): string {
  return `multiple active runs: ${ids.join(", ")} — pass one`
}

/**
 * Resolve a run-scoped verb's target. `show`/`result`/`pause`/`resume`/`stop`
 * omit runID → single active run; 0 → NO_ACTIVE_RUN; many → list ids.
 */
export function resolveActiveTarget(
  rest: string,
  active: readonly RunRecord[],
): { ok: true; runID: string } | { ok: false; error: string } {
  const explicit = firstToken(rest)
  if (explicit) return { ok: true, runID: explicit }
  if (active.length === 0) return { ok: false, error: NO_ACTIVE_RUN }
  if (active.length === 1) return { ok: true, runID: active[0]!.id }
  return { ok: false, error: multipleActiveMessage(active.map((r) => r.id)) }
}

function firstToken(rest: string): string {
  const trimmed = rest.trim()
  if (!trimmed) return ""
  return trimmed.split(/\s+/, 1)[0] ?? ""
}

/** Hint on the background-run tool ack. Honest limitation: no late tool result. */
export const BACKGROUND_RUN_HINT =
  "Watch the inspect panel (ctrl+g) or poll /ultracode status [runID] / ultracode_status. The host cannot deliver a late tool result after execute returns — the calling agent is not auto-woken on completion."

export type RunStatusPayload = {
  runID: string
  status: RunStatus
  agents: { done: number; total: number; failed: number }
  startedAt: number
}

export function runStatusPayload(run: RunRecord): RunStatusPayload {
  const counts = countAgents(run)
  return {
    runID: run.id,
    status: run.status,
    agents: {
      done: counts.succeeded + counts.failed + counts.interrupted,
      total: counts.total,
      failed: counts.failed,
    },
    startedAt: run.startedAt,
  }
}

/** Compact human-facing `/ultracode status` line. */
export function formatStatusRun(run: RunRecord, now = Date.now()): string {
  const payload = runStatusPayload(run)
  const elapsed = compactElapsed((run.endedAt ?? now) - run.startedAt)
  return `${payload.runID} · ${payload.status} · agents ${payload.agents.done}/${payload.agents.total} · ${elapsed}`
}

export function resolveRunStatus(
  registry: Pick<Registry, "get">,
  restOrRunID: string,
  active: readonly RunRecord[],
): { ok: true; payload: RunStatusPayload } | { ok: false; error: string } {
  const target = resolveActiveTarget(restOrRunID, active)
  if (!target.ok) return target
  const run = registry.get(target.runID)
  if (!run) return { ok: false, error: `Run \`${target.runID}\` not found. See /ultracode for known runs.` }
  return { ok: true, payload: runStatusPayload(run) }
}

/**
 * Tool launch: default awaits supervisor.start (blocking envelope).
 * `background: true` returns after startDetached admission (do not await done).
 */
export async function executeWorkflowLaunch(
  supervisor: Pick<Supervisor, "start" | "startDetached">,
  input: { script: string; meta?: WorkflowMeta; args?: Json; name?: string; workflowName?: string },
  parent: ParentContext,
  background: boolean,
): Promise<{ content: string }> {
  if (background) {
    const { runID, done } = supervisor.startDetached(input, parent)
    void done.catch((err: unknown) => {
      console.error(`ultracode background run ${runID} failed: ${describeError(err)}`)
    })
    return { content: JSON.stringify({ runID, status: "running", hint: BACKGROUND_RUN_HINT }) }
  }
  const outcome = await supervisor.start(input, parent)
  return { content: JSON.stringify(outcome.envelope, null, 1) }
}

// ---------------------------------------------------------------------------
// Show renderer (D11 cells + show-only sessionID)
// ---------------------------------------------------------------------------

const AGENT_TABLE_HEADERS = ["status", "id / label", "phase", "agent", "model", "tokens", "tools", "session"]

export function formatShowRun(run: RunRecord, extra?: { pending?: readonly string[] }): string {
  const lines: string[] = []
  const header = runHeaderCells(run).join(" · ")
  lines.push(`## Run \`${run.id}\`${run.name ? ` — ${run.name}` : ""}`)
  lines.push("")
  lines.push(header)
  lines.push("")
  lines.push(`- status: **${run.status}**`)
  if (run.workflowName) lines.push(`- workflow: ${run.workflowName}`)
  if (run.error) lines.push(`- error: ${run.error}`)
  if (run.stopReason) lines.push(`- stop reason: ${run.stopReason}`)
  if (run.totalTokens) {
    const t = run.totalTokens
    lines.push(
      `- tokens: in ${compactCount(t.input)} · out ${compactCount(t.output)} · reasoning ${compactCount(t.reasoning)} · cache read ${compactCount(t.cache.read)}`,
    )
  }
  if (run.scriptPath) lines.push(`- script artifact: ${run.scriptPath}`)
  if (run.resultTruncated && run.resultArtifactKey) {
    lines.push(
      `- result truncated — full result: /ultracode result \`${run.id}\` (artifact key \`${run.resultArtifactKey}\`)`,
    )
  }
  lines.push("")
  lines.push("### Agents")
  lines.push("")
  if (run.agents.length === 0) {
    lines.push("(no agents were started)")
  } else {
    lines.push(`| ${AGENT_TABLE_HEADERS.join(" | ")} |`)
    lines.push(`| ${AGENT_TABLE_HEADERS.map(() => "---").join(" | ")} |`)
    for (const a of run.agents) {
      const cells = [...agentCells(a), a.sessionID ?? "-"]
      lines.push(`| ${cells.join(" | ")} |`)
    }
  }
  if (extra?.pending && extra.pending.length > 0) {
    lines.push("")
    lines.push("**Waiting for permission**")
    lines.push(...extra.pending)
  }
  if (run.result !== undefined && !run.resultTruncated) {
    lines.push("")
    lines.push("### Result")
    lines.push("")
    lines.push("```json")
    lines.push(JSON.stringify(run.result, null, 1))
    lines.push("```")
  }
  if (run.error) {
    lines.push("")
    lines.push("### Error")
    lines.push("")
    lines.push(run.error)
  }
  lines.push("")
  lines.push("### Script")
  lines.push("")
  lines.push("```js")
  lines.push(run.script)
  lines.push("```")
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// session.tool.* → AgentRecord.toolCalls (D6)
// ---------------------------------------------------------------------------

export function feedToolEvent(
  state: ToolEventState,
  evt: ToolEvent & { created?: number },
  registry: Pick<Registry, "agentForSession" | "updateAgent" | "getAgent">,
): ToolEventState {
  const sessionID = evt.data?.sessionID
  if (typeof sessionID !== "string" || sessionID.length === 0) return state
  const mapped = registry.agentForSession(sessionID)
  if (!mapped) return state
  const agent = registry.getAgent(mapped.runID, mapped.agentID)
  if (typeof evt.created === "number" && agent?.startedAt !== undefined && evt.created < agent.startedAt) {
    return state
  }
  const next = reduceToolEvent(state, evt)
  registry.updateAgent(mapped.runID, mapped.agentID, { toolCalls: toolCallsFor(next, sessionID) })
  return next
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

export interface CommandStorage {
  listWorkflows(): SavedWorkflow[]
  loadWorkflow(name: string): SavedWorkflow | undefined
  saveWorkflow(
    name: string,
    script: string,
    manifest: {
      name: string
      description?: string
      phases?: string[]
      requires?: string[]
      savedFromRunID?: string
      source: "project" | "personal"
    },
  ): Promise<SavedWorkflow>
  saveWorkflowFromFile(name: string): Promise<SavedWorkflow>
  trustWorkflow(name: string): Promise<{ workflow: SavedWorkflow; digest: string } | undefined>
  revokeTrust(name: string): Promise<void>
  workflowTrustState(name: string): "trusted" | "untrusted" | "unknown"
  refreshWorkflows(): Promise<void>
  loadResultArtifactFresh(key: string): Promise<Json | undefined>
}

export interface CommandSupervisor {
  pause(runID: string): boolean
  resume(runID: string): boolean
  stop(runID: string, reason: string): boolean
  startDetached(
    input: Parameters<Supervisor["startDetached"]>[0],
    parent: ParentContext,
  ): { runID: string; done: Promise<RunOutcome> }
  activeRuns(): RunRecord[]
  updateDefaults?(next: Required<UltracodeOptions>): void
}

export type ListedAgent = { id: string; description?: string }

export type AgentListResult =
  | { ok: true; agents: ListedAgent[] }
  | { ok: false; error: string }

/**
 * Shared launch preflight for the tool executor and `/ultracode rerun`:
 * fetch available agents, require the configured default, validate meta.requires.
 */
export async function prepareRunLaunch(input: {
  listAgents: () => Promise<AgentListResult>
  defaultAgent: string
  requires?: readonly string[]
}): Promise<{ ok: true; availableAgents: string[]; agents: ListedAgent[] } | { ok: false; error: string }> {
  const listed = await input.listAgents()
  if (!listed.ok) {
    return {
      ok: false,
      error: `error: could not list available agents (${listed.error}) — refusing to start the run`,
    }
  }
  const availableAgents = listed.agents.map((a) => a.id)
  const requires = input.requires ?? []
  const missingRequires = [...new Set(requires)].filter((id) => !availableAgents.includes(id))
  if (missingRequires.length > 0) {
    return {
      ok: false,
      error:
        `error: workflow requires agent(s) not available: ${missingRequires.join(", ")}. ` +
        `Available agents: ${availableAgents.join(", ") || "(none — create agents or check your install)"}`,
    }
  }
  if (!availableAgents.includes(input.defaultAgent)) {
    return {
      ok: false,
      error:
        `error: default agent "${input.defaultAgent}" is not available in this location. ` +
        `Available agents: ${availableAgents.join(", ") || "(none — create agents or check your install)"}. ` +
        `Set the "agent" plugin option to an available agent id.`,
    }
  }
  return { ok: true, availableAgents, agents: listed.agents }
}

export interface CommandDeps {
  registry: Registry
  supervisor?: CommandSupervisor
  supervisorError?: string
  storage: CommandStorage
  say(sessionID: string, text: string): Promise<void>
  projectRoot: string
  personalWorkflowDir: string
  pendingPermissions?: (sessionID: string) => Promise<string | undefined>
  prepare?: () => Promise<void>
  listAgents: () => Promise<AgentListResult>
  defaultAgent: string
  /** Next-run defaults after overlay merge (required for set/settings). */
  nextRunSettings?: () => PanelSettings
  persistAndRefreshSettings?: (overlay: ReturnType<typeof overlayFromPanel>) => Promise<PanelSettings>
  /** `/ultracode doctor` — plugin wiring diagnostics. */
  doctor?: () => string | Promise<string>
}

export type DoctorReport = {
  version: string
  installDir?: string
  projectRoot: string
  projectID: string
  marker?: { v?: number; version?: string; tui?: number }
  entryFiles: { index: boolean; srcIndex: boolean; tui: boolean; srcTui: boolean }
  rpc: boolean
  supervisor: boolean
  liveRuns: number
  persistedRuns: number
  kvErrorCount: number
  lastKvError?: string
  tuiGate?: { version: string; channel?: string; enabled: boolean }
  duplicateWarning?: string
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    `ultracode doctor ${report.version}`,
    `- installDir: ${report.installDir ?? "(unknown)"}`,
    `- projectRoot: ${report.projectRoot}`,
    `- projectID: ${report.projectID}`,
  ]
  if (report.marker) {
    lines.push(`- marker: v${report.marker.v ?? "?"} version=${report.marker.version ?? "?"} tui=${report.marker.tui ?? 0}`)
  } else {
    lines.push("- marker: (missing — this load may not be an installer tree)")
  }
  lines.push(
    `- entries: index.ts=${report.entryFiles.index ? "yes" : "NO"} src/index.ts=${report.entryFiles.srcIndex ? "yes" : "NO"} tui.tsx=${report.entryFiles.tui ? "yes" : "no"} src/tui.tsx=${report.entryFiles.srcTui ? "yes" : "NO"}`,
  )
  lines.push(`- rpc: ${report.rpc ? "registered" : "unavailable"}`)
  lines.push(`- supervisor: ${report.supervisor ? "loaded" : "unavailable"}`)
  lines.push(`- runs: live=${report.liveRuns} persisted=${report.persistedRuns}`)
  lines.push(`- kv errors: ${report.kvErrorCount}${report.lastKvError ? ` last=${report.lastKvError}` : ""}`)
  if (report.tuiGate) {
    lines.push(
      `- tui gate: version=${report.tuiGate.version} channel=${report.tuiGate.channel ?? "(none)"} enabled=${report.tuiGate.enabled}`,
    )
  }
  if (report.duplicateWarning) lines.push(`- warning: ${report.duplicateWarning}`)
  return lines.join("\n")
}

export interface CommandInvocation {
  sessionID: string
  prompt?: { text?: string }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

function summarizeRun(run: RunRecord): string {
  const counts = countAgents(run)
  const bits = [
    `\`${run.id}\``,
    run.name ?? run.workflowName ?? "(unnamed)",
    `[${run.status}]`,
    `agents ${counts.succeeded + counts.failed + counts.interrupted}/${counts.total}`,
  ]
  const tokens = run.totalTokens
  if (tokens) bits.push(`~${compactTokens(tokens)} tok`)
  if (run.error) bits.push(`error: ${run.error.slice(0, 80)}`)
  return `- ${bits.join(" · ")}`
}

function activeList(deps: CommandDeps): RunRecord[] {
  return deps.supervisor?.activeRuns() ?? deps.registry.activeRuns()
}

/**
 * /ultracode executor. First statement: reject run-starting verbs when the
 * invocation session is owned by an active run (R15 nested-run hole).
 */
export async function handleUltracodeCommand(invocation: CommandInvocation, deps: CommandDeps): Promise<void> {
  // R15: first statement — nested sessions may not start a new run.
  const nestedOwned = deps.registry.isOwnedActive(invocation.sessionID)
  const { sessionID } = invocation
  const argsText = commandArgs(invocation.prompt?.text)
  const { sub, rest } = parseSubcommand(argsText)

  if (nestedOwned && RUN_STARTING_VERBS.has(sub)) {
    await deps.say(sessionID, NESTED_RUN_REFUSED)
    return
  }

  if (deps.prepare) await deps.prepare()

  if (sub === "") {
    await renderDashboard(deps, sessionID)
    return
  }

  if (sub === "help") {
    await deps.say(sessionID, helpText())
    return
  }

  if (sub === "show") {
    const target = resolveActiveTarget(rest, activeList(deps))
    if (!target.ok) {
      await deps.say(sessionID, target.error)
      return
    }
    const run = deps.registry.get(target.runID)
    if (!run) {
      await deps.say(sessionID, `Run \`${target.runID}\` not found. See /ultracode for known runs.`)
      return
    }
    const pending: string[] = []
    if (isActiveRunStatus(run.status) && deps.pendingPermissions) {
      for (const a of run.agents) {
        if (a.status !== "running" || !a.sessionID) continue
        const text = await deps.pendingPermissions(a.sessionID)
        if (text) pending.push(`- \`${a.id}\` (\`${a.sessionID}\`): ${text}`)
      }
    }
    await deps.say(sessionID, formatShowRun(run, pending.length ? { pending } : undefined))
    return
  }

  if (sub === "status") {
    const target = resolveActiveTarget(rest, activeList(deps))
    if (!target.ok) {
      await deps.say(sessionID, target.error)
      return
    }
    const run = deps.registry.get(target.runID)
    if (!run) {
      await deps.say(sessionID, `Run \`${target.runID}\` not found. See /ultracode for known runs.`)
      return
    }
    await deps.say(sessionID, formatStatusRun(run))
    return
  }

  if (sub === "result") {
    const target = resolveActiveTarget(rest, activeList(deps))
    if (!target.ok) {
      await deps.say(sessionID, target.error)
      return
    }
    await renderResult(deps, sessionID, target.runID)
    return
  }

  if (sub === "stop") {
    const target = resolveActiveTarget(rest, activeList(deps))
    if (!target.ok) {
      await deps.say(sessionID, target.error)
      return
    }
    if (!deps.supervisor) {
      await deps.say(sessionID, `error: ${deps.supervisorError ?? "supervisor unavailable"}`)
      return
    }
    const stopped = deps.supervisor.stop(target.runID, "user requested (/ultracode stop)")
    await deps.say(
      sessionID,
      stopped
        ? `Stopping run \`${target.runID}\` — in-flight agents will be interrupted.`
        : `Run \`${target.runID}\` is unknown or already finished. See /ultracode for the list.`,
    )
    return
  }

  if (sub === "pause") {
    const target = resolveActiveTarget(rest, activeList(deps))
    if (!target.ok) {
      await deps.say(sessionID, target.error)
      return
    }
    await pauseRun(deps, sessionID, target.runID)
    return
  }

  if (sub === "resume") {
    const target = resolveActiveTarget(rest, activeList(deps))
    if (!target.ok) {
      await deps.say(sessionID, target.error)
      return
    }
    await resumeRun(deps, sessionID, target.runID)
    return
  }

  if (sub === "rerun") {
    await rerunRun(deps, sessionID, rest)
    return
  }

  if (sub === "save") {
    await saveRun(deps, sessionID, rest)
    return
  }

  if (sub === "trust") {
    await trustWorkflow(deps, sessionID, rest)
    return
  }

  if (sub === "untrust") {
    await untrustWorkflow(deps, sessionID, rest)
    return
  }

  if (sub === "settings") {
    await renderSettings(deps, sessionID, rest)
    return
  }

  if (sub === "set") {
    await setSettings(deps, sessionID, rest)
    return
  }

  if (sub === "doctor") {
    if (!deps.doctor) {
      await deps.say(sessionID, "error: doctor unavailable")
      return
    }
    await deps.say(sessionID, await deps.doctor())
    return
  }

  await deps.say(sessionID, `Unknown /ultracode argument: ${JSON.stringify(sub)}\n\n${helpText()}`)
}

function settingsAckFor(deps: CommandDeps, rest: string, overlay: PanelSettings): string {
  const explicit = firstToken(rest)
  let runID: string | undefined
  let effective: PanelSettings | undefined
  if (explicit) {
    runID = explicit
    const run = deps.registry.get(explicit)
    effective = capturedFromRecord(run)
  } else {
    const active = activeList(deps)
    if (active.length === 1) {
      runID = active[0]!.id
      effective = capturedFromRecord(active[0])
    }
  }
  return formatSettingsAck({ overlay, runID, effective })
}

async function renderSettings(deps: CommandDeps, sessionID: string, rest: string): Promise<void> {
  const overlay = deps.nextRunSettings?.()
  if (!overlay) {
    await deps.say(sessionID, "error: settings unavailable")
    return
  }
  await deps.say(sessionID, settingsAckFor(deps, rest, overlay))
}

async function setSettings(deps: CommandDeps, sessionID: string, rest: string): Promise<void> {
  const parsed = parseSetArgs(rest)
  if (!parsed) {
    await deps.say(sessionID, "Usage: /ultracode set <key> <value>")
    return
  }
  const current = deps.nextRunSettings?.()
  if (!current || !deps.persistAndRefreshSettings) {
    await deps.say(sessionID, "error: settings unavailable")
    return
  }
  const next = applySetValue(current, parsed.key, parsed.value)
  const overlay = next === "ignored" ? current : next
  let applied = overlay
  if (next !== "ignored") {
    applied = await deps.persistAndRefreshSettings(overlayFromPanel(overlay))
  }
  await deps.say(sessionID, settingsAckFor(deps, "", applied))
}

async function renderDashboard(deps: CommandDeps, sessionID: string): Promise<void> {
  const active = activeList(deps)
  const finished = deps.registry.listRecent(50).filter((r) => !isActiveRunStatus(r.status)).slice(0, 5)
  const saved = deps.storage.listWorkflows()
  const parts: string[] = [
    `## Ultracode workflows · plugin ${PLUGIN_VERSION} · min OpenCode beta-${MIN_SUPPORTED_BUILD}`,
    "",
  ]
  parts.push("**Active runs**")
  parts.push(active.length ? active.map(summarizeRun).join("\n") : "(none)")
  parts.push("")
  parts.push("**Recent runs**")
  parts.push(finished.length ? finished.map(summarizeRun).join("\n") : "(none)")
  parts.push("")
  parts.push("**Saved workflows**")
  parts.push(
    saved.length
      ? saved
          .map((w) => {
            const state = deps.storage.workflowTrustState(w.manifest.name)
            const stateText =
              state === "trusted" ? "trusted" : state === "untrusted" ? "untrusted (changed)" : "unknown"
            return `- \`${w.manifest.name}\` — ${w.manifest.description ?? "(no description)"} [${w.manifest.source} · ${stateText}]`
          })
          .join("\n")
      : "(none — save one with `/ultracode save <name>` or `/ultracode save <runID> <name>`)",
  )
  parts.push("")
  parts.push(
    `Workflow dirs: project \`${normalizePath(`${deps.projectRoot}/.opencode/workflows`)}\` (wins) · personal \`${deps.personalWorkflowDir}\``,
  )
  await deps.say(sessionID, parts.join("\n"))
}

async function renderResult(deps: CommandDeps, sessionID: string, runID: string): Promise<void> {
  const run = deps.registry.get(runID)
  if (!run) {
    await deps.say(sessionID, `Run \`${runID}\` not found. See /ultracode for known runs.`)
    return
  }
  if (!run.resultArtifactKey) {
    await deps.say(
      sessionID,
      run.resultTruncated
        ? `Run \`${runID}\` was truncated but no result artifact was recorded.`
        : `Run \`${runID}\` was not truncated — its result is already in the tool output (see /ultracode show).`,
    )
    return
  }
  const result = await deps.storage.loadResultArtifactFresh(run.resultArtifactKey)
  if (result === undefined) {
    await deps.say(sessionID, `No stored result found for run \`${runID}\` (key \`${run.resultArtifactKey}\`).`)
    return
  }
  await deps.say(sessionID, `## Full result — \`${runID}\`\n\n\`\`\`json\n${JSON.stringify(result, null, 1)}\n\`\`\``)
}

async function pauseRun(deps: CommandDeps, sessionID: string, runID: string): Promise<void> {
  const run = deps.registry.get(runID)
  if (!run) {
    await deps.say(sessionID, `Run \`${runID}\` not found. See /ultracode for known runs.`)
    return
  }
  if (run.status === "paused") {
    await deps.say(sessionID, `run \`${runID}\` is already paused`)
    return
  }
  if (!deps.supervisor) {
    await deps.say(sessionID, `error: ${deps.supervisorError ?? "supervisor unavailable"}`)
    return
  }
  const ok = deps.supervisor.pause(runID)
  if (!ok) {
    await deps.say(sessionID, `cannot pause run \`${runID}\` (status: ${run.status})`)
    return
  }
  const next = deps.registry.get(runID)
  await deps.say(sessionID, `Paused run \`${runID}\` — status: ${next?.status ?? "paused"}`)
}

async function resumeRun(deps: CommandDeps, sessionID: string, runID: string): Promise<void> {
  const run = deps.registry.get(runID)
  if (!run) {
    await deps.say(sessionID, `Run \`${runID}\` not found. See /ultracode for known runs.`)
    return
  }
  if (run.status !== "paused") {
    await deps.say(sessionID, `run \`${runID}\` is not paused (status: ${run.status})`)
    return
  }
  if (!deps.supervisor) {
    await deps.say(sessionID, `error: ${deps.supervisorError ?? "supervisor unavailable"}`)
    return
  }
  const ok = deps.supervisor.resume(runID)
  if (!ok) {
    await deps.say(sessionID, `cannot resume run \`${runID}\` (status: ${run.status})`)
    return
  }
  const next = deps.registry.get(runID)
  await deps.say(sessionID, `Resumed run \`${runID}\` — status: ${next?.status ?? "running"}`)
}

async function rerunRun(deps: CommandDeps, sessionID: string, rest: string): Promise<void> {
  const trimmed = rest.trim()
  let source: RunRecord | undefined
  let argsJSON: string | undefined
  if (trimmed) {
    const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
    const runID = m?.[1] ?? ""
    argsJSON = m?.[2]?.trim() || undefined
    source = deps.registry.get(runID)
    if (!source) {
      await deps.say(sessionID, `Run \`${runID}\` not found. See /ultracode for known runs.`)
      return
    }
    if (isActiveRunStatus(source.status)) {
      await deps.say(sessionID, SOURCE_STILL_ACTIVE)
      return
    }
  } else {
    const recent = deps.registry.listRecent(50).filter((r) => !isActiveRunStatus(r.status))
    source = recent[0]
    if (!source) {
      await deps.say(sessionID, "no final run to rerun — pass a runID (/ultracode shows recent)")
      return
    }
  }

  if (source.workflowName) {
    let saved: SavedWorkflow | undefined
    try {
      saved = deps.storage.loadWorkflow(source.workflowName)
    } catch (err) {
      await deps.say(
        sessionID,
        `cannot rerun workflow "${source.workflowName}": ${describeError(err)} Re-trust with /ultracode trust ${source.workflowName}.`,
      )
      return
    }
    if (!saved) {
      await deps.say(
        sessionID,
        `cannot rerun: workflow "${source.workflowName}" is not on disk. Re-save it, then /ultracode trust ${source.workflowName}.`,
      )
      return
    }
    if (sha256(source.script) !== sha256(saved.script)) {
      await deps.say(
        sessionID,
        `cannot rerun: workflow "${source.workflowName}" has changed since this run (script digest ≠ current trusted script). Re-trust the current version with /ultracode trust ${source.workflowName}.`,
      )
      return
    }
  }

  let args: Json | undefined = source.args
  if (argsJSON) {
    try {
      args = JSON.parse(argsJSON) as Json
    } catch (err) {
      await deps.say(sessionID, `error: invalid args JSON — ${describeError(err)}`)
      return
    }
  }

  if (!deps.supervisor) {
    await deps.say(sessionID, `error: ${deps.supervisorError ?? "supervisor unavailable"}`)
    return
  }

  const prep = await prepareRunLaunch({
    listAgents: deps.listAgents,
    defaultAgent: deps.defaultAgent,
    requires: source.meta?.requires,
  })
  if (!prep.ok) {
    await deps.say(sessionID, prep.error)
    return
  }

  let launched: { runID: string; done: Promise<RunOutcome> }
  try {
    launched = deps.supervisor.startDetached(
      {
        script: source.script,
        meta: source.meta,
        args,
        name: source.name,
        workflowName: source.workflowName,
      },
      { sessionID, report: () => {}, availableAgents: prep.availableAgents },
    )
  } catch (err) {
    await deps.say(sessionID, `error: could not rerun — ${describeError(err)}`)
    return
  }

  const newRunID = launched.runID
  const oldRunID = source.id
  await deps.say(sessionID, `rerun started: ${newRunID} (from ${oldRunID})`)
  launched.done
    .then((outcome) => {
      const envelope: RunEnvelope | unknown = outcome?.envelope ?? outcome
      void deps.say(sessionID, JSON.stringify(envelope, null, 1))
    })
    .catch((err: unknown) => {
      void deps.say(sessionID, `rerun ${newRunID} failed: ${describeError(err)}`)
    })
}

async function saveRun(deps: CommandDeps, sessionID: string, rest: string): Promise<void> {
  const saveMatch = /^(\S+)\s+(\S+)$/.exec(rest)
  if (saveMatch) {
    const runID = saveMatch[1]!
    const name = saveMatch[2]!
    const run = deps.registry.get(runID)
    if (!run) {
      await deps.say(sessionID, `Run \`${runID}\` not found. See /ultracode for known runs.`)
      return
    }
    try {
      const display = run.meta?.name ?? run.name
      const saved = await deps.storage.saveWorkflow(name, run.script, {
        name,
        description: display && display !== name ? `saved from run ${run.id} (${display})` : `saved from run ${run.id}`,
        phases: run.meta?.phases,
        requires: run.meta?.requires,
        savedFromRunID: run.id,
        source: "project",
      })
      await saySavedWorkflow(deps, sessionID, saved.manifest.name, saved.manifest.source)
    } catch (err) {
      await deps.say(sessionID, `error: could not save workflow — ${describeError(err)}`)
    }
    return
  }
  const name = rest.trim()
  if (name && !/\s/.test(name) && !deps.registry.get(name)) {
    try {
      const saved = await deps.storage.saveWorkflowFromFile(name)
      await saySavedWorkflow(deps, sessionID, saved.manifest.name, saved.manifest.source)
    } catch (err) {
      await deps.say(sessionID, `error: could not save workflow — ${describeError(err)}`)
    }
    return
  }
  await deps.say(
    sessionID,
    "Usage: /ultracode save <name>\n       /ultracode save <runID> <name>\n(name: lowercase alphanumerics, `-`/`_`, max 64 chars)",
  )
}

async function saySavedWorkflow(
  deps: CommandDeps,
  sessionID: string,
  name: string,
  source: string,
): Promise<void> {
  await deps.say(
    sessionID,
    `Saved workflow \`${name}\` (${source}) — approve it once with \`/ultracode trust ${name}\`, then run it with { workflow: "${name}" }`,
  )
}

async function trustWorkflow(deps: CommandDeps, sessionID: string, rest: string): Promise<void> {
  if (!rest || /\s/.test(rest)) {
    await deps.say(sessionID, "Usage: /ultracode trust <name>")
    return
  }
  try {
    const trusted = await deps.storage.trustWorkflow(rest)
    if (!trusted) {
      await deps.say(sessionID, `Workflow \`${rest}\` not found on disk. See /ultracode for the list.`)
      return
    }
    await deps.say(
      sessionID,
      `Trusted workflow \`${rest}\` (current version, sha256 ${trusted.digest.slice(0, 12)}…) — it can now be run with { workflow: "${rest}" }.`,
    )
  } catch (err) {
    await deps.say(sessionID, `error: could not trust workflow — ${describeError(err)}`)
  }
}

async function untrustWorkflow(deps: CommandDeps, sessionID: string, rest: string): Promise<void> {
  if (!rest || /\s/.test(rest)) {
    await deps.say(sessionID, "Usage: /ultracode untrust <name>")
    return
  }
  try {
    await deps.storage.revokeTrust(rest)
    await deps.say(sessionID, `Revoked trust for workflow \`${rest}\`.`)
  } catch (err) {
    await deps.say(sessionID, `error: could not untrust workflow — ${describeError(err)}`)
  }
}
