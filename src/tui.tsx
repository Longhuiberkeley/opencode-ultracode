/** @jsxImportSource solid-js */
/**
 * TUI inspect: chip + session.panel two-column inspector + palette + toast.
 * Fail-soft, version-gated. Overlay is panel-hosted (G1 NO-GO: dialog steals keys).
 * Keymap layers live inside mounted components (A4).
 *
 * Per-frame derivation lives in tui-render.inspectModel — component bodies
 * only read accessors/store ticks and paint the model.
 */
import { Plugin } from "@opencode/plugin/tui"
import {
  detailsFromMessages,
  footerHints,
  formatCounts,
  groupRuns,
  inspectModel,
  inspectPhaseList,
  nextSettlePrev,
  parseRunAck,
  planSettleCheck,
  shouldEnableTui,
  shortRunID,
  type InspectModel,
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
  message?: {
    list?: (sessionID: string) => unknown[]
    sync?: (sessionID: string) => Promise<void>
    invalidate?: (sessionID: string) => void
  }
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
  client?: {
    session?: {
      command?: (input: unknown) => Promise<unknown>
      context?: (input: unknown) => Promise<unknown>
    }
    message?: { list?: (input: unknown) => Promise<unknown> }
  }
  theme?: unknown
  storage?: {
    memory?: <T extends object>(key: string, opts: { initial: T }) => readonly [T, (fn: (draft: T) => void) => void]
  }
}

type InspectState = {
  tick: number
  offset: number
  selected: number
  phase: string
  /** null = associate from panel parent via defaultRunIndex */
  runIndex: number | null
}

type RowDetails = { model?: { providerID: string; id: string }; toolCalls: number }

const PANEL_KEYS = ["up", "down", "x", "p", "s", "return", "right", "esc", "[", "]"] as const

function warn(message: string, err?: unknown): void {
  try {
    const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[ultracode] ${message}${detail}`)
  } catch {
    // never throw from logging
  }
}

function asSessionView(value: unknown, details?: RowDetails): SessionView | undefined {
  if (!value || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>
  if (typeof rec.id !== "string" || typeof rec.title !== "string") return undefined
  return {
    id: rec.id,
    title: rec.title,
    outcome: typeof rec.outcome === "string" ? rec.outcome : undefined,
    tokens: rec.tokens as SessionView["tokens"],
    time: rec.time as SessionView["time"],
    agent: typeof rec.agent === "string" ? rec.agent : undefined,
    model: details?.model,
    toolCalls: details?.toolCalls,
  }
}

function listSessions(data: DataApi | undefined, details: Map<string, RowDetails>): SessionView[] {
  try {
    const raw = data?.session?.list?.()
    if (!Array.isArray(raw)) return []
    const out: SessionView[] = []
    for (const item of raw) {
      const rec = item && typeof item === "object" ? (item as { id?: string }) : undefined
      const extra = rec?.id ? details.get(rec.id) : undefined
      const view = asSessionView(item, extra)
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

function eventText(ev: unknown): string | undefined {
  if (!ev || typeof ev !== "object") return undefined
  const rec = ev as Record<string, unknown>
  const data = rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : rec
  if (typeof data.text === "string") return data.text
  if (typeof rec.text === "string") return rec.text
  return undefined
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
  setup(context: TuiContext) {
    // typed locally; Plugin.define Context is host-only
    try {
      const version = String(context.app?.version ?? "")
      const channel = context.app?.channel
      if (!shouldEnableTui(version, channel, MIN_BUILD)) {
        warn(`TUI inspect disabled (version gate): version=${version} channel=${String(channel)} minBuild=${MIN_BUILD}`)
        return
      }

      let disposed = false
      const unsubs: Array<() => void> = []
      const settlePrev = new Map<string, SettlePrev>()
      const lastChange: Record<string, number> = {}
      const fired: Record<string, number> = {}
      const pauseIntent = new Map<string, boolean>()
      const detailCache = new Map<string, RowDetails>()
      const detailInflight = new Map<string, Promise<void>>()

      let tick = 0
      let offset = 0
      let selected = 0
      let phase = "all"
      let runIndex: number | null = null
      let requestedPanelFocus = false
      let state: InspectState | undefined
      let setState: ((fn: (draft: InspectState) => void) => void) | undefined

      try {
        const mem = context.storage?.memory?.("ultracode.inspect", {
          initial: {
            tick: 0,
            offset: 0,
            selected: 0,
            phase: "all",
            runIndex: null,
          } satisfies InspectState,
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
        phase: state?.phase ?? phase,
        runIndex: state?.runIndex ?? runIndex,
      })

      const writeState = (patch: Partial<InspectState>): void => {
        if (disposed) return
        tick = patch.tick ?? tick
        offset = patch.offset ?? offset
        selected = patch.selected ?? selected
        phase = patch.phase ?? phase
        if (patch.runIndex !== undefined) runIndex = patch.runIndex
        try {
          setState?.((draft) => {
            if (patch.tick !== undefined) draft.tick = patch.tick
            if (patch.offset !== undefined) draft.offset = patch.offset
            if (patch.selected !== undefined) draft.selected = patch.selected
            if (patch.phase !== undefined) draft.phase = patch.phase
            if (patch.runIndex !== undefined) draft.runIndex = patch.runIndex
          })
        } catch (err) {
          warn("storage.memory update failed", err)
        }
      }

      const bump = (): void => {
        if (disposed) return
        writeState({ tick: readState().tick + 1 })
      }

      const sessionsNow = (): SessionView[] => listSessions(context.data, detailCache)

      const modelNow = (parentSessionID: string | undefined): InspectModel => {
        const st = readState()
        return inspectModel(
          sessionsNow(),
          {
            runIndex: st.runIndex ?? undefined,
            phase: st.phase,
            offset: st.offset,
            selected: st.selected,
            parentSessionID,
          },
          Date.now(),
        )
      }

      const toast = (opts: { message: string; variant?: string }): void => {
        if (disposed) return
        try {
          context.ui?.toast?.show?.(opts)
        } catch (err) {
          warn("ui.toast.show failed", err)
        }
      }

      const fireSettle = (nowTs: number): void => {
        if (disposed) return
        try {
          const runs = groupRuns(sessionsNow())
          for (const run of runs) {
            const prev = settlePrev.get(run.runID)
            const next = nextSettlePrev(prev, run, nowTs)
            settlePrev.set(run.runID, next)
            if (run.settled) lastChange[run.runID] = next.lastChangeAt
          }
          for (const runID of planSettleCheck(fired, lastChange, nowTs, QUIET_MS)) {
            const run = runs.find((r) => r.runID === runID)
            const msg = `ultracode run ${shortRunID(runID)} finished: ${formatCounts(run?.counts ?? { total: 0, done: 0, failed: 0 })}`
            toast({ message: msg, variant: "success" })
            try {
              void context.attention?.notify?.({ message: msg, sound: { name: "done" } })
            } catch (err) {
              warn("attention.notify failed", err)
            }
            fired[runID] = nowTs
            const prev = settlePrev.get(runID)
            if (prev) settlePrev.set(runID, { ...prev, fired: true })
          }
        } catch (err) {
          warn("settle scan failed", err)
        }
      }

      const onSessionEvent = (ev: unknown): void => {
        if (disposed) return
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
                  if (disposed) return
                  bump()
                  fireSettle(Date.now())
                })
              return
            }
          } catch (err) {
            warn("data.session.sync failed", err)
          }
        }
        bump()
        fireSettle(Date.now())
      }

      const onSynthetic = (ev: unknown): void => {
        if (disposed) return
        const text = eventText(ev)
        if (!text) {
          onSessionEvent(ev)
          return
        }
        const ack = parseRunAck(text)
        if (ack?.runID && (ack.kind === "paused" || ack.kind === "resumed")) {
          pauseIntent.set(ack.runID, ack.kind === "paused")
        }
        onSessionEvent(ev)
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
          const off = context.data?.on?.(type, onSessionEvent)
          if (typeof off === "function") unsubs.push(off)
        } catch (err) {
          warn(`data.on(${type}) failed`, err)
        }
      }
      try {
        const off = context.data?.on?.("session.synthetic", onSynthetic)
        if (typeof off === "function") unsubs.push(off)
      } catch (err) {
        warn("data.on(session.synthetic) failed", err)
      }

      const settleTimer = setInterval(() => {
        if (disposed) return
        fireSettle(Date.now())
      }, 1000)
      if (typeof (settleTimer as { unref?: () => void }).unref === "function") {
        ;(settleTimer as { unref: () => void }).unref()
      }

      const openPanel = (): void => {
        if (disposed) return
        try {
          context.ui?.panel?.open?.(PANEL_NAME)
        } catch (err) {
          warn("ui.panel.open failed", err)
        }
      }

      const sendRunCommand = async (sessionID: string | undefined, text: string): Promise<void> => {
        if (disposed) return
        if (!sessionID) {
          warn("session.command skipped: no transport session id")
          throw new Error("no transport session id")
        }
        const command = context.client?.session?.command
        if (typeof command !== "function") throw new Error("session.command unavailable")
        await command({
          sessionID,
          command: "ultracode",
          text,
        })
      }

      const ensureDetails = (sessionID: string | undefined): void => {
        if (disposed || !sessionID) return
        if (detailCache.has(sessionID) || detailInflight.has(sessionID)) return
        const work = (async () => {
          let messages: unknown[] = []
          try {
            await context.data?.session?.message?.sync?.(sessionID)
            const listed = context.data?.session?.message?.list?.(sessionID)
            if (Array.isArray(listed) && listed.length > 0) messages = listed
          } catch (err) {
            warn("data.session.message sync failed", err)
          }
          if (messages.length === 0) {
            try {
              const ctxMsgs = await context.client?.session?.context?.({ sessionID })
              if (Array.isArray(ctxMsgs)) messages = ctxMsgs
            } catch (err) {
              warn("client.session.context failed", err)
            }
          }
          if (messages.length === 0) {
            try {
              const listed = await context.client?.message?.list?.({ sessionID })
              const rec = listed && typeof listed === "object" ? (listed as { data?: unknown }) : undefined
              if (Array.isArray(rec?.data)) messages = rec.data
              else if (Array.isArray(listed)) messages = listed
            } catch (err) {
              warn("client.message.list failed", err)
            }
          }
          if (disposed) return
          detailCache.set(sessionID, detailsFromMessages(messages as Parameters<typeof detailsFromMessages>[0]))
          bump()
        })().catch((err) => warn("selected-row details fetch failed", err))
        detailInflight.set(sessionID, work)
        void work.finally(() => {
          detailInflight.delete(sessionID)
        })
      }

      const moveInspect = (parentSessionID: string | undefined, delta: number): void => {
        if (disposed) return
        const model = modelNow(parentSessionID)
        const run = model.run
        if (!run) return
        const phases = inspectPhaseList(run)
        let ph = model.selectedPhase
        let sel = model.selected
        const rowsFor = (p: string) => run.agents.filter((a) => (p === "all" ? true : p === "-" ? !a.phase : a.phase === p))
        if (delta < 0) {
          if (sel > 0) sel -= 1
          else {
            const pi = phases.indexOf(ph)
            if (pi > 0) {
              ph = phases[pi - 1]!
              sel = Math.max(0, rowsFor(ph).length - 1)
            } else sel = 0
          }
        } else if (delta > 0) {
          const n = rowsFor(ph).length
          if (sel < n - 1) sel += 1
          else {
            const pi = phases.indexOf(ph)
            if (pi >= 0 && pi < phases.length - 1) {
              ph = phases[pi + 1]!
              sel = 0
            } else sel = Math.max(0, n - 1)
          }
        }
        const n = rowsFor(ph).length
        const nextSel = n === 0 ? 0 : Math.min(sel, n - 1)
        const off = readState().offset
        writeState({
          phase: ph,
          selected: nextSel,
          offset: nextSel < off ? nextSel : nextSel >= off + PAGE_HEIGHT ? nextSel - PAGE_HEIGHT + 1 : off,
          runIndex: model.runIndex,
        })
      }

      const cycleRun = (parentSessionID: string | undefined, delta: number): void => {
        if (disposed) return
        const model = modelNow(parentSessionID)
        const n = model.runs.length
        if (n === 0) return
        const next = (model.runIndex + delta + n) % n
        writeState({ runIndex: next, phase: "all", selected: 0, offset: 0 })
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
        const n = modelNow(undefined).runningCount
        if (n === 0) return <text></text>
        return <text>ultracode · {n} running</text>
      }

      function drill(parentSessionID: string | undefined): void {
        if (disposed) return
        try {
          if (!context.ui?.tabs?.enabled?.()) return
          const row = modelNow(parentSessionID).selectedSessionID
          if (row) context.ui.tabs.open?.(row)
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
        const selectedRunID = (): string | undefined => modelNow(input?.sessionID).run?.runID
        try {
          context.keymap?.layer?.(() => ({
            enabled: () => input?.name === PANEL_NAME,
            priority: 90,
            commands: [
              {
                id: "ultracode.inspect.up",
                title: "Inspect previous phase/row",
                bind: "up",
                run: () => moveInspect(input?.sessionID, -1),
              },
              {
                id: "ultracode.inspect.down",
                title: "Inspect next phase/row",
                bind: "down",
                run: () => moveInspect(input?.sessionID, 1),
              },
              {
                id: "ultracode.inspect.run.prev",
                title: "Previous run",
                bind: "[",
                run: () => cycleRun(input?.sessionID, -1),
              },
              {
                id: "ultracode.inspect.run.next",
                title: "Next run",
                bind: "]",
                run: () => cycleRun(input?.sessionID, 1),
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
                  const runID = selectedRunID()
                  if (!runID) return
                  void sendRunCommand(sid(), `stop ${runID}`).catch((err) => {
                    if (disposed) return
                    toast({ message: `ultracode stop failed: ${err instanceof Error ? err.message : String(err)}`, variant: "error" })
                  })
                },
              },
              {
                id: "ultracode.inspect.pause",
                title: "Pause or resume run",
                bind: "p",
                run: () => {
                  const runID = selectedRunID()
                  if (!runID) return
                  const verb = pauseIntent.get(runID) ? "resume" : "pause"
                  void sendRunCommand(sid(), `${verb} ${runID}`)
                    .then(() => {
                      if (disposed) return
                      pauseIntent.set(runID, verb === "pause")
                      bump()
                    })
                    .catch((err) => {
                      if (disposed) return
                      toast({
                        message: `ultracode ${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
                        variant: "error",
                      })
                    })
                },
              },
              {
                id: "ultracode.inspect.save",
                title: "Save workflow",
                bind: "s",
                run: () => {
                  const runID = selectedRunID()
                  if (!runID) return
                  void (async () => {
                    try {
                      const name = await context.ui?.dialog?.prompt?.({ title: "workflow name" })
                      if (disposed || !name) return
                      await sendRunCommand(sid(), `save ${runID} ${name}`)
                      toast({
                        message: `approve with /ultracode trust ${name}`,
                        variant: "info",
                      })
                    } catch (err) {
                      if (disposed) return
                      warn("save prompt failed", err)
                      toast({
                        message: `ultracode save failed: ${err instanceof Error ? err.message : String(err)}`,
                        variant: "error",
                      })
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

        const model = modelNow(input?.sessionID)
        ensureDetails(model.selectedSessionID)
        if (!model.run) {
          return (
            <box flexDirection="column">
              <text>ultracode inspect UC-INSPECT</text>
              <text>no ultracode runs</text>
            </box>
          )
        }

        const hints = footerHints([...PANEL_KEYS])
        const sel = model.selected

        return (
          <box flexDirection="column">
            <text>ultracode inspect UC-INSPECT</text>
            <text>{model.header}</text>
            <box flexDirection="row">
              <box flexGrow={1}>
                {model.left.map((line) => (
                  <text>{line}</text>
                ))}
              </box>
              <box flexGrow={1}>
                <text>
                  {model.selectedPhase} · {model.run.agents.length} agents
                </text>
                {model.rows.map((cells, i) => {
                  const idx = model.offset + i
                  const mark = idx === sel ? ">" : " "
                  return (
                    <text>
                      {mark} {cells.join("  ")}
                    </text>
                  )
                })}
              </box>
            </box>
            <text>{model.pageLabel}</text>
            <text>{hints}</text>
          </box>
        )
      }

      try {
        const off = context.ui?.slot?.({ append: "prompt.footer.status", render: Chip })
        if (typeof off === "function") unsubs.push(off)
      } catch (err) {
        warn("ui.slot chip failed", err)
      }
      try {
        const off = context.ui?.slot?.({ append: "session.panel", render: Panel })
        if (typeof off === "function") unsubs.push(off)
      } catch (err) {
        warn("ui.slot panel failed", err)
      }

      return () => {
        disposed = true
        clearInterval(settleTimer)
        for (const key of Object.keys(lastChange)) delete lastChange[key]
        for (const key of Object.keys(fired)) delete fired[key]
        settlePrev.clear()
        pauseIntent.clear()
        detailInflight.clear()
        for (const off of unsubs) {
          try {
            off()
          } catch (err) {
            warn("unsubscribe failed", err)
          }
        }
        unsubs.length = 0
      }
    } catch (err) {
      warn("TUI setup failed", err)
    }
  },
} as never)
