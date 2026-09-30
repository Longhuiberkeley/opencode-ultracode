/**
 * Pure tool-event reducer (plugin-free). Counts unique tool calls per session.
 *
 * Event names confirmed from `@opencode/client` dist typings (plugin re-exports
 * the client event union; `@opencode/plugin` dist has no local copies):
 *   session.tool.called   — SessionToolCalled  (`data.sessionID`, `data.id`)
 *   session.tool.success  — SessionToolSuccess (`data.sessionID`, `data.id`)
 *   session.tool.failed   — SessionToolFailed  (`data.sessionID`, `data.id`)
 * Family-adjacent but NOT counted: session.tool.progress, session.tool.input.*.
 *
 * Dedupe key is `data.id` per session. Events missing sessionID or id are ignored.
 */
export interface ToolEvent {
  type: string
  data?: { sessionID?: string; id?: string }
}

export interface ToolEventState {
  /** sessionID -> set of seen tool-call ids */
  seen: Map<string, Set<string>>
}

const COUNTED_TYPES: ReadonlySet<string> = new Set([
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
])

export function emptyToolEventState(): ToolEventState {
  return { seen: new Map() }
}

export function reduceToolEvent(state: ToolEventState, evt: ToolEvent): ToolEventState {
  if (!COUNTED_TYPES.has(evt.type)) return state
  const sessionID = evt.data?.sessionID
  const id = evt.data?.id
  if (typeof sessionID !== "string" || sessionID.length === 0) return state
  if (typeof id !== "string" || id.length === 0) return state
  let ids = state.seen.get(sessionID)
  if (!ids) {
    ids = new Set()
    state.seen.set(sessionID, ids)
  }
  ids.add(id)
  return state
}

export function toolCallsFor(state: ToolEventState, sessionID: string): number {
  return state.seen.get(sessionID)?.size ?? 0
}
