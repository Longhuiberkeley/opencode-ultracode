/**
 * Session driver — drives real OpenCode child sessions through the narrow
 * `SessionCtx` capability interface (verified shapes; see docs/SPIKE-FINDINGS.md).
 *
 * Builder B module. Never called from plugin setup() — only from tool/command
 * executors (deadlock rule).
 */
import type { AgentResult, ContextMessage, Json, SessionCtx, TokenUsage } from "./types.ts"
import { extractJson, validateJsonSchemaValue } from "./serialize.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AgentErrorKind = "agent" | "outcome" | "abort" | "schema" | "extraction"

/** Typed agent-call failure (registry records `error`, callers may branch on kind). */
export class AgentCallError extends Error {
  readonly kind: AgentErrorKind
  /** Assistant text extracted alongside the failure, when any. */
  readonly text?: string

  constructor(kind: AgentErrorKind, message: string, text?: string) {
    super(message)
    this.name = "AgentCallError"
    this.kind = kind
    this.text = text
  }
}

/**
 * Typed failure raised when a child session registers after its run closed:
 * the child was never prompted, never gained ownership, and is interrupted
 * best-effort. Extends AgentCallError("abort") so the runner records the
 * agent as interrupted (not failed).
 */
export class RunClosedError extends AgentCallError {
  constructor(message: string) {
    super("abort", message)
    this.name = "RunClosedError"
  }
}

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

export interface AgentRunInput {
  prompt: string
  agent?: string
  /** Pinned model for the resolved agent (from user agent config); applied at create. */
  model?: { providerID: string; id: string; variant?: string }
  label?: string
  phase?: string
  schema?: Json
  defaultAgent: string
  /** Full run id for child titles `[uc:<runID> <ord> <phase> p:<parent>] <label>`. */
  runID?: string
  /** Agent ordinal within the run ("a1", "a2", ...). */
  ord?: string
  /** Parent (invocation) session — title `p:` segment + create metadata. */
  parentSessionID?: string
  /** Saved-workflow name, when launched via {workflow: "name"}. */
  workflowName?: string
}

export interface AgentRunHooks {
  /**
   * Fires IMMEDIATELY after session.create resolves (before any prompt).
   * Return "rejected" to refuse registration (run closed): the driver then
   * interrupts that child best-effort and throws RunClosedError BEFORE any
   * prompt — the child never gains ownership and is never prompted.
   */
  onSessionID(sessionID: string): "accepted" | "rejected" | void
  /** Abort: prompt/wait race an abort-driven rejection + best-effort interrupt. */
  signal: AbortSignal
}

export interface SessionDriver {
  runAgent(
    input: AgentRunInput,
    availableAgents: string[] | undefined,
    hooks: AgentRunHooks,
  ): Promise<AgentResult>
}

export interface SessionDriverOptions {
  /** Cap on text length embedded into error messages (default 500 chars). */
  errorTextSnippetChars?: number
}

/** Result of structured-output resolution (fields present when repaired). */
interface StructuredOutcome {
  data: Json
  repaired: boolean
  text?: string
  model?: AgentResult["model"]
  tokens?: TokenUsage
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createSessionDriver(sessions: SessionCtx, options: SessionDriverOptions = {}): SessionDriver {
  const snippetChars = options.errorTextSnippetChars ?? 500

  async function runAgent(
    input: AgentRunInput,
    availableAgents: string[] | undefined,
    hooks: AgentRunHooks,
  ): Promise<AgentResult> {
    // 1. Resolve agent — fail fast with the available list.
    const agent = resolveAgent(input, availableAgents)

    // 2. Create the child session; register the ID immediately. A pinned
    // model (from the user's agent config) rides along at create time —
    // server-side session.create does not apply global agent pins itself.
    const created = await sessions.create({
      title: buildChildTitle(input),
      agent,
      ...(input.model !== undefined ? { model: input.model } : {}),
      metadata: stampChildMetadata(input),
    })
    const sessionID = created.id
    const registration = hooks.onSessionID(sessionID)
    if (registration === "rejected") {
      // Registration refused (run closed): interrupt the orphaned child
      // best-effort and bail BEFORE prompting — no ownership, no prompt.
      await interruptSafe(sessions, sessionID)
      throw new RunClosedError(
        `workflow run closed while this agent was being created (session ${sessionID}) — it was never started`,
      )
    }

    // Re-check abort after create — interrupt best-effort and bail.
    if (hooks.signal.aborted) {
      await interruptSafe(sessions, sessionID)
      throw new AgentCallError("abort", `agent aborted before prompt (session ${sessionID})`)
    }

    // 3. Prompt -> wait (racing the abort signal).
    await promptAndWait(sessions, sessionID, buildPromptText(input.prompt, input.schema), hooks.signal)

    // 4. Outcome + last assistant message. A failed outcome is the primary
    // error; a succeeded outcome with a missing/unreadable assistant message
    // is a typed extraction error (never an empty successful reply).
    const info = await sessions.get({ sessionID })
    const first = await readAssistantReply(sessions, sessionID, info.outcome)
    if (info.outcome !== "succeeded") {
      const detail = describeSessionFailure(info, first.message)
      throw new AgentCallError(
        "outcome",
        `agent session outcome "${info.outcome ?? "unknown"}"${detail ? `: ${snippet(detail, snippetChars)}` : ""}` +
          (first.text ? `${detail ? " | " : ": "}${snippet(first.text, snippetChars)}` : ""),
        first.text,
      )
    }
    const result: AgentResult = {
      text: first.text,
      sessionID,
      agent: first.message?.agent,
      model: first.message?.model ?? null,
      tokens: info.tokens ?? first.message?.tokens,
    }

    // 5. Schema mode: tolerant extraction + validate + ONE repair round.
    // After a successful repair, .text/.model/.tokens describe the REPAIRED
    // response (attempt 2), consistent with .data.
    if (input.schema !== undefined) {
      const structured = await resolveStructured(sessions, sessionID, input.schema, first, hooks.signal)
      result.data = structured.data
      if (structured.repaired) {
        result.text = structured.text ?? first.text
        result.model = structured.model ?? null
        result.tokens = structured.tokens
      }
    }
    return result
  }

  interface AssistantReply {
    text: string
    message: ContextMessage | undefined
  }

  /**
   * Read the last assistant message of a settled turn. Throws typed extraction
   * errors when the context fetch fails or no assistant message exists — but
   * only for succeeded outcomes (callers surface the outcome error first).
   */
  async function readAssistantReply(
    sessions: SessionCtx,
    sessionID: string,
    outcome: string | undefined,
  ): Promise<AssistantReply> {
    let messages: ReadonlyArray<ContextMessage>
    try {
      messages = await sessions.context({ sessionID })
    } catch (err) {
      if (outcome === "succeeded") {
        throw new AgentCallError("extraction", `failed to read session context: ${errorMessage(err)}`)
      }
      return { text: "", message: undefined }
    }
    let last: ContextMessage | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === "assistant") {
        last = messages[i]
        break
      }
    }
    if (!last && outcome === "succeeded") {
      throw new AgentCallError("extraction", `no assistant message in session ${sessionID} (outcome "succeeded")`)
    }
    return { text: assistantText(last), message: last }
  }

  /**
   * Structured-output resolution: extract -> validate; on failure run exactly
   * ONE repair round (second prompt carrying the validation error), then
   * re-extract + re-validate or throw a typed schema error. On success via
   * repair, the returned text/model/tokens describe the REPAIRED response.
   */
  async function resolveStructured(
    sessions: SessionCtx,
    sessionID: string,
    schema: Json,
    first: AssistantReply,
    signal: AbortSignal,
  ): Promise<StructuredOutcome> {
    let problem: string
    const extracted = extractJson(first.text)
    if (extracted.ok) {
      const check = validateJsonSchemaValue(schema, extracted.value)
      if (check.ok) return { data: extracted.value, repaired: false }
      problem = check.error
    } else {
      problem = extracted.error
    }

    // ONE repair round: re-prompt with the validation error, then re-validate.
    const repairPrompt =
      "Your previous reply was not a valid JSON value matching the required schema.\n" +
      `Problem: ${problem}\n` +
      "Output only the corrected JSON value — no prose, no markdown fences."
    await promptAndWait(sessions, sessionID, buildPromptText(repairPrompt, schema), signal)
    const info = await sessions.get({ sessionID })
    const reply = await readAssistantReply(sessions, sessionID, info.outcome)
    if (info.outcome !== "succeeded") {
      throw new AgentCallError(
        "outcome",
        `agent session outcome "${info.outcome ?? "unknown"}" during schema repair${reply.text ? `: ${snippet(reply.text, snippetChars)}` : ""}`,
        reply.text,
      )
    }
    const second = extractJson(reply.text)
    if (!second.ok) {
      throw new AgentCallError("schema", `structured output repair failed: ${second.error}`, reply.text)
    }
    const secondCheck = validateJsonSchemaValue(schema, second.value)
    if (!secondCheck.ok) {
      throw new AgentCallError("schema", `structured output still invalid after repair: ${secondCheck.error}`, reply.text)
    }
    return {
      data: second.value,
      repaired: true,
      text: reply.text,
      model: reply.message?.model ?? null,
      tokens: info.tokens ?? reply.message?.tokens,
    }
  }

  return { runAgent }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort failure detail for a non-succeeded outcome: the server-side
 * error text (when exposed) plus any error part on the last message. Empty
 * string when nothing is available — never throws.
 */
export function describeSessionFailure(
  info: { error?: string },
  last: ContextMessage | undefined,
): string {
  const parts: string[] = []
  if (typeof info.error === "string" && info.error.length > 0) parts.push(info.error)
  if (last?.content) {
    for (const part of last.content) {
      if (part.type === "error" && typeof part.text === "string" && part.text.length > 0) {
        parts.push(part.text)
        break // one error part is enough signal
      }
    }
  }
  if (parts.length === 0 && last?.finish && last.finish !== "stop" && last.finish !== "unknown") {
    parts.push(`finish: ${last.finish}`)
  }
  return parts.join(" | ")
}

function resolveAgent(input: AgentRunInput, availableAgents: string[] | undefined): string {
  if (input.agent !== undefined) {
    if (availableAgents !== undefined && !availableAgents.includes(input.agent)) {
      throw new AgentCallError(
        "agent",
        `unknown agent "${input.agent}" — available agents: ${availableAgents.join(", ")}`,
      )
    }
    return input.agent
  }
  if (availableAgents !== undefined && !availableAgents.includes(input.defaultAgent)) {
    throw new AgentCallError(
      "agent",
      `default agent "${input.defaultAgent}" is not available — available agents: ${availableAgents.join(", ")}. ` +
        "Pass an explicit agent via agent(prompt, { agent: \"...\" }) or configure the plugin default.",
    )
  }
  return input.defaultAgent
}

/** Final prompt text: schema mode appends the strict JSON instruction. */
export function buildPromptText(prompt: string, schema?: Json): string {
  if (schema === undefined) return prompt
  return (
    prompt +
    "\n\nRespond with ONLY a JSON value matching this JSON schema — no prose, no markdown fences:\n" +
    JSON.stringify(schema)
  )
}

async function promptAndWait(sessions: SessionCtx, sessionID: string, text: string, signal: AbortSignal): Promise<void> {
  const interrupt = () => {
    void interruptSafe(sessions, sessionID)
  }
  await raceAbort(sessions.prompt({ sessionID, text }), signal, interrupt)
  await raceAbort(sessions.wait({ sessionID }), signal, interrupt)
}

/**
 * Race a session promise against an AbortSignal. On abort: best-effort
 * `session.interrupt({ sessionID, continue: false })`, then reject.
 */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      onAbort()
      reject(new AgentCallError("abort", "agent aborted: run stopping"))
      return
    }
    const onAbortFn = () => {
      cleanup()
      onAbort()
      reject(new AgentCallError("abort", "agent aborted: run stopping"))
    }
    const cleanup = () => signal.removeEventListener("abort", onAbortFn)
    signal.addEventListener("abort", onAbortFn, { once: true })
    p.then(
      (v) => {
        cleanup()
        resolve(v)
      },
      (err) => {
        cleanup()
        reject(err)
      },
    )
  })
}

async function interruptSafe(sessions: SessionCtx, sessionID: string): Promise<void> {
  try {
    await sessions.interrupt({ sessionID, continue: false })
  } catch {
    // best-effort
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Child session title (A1 primary contract):
 *   `[uc:<fullRunID> <ord> <phase> p:<parentSessionID>] <label>`
 * Phase segment omitted when absent: `[uc:<runID> <ord> p:<parent>] <label>`.
 * `p:` is present whenever the parent session is known.
 * Direct driver use (no runID) is a plain label.
 */
export function buildChildTitle(input: {
  label?: string
  phase?: string
  runID?: string
  ord?: string
  parentSessionID?: string
}): string {
  const label = input.label || input.phase || "agent"
  if (input.runID === undefined) return label
  const bits: string[] = [input.runID]
  if (input.ord !== undefined) {
    bits.push(input.ord)
    if (input.phase) bits.push(input.phase)
  }
  if (input.parentSessionID) bits.push(`p:${input.parentSessionID}`)
  return `[uc:${bits.join(" ")}] ${label}`
}

/**
 * Parse a child title. Tolerant of the legacy `[uc:<tag>] label` shape
 * (runID=tag, ord/phase/parent undefined). Returns undefined when the title is
 * not a `[uc:…]` child title.
 */
export function parseChildTitle(title: string): {
  runID?: string
  ord?: string
  phase?: string
  label?: string
  parent?: string
} | undefined {
  const m = /^\[uc:([^\]]+)\](?:\s+(.*))?$/.exec(title)
  if (!m) return undefined
  const inner = m[1]!.trim()
  if (!inner) return undefined
  const label = m[2]
  const parts = inner.split(/\s+/).filter((p) => p.length > 0)
  let parent: string | undefined
  const last = parts[parts.length - 1]
  if (last?.startsWith("p:")) {
    const id = last.slice(2)
    parent = id.length > 0 ? id : undefined
    parts.pop()
  }
  if (parts.length === 0) {
    return { runID: undefined, ord: undefined, phase: undefined, label, parent }
  }
  if (parts.length === 1) {
    return { runID: parts[0], ord: undefined, phase: undefined, label, parent }
  }
  if (parts.length === 2) {
    return { runID: parts[0], ord: parts[1], phase: undefined, label, parent }
  }
  return { runID: parts[0], ord: parts[1], phase: parts.slice(2).join(" "), label, parent }
}

/** D12 stamp — written on create, never read back (A1). */
function stampChildMetadata(input: AgentRunInput): Record<string, unknown> | undefined {
  if (input.runID === undefined) return undefined
  const uc: Record<string, unknown> = { v: 1, run: input.runID, parent: input.parentSessionID }
  if (input.ord !== undefined) uc.ord = input.ord
  if (input.phase !== undefined) uc.phase = input.phase
  if (input.label !== undefined) uc.label = input.label
  if (input.workflowName !== undefined) uc.wf = input.workflowName
  return { uc }
}

/** Concat of content parts where part.type === "text" (verified extraction rule). */
export function assistantText(message: ContextMessage | undefined): string {
  if (!message) return ""
  const content = message.content
  if (content === undefined) return typeof message.text === "string" ? message.text : ""
  let out = ""
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") out += part.text
  }
  return out
}

function snippet(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
