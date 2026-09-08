/** @jsxImportSource solid-js */
/**
 * TUI inspect: chip + session.panel two-column inspector + palette + toast.
 * Fail-soft, version-gated. Overlay is panel-hosted (G1 NO-GO: dialog steals keys).
 * Keymap layers live inside mounted components (A4).
 */
import { Plugin } from "@opencode/plugin/tui"
import {
  footerHints,
  formatCounts,
  groupRuns,
  nextSettlePrev,
  runningRunCount,
  settleCandidate,
  shouldEnableTui,
  shortRunID,
  twoColumn,
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
  panel?: { open?: (name: string) => boolean; close?: () => void }
  toast?: { show?: (opts: unknown) => void }
  tabs?: { enabled?: () => boolean; open?: (sessionID: string) => boolean }
  dialog?: {
    prompt?: (opts: { title: string; description?: string; placeholder?: string }) => Promise<string | undefined>
  }
  router?: { current?: () => { type?: string; sessionID?: string } }
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
  client?: { session?: { command?: (input: unknown) => Promise<unknown> } }
  theme?: unknown
  storage?: {
    memory?: <T extends object>(key: string, opts: { initial: T }) => readonly [T, (fn: (draft: T) => void) => void]
  }
}

type InspectState = {
  tick: number
  offset: number
  selected: number
  selectedPhase: number
  paused: boolean
}

const PANEL_KEYS = ["up", "down", "x", "p", "s", "return", "right", "esc"] as const

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

function pickRun(runs: RunView[], sessionID: string | undefined): RunView | undefined {
  if (sessionID) {
    const hit = runs.find((r) => r.agents.some((a) => a.sessionID === sessionID))
    if (hit) return hit
  }
  return runs[0]
}

function phaseAgents(run: RunView, phaseIndex: number): RunView["agents"] {
  if (run.phases.length === 0) return run.agents
  const phase = run.phases[Math.min(Math.max(0, phaseIndex), run.phases.length - 1)]
  return run.agents.filter((a) => a.phase === phase)
}

/**
 * Transport target = the session the inspect panel was opened from
 * (PanelInput.sessionID, else router.current). parentID is null (A1);
 * data.location is a LocationRef (directory), not a session id.
 */
function transportSessionID(
  panelSessionID: string | undefined,
  router: { current?: () => { type?: string; sessionID?: string } } | undefined,
): string | undefined {
  if (panelSessionID) return panelSessionID
  try {
    const route = router?.current?.()
    if (route?.type === "session" && typeof route.sessionID === "string") return route.sessionID
  } catch {
    // ignore
  }
  return undefined
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
      let selectedPhase = 0
      let paused = false
      let requestedPanelFocus = false
      let state: InspectState | undefined
      let setState: ((fn: (draft: InspectState) => void) => void) | undefined

      try {
        const mem = context.storage?.memory?.("ultracode.inspect", {
          initial: { tick: 0, offset: 0, selected: 0, selectedPhase: 0, paused: false } satisfies InspectState,
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
        selectedPhase: state?.selectedPhase ?? selectedPhase,
        paused: state?.paused ?? paused,
      })

      const writeState = (patch: Partial<InspectState>): void => {
        tick = patch.tick ?? tick
        offset = patch.offset ?? offset
        selected = patch.selected ?? selected
        selectedPhase = patch.selectedPhase ?? selectedPhase
        paused = patch.paused ?? paused
        try {
          setState?.((draft) => {
            if (patch.tick !== undefined) draft.tick = patch.tick
            if (patch.offset !== undefined) draft.offset = patch.offset
            if (patch.selected !== undefined) draft.selected = patch.selected
            if (patch.selectedPhase !== undefined) draft.selectedPhase = patch.selectedPhase
            if (patch.paused !== undefined) draft.paused = patch.paused
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

      const sendRunCommand = async (sessionID: string | undefined, text: string): Promise<void> => {
        if (!sessionID) {
          warn("session.command skipped: no transport session id")
          return
        }
        try {
          await context.client?.session?.command?.({
            sessionID,
            command: "ultracode",
            text,
          })
        } catch (err) {
          warn("client.session.command failed", err)
        }
      }

      const moveInspect = (run: RunView | undefined, delta: number): void => {
        if (!run || run.agents.length === 0) return
        const st = readState()
        let ph = run.phases.length === 0 ? 0 : Math.min(st.selectedPhase, Math.max(0, run.phases.length - 1))
        let sel = st.selected
        const rows = () => phaseAgents(run, ph)
        if (delta < 0) {
          if (sel > 0) sel -= 1
          else if (ph > 0) {
            ph -= 1
            sel = Math.max(0, rows().length - 1)
          } else sel = 0
        } else if (delta > 0) {
          const n = rows().length
          if (sel < n - 1) sel += 1
          else if (ph < run.phases.length - 1) {
            ph += 1
            sel = 0
          } else sel = Math.max(0, n - 1)
        }
        const n = phaseAgents(run, ph).length
        const nextSel = n === 0 ? 0 : Math.min(sel, n - 1)
        const off = st.offset
        writeState({
          selectedPhase: ph,
          selected: nextSel,
          offset: nextSel < off ? nextSel : nextSel >= off + PAGE_HEIGHT ? nextSel - PAGE_HEIGHT + 1 : off,
        })
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

      function currentRun(sessionID: string | undefined): RunView | undefined {
        return pickRun(groupRuns(listSessions(context.data)), sessionID)
      }

      function selectedAgent(run: RunView | undefined): RunView["agents"][number] | undefined {
        if (!run) return undefined
        const st = readState()
        const rows = phaseAgents(run, st.selectedPhase)
        return rows[Math.min(st.selected, Math.max(0, rows.length - 1))]
      }

      function drill(sessionID: string | undefined): void {
        try {
          if (!context.ui?.tabs?.enabled?.()) return
          const row = selectedAgent(currentRun(sessionID))
          if (row?.sessionID) context.ui.tabs.open?.(row.sessionID)
        } catch (err) {
          warn("tabs.open failed", err)
        }
      }

      function Panel(input: {
        name?: string
        sessionID?: string
        focused?: boolean
        width?: number
        focus?: () => void
      }) {
        const st = readState()
        void st.tick
        void context.theme
        if (!requestedPanelFocus && input?.name === PANEL_NAME && !input.focused) {
          requestedPanelFocus = true
          try {
            input.focus?.()
          } catch (err) {
            warn("panel focus failed", err)
          }
        }
        const sid = () => transportSessionID(input?.sessionID, context.ui?.router)
        try {
          context.keymap?.layer?.(() => ({
            enabled: () => input?.name === PANEL_NAME,
            priority: 90,
            commands: [
              {
                id: "ultracode.inspect.up",
                title: "Inspect previous phase/row",
                bind: "up",
                run: () => moveInspect(currentRun(input?.sessionID), -1),
              },
              {
                id: "ultracode.inspect.down",
                title: "Inspect next phase/row",
                bind: "down",
                run: () => moveInspect(currentRun(input?.sessionID), 1),
              },
              {
                id: "ultracode.inspect.open",
                title: "Open agent session",
                bind: "return",
                run: () => drill(input?.sessionID),
              },
              {
                id: "ultracode.inspect.open.right",
                title: "Open agent session",
                bind: "right",
                run: () => drill(input?.sessionID),
              },
              {
                id: "ultracode.inspect.stop",
                title: "Stop run",
                bind: "x",
                run: () => {
                  const run = currentRun(input?.sessionID)
                  if (!run) return
                  void sendRunCommand(sid(), `stop ${run.runID}`)
                },
              },
              {
                id: "ultracode.inspect.pause",
                title: "Pause or resume run",
                bind: "p",
                run: () => {
                  const run = currentRun(input?.sessionID)
                  if (!run) return
                  const verb = readState().paused ? "resume" : "pause"
                  void sendRunCommand(sid(), `${verb} ${run.runID}`).then(() => {
                    writeState({ paused: verb === "pause" })
                  })
                },
              },
              {
                id: "ultracode.inspect.save",
                title: "Save workflow",
                bind: "s",
                run: () => {
                  const run = currentRun(input?.sessionID)
                  if (!run) return
                  void (async () => {
                    try {
                      const name = await context.ui?.dialog?.prompt?.({ title: "workflow name" })
                      if (!name) return
                      await sendRunCommand(sid(), `save ${run.runID} ${name}`)
                      try {
                        context.ui?.toast?.show?.({
                          message: `approve with /ultracode trust ${name}`,
                          variant: "info",
                        })
                      } catch (err) {
                        warn("ui.toast.show failed", err)
                      }
                    } catch (err) {
                      warn("save prompt failed", err)
                    }
                  })()
                },
              },
            ],
          }))
        } catch (err) {
          warn("panel keymap.layer failed", err)
        }

        if (input?.name && input.name !== PANEL_NAME) return <box></box>

        const run = currentRun(input?.sessionID)
        if (!run) {
          return (
            <box flexDirection="column">
              <text>ultracode inspect UC-INSPECT</text>
              <text>no ultracode runs</text>
            </box>
          )
        }

        const view = twoColumn(run, {
          width: typeof input?.width === "number" ? input.width : 80,
          selectedPhase: st.selectedPhase,
          offset: st.offset,
          height: PAGE_HEIGHT,
        })
        const hints = footerHints([...PANEL_KEYS])
        const sel = st.selected

        return (
          <box flexDirection="column">
            <text>ultracode inspect UC-INSPECT</text>
            {view.header.map((line) => (
              <text>{line}</text>
            ))}
            <box flexDirection="row">
              <box flexGrow={1}>
                {view.left.map((line) => (
                  <text>{line}</text>
                ))}
              </box>
              <box flexGrow={1}>
                {view.right.map((cells, i) => {
                  if (i === 0) return <text>{cells.join(" ")}</text>
                  const idx = st.offset + i - 1
                  const mark = idx === sel ? ">" : " "
                  return (
                    <text>
                      {mark} {cells.join("  ")}
                    </text>
                  )
                })}
              </box>
            </box>
            <text>{view.page}</text>
            <text>{hints}</text>
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
