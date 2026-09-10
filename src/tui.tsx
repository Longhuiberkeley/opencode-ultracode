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
  canRefreshRunSettings,
  chipCounts,
  cycleInspectPane,
  cycleRunSelection,
  detailsCacheEntry,
  detailsFromMessages,
  filterSessionsForChip,
  filterSnapshotsForChip,
  firstBlockedSessionID,
  footerHints,
  formatChipText,
  formatCounts,
  formatPermissionLines,
  groupRuns,
  inspectModel,
  mergeAuthoritativeRuns,
  inspectPaneView,
  inspectSelFromSelection,
  moveTree,
  PAGE_HEIGHT,
  PANE_TITLE_DETAIL,
  PANE_TITLE_LIVE,
  PANE_TITLE_SETTINGS,
  compactRunAcks,
  parsePermissionList,
  parseRunAck,
  pausedRunIDsFromAcks,
  permissionsForRun,
  runStripLines,
  runsForParent,
  selectForOpen,
  selectionMapKey,
  settingsPaneView,
  shouldEnableTui,
  shortRunID,
  toggleExpand,
  wrapPaneLines,
  splitPanelWidth,
  toggleFollowPin,
  type AuthoritativeSnapshot,
  type ChipScope,
  type DetailCacheEntry,
  type InspectModel,
  type InspectSelection,
  type PendingPermissionView,
  type RunAck,
  type RunView,
  type SessionView,
  type SettingsHydration,
  type SettleMaps,
  type TreeSelection,
} from "./tui-render.ts"
import { SETTINGS_KEYS, stepPanelSetting, type PanelSettings } from "./settings.ts"
import { ULTRACODE_RPC } from "./rpc-definition.ts"
import {
  parseRunStatusResponse,
  parseSettingsResponse,
  runStateEventInScope,
} from "./run-status.ts"

const MIN_BUILD = 19271
const QUIET_MS = 5000
const PANEL_NAME = "ultracode.inspect"

type SessionStore = {
  list?: () => unknown[]
  get?: (id: string) => unknown
  sync?: (id: string) => Promise<void>
  invalidate?: (id: string) => void
  status?: (id: string) => unknown
  message?: {
    list?: (sessionID: string) => unknown[]
    sync?: (sessionID: string) => Promise<void>
    invalidate?: (sessionID: string) => void
  }
  permission?: {
    list?: (sessionID: string) => unknown[] | undefined
    sync?: (sessionID: string) => Promise<void>
    invalidate?: (sessionID: string) => void
  }
}

type LocationRef = {
  directory?: string
  workspaceID?: string
}

type DataApi = {
  on?: (type: string, handler: (ev: unknown) => void) => () => void
  session?: SessionStore
  location?: { default?: () => LocationRef | undefined }
}

type UiApi = {
  slot?: (claim: unknown) => () => void
  panel?: {
    open?: (name: string, options?: { presentation?: "panel" | "fullscreen" }) => boolean
    close?: () => void
    current?: () => { name: string; sessionID: string } | undefined
  }
  toast?: { show?: (opts: unknown) => void }
  tabs?: { enabled?: () => boolean; open?: (sessionID: string) => boolean; focus?: (sessionID: string) => void }
  dialog?: {
    confirm?: (opts: { title: string; message: string; label?: { confirm: string; cancel: string } }) => Promise<boolean>
    prompt?: (opts: { title: string; description?: string; placeholder?: string }) => Promise<string | undefined>
  }
  router?: { current?: () => { type?: string; sessionID?: string }; navigate?: (input: { type: "session"; sessionID: string }) => void }
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
  location?: LocationRef
  attention?: AttentionApi
  client?: {
    session?: {
      command?: (input: unknown) => Promise<unknown>
      context?: (input: unknown) => Promise<unknown>
    }
    message?: { list?: (input: unknown) => Promise<unknown> }
    permission?: {
      list?: (input: { sessionID: string }) => Promise<unknown>
      reply?: (input: { sessionID: string; requestID: string; reply: "once" | "reject" }) => Promise<void>
    }
    rpc?: (definition: unknown) => {
      runStatus?: (input?: unknown, options?: unknown) => Promise<unknown>
      settings?: (input?: unknown, options?: unknown) => Promise<unknown>
      events?: {
        on?: (name: string, handler: (event: unknown) => void, options?: unknown) => () => void
      }
    }
  }
  theme?: unknown
  storage?: {
    memory?: <T extends object>(key: string, opts: { initial: T }) => readonly [T, (fn: (draft: T) => void) => void]
  }
}

type InspectState = {
  tick: number
  acks: RunAck[]
  recent: AuthoritativeSnapshot[]
}

type RowDetails = DetailCacheEntry

const PANEL_KEYS = ["up", "down", "left", "right", "h", "l", "x", "p", "s", "r", "return", "esc", "ctrl+g", "[", "]", ".", "f", "y", "n", "+", "-", "="] as const

function treeSelEqual(a: TreeSelection | undefined, b: TreeSelection | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.cursor.kind !== b.cursor.kind || a.cursor.id !== b.cursor.id) return false
  if (a.detailOffset !== b.detailOffset) return false
  const keys = new Set([...Object.keys(a.expanded), ...Object.keys(b.expanded)])
  for (const key of keys) {
    if ((a.expanded[key] !== false) !== (b.expanded[key] !== false)) return false
  }
  return true
}

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

function locationDirectoryOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const directory = (value as { directory?: unknown }).directory
  return typeof directory === "string" ? directory : undefined
}

function locationProjectID(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const rec = value as Record<string, unknown>
  if (typeof rec.projectID === "string" && rec.projectID !== "") return rec.projectID
  const project = rec.project
  if (project && typeof project === "object" && !Array.isArray(project)) {
    const id = (project as { id?: unknown }).id
    if (typeof id === "string" && id !== "") return id
  }
  return undefined
}

function hostStatusOf(data: DataApi | undefined, id: string): SessionView["hostStatus"] {
  try {
    const status = data?.session?.status?.(id)
    if (status === "idle" || status === "running") return status
  } catch {
    // host method may be absent on older builds
  }
  return undefined
}

function asSessionView(
  value: unknown,
  details?: RowDetails,
  extras?: { hostStatus?: SessionView["hostStatus"]; lastExecution?: SessionView["lastExecution"] },
): SessionView | undefined {
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
    projectID: typeof rec.projectID === "string" ? rec.projectID : undefined,
    locationDirectory: locationDirectoryOf(rec.location),
    hostStatus: extras?.hostStatus,
    lastExecution: extras?.lastExecution,
  }
}

function listSessions(
  data: DataApi | undefined,
  details: Map<string, RowDetails>,
  executionBySession: Map<string, NonNullable<SessionView["lastExecution"]>>,
): SessionView[] {
  try {
    const raw = data?.session?.list?.()
    if (!Array.isArray(raw)) return []
    const out: SessionView[] = []
    for (const item of raw) {
      const rec = item && typeof item === "object" ? (item as { id?: string }) : undefined
      const extra = rec?.id ? details.get(rec.id) : undefined
      const view = asSessionView(item, extra, rec?.id
        ? {
            hostStatus: hostStatusOf(data, rec.id),
            lastExecution: executionBySession.get(rec.id),
          }
        : undefined)
      if (view) out.push(view)
    }
    return out
  } catch {
    return []
  }
}

function chipScopeFromContext(context: TuiContext): ChipScope | undefined {
  try {
    const route = context.ui?.router?.current?.()
    const current = route?.sessionID ? context.data?.session?.get?.(route.sessionID) : undefined
    if (current && typeof current === "object") {
      const rec = current as { location?: unknown; projectID?: string }
      const directory = locationDirectoryOf(rec.location)
      if (directory) return { directory, projectID: rec.projectID }
    }
    const loc = context.location ?? context.data?.location?.default?.()
    const directory =
      (typeof context.location?.directory === "string" ? context.location.directory : undefined) ??
      locationDirectoryOf(loc)
    const projectID = locationProjectID(loc) ?? locationProjectID(context.location)
    if (directory || projectID) return { ...(directory ? { directory } : {}), ...(projectID ? { projectID } : {}) }
  } catch {
    // ignore
  }
  return undefined
}

function executionKind(type: string | undefined): SessionView["lastExecution"] {
  if (type === "session.execution.started") return "started"
  if (type === "session.execution.succeeded") return "succeeded"
  if (type === "session.execution.failed") return "failed"
  if (type === "session.execution.interrupted") return "interrupted"
  return undefined
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
      const executionBySession = new Map<string, NonNullable<SessionView["lastExecution"]>>()
      const detailCache = new Map<string, RowDetails>()
      const detailInflight = new Map<string, Promise<void>>()
      const selMap: Record<string, InspectSelection> = {}

      const [tick, setTick] = createSignal(Date.now())
      const [sel, setSel] = createSignal<InspectSelection>({ phase: "all", offset: 0, selected: 0 })
      const [settingsHydration, setSettingsHydration] = createSignal<SettingsHydration>({
        byRun: {},
        hydrated: false,
      })
      const [blockedPerms, setBlockedPerms] = createSignal<PendingPermissionView[]>([])
      let requestedPanelFocus = false
      let setState: ((fn: (draft: InspectState) => void) => void) | undefined
      let runAcks: RunAck[] = []
      let liveSnaps: AuthoritativeSnapshot[] = []
      let extraSnaps: AuthoritativeSnapshot[] = []

      try {
        const mem = context.storage?.memory?.("ultracode.inspect", {
          initial: {
            tick: Date.now(),
            acks: [] as RunAck[],
            recent: [] as AuthoritativeSnapshot[],
          } satisfies InspectState,
        })
        if (mem) {
          setState = mem[1]
          if (Array.isArray(mem[0]?.acks)) {
            runAcks = compactRunAcks(mem[0].acks.filter((a) => a && typeof a.kind === "string"))
          }
          if (Array.isArray(mem[0]?.recent)) {
            extraSnaps = mem[0].recent.filter((s) => s && typeof s.runID === "string")
          }
        }
      } catch (err) {
        warn("storage.memory unavailable", err)
      }

      const persistInspectState = (): void => {
        try {
          setState?.((draft) => {
            draft.acks = runAcks
            draft.recent = extraSnaps.length > 0 ? extraSnaps : liveSnaps
          })
        } catch (err) {
          warn("storage.memory persist failed", err)
        }
      }

      const persistAcks = (): void => {
        persistInspectState()
      }

      const bump = (): void => {
        if (disposed) return
        const now = Date.now()
        setTick(now)
        try {
          setState?.((draft) => {
            draft.tick = now
            draft.acks = runAcks
            draft.recent = extraSnaps.length > 0 ? extraSnaps : liveSnaps
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
      // Monotonic guard: an older in-flight poll must never overwrite a newer snapshot.
      let authGen = 0

      const getRpcClient = ():
        | {
            runStatus?: (input?: unknown, options?: unknown) => Promise<unknown>
            settings?: (input?: unknown, options?: unknown) => Promise<unknown>
            events?: { on?: (name: string, handler: (event: unknown) => void, options?: unknown) => () => void }
          }
        | undefined => {
        try {
          const factory = context.client?.rpc
          if (typeof factory !== "function") return undefined
          const client = factory(ULTRACODE_RPC)
          if (!client || typeof client !== "object") return undefined
          return client
        } catch {
          return undefined
        }
      }

      const currentParentID = (): string | undefined =>
        transportSessionID(context.ui?.panel?.current?.()?.sessionID, context.ui?.router)

      const refreshAuth = async (runID?: string, sessionID?: string): Promise<void> => {
        if (disposed) return
        const gen = ++authGen
        try {
          const rpc = getRpcClient()
          const call = rpc?.runStatus
          if (typeof call !== "function") {
            // rpc-unavailable: still move tick so Chip/panel fallback expiry can fire
            bump()
            return
          }
          const parent = sessionID ?? currentParentID()
          if (!parent) return
          const raw = await call(
            runID
              ? { runID, ...(parent ? { sessionID: parent } : {}) }
              : { includeFinished: true, ...(parent ? { sessionID: parent } : {}) },
            { location: { directory: chipScopeFromContext(context)?.directory } },
          )
          const parsed = parseRunStatusResponse(raw)
          if (!parsed || gen !== authGen || parent !== currentParentID()) return
          if (runID) extraSnaps = parsed
          else liveSnaps = parsed
          bump()
        } catch {
          // silent: keep session heuristics
        }
      }

      /** Subscribe to tick for re-render; pass wall-clock nowTs (tick may be stale). */
      const wallNow = (): number => {
        void tick()
        return Date.now()
      }

      const currentSessionSnapshot = (): SessionView[] =>
        listSessions(context.data, detailCache, executionBySession)

      const scopedSessionSnapshot = (): SessionView[] =>
        filterSessionsForChip(currentSessionSnapshot(), chipScopeFromContext(context))

      const runsForUi = (sessions: SessionView[], nowTs: number) => {
        try {
          const auth = scopedAuth(sessions, nowTs)
          return mergeAuthoritativeRuns(groupRuns(sessions, nowTs), auth.live, auth.persisted)
        } catch {
          return groupRuns(sessions, nowTs)
        }
      }

      const scopedAuth = (sessions: SessionView[], nowTs: number) => {
        const known = new Set(groupRuns(sessions, nowTs).map((r) => r.runID))
        const scope = chipScopeFromContext(context)
        return {
          live: filterSnapshotsForChip(liveSnaps, scope, known),
          persisted: filterSnapshotsForChip(extraSnaps, scope, known),
        }
      }

      const blockedFromStore = (runs: readonly RunView[]): PendingPermissionView[] => {
        const out: PendingPermissionView[] = []
        const seen = new Set<string>()
        for (const run of runs) {
          for (const agent of run.agents) {
            const sid = agent.sessionID
            if (!sid || seen.has(sid)) continue
            seen.add(sid)
            try {
              const listed = context.data?.session?.permission?.list?.(sid)
              out.push(...parsePermissionList(listed))
            } catch {
              // host store may omit permission
            }
          }
        }
        return out
      }

      let permissionGeneration = 0
      let permissionPollKey: string | undefined
      const refreshPermissions = (runs: readonly RunView[]): void => {
        const ids = [...new Set(runs.filter((r) => !r.settled).flatMap((r) => r.agents
          .filter((a) => (a.status === "running" || a.status === "pending") && a.sessionID).map((a) => a.sessionID)))].sort()
        const parent = currentParentID()
        const key = `${parent ?? ""}:${ids.join(",")}`
        if (permissionPollKey === key) return
        const gen = ++permissionGeneration
        const list = context.client?.permission?.list
        if (typeof list !== "function") {
          setBlockedPerms(blockedFromStore(runs))
          return
        }
        permissionPollKey = key
        void (async () => {
          const out: PendingPermissionView[] = []
          for (let start = 0; start < ids.length; start += 8) {
            await Promise.all(ids.slice(start, start + 8).map(async (sid) => {
              try { out.push(...parsePermissionList(await list({ sessionID: sid }))) }
              catch { /* retry on the next poll */ }
            }))
          }
          if (!disposed && gen === permissionGeneration && parent === currentParentID()) setBlockedPerms(out)
        })().finally(() => {
          if (gen === permissionGeneration) permissionPollKey = undefined
        })
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
        if (!currentParentID()) return
        try {
          const snapshot = scopedSessionSnapshot()
          refreshPermissions(runsForParent(runsForUi(snapshot, nowTs), currentParentID()))
          const runs = runsForParent(runsForUi(snapshot, nowTs), currentParentID())
          const due = applySettleTick(runs, settleMaps, nowTs, QUIET_MS)
          for (const runID of due) {
            const run = runs.find((r) => r.runID === runID)
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
        const kind = executionKind(eventType(ev))
        if (sessionID && kind) executionBySession.set(sessionID, kind)
        if (sessionID && eventType(ev) === "session.deleted") executionBySession.delete(sessionID)
        if (sessionID) {
          const decision = cacheDecision(detailCache.get(sessionID), { type: eventType(ev) ?? "session.created", sessionID })
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
        if (ack?.runID && (ack.kind === "paused" || ack.kind === "resumed" || ack.kind === "stopped")) {
          runAcks = compactRunAcks([...runAcks, ack])
          persistAcks()
        }
        if (ack?.kind === "settings" && ack.settings) {
          const payload = ack.settings
          setSettingsHydration((prev) => {
            const byRun = { ...prev.byRun }
            if (payload.runID && payload.effective) byRun[payload.runID] = payload.effective
            return { overlay: payload.overlay, byRun, hydrated: true }
          })
        }
        onSessionEvent(ev)
      }

      const eventNames = [
        "session.created",
        "session.deleted",
        "session.execution.started",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
        "session.usage.updated",
        "session.inbox.delivered",
        "session.inbox.enqueued",
        "permission.asked",
        "permission.replied",
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

      try {
        const rpc = getRpcClient()
        const on = rpc?.events?.on
        if (typeof on === "function") {
          const off = on("runState", (event) => {
            if (!runStateEventInScope(event, chipScopeFromContext(context))) return
            void refreshAuth()
          })
          if (typeof off === "function") unsubs.push(off)
        }
        void refreshAuth()
      } catch {
        // rpc optional — heuristics stay
      }

      const settleTimer = setInterval(() => {
        if (disposed) return
        fireSettle(Date.now())
        void refreshAuth()
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

      const closeInspect = (input?: { close?: unknown }): void => {
        if (disposed) return
        try {
          if (typeof input?.close === "function") {
            input.close()
            return
          }
          if (typeof context.ui?.panel?.close === "function") {
            context.ui.panel.close()
          }
        } catch (err) {
          warn("panel close failed", err)
        }
      }

      const toggleInspect = (): void => {
        if (disposed) return
        try {
          const cur = context.ui?.panel?.current?.()
          if (cur?.name === PANEL_NAME) closeInspect()
          else openPanel()
        } catch (err) {
          warn("ui.panel toggle failed", err)
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

      function Chip(input?: { sessionID?: string }) {
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
                bind: "ctrl+g",
                shortcuts: ["ctrl+g"],
                run: () => {
                  toggleInspect()
                },
              },
            ],
          }))
        } catch (err) {
          warn("chip keymap.layer failed", err)
        }
        const chipLabel = createMemo(() => {
          const nowTs = wallNow()
          try {
            const parent = typeof input?.sessionID === "string" ? input.sessionID : currentParentID()
            if (!parent) return ""
            const scoped = scopedSessionSnapshot()
            const pausedIDs = pausedRunIDsFromAcks(runAcks)
            const runs = runsForParent(
              runsForUi(scoped, nowTs).map((run) =>
                run.source === "live" || run.source === "persisted"
                  ? run
                  : pausedIDs.has(run.runID)
                    ? { ...run, paused: true }
                    : run,
              ),
              parent,
            )
            const blocked = runs.flatMap((run) => permissionsForRun(run, blockedPerms()))
            const counts = chipCounts(runs, pausedIDs, blocked.length)
            counts.agents = Math.max(0, (counts.agents ?? 0) - new Set(blocked.map((p) => p.sessionID)).size)
            return formatChipText(counts)
          } catch {
            return ""
          }
        })
        return (
          <text>
            {chipLabel()}
          </text>
        )
      }

      function Panel(input: {
        name?: string
        sessionID?: string
        focused?: boolean
        width?: number
        focus?: () => void
        close?: () => void
        toggleFullscreen?: () => void
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
          const nowTs = wallNow()
          try {
            const snapshot = scopedSessionSnapshot()
            const parent = openParent()
            const runs = runsForParent(runsForUi(snapshot, nowTs), parent)
            const opened = selectForOpen(sel(), runs, parent)
            return inspectModel(snapshot, inspectSelFromSelection(opened, runs), nowTs, scopedAuth(snapshot, nowTs))
          } catch {
            return inspectModel([], { offset: 0, selected: 0 }, nowTs)
          }
        })

        createEffect(() => {
          const parent = openParent()
          const snapshot = scopedSessionSnapshot()
          const nowTs = wallNow()
          const runs = runsForParent(runsForUi(snapshot, nowTs), parent)
          const next = selectForOpen(sel(), runs, parent)
          const opened = inspectModel(snapshot, inspectSelFromSelection(next, runs), nowTs, scopedAuth(snapshot, nowTs))
          const withTree: InspectSelection = opened.run
            ? { ...next, runID: opened.run.runID, treeSel: opened.treeSel, pane: next.pane ?? "tree" }
            : next
          const prev = sel()
          if (
            withTree.parentSessionID !== prev.parentSessionID ||
            withTree.runID !== prev.runID ||
            withTree.phase !== prev.phase ||
            withTree.offset !== prev.offset ||
            withTree.selected !== prev.selected ||
            withTree.pane !== prev.pane ||
            !treeSelEqual(withTree.treeSel, prev.treeSel)
          ) {
            commitSel(withTree)
          }
        })

        createEffect(() => {
          const id = model().selectedSessionID
          void tick()
          const entry = id ? detailCache.get(id) : undefined
          if (id && (!entry || entry.tentative)) ensureDetails(id)
        })

        // Selected run changed: fetch its authoritative snapshot (live registry,
        // else persisted record) quietly via rpc. Populates extraSnaps so the
        // panel and chip prefer real state over title heuristics.
        let fetchedAuthRunID: string | undefined
        createEffect(() => {
          const runID = model().run?.runID
          if (!runID || runID === fetchedAuthRunID) return
          fetchedAuthRunID = runID
          void refreshAuth(runID)
        })

        const sid = () => openParent()
        const selectedRunID = (): string | undefined => model().run?.runID

        const commitTree = (treeSel: TreeSelection, pane?: InspectSelection["pane"]): void => {
          const m = model()
          const run = m.run
          if (!run) return
          const agentIdx =
            treeSel.cursor.kind === "agent" ? run.agents.findIndex((a) => a.sessionID === treeSel.cursor.id) : -1
          const selected = agentIdx >= 0 ? agentIdx : sel().selected
          const off = sel().offset
          commitSel({
            parentSessionID: openParent(),
            runID: run.runID,
            phase: sel().phase,
            selected,
            offset: selected < off ? selected : selected >= off + PAGE_HEIGHT ? selected - PAGE_HEIGHT + 1 : off,
            treeSel,
            pane: pane ?? sel().pane ?? "tree",
            settingsRow: sel().settingsRow,
          })
        }

        const moveInspect = (delta: number): void => {
          if (disposed) return
          const pane = sel().pane ?? "tree"
          if (pane === "settings") {
            const nextRow = Math.min(SETTINGS_KEYS.length - 1, Math.max(0, (sel().settingsRow ?? 0) + delta))
            commitSel({ ...sel(), settingsRow: nextRow })
            return
          }
          const m = model()
          if (!m.run) return
          if (pane === "detail") {
            const count = wrapPaneLines(m.detail, Math.max(1, splitPanelWidth(input.width ?? 80).detail - 2)).length
            const maxOff = Math.max(0, count - PAGE_HEIGHT)
            const nextOff = Math.min(maxOff, Math.max(0, m.treeSel.detailOffset + delta))
            commitTree({ ...m.treeSel, detailOffset: nextOff }, pane)
            return
          }
          commitTree(moveTree(m.tree, m.treeSel, delta), pane)
        }

        const expandKey = (key: "left" | "right"): void => {
          if (disposed) return
          const m = model()
          if (!m.run) return
          commitTree(toggleExpand(m.tree, m.treeSel, key), sel().pane ?? "tree")
        }

        const cyclePane = (dir: number): void => {
          if (disposed) return
          const m = model()
          const nextPane = cycleInspectPane(sel().pane, dir)
          if (!m.run) {
            commitSel({ ...sel(), pane: nextPane })
          } else {
            commitTree(m.treeSel, nextPane)
          }
          // Entering the settings pane hydrates quietly via rpc when available
          // (no session message, no agent wake); r remains the manual fallback.
          if (nextPane === "settings" && !settingsHydration().hydrated) {
            void fetchSettingsViaRpc(m.run?.runID)
          }
        }

        const fetchSettingsViaRpc = async (runID?: string): Promise<boolean> => {
          try {
            const rpc = getRpcClient()
            if (typeof rpc?.settings !== "function") return false
            const parent = openParent()
            const payload = parseSettingsResponse(await rpc.settings(
              { ...(runID ? { runID } : {}), sessionID: parent },
              { location: { directory: chipScopeFromContext(context)?.directory } },
            ))
            if (parent !== openParent()) return false
            if (!payload) return false
            setSettingsHydration((prev) => {
              const byRun = { ...prev.byRun }
              if (payload.runID && payload.effective) byRun[payload.runID] = payload.effective
              return { overlay: payload.overlay ?? prev.overlay, byRun, hydrated: true }
            })
            return true
          } catch {
            return false
          }
        }

        const requestSettings = (): void => {
          if ((sel().pane ?? "tree") !== "settings") return
          const run = model().run
          if (!canRefreshRunSettings(run) || !run) return
          void (async () => {
            if (await fetchSettingsViaRpc(run.runID)) return
            void sendRunCommand(sid(), `settings ${run.runID}`).catch((err) => {
              warn("settings refresh failed", err)
            })
          })()
        }

        const adjustSetting = (dir: 1 | -1): void => {
          if (disposed) return
          if ((sel().pane ?? "tree") !== "settings") return
          const hydrated = settingsHydration()
          if (!hydrated.hydrated || !hydrated.overlay) return
          const key = SETTINGS_KEYS[sel().settingsRow ?? 0] ?? "concurrency"
          const next: PanelSettings = stepPanelSetting(hydrated.overlay, key, dir)
          void sendRunCommand(sid(), `set ${key} ${next[key]}`).catch((err) => {
            warn("settings set failed", err)
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
            treeSel: cycled.selection.treeSel,
            pane: cycled.selection.pane ?? "tree",
            settingsRow: cycled.selection.settingsRow,
            pinned: cycled.selection.pinned ?? true,
          })
        }

        let permissionReplyPending = false
        const replyPermission = (reply: "once" | "reject"): void => {
          if (disposed) return
          const pending = permissionsForRun(model().run, blockedPerms())
          const item = pending[0]
          const fn = context.client?.permission?.reply
          if (!item || typeof fn !== "function" || permissionReplyPending) return
          permissionReplyPending = true
          void (async () => {
            const confirm = context.ui?.dialog?.confirm
            if (!confirm) {
              context.ui?.router?.navigate?.({ type: "session", sessionID: item.sessionID })
              return
            }
            const accepted = await confirm({
              title: reply === "once" ? "Allow child permission once?" : "Reject child permission?",
              message: `${item.action}\n${item.resources.join("\n")}\n${item.message ?? ""}\nChild: ${item.sessionID}`,
              label: { confirm: reply === "once" ? "Allow once" : "Reject", cancel: "Cancel" },
            })
            if (!accepted || disposed) return
            await fn({ sessionID: item.sessionID, requestID: item.id, reply })
            setBlockedPerms(blockedPerms().filter((p) => p.id !== item.id))
          })()
            .then(() => {
              if (disposed) return
              bump()
              refreshPermissions(model().runs)
            }).finally(() => { permissionReplyPending = false })
            .catch((err) => {
              if (disposed) return
              warn("permission.reply failed", err)
              toast({
                message: `ultracode permission ${reply} failed: ${err instanceof Error ? err.message : String(err)}`,
                variant: "error",
              })
            })
        }

        const drill = (): void => {
          if (disposed) return
          try {
            const pending = permissionsForRun(model().run, blockedPerms())
            const row = firstBlockedSessionID(pending) ?? model().selectedSessionID
            if (!row) return
            // tabs.open adds the tab when not already open (focus only targets existing tabs,
            // which silently no-ops for fresh child sessions); false falls back to navigation.
            const opened = typeof context.ui?.tabs?.open === "function" ? context.ui.tabs.open(row) : false
            if (!opened) context.ui?.router?.navigate?.({ type: "session", sessionID: row })
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
                title: "Inspect previous tree row",
                bind: "up",
                run: () => moveInspect(-1),
              },
              {
                id: "ultracode.inspect.down",
                title: "Inspect next tree row",
                bind: "down",
                run: () => {
                  moveInspect(1)
                  probeKind("inspect-down", { sel: sel(), selected: model().selected, rowInWindow: model().rowInWindow })
                },
              },
              {
                id: "ultracode.inspect.collapse",
                title: "Collapse tree node",
                bind: "left",
                run: () => expandKey("left"),
              },
              {
                id: "ultracode.inspect.expand",
                title: "Expand tree node",
                bind: "right",
                run: () => expandKey("right"),
              },
              {
                id: "ultracode.inspect.pane.prev",
                title: "Previous pane",
                bind: "h",
                run: () => cyclePane(-1),
              },
              {
                id: "ultracode.inspect.pane.next",
                title: "Next pane",
                bind: "l",
                run: () => cyclePane(1),
              },
              {
                id: "ultracode.inspect.settings.inc",
                title: "Increase setting",
                bind: "+",
                run: () => adjustSetting(1),
              },
              {
                id: "ultracode.inspect.settings.inc.eq",
                title: "Increase setting",
                bind: "=",
                run: () => adjustSetting(1),
              },
              {
                id: "ultracode.inspect.settings.dec",
                title: "Decrease setting",
                bind: "-",
                run: () => adjustSetting(-1),
              },
              {
                id: "ultracode.inspect.settings.refresh",
                title: "Refresh settings",
                bind: "r",
                run: () => requestSettings(),
              },
              {
                id: "ultracode.inspect.close",
                title: "Close inspect panel",
                bind: "esc",
                run: () => closeInspect(input),
              },
              {
                id: "ultracode.inspect.close.escape",
                title: "Close inspect panel",
                bind: "escape",
                run: () => closeInspect(input),
              },
              {
                id: "ultracode.inspect.close.toggle",
                title: "Close inspect panel",
                bind: "ctrl+g",
                run: () => {
                  if (input?.name === PANEL_NAME) closeInspect(input)
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
                id: "ultracode.inspect.fullscreen",
                title: "Toggle full-screen inspector",
                bind: "f",
                run: () => input.toggleFullscreen?.(),
              },
              {
                id: "ultracode.inspect.run.follow",
                title: "Toggle follow latest vs pinned history",
                bind: ".",
                run: () => commitSel(toggleFollowPin(sel())),
              },
              {
                id: "ultracode.inspect.perm.once",
                title: "Allow child permission once",
                bind: "y",
                run: () => replyPermission("once"),
              },
              {
                id: "ultracode.inspect.perm.reject",
                title: "Reject child permission",
                bind: "n",
                run: () => replyPermission("reject"),
              },
              {
                id: "ultracode.inspect.open",
                title: "Open agent session",
                bind: "return",
                run: () => drill(),
              },
              {
                id: "ultracode.inspect.stop",
                title: "Stop run",
                bind: "x",
                enabled: () => !!model().run && !model().run!.settled && model().run!.status !== "stopping",
                run: () => {
                  if (!model().run || model().run!.settled || model().run!.status === "stopping") return
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
                enabled: () => !!model().run && !model().run!.settled && model().run!.status !== "stopping",
                run: () => {
                  const run = model().run
                  if (!run || run.settled || run.status === "stopping") return
                  const runID = selectedRunID()
                  if (!runID) return
                  const verb = run.paused ? "resume" : "pause"
                  void sendRunCommand(sid(), `${verb} ${runID}`)
                    .then(() => {
                      if (disposed) return
                      void refreshAuth(runID)
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
        const paneView = createMemo(() =>
          inspectPaneView(model(), sel().pane, typeof input?.width === "number" ? input.width : 0),
        )
        const treeLines = createMemo(() => paneView().treeLines)
        const detailLines = createMemo(() => paneView().detailLines)
        const treePageLabel = createMemo(() => paneView().treePageLabel)
        const treeTitle = createMemo(() => paneView().treeTitle)
        const settingsView = createMemo(() =>
          settingsPaneView(
            model().run,
            settingsHydration(),
            sel().settingsRow ?? 0,
            typeof input?.width === "number" ? input.width : 0,
          ),
        )
        const pickerLines = createMemo(() =>
          runStripLines(model().runs, model().run?.runID, { pinned: sel().pinned === true, limit: 3 }),
        )
        const permLines = createMemo(() => formatPermissionLines(permissionsForRun(model().run, blockedPerms())))

        return (
          <box flexDirection="column">
            <text>ultracode inspect UC-INSPECT</text>
            <text>Runs · [ ] switch · . follow/pin · f fullscreen</text>
            {pickerLines().length > 0 ? <text>{wrapPaneLines(pickerLines(), input.width ?? 80).join("\n")}</text> : <text></text>}
            {permLines().length > 0 ? <text>{wrapPaneLines(permLines(), input.width ?? 80).join("\n")}</text> : <text></text>}
            {(sel().pane ?? "tree") === "settings" ? (
              <box flexDirection="column">
                {model().run ? <text>{model().header}</text> : <text></text>}
                <box flexDirection="row">
                  <box flexGrow={1} flexDirection="column">
                    <text>{PANE_TITLE_SETTINGS}</text>
                    <text>{settingsView().settingsLines.join("\n")}</text>
                  </box>
                  <box flexGrow={1} flexDirection="column">
                    <text>{PANE_TITLE_LIVE}</text>
                    <text>{settingsView().liveLines.join("\n")}</text>
                  </box>
                </box>
              </box>
            ) : model().run ? (
              <box flexDirection="column">
                <text>{model().header}</text>
                <box flexDirection="row">
                  <box width={paneView().cols.tree} flexShrink={0} flexDirection="column">
                    <text>{treeTitle()}</text>
                    <text>{treeLines().join("\n")}</text>
                  </box>
                  <box width={paneView().cols.detail} flexShrink={0} flexDirection="column">
                    <text>{PANE_TITLE_DETAIL}</text>
                    <text>{detailLines().join("\n")}</text>
                  </box>
                </box>
                <text>{treePageLabel()}</text>
              </box>
            ) : (
              <text>no ultracode runs</text>
            )}
            <text>{wrapPaneLines([hints], input.width ?? 80).join("\n")}</text>
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
