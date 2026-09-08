/**
 * Session driver — drives real OpenCode child sessions through the narrow
 * `SessionCtx` capability interface (verified shapes; see docs/SPIKE-FINDINGS.md).
 *
 * Builder B module. Never called from plugin setup() — only from tool/command
 * executors (deadlock rule).
 */
import type { AgentResult, ContextMessage, Json, SessionCtx } from "./types.ts"
import { extractJson, validateJsonSchemaValue } from "./serialize.ts"

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AgentErrorKind = "agent" | "outcome" | "abort" | "schema"

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

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

export interface AgentRunInput {
  prompt: string
  agent?: string
  label?: string
  phase?: string
  schema?: Json
  defaultAgent: string
}

export interface AgentRunHooks {
  /** Fires IMMEDIATELY after session.create resolves (before any prompt). */
  onSessionID(sessionID: string): void
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

    // 2. Create the child session; register the ID immediately.
    const created = await sessions.create({
      title: input.label || input.phase || "workflow agent",
      agent,
    })
    const sessionID = created.id
    hooks.onSessionID(sessionID)

    // Re-check abort after create — interrupt best-effort and bail.
    if (hooks.signal.aborted) {
      await interruptSafe(sessions, sessionID)
      throw new AgentCallError("abort", `agent aborted before prompt (session ${sessionID})`)
    }

    // 3. Prompt -> wait (racing the abort signal).
    await promptAndWait(sessions, sessionID, buildPromptText(input.prompt, input.schema), hooks.signal)

    // 4. Outcome + last assistant message.
    const info = await sessions.get({ sessionID })
    const last = await lastAssistant(sessions, sessionID)
    const text = assistantText(last)
    if (info.outcome !== "succeeded") {
      throw new AgentCallError(
        "outcome",
        `agent session outcome "${info.outcome ?? "unknown"}"${text ? `: ${snippet(text, snippetChars)}` : ""}`,
        text,
      )
    }
    const result: AgentResult = {
      text,
      sessionID,
      agent: last?.agent,
      model: last?.model ?? null,
      tokens: info.tokens ?? last?.tokens,
    }

    // 5. Schema mode: tolerant extraction + validate + ONE repair round.
    if (input.schema !== undefined) {
      const data = await resolveStructured(sessions, sessionID, input.schema, text, hooks.signal)
      result.data = data
    }
    return result
  }

  /**
   * Structured-output resolution: extract -> validate; on failure run exactly
   * ONE repair round (second prompt carrying the validation error), then
   * re-extract + re-validate or throw a typed schema error.
   */
  async function resolveStructured(
    sessions: SessionCtx,
    sessionID: string,
    schema: Json,
    firstText: string,
    signal: AbortSignal,
  ): Promise<Json> {
    let problem: string
    const first = extractJson(firstText)
    if (first.ok) {
      const check = validateJsonSchemaValue(schema, first.value)
      if (check.ok) return first.value
      problem = check.error
    } else {
      problem = first.error
    }

    // ONE repair round: re-prompt with the validation error, then re-validate.
    const repairPrompt =
      "Your previous reply was not a valid JSON value matching the required schema.\n" +
      `Problem: ${problem}\n` +
      "Output only the corrected JSON value — no prose, no markdown fences."
    await promptAndWait(sessions, sessionID, buildPromptText(repairPrompt, schema), signal)
    const info = await sessions.get({ sessionID })
    const last = await lastAssistant(sessions, sessionID)
    const text = assistantText(last)
    if (info.outcome !== "succeeded") {
      throw new AgentCallError(
        "outcome",
        `agent session outcome "${info.outcome ?? "unknown"}" during schema repair${text ? `: ${snippet(text, snippetChars)}` : ""}`,
        text,
      )
    }
    const second = extractJson(text)
    if (!second.ok) {
      throw new AgentCallError("schema", `structured output repair failed: ${second.error}`, text)
    }
    const secondCheck = validateJsonSchemaValue(schema, second.value)
    if (!secondCheck.ok) {
      throw new AgentCallError("schema", `structured output still invalid after repair: ${secondCheck.error}`, text)
    }
    return second.value
  }

  return { runAgent }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function lastAssistant(sessions: SessionCtx, sessionID: string): Promise<ContextMessage | undefined> {
  let messages: ReadonlyArray<ContextMessage>
  try {
    messages = await sessions.context({ sessionID })
  } catch {
    return undefined
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "assistant") return messages[i]
  }
  return undefined
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
