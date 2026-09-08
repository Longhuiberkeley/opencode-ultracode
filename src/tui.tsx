/** @jsxImportSource solid-js */
/**
 * TUI v1 inspect: chip + session.panel + palette command + completion toast.
 * Fail-soft, version-gated. Keymap layers live inside mounted components (A4).
 */
import { Plugin } from "@opencode/plugin/tui"
import { compactElapsed } from "./run-format.ts"
import {
  agentRows,
  formatCounts,
  groupRuns,
  nextSettlePrev,
  paginate,
  phaseColumns,
  runningRunCount,
  settleCandidate,
  shouldEnableTui,
  type RunView,
  type SessionView,
  type SettlePrev,
} from "./tui-render.ts"

const MIN_BUILD = 19271
const QUIET_MS = 5000
const PAGE_HEIGHT = 10
const PANEL_NAME = "ultracode.inspect"

type SessionStore = {
  list?: () => unknown[]
  get?: (id: string) => unknown
  sync?: (id: string) => Promise<void>
  invalidate?: (id: string) => void
}

type DataApi = {
  on?: (type: string, handler: (ev: unknown) => void) => () => void
  session?: SessionStore
}

type UiApi = {
  slot?: (claim: unknown) => () => void
  panel?: { open?: (name: string) => boolean }
  toast?: { show?: (opts: unknown) => void }
  tabs?: { enabled?: () => boolean; open?: (sessionID: string) => boolean }
}

type KeymapApi = {
  layer?: (input: () => unknown) => void
}

type AttentionApi = {
  notify?: (opts: unknown) => Promise<unknown>
}

type TuiContext = {
  app?: { version?: string; channel?: string }
  ui?: UiApi
  keymap?: KeymapApi
  data?: DataApi
  attention?: AttentionApi
  storage?: {
    memory?: <T extends object>(key: string, opts: { initial: T }) => readonly [T, (fn: (draft: T) => void) => void]
  }
}

type InspectState = {
  tick: number
  offset: number
  selected: number
}

function warn(message: string, err?: unknown): void {
  try {
    const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[ultracode] ${message}${detail}`)
  } catch {
    // never throw from logging
  }
}

function asSessionView(value: unknown): SessionView | undefined {
  if (!value || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>
  if (typeof rec.id !== "string" || typeof rec.title !== "string") return undefined
  return {
    id: rec.id,
    title: rec.title,
    outcome: typeof rec.outcome === "string" ? rec.outcome : undefined,
    tokens: rec.tokens as SessionView["tokens"],
    time: rec.time as SessionView["time"],
  }
}

function listSessions(data: DataApi | undefined): SessionView[] {
  try {
    const raw = data?.session?.list?.()
    if (!Array.isArray(raw)) return []
    const out: SessionView[] = []
    for (const item of raw) {
      const view = asSessionView(item)
      if (view) out.push(view)
    }
    return out
  } catch {
    return []
  }
}

function eventSessionID(ev: unknown): string | undefined {
  if (!ev || typeof ev !== "object") return undefined
  const rec = ev as Record<string, unknown>
  const data = rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : rec
  return typeof data.sessionID === "string" ? data.sessionID : undefined
}

function shortRunID(runID: string): string {
  if (runID.length <= 16) return runID
  return runID.slice(0, 16)
}

function pickRun(runs: RunView[], sessionID: string | undefined): RunView | undefined {
  if (sessionID) {
    const hit = runs.find((r) => r.agents.some((a) => a.sessionID === sessionID))
    if (hit) return hit
  }
  return runs[0]
}

export default Plugin.define({
  id: "ultracode-tui",
  setup(context: TuiContext) { // typed locally; Plugin.define Context is host-only
    try {
      const version = String(context.app?.version ?? "")
      const channel = context.app?.channel
      if (!shouldEnableTui(version, channel, MIN_BUILD)) {
        warn(`TUI inspect disabled (version gate): version=${version} channel=${String(channel)} minBuild=${MIN_BUILD}`)
        return
      }

      const settleMap = new Map<string, SettlePrev>()
      let tick = 0
      let offset = 0
      let selected = 0
      let state: InspectState | undefined
      let setState: ((fn: (draft: InspectState) => void) => void) | undefined

      try {
        const mem = context.storage?.memory?.("ultracode.inspect", {
          initial: { tick: 0, offset: 0, selected: 0 } satisfies InspectState,
        })
        if (mem) {
          state = mem[0]
          setState = mem[1]
        }
      } catch (err) {
        warn("storage.memory unavailable", err)
      }

      const readState = (): InspectState => ({
        tick: state?.tick ?? tick,
        offset: state?.offset ?? offset,
        selected: state?.selected ?? selected,
      })

      const writeState = (patch: Partial<InspectState>): void => {
        tick = patch.tick ?? tick
        offset = patch.offset ?? offset
        selected = patch.selected ?? selected
        try {
          setState?.((draft) => {
            if (patch.tick !== undefined) draft.tick = patch.tick
            if (patch.offset !== undefined) draft.offset = patch.offset
            if (patch.selected !== undefined) draft.selected = patch.selected
          })
        } catch (err) {
          warn("storage.memory update failed", err)
        }
      }

      const bump = (): void => {
        writeState({ tick: readState().tick + 1 })
      }

      const maybeSettle = (): void => {
        try {
          const nowTs = Date.now()
          const runs = groupRuns(listSessions(context.data))
          for (const run of runs) {
            const prev = settleMap.get(run.runID)
            if (settleCandidate(prev, run, QUIET_MS, nowTs)) {
              const msg = `ultracode run ${shortRunID(run.runID)} finished: ${formatCounts(run.counts)}`
              try {
                context.ui?.toast?.show?.({ message: msg, variant: "success" })
              } catch (err) {
                warn("ui.toast.show failed", err)
              }
              try {
                void context.attention?.notify?.({ message: msg, sound: { name: "done" } })
              } catch (err) {
                warn("attention.notify failed", err)
              }
              settleMap.set(run.runID, { ...nextSettlePrev(prev, run, nowTs), fired: true })
            } else {
              settleMap.set(run.runID, nextSettlePrev(prev, run, nowTs))
            }
          }
        } catch (err) {
          warn("settle scan failed", err)
        }
      }

      const onSessionEvent = (ev: unknown): void => {
        const sessionID = eventSessionID(ev)
        if (sessionID) {
          try {
            context.data?.session?.invalidate?.(sessionID)
          } catch (err) {
            warn("data.session.invalidate failed", err)
          }
          try {
            const sync = context.data?.session?.sync
            if (sync) {
              void sync(sessionID)
                .catch((err) => warn("data.session.sync failed", err))
                .finally(() => {
                  bump()
                  maybeSettle()
                })
              return
            }
          } catch (err) {
            warn("data.session.sync failed", err)
          }
        }
        bump()
        maybeSettle()
      }

      const eventNames = [
        "session.created",
        "session.updated",
        "session.deleted",
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.usage.updated",
        "session.inbox.delivered",
        "session.inbox.enqueued",
      ]
      for (const type of eventNames) {
        try {
          context.data?.on?.(type, onSessionEvent)
        } catch (err) {
          warn(`data.on(${type}) failed`, err)
        }
      }

      const openPanel = (): void => {
        try {
          context.ui?.panel?.open?.(PANEL_NAME)
        } catch (err) {
          warn("ui.panel.open failed", err)
        }
      }

      function Chip() {
        try {
          context.keymap?.layer?.(() => ({
            enabled: true,
            priority: 80,
            commands: [
              {
                id: "ultracode.inspect",
                title: "Ultracode inspect",
                description: "Open the ultracode run inspect panel",
                palette: true,
                bind: false,
                run: () => {
                  openPanel()
                },
              },
            ],
          }))
        } catch (err) {
          warn("chip keymap.layer failed", err)
        }
        void readState().tick
        const n = runningRunCount(groupRuns(listSessions(context.data)))
        if (n === 0) return <text></text>
        return <text>ultracode · {n} running</text>
      }

      function Panel(input: {
        name?: string
        sessionID?: string
        focused?: boolean
        width?: number
      }) {
        const st = readState()
        void st.tick
        try {
          context.keymap?.layer?.(() => ({
            enabled: () => Boolean(input?.focused) && input?.name === PANEL_NAME,
            priority: 90,
            commands: [
              {
                id: "ultracode.inspect.up",
                title: "Inspect previous row",
                bind: "up",
                run: () => {
                  const runs = groupRuns(listSessions(context.data))
                  const run = pickRun(runs, input?.sessionID)
                  const n = run?.agents.length ?? 0
                  if (n === 0) return
                  const next = Math.max(0, readState().selected - 1)
                  writeState({ selected: next, offset: Math.min(readState().offset, next) })
                },
              },
              {
                id: "ultracode.inspect.down",
                title: "Inspect next row",
                bind: "down",
                run: () => {
                  const runs = groupRuns(listSessions(context.data))
                  const run = pickRun(runs, input?.sessionID)
                  const n = run?.agents.length ?? 0
                  if (n === 0) return
                  const next = Math.min(n - 1, readState().selected + 1)
                  const off = readState().offset
                  writeState({
                    selected: next,
                    offset: next >= off + PAGE_HEIGHT ? next - PAGE_HEIGHT + 1 : off,
                  })
                },
              },
              {
                id: "ultracode.inspect.open",
                title: "Open agent session",
                bind: "return",
                run: () => {
                  try {
                    if (!context.ui?.tabs?.enabled?.()) return
                    const runs = groupRuns(listSessions(context.data))
                    const run = pickRun(runs, input?.sessionID)
                    const row = run?.agents[readState().selected]
                    if (row?.sessionID) context.ui.tabs.open?.(row.sessionID)
                  } catch (err) {
                    warn("tabs.open failed", err)
                  }
                },
              },
            ],
          }))
        } catch (err) {
          warn("panel keymap.layer failed", err)
        }

        if (input?.name && input.name !== PANEL_NAME) return <box></box>

        const runs = groupRuns(listSessions(context.data))
        const run = pickRun(runs, input?.sessionID)
        if (!run) {
          return (
            <box flexDirection="column">
              <text>ultracode inspect UC-INSPECT</text>
              <text>no ultracode runs</text>
            </box>
          )
        }

        const rows = agentRows(run)
        const page = paginate(rows, st.offset, PAGE_HEIGHT)
        const sel = Math.min(st.selected, Math.max(0, run.agents.length - 1))
        const elapsed = compactElapsed(Date.now() - run.startedAt)
        const columns = phaseColumns(run)

        return (
          <box flexDirection="column">
            <text>ultracode inspect UC-INSPECT</text>
            <text>
              {shortRunID(run.runID)} · {formatCounts(run.counts)} · {elapsed}
            </text>
            <box flexDirection="row">
              <box flexGrow={1}>
                {columns.map((c) => (
                  <text>
                    {c.phase} {c.done}/{c.total}
                  </text>
                ))}
              </box>
              <box flexGrow={1}>
                {page.window.map((cells, i) => {
                  const idx = st.offset + i
                  const mark = idx === sel ? ">" : " "
                  return <text>{mark} {cells.join("  ")}</text>
                })}
              </box>
            </box>
            <text>{page.label}</text>
          </box>
        )
      }

      try {
        context.ui?.slot?.({ append: "prompt.footer.status", render: Chip })
      } catch (err) {
        warn("ui.slot chip failed", err)
      }
      try {
        context.ui?.slot?.({ append: "session.panel", render: Panel })
      } catch (err) {
        warn("ui.slot panel failed", err)
      }
    } catch (err) {
      warn("TUI setup failed", err)
    }
  },
} as never)
