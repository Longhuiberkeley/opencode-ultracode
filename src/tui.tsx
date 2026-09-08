/** @jsxImportSource solid-js */
/**
 * TUI inspect: chip + session.panel two-column inspector + palette + toast.
 * Fail-soft, version-gated. Overlay is panel-hosted (G1 NO-GO: dialog steals keys).
 * Keymap layers live inside mounted components (A4).
 *
 * Per-frame derivation lives in tui-render.inspectModel — component bodies
 * only read accessors/store ticks and paint the model.
 */
import { appendFileSync } from "node:fs"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal } from "solid-js"
import {
  applySettleTick,
  cacheDecision,
  detailsCacheEntry,
  detailsFromMessages,
  footerHints,
  formatCounts,
  groupRuns,
  inspectModel,
  inspectPhaseList,
  inspectSelFromSelection,
  parseRunAck,
  cycleRunSelection,
  selectForOpen,
  selectionMapKey,
  shouldEnableTui,
  shortRunID,
  type DetailCacheEntry,
  type InspectModel,
  type InspectSelection,
  type SessionView,
  type SettleMaps,
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
}

type RowDetails = DetailCacheEntry

const PANEL_KEYS = ["up", "down", "x", "p", "s", "return", "right", "esc", "[", "]"] as const

function probeKind(kind: string, data: unknown = {}): void {
  const path = process.env.PROBE_TUI_OUT
  if (!path) return
  try {
    appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // ignore
  }
}

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
    model: details?.model ?? undefined,
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
      const settleMaps: SettleMaps = {
        lastChange: {},
        fired: {},
        prev: new Map(),
      }
      const pauseIntent = new Map<string, boolean>()
      const detailCache = new Map<string, RowDetails>()
      const detailInflight = new Map<string, Promise<void>>()
      const selMap: Record<string, InspectSelection> = {}

      const [tick, setTick] = createSignal(Date.now())
      const [sel, setSel] = createSignal<InspectSelection>({ phase: "all", offset: 0, selected: 0 })
      let requestedPanelFocus = false
      let setState: ((fn: (draft: InspectState) => void) => void) | undefined

      try {
        const mem = context.storage?.memory?.("ultracode.inspect", {
          initial: {
            tick: Date.now(),
          } satisfies InspectState,
        })
        if (mem) {
          setState = mem[1]
        }
      } catch (err) {
        warn("storage.memory unavailable", err)
      }

      const bump = (): void => {
        if (disposed) return
        const now = Date.now()
        setTick(now)
        try {
          setState?.((draft) => {
            draft.tick = now
          })
        } catch (err) {
          warn("storage.memory update failed", err)
        }
      }

      const commitSel = (next: InspectSelection): void => {
        selMap[selectionMapKey(next.parentSessionID, next.runID)] = next
        setSel(next)
        bump()
      }

      const currentSessionSnapshot = (): SessionView[] => listSessions(context.data, detailCache)

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
          const snapshot = currentSessionSnapshot()
          const model = inspectModel(snapshot, { offset: 0, selected: 0 }, nowTs)
          const due = applySettleTick(model.runs, settleMaps, nowTs, QUIET_MS)
          for (const runID of due) {
            const verified = inspectModel(currentSessionSnapshot(), { offset: 0, selected: 0 }, nowTs)
            const run = verified.runs.find((r) => r.runID === runID)
            if (!run?.settled) {
              delete settleMaps.lastChange[runID]
              continue
            }
            const msg = `ultracode run ${shortRunID(runID)} finished: ${formatCounts(run.counts)}`
            toast({ message: msg, variant: "success" })
            try {
              void context.attention?.notify?.({ message: msg, sound: { name: "done" } })
            } catch (err) {
              warn("attention.notify failed", err)
            }
          }
        } catch (err) {
          warn("settle scan failed", err)
        }
      }

      const eventType = (ev: unknown): string | undefined => {
        if (!ev || typeof ev !== "object") return undefined
        const rec = ev as Record<string, unknown>
        return typeof rec.type === "string" ? rec.type : undefined
      }

      const onSessionEvent = (ev: unknown): void => {
        if (disposed) return
        const sessionID = eventSessionID(ev)
        if (sessionID) {
          const decision = cacheDecision(detailCache.get(sessionID), { type: eventType(ev) ?? "session.updated", sessionID })
          if (decision === "delete") detailCache.delete(sessionID)
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
        const cached = detailCache.get(sessionID)
        if (cached && !cached.tentative) return
        if (detailInflight.has(sessionID)) return
        const work = (async () => {
          let messages: unknown[] = []
          let fetched = false
          try {
            await context.data?.session?.message?.sync?.(sessionID)
            const listed = context.data?.session?.message?.list?.(sessionID)
            if (Array.isArray(listed)) {
              messages = listed
              fetched = true
            }
          } catch (err) {
            warn("data.session.message sync failed", err)
          }
          if (messages.length === 0) {
            try {
              const ctxMsgs = await context.client?.session?.context?.({ sessionID })
              if (Array.isArray(ctxMsgs)) {
                messages = ctxMsgs
                fetched = true
              }
            } catch (err) {
              warn("client.session.context failed", err)
            }
          }
          if (messages.length === 0) {
            try {
              const listed = await context.client?.message?.list?.({ sessionID })
              const rec = listed && typeof listed === "object" ? (listed as { data?: unknown }) : undefined
              if (Array.isArray(rec?.data)) {
                messages = rec.data
                fetched = true
              } else if (Array.isArray(listed)) {
                messages = listed
                fetched = true
              }
            } catch (err) {
              warn("client.message.list failed", err)
            }
          }
          if (disposed) return
          if (!fetched) return
          detailCache.set(sessionID, detailsCacheEntry(detailsFromMessages(messages as Parameters<typeof detailsFromMessages>[0])))
          bump()
        })().catch((err) => warn("selected-row details fetch failed", err))
        detailInflight.set(sessionID, work)
        void work.finally(() => {
          detailInflight.delete(sessionID)
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
        const runningCount = createMemo(() => {
          return inspectModel(currentSessionSnapshot(), { offset: 0, selected: 0 }, tick()).runningCount
        })
        return (
          <text>
            {runningCount() === 0 ? "" : `ultracode · ${runningCount()} running`}
          </text>
        )
      }

      function Panel(input: {
        name?: string
        sessionID?: string
        focused?: boolean
        width?: number
        focus?: () => void
      }) {
        void context.theme
        if (input?.name === PANEL_NAME && !input.focused) {
          requestedPanelFocus = true
          try {
            input.focus?.()
          } catch (err) {
            warn("panel focus failed", err)
          }
        }

        const openParent = () => transportSessionID(input?.sessionID, context.ui?.router)

        const model = createMemo((): InspectModel => {
          const snapshot = currentSessionSnapshot()
          const runs = groupRuns(snapshot)
          const parent = openParent()
          const opened = selectForOpen(sel(), runs, parent)
          return inspectModel(snapshot, inspectSelFromSelection(opened, runs), tick())
        })

        createEffect(() => {
          const parent = openParent()
          const runs = groupRuns(currentSessionSnapshot())
          void tick()
          const next = selectForOpen(sel(), runs, parent)
          if (
            next.parentSessionID !== sel().parentSessionID ||
            next.runID !== sel().runID ||
            next.phase !== sel().phase ||
            next.offset !== sel().offset ||
            next.selected !== sel().selected
          ) {
            commitSel(next)
          }
        })

        createEffect(() => {
          const id = model().selectedSessionID
          void tick()
          const entry = id ? detailCache.get(id) : undefined
          if (id && (!entry || entry.tentative)) ensureDetails(id)
        })

        const sid = () => openParent()
        const selectedRunID = (): string | undefined => model().run?.runID

        const moveInspect = (delta: number): void => {
          if (disposed) return
          const m = model()
          const run = m.run
          if (!run) return
          const phases = inspectPhaseList(run)
          let ph = m.selectedPhase
          let row = m.selected
          const rowsFor = (p: string) => run.agents.filter((a) => (p === "all" ? true : p === "-" ? !a.phase : a.phase === p))
          if (delta < 0) {
            if (row > 0) row -= 1
            else {
              const pi = phases.indexOf(ph)
              if (pi > 0) {
                ph = phases[pi - 1]!
                row = Math.max(0, rowsFor(ph).length - 1)
              } else row = 0
            }
          } else if (delta > 0) {
            const n = rowsFor(ph).length
            if (row < n - 1) row += 1
            else {
              const pi = phases.indexOf(ph)
              if (pi >= 0 && pi < phases.length - 1) {
                ph = phases[pi + 1]!
                row = 0
              } else row = Math.max(0, n - 1)
            }
          }
          const n = rowsFor(ph).length
          const nextSel = n === 0 ? 0 : Math.min(row, n - 1)
          const off = sel().offset
          commitSel({
            parentSessionID: openParent(),
            runID: run.runID,
            phase: ph,
            selected: nextSel,
            offset: nextSel < off ? nextSel : nextSel >= off + PAGE_HEIGHT ? nextSel - PAGE_HEIGHT + 1 : off,
          })
        }

        const cycleRun = (delta: number): void => {
          if (disposed) return
          const m = model()
          if (m.runs.length === 0) return
          const parent = openParent()
          const cycled = cycleRunSelection(selMap, m.runs, m.run?.runID, delta, parent)
          commitSel({
            parentSessionID: parent,
            runID: cycled.runID,
            phase: cycled.selection.phase,
            offset: cycled.selection.offset,
            selected: cycled.selection.selected,
            rowInWindow: cycled.selection.rowInWindow,
          })
        }

        const drill = (): void => {
          if (disposed) return
          try {
            if (!context.ui?.tabs?.enabled?.()) return
            const row = model().selectedSessionID
            if (row) context.ui.tabs.open?.(row)
          } catch (err) {
            warn("tabs.open failed", err)
          }
        }

        try {
          context.keymap?.layer?.(() => ({
            enabled: () => !input?.name || input.name === PANEL_NAME,
            priority: 200,
            commands: [
              {
                id: "ultracode.inspect.up",
                title: "Inspect previous phase/row",
                bind: "up",
                run: () => moveInspect(-1),
              },
              {
                id: "ultracode.inspect.down",
                title: "Inspect next phase/row",
                bind: "down",
                run: () => {
                  moveInspect(1)
                  probeKind("inspect-down", { sel: sel(), selected: model().selected, rowInWindow: model().rowInWindow })
                },
              },
              {
                id: "ultracode.inspect.run.prev",
                title: "Previous run",
                bind: "[",
                run: () => cycleRun(-1),
              },
              {
                id: "ultracode.inspect.run.next",
                title: "Next run",
                bind: "]",
                run: () => cycleRun(1),
              },
              {
                id: "ultracode.inspect.open",
                title: "Open agent session",
                bind: "return",
                run: () => drill(),
              },
              {
                id: "ultracode.inspect.open.right",
                title: "Open agent session",
                bind: "right",
                run: () => drill(),
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

        const hints = footerHints([...PANEL_KEYS])

        return (
          <box flexDirection="column">
            <text>ultracode inspect UC-INSPECT</text>
            {model().run ? (
              <box flexDirection="column">
                <text>{model().header}</text>
                <box flexDirection="row">
                  <box flexGrow={1}>
                    <text>{model().left.join("\n")}</text>
                  </box>
                  <box flexGrow={1}>
                    <text>
                      {model().selectedPhase} · {model().run!.agents.length} agents
                      {"\n"}
                      {model().window
                        .map((cells, i) => {
                          const abs = model().offset + i
                          const mark = i === model().rowInWindow ? ">" : " "
                          return `${mark} ${abs + 1} ${cells.join("  ")}`
                        })
                        .join("\n")}
                    </text>
                  </box>
                </box>
                <text>{model().pageLabel}</text>
              </box>
            ) : (
              <text>no ultracode runs</text>
            )}
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
        for (const key of Object.keys(settleMaps.lastChange)) delete settleMaps.lastChange[key]
        for (const key of Object.keys(settleMaps.fired)) delete settleMaps.fired[key]
        settleMaps.prev.clear()
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
