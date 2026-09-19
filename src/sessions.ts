/**
 * Session driver — drives real OpenCode child sessions through the narrow
 * `SessionCtx` capability interface (verified shapes; see docs/SPIKE-FINDINGS.md).
 *
 * Builder B module. Never called from plugin setup() — only from tool/command
 * executors (deadlock rule).
 */
import type { AgentResult, ContextMessage, ContextMessageError, Json, SessionCtx, TokenUsage } from "./types.ts"
import { extractJson, validateJsonSchemaValue } from "./serialize.ts"
import { classifyFailure, readFailureStatus, type FailureClassification } from "./failure-classify.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AgentErrorKind = "agent" | "outcome" | "abort" | "schema" | "extraction"

/** Typed agent-call failure (registry records `error`, callers may branch on kind). */
export class AgentCallError extends Error {
  readonly kind: AgentErrorKind
  /** Assistant text extracted alongside the failure, when any. */
  readonly text?: string
  /**
   * Structured provider-failure classification on outcome failures, when the
   * failed turn exposed an error signal. Retry/failover policy branches on
   * `.failure.class` instead of re-parsing error strings (see
   * src/failure-classify.ts).
   */
  readonly failure?: FailureClassification
  /**
   * CONTINUATION-ONLY signal: the continued turn produced no usable progress —
   * empty assistant text and no token growth (production: instant 0-token
   * provider deaths). The runner promotes such a re-failure to quota-shaped
   * handling instead of burning more same-model probes. Undefined on the
   * first (created-session) turn.
   */
  readonly noProgress?: boolean

  constructor(
    kind: AgentErrorKind,
    message: string,
    text?: string,
    failure?: FailureClassification,
    noProgress?: boolean,
  ) {
    super(message)
    this.name = "AgentCallError"
    this.kind = kind
    this.text = text
    this.failure = failure
    this.noProgress = noProgress
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
  /** Model for the resolved agent (explicit override or config pin); applied at create. */
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
  /**
   * Continue an EXISTING session (same-session burst retry; later: quota
   * failover). Shares runAgent's step 3-5 code (prompt -> wait -> outcome ->
   * structured extraction) but NEVER calls session.create: a failed session
   * that already did work is never replaced by a fresh one. `model` is applied
   * via session.switchModel BEFORE the prompt (feature-detected).
   *
   * Optional and feature-detected: hand-built drivers may omit it, and the
   * runner then refuses to retry (surfacing the typed error) instead of
   * spawning a fresh session.
   */
  continueAgent?(input: AgentContinueInput, hooks: AgentContinueHooks): Promise<AgentResult>
}

/**
 * Continue an existing child session in place. The session keeps its sessionID,
 * message history and registry ownership; only the prompt (and optionally the
 * model) changes.
 */
export interface AgentContinueInput {
  sessionID: string
  /** Instruction for the continued turn — see buildContinuationPrompt. */
  continuationPrompt: string
  /** Applied via session.switchModel before prompting; absent = same model. */
  model?: { providerID: string; id: string; variant?: string }
  /** Same structured-output contract as the original call (repair round included). */
  schema?: Json
}

export interface AgentContinueHooks {
  /** Abort: prompt/wait race an abort-driven rejection + best-effort interrupt. */
  signal: AbortSignal
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

/**
 * Build the session driver. The returned driver ALWAYS supports
 * `continueAgent` (`Required<SessionDriver>`): the optional seam on
 * SessionDriver exists only so hand-built doubles can stay small.
 */
export function createSessionDriver(sessions: SessionCtx, options: SessionDriverOptions = {}): Required<SessionDriver> {
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

    // 3.-5. Prompt -> wait -> outcome -> structured extraction. Shared with
    // continueAgent so run and continue can never diverge.
    return completeTurn(sessionID, buildPromptText(input.prompt, input.schema), input.schema, hooks.signal)
  }

  /**
   * Continue an existing session with a new prompt (same-session retry or
   * failover): optional model switch BEFORE the prompt, then the exact same
   * prompt -> wait -> outcome -> structured extraction sequence as runAgent.
   * Never creates, interrupts-before-prompt or re-registers a session.
   */
  async function continueAgent(input: AgentContinueInput, hooks: AgentContinueHooks): Promise<AgentResult> {
    if (input.model !== undefined) await applyModelSwitch(input.sessionID, input.model)
    // Snapshot the session token total BEFORE prompting so a re-failure can be
    // recognized as a 0-work instant death (AgentCallError.noProgress).
    const beforeTokens = await readTokenTotal(input.sessionID)
    return completeTurn(
      input.sessionID,
      buildPromptText(input.continuationPrompt, input.schema),
      input.schema,
      hooks.signal,
      { beforeTokens, continuation: true },
    )
  }

  interface TurnContext {
    /** Token total observed just before this turn (continue only). */
    beforeTokens?: number
    /** True for a continued turn — outcome failures carry the noProgress signal. */
    continuation?: boolean
  }

  /**
   * Steps 3-5, shared by runAgent and continueAgent: prompt -> wait (racing
   * the abort signal) -> outcome + last assistant message -> optional schema
   * resolution. A non-succeeded outcome throws the typed outcome error; a
   * CONTINUED turn additionally reports whether the turn produced any work.
   */
  async function completeTurn(
    sessionID: string,
    promptText: string,
    schema: Json | undefined,
    signal: AbortSignal,
    turn: TurnContext = {},
  ): Promise<AgentResult> {
    await promptAndWait(sessions, sessionID, promptText, signal)

    // Outcome + last assistant message. A failed outcome is the primary
    // error; a succeeded outcome with a missing/unreadable assistant message
    // is a typed extraction error (never an empty successful reply).
    const info = await sessions.get({ sessionID })
    const first = await readAssistantReply(sessions, sessionID, info.outcome)
    if (info.outcome !== "succeeded") {
      const detail = describeSessionFailure(info, first.message)
      const tokens = info.tokens ?? first.message?.tokens
      throw new AgentCallError(
        "outcome",
        `agent session outcome "${info.outcome ?? "unknown"}"${detail ? `: ${snippet(detail, snippetChars)}` : ""}` +
          (first.text ? `${detail ? " | " : ": "}${snippet(first.text, snippetChars)}` : ""),
        first.text,
        classifySessionFailure(info, first.message, first.text),
        turn.continuation === true ? !turnProgressed(turn.beforeTokens, tokenTotal(tokens), first.text) : undefined,
      )
    }
    const result: AgentResult = {
      text: first.text,
      sessionID,
      agent: first.message?.agent,
      model: first.message?.model ?? null,
      tokens: info.tokens ?? first.message?.tokens,
    }

    // Schema mode: tolerant extraction + validate + ONE repair round.
    // After a successful repair, .text/.model/.tokens describe the REPAIRED
    // response (attempt 2), consistent with .data.
    if (schema !== undefined) {
      const structured = await resolveStructured(sessions, sessionID, schema, first, signal)
      result.data = structured.data
      if (structured.repaired) {
        result.text = structured.text ?? first.text
        result.model = structured.model ?? null
        result.tokens = structured.tokens
      }
    }
    return result
  }

  /**
   * Apply a requested model switch before a continuation prompt.
   * Feature-detected: the verified host session domain exposes switchModel,
   * but the narrow SessionCtx (verified doubles included) may omit it. A
   * requested switch that cannot be applied is a typed failure — silently
   * continuing on the dead model would guarantee another instant failure.
   */
  async function applyModelSwitch(
    sessionID: string,
    model: { providerID: string; id: string; variant?: string },
  ): Promise<void> {
    const switchModel = sessions.switchModel
    if (typeof switchModel !== "function") {
      throw new AgentCallError(
        "agent",
        `session.switchModel is unavailable — cannot continue session ${sessionID} on ${model.providerID}/${model.id}`,
      )
    }
    await switchModel.call(sessions, { sessionID, model })
  }

  /** Best-effort session token total; undefined when unavailable. Never throws. */
  async function readTokenTotal(sessionID: string): Promise<number | undefined> {
    try {
      const info = await sessions.get({ sessionID })
      return tokenTotal(info.tokens)
    } catch {
      return undefined
    }
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
      const detail = describeSessionFailure(info, reply.message)
      throw new AgentCallError(
        "outcome",
        `agent session outcome "${info.outcome ?? "unknown"}" during schema repair${detail ? `: ${snippet(detail, snippetChars)}` : ""}` +
          (reply.text ? `${detail ? " | " : ": "}${snippet(reply.text, snippetChars)}` : ""),
        reply.text,
        classifySessionFailure(info, reply.message, reply.text),
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

  return { runAgent, continueAgent }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort failure detail for a non-succeeded outcome: the server-side
 * error text (when exposed), the structured provider error on the last
 * message, any error part on that message, and — only when nothing else is
 * available — the finish reason. Empty string when nothing is available —
 * never throws.
 */
export function describeSessionFailure(
  info: { error?: string },
  last: ContextMessage | undefined,
): string {
  const parts: string[] = []
  const pushUnique = (value: string) => {
    if (value.length > 0 && !parts.includes(value)) parts.push(value)
  }
  if (typeof info.error === "string" && info.error.length > 0) pushUnique(info.error)
  pushUnique(structuredFailureText(last?.error))
  if (last?.content) {
    for (const part of last.content) {
      if (part.type === "error" && typeof part.text === "string" && part.text.length > 0) {
        pushUnique(part.text)
        break // one error part is enough signal
      }
    }
  }
  if (parts.length === 0 && last?.finish && last.finish !== "stop" && last.finish !== "unknown") {
    parts.push(`finish: ${last.finish}`)
  }
  return parts.join(" | ")
}

/**
 * Human-readable form of the structured provider error on a failed assistant
 * message: `message (type, status)`. Empty when nothing usable is present.
 */
function structuredFailureText(err: ContextMessageError | undefined): string {
  if (err === undefined) return ""
  const message = typeof err.message === "string" ? err.message.trim() : ""
  const bits: string[] = []
  if (typeof err.type === "string" && err.type.trim().length > 0) bits.push(err.type.trim())
  const status = readFailureStatus(err)
  if (status !== undefined) bits.push(String(status))
  const suffix = bits.length > 0 ? ` (${bits.join(", ")})` : ""
  return message.length > 0 ? `${message}${suffix}` : bits.join(", ")
}

/**
 * Classify a non-succeeded turn from its structured error plus the failure
 * detail and assistant text. Never throws; callers branch on `.class`.
 */
function classifySessionFailure(
  info: { error?: string },
  last: ContextMessage | undefined,
  text: string,
): FailureClassification {
  const detail = describeSessionFailure(info, last)
  const signal = detail.length > 0 && text.length > 0 ? `${detail}\n${text}` : detail.length > 0 ? detail : text
  return classifyFailure(last?.error, signal)
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

/**
 * Continuation instruction for a same-session retry/failover. WHY it embeds
 * the ORIGINAL request: production rate-limit deaths returned 0 tokens with no
 * assistant text, so a bare "continue" would ask the model to continue
 * nothing. Re-anchoring the request makes the retry correct whether or not the
 * failed turn produced partial work, and the "don't repeat" clause keeps a
 * partial turn from being redone wholesale.
 */
export function buildContinuationPrompt(originalPrompt: string, reason: string): string {
  return [
    "The previous turn of this session was interrupted by a provider failure before it completed.",
    `Reason: ${reason}`,
    "Your previous turn may be EMPTY — if it produced no usable output, do the original task now from the start.",
    "If you already produced partial work, do not repeat it; finish the task and reply with the final result only.",
    "",
    "Original request:",
    originalPrompt,
  ].join("\n")
}

/** Sum of a token usage, or undefined when no usage was exposed. */
function tokenTotal(tokens: TokenUsage | undefined): number | undefined {
  if (tokens === undefined) return undefined
  return (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0)
}

/**
 * Did a continued turn produce usable work? Assistant text is authoritative;
 * with none, token growth decides. An empty turn with no measurable growth
 * (both totals equal, or no usage exposed at all) is the 0-token instant-death
 * shape (see AgentCallError.noProgress). A reported positive total without a
 * baseline still reads as progress, so a genuine burst keeps its bounded probe.
 */
function turnProgressed(before: number | undefined, after: number | undefined, text: string): boolean {
  if (text.length > 0) return true
  if (before !== undefined && after !== undefined) return after > before
  return after !== undefined && after > 0
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
