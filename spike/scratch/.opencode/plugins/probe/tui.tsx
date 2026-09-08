/** @jsxImportSource solid-js */
/**
 * Phase 0-tui interactive probe (TSX / solid JSX).
 * Loaded as the TUI half of `.opencode/plugins/probe/` when package.json
 * exports["./tui"] points here.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const OUT =
  process.env.PROBE_TUI_OUT ??
  "<repo>/spike/out/tui-probe.jsonl"

function log(kind: string, data: unknown = {}): void {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // best effort
  }
}

log("tui-module-evaluated", {
  out: OUT,
  cwd: process.cwd(),
  entry: "tui.tsx",
  jsxImportSource: "solid-js",
  pragma: true,
})

function shape(value: unknown, depth = 2): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "function") return "[fn]"
  if (t !== "object") return value
  if (depth <= 0) return Array.isArray(value) ? `[array:${(value as unknown[]).length}]` : "[object]"
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => shape(item, depth - 1))
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as object).sort()) {
    try {
      out[key] = shape((value as Record<string, unknown>)[key], depth - 1)
    } catch (err) {
      out[key] = `[throw:${String(err)}]`
    }
  }
  return out
}

function keysOf(value: unknown): string[] {
  if (value && typeof value === "object") return Object.keys(value as object).sort()
  return []
}

type AnyCtx = {
  app?: { version?: string; channel?: string }
  ui?: Record<string, unknown>
  keymap?: Record<string, unknown>
  data?: Record<string, unknown>
  client?: Record<string, unknown>
  location?: unknown
  options?: unknown
}

let ctxRef: AnyCtx | null = null
let layerEnabled = true
let dialogOpen = false
let parentSessionID: string | null = null

function inspectLayer(from: string, priority: number): void {
  try {
    const keymap = ctxRef?.keymap as
      | { layer?: (input: () => unknown) => void }
      | undefined
    const ui = ctxRef?.ui as {
      panel?: { open?: (name: string) => boolean; current?: () => unknown }
      dialog?: {
        show?: (render: () => unknown, onClose?: () => void) => void
        set?: (opts: unknown) => void
      }
    }
    keymap?.layer?.(() => ({
      enabled: () => layerEnabled,
      priority,
      commands: [
        {
          id: "ultracode.inspect",
          title: "Ultracode inspect (probe)",
          description: "Phase 0-tui probe panel",
          palette: true,
          bind: "ctrl+g",
          slash: { name: "ucprobe" },
          run: () => {
            log("command-run", { id: "ultracode.inspect", from })
            try {
              const ok = ui?.panel?.open?.("ultracode.inspect")
              log("panel-open", { ok, from, current: shape(ui?.panel?.current?.()) })
            } catch (err) {
              log("panel-open-error", String(err))
            }
          },
        },
        {
          id: "probe.dialog",
          title: "Probe dialog",
          palette: true,
          bind: "ctrl+f",
          run: () => {
            log("command-run", { id: "probe.dialog", from })
            openDialog(ui)
          },
        },
        {
          id: "probe.layer.z",
          title: "probe layer z",
          bind: "z",
          run: (_input?: string, event?: unknown) => {
            log("layer-key", { from, key: "z", dialogOpen, event: shape(event, 1) })
          },
        },
        {
          id: "probe.layer.ctrlk",
          title: "probe layer ctrl+k",
          bind: "ctrl+k",
          run: (_input?: string, event?: unknown) => {
            log("layer-key", { from, key: "ctrl+k", dialogOpen, event: shape(event, 1) })
          },
        },
      ],
    }))
  } catch (err) {
    log("layer-from-component-error", { from, error: String(err) })
  }
}

function ProbeChip(_input: unknown) {
  inspectLayer("component-chip", 80)
  return <text>UCPROBE-CHIP</text>
}

function ProbePanel(input: { name?: string; sessionID?: string; focused?: boolean }) {
  inspectLayer("component-panel", 90)
  log("panel-render", {
    name: input?.name ?? null,
    sessionID: input?.sessionID ?? null,
    focused: input?.focused ?? null,
    keys: keysOf(input),
  })
  return (
    <box>
      <text>UCPROBE-PANEL</text>
    </box>
  )
}

function ProbeDialog() {
  inspectLayer("component-dialog", 100)
  return (
    <box flexDirection="column">
      <text>UCPROBE-DIALOG</text>
      <box flexDirection="row">
        <box flexGrow={1}>
          <text>col1-status</text>
          <text>col1-phase</text>
        </box>
        <box flexGrow={1}>
          <text>col2-agent</text>
          <text>col2-tokens</text>
        </box>
      </box>
    </box>
  )
}

function dumpCommands(keymap: Record<string, unknown>, label: string): void {
  if (typeof keymap.commands !== "function") {
    log("keymap-commands-missing", { label, keymapKeys: Object.keys(keymap) })
    return
  }
  try {
    const commands = (keymap.commands as () => unknown)()
    const list = Array.isArray(commands) ? commands : []
    log("keymap-commands-count", { label, count: list.length })
    const brief = list.map((c) => {
      const rec = c as Record<string, unknown>
      const id = String(rec.id ?? rec.name ?? "")
      let shortcuts: unknown = null
      try {
        if (typeof keymap.shortcuts === "function" && id) {
          shortcuts = (keymap.shortcuts as (id: string) => unknown)(id)
        }
      } catch (err) {
        shortcuts = `[throw:${String(err)}]`
      }
      return {
        id,
        title: rec.title ?? null,
        bind: rec.bind ?? null,
        palette: rec.palette ?? null,
        slash: rec.slash ?? null,
        group: rec.group ?? null,
        shortcuts,
      }
    })
    log("keymap-commands", { label, commands: brief })
    const probeish = brief.filter((c) =>
      /ultracode|probe|inspect|palette|command/i.test(
        `${c.id} ${c.title ?? ""} ${c.bind ?? ""} ${JSON.stringify(c.slash ?? "")}`,
      ),
    )
    log("keymap-probeish", { label, commands: probeish })
  } catch (err) {
    log("keymap-commands-error", { label, error: String(err) })
  }
}

async function probeRuntimes(): Promise<void> {
  const specs = [
    "solid-js",
    "solid-js/jsx-runtime",
    "@opentui/solid",
    "@opentui/solid/jsx-runtime",
    "solid-js/web",
  ]
  for (const spec of specs) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>
      log("runtime-import-ok", { spec, keys: Object.keys(mod).slice(0, 40) })
    } catch (err) {
      log("runtime-import-fail", { spec, error: String(err) })
    }
  }
}

async function afterSetup(context: AnyCtx): Promise<void> {
  log("after-setup-start", {})
  await probeRuntimes()

  const client = context.client as {
    session?: {
      create?: (input?: unknown) => Promise<Record<string, unknown>>
      command?: (input: unknown) => Promise<unknown>
      prompt?: (input: unknown) => Promise<unknown>
    }
  }
  const ui = context.ui as {
    router?: { navigate?: (d: unknown) => void; current?: () => unknown }
    panel?: { open?: (name: string, opts?: unknown) => boolean; current?: () => unknown }
    dialog?: {
      show?: (render: () => unknown, onClose?: () => void) => void
      set?: (opts: unknown) => void
      clear?: () => void
    }
    toast?: { show?: (opts: unknown) => void }
  }
  const data = context.data as {
    session?: {
      list?: () => unknown[]
      get?: (id: string) => unknown
      sync?: (id?: string) => Promise<void>
    }
  }
  const keymap = context.keymap as Record<string, unknown>

  try {
    const created = await client?.session?.create?.({ title: "probe-tui-parent" })
    parentSessionID = typeof created?.id === "string" ? created.id : null
    log("client-session-create", {
      id: parentSessionID,
      keys: keysOf(created),
      title: created?.title ?? null,
      metadata: created?.metadata ?? null,
      outcome: created?.outcome ?? null,
      tokens: created?.tokens ?? null,
    })
    if (parentSessionID) {
      try {
        ui.router?.navigate?.({ type: "session", sessionID: parentSessionID })
        log("router-navigate", { sessionID: parentSessionID, current: shape(ui.router?.current?.()) })
      } catch (err) {
        log("router-navigate-error", String(err))
      }
    }
  } catch (err) {
    log("client-session-create-error", String(err))
  }

  await new Promise((r) => setTimeout(r, 800))
  dumpCommands(keymap, "after-navigate")
  dumpSessionStore(data, "after-navigate")

  try {
    const ok = ui.panel?.open?.("ultracode.inspect")
    log("panel-open", { ok, from: "after-setup", current: shape(ui.panel?.current?.()) })
  } catch (err) {
    log("panel-open-error", { from: "after-setup", error: String(err) })
  }
  await new Promise((r) => setTimeout(r, 1200))
  dumpCommands(keymap, "after-panel-open")
  openDialog(ui)
  await new Promise((r) => setTimeout(r, 1200))
  dumpCommands(keymap, "after-dialog-show")

  if (parentSessionID && typeof client?.session?.command === "function") {
    const input = { sessionID: parentSessionID, command: "ultracode", text: "help" }
    try {
      const result = await client.session.command(input)
      log("client-session-command", { input, result: shape(result), threw: null })
    } catch (err) {
      log("client-session-command-error", { input, error: String(err) })
      const fallback = { sessionID: parentSessionID, command: "probe_tui", text: "help" }
      try {
        const result = await client.session.command(fallback)
        log("client-session-command-fallback", { input: fallback, result: shape(result) })
      } catch (err2) {
        log("client-session-command-fallback-error", { input: fallback, error: String(err2) })
      }
    }
  } else {
    log("client-session-command-missing", { hasClient: Boolean(client), sessionKeys: keysOf(client?.session) })
  }

  await new Promise((r) => setTimeout(r, 1500))
  dumpSessionStore(data, "after-command")

  log("ready-for-keys", {
    parentSessionID,
    panelCurrent: shape(ui.panel?.current?.()),
    route: shape(ui.router?.current?.()),
  })
}

function dumpSessionStore(data: AnyCtx["data"], label: string): void {
  const session = data?.session as
    | { list?: () => unknown[]; get?: (id: string) => unknown }
    | undefined
  try {
    const list = typeof session?.list === "function" ? session.list() : null
    const items = Array.isArray(list) ? list : []
    log("data-session-list", {
      label,
      count: items.length,
      entries: items.slice(0, 12).map((s) => {
        const rec = s && typeof s === "object" ? (s as Record<string, unknown>) : {}
        return {
          keys: keysOf(rec),
          id: rec.id ?? null,
          title: rec.title ?? null,
          outcome: rec.outcome ?? null,
          tokens: rec.tokens ?? null,
          metadata: rec.metadata ?? null,
          time: rec.time ?? null,
          agent: rec.agent ?? null,
          parentID: rec.parentID ?? null,
          full: rec,
        }
      }),
    })
  } catch (err) {
    log("data-session-list-error", { label, error: String(err) })
  }
}

function subscribeData(context: AnyCtx): void {
  const data = context.data as {
    on?: (type: string, handler: (ev: unknown) => void) => () => void
    listen?: (handler: (ev: unknown) => void) => () => void
  }
  const eventNames = [
    "session.created",
    "session.updated",
    "session.deleted",
    "session.error",
    "session.idle",
    "session.status",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.tool.called",
    "session.tool.success",
    "session.tool.failed",
    "session.inbox.delivered",
    "session.inbox.enqueued",
    "command.updated",
  ]
  if (typeof data?.listen === "function") {
    try {
      data.listen((ev) => {
        const rec = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {}
        const details = rec.details && typeof rec.details === "object" ? (rec.details as Record<string, unknown>) : rec
        const type = String(details.type ?? rec.type ?? "unknown")
        if (!/^session\.|^command\./.test(type) && type !== "unknown") return
        log("data-listen", {
          type,
          keys: keysOf(details),
          dataKeys: keysOf(details.data),
          sessionID: (details.data as { sessionID?: unknown } | undefined)?.sessionID ?? null,
        })
      })
      log("data-listen-ok", {})
    } catch (err) {
      log("data-listen-error", String(err))
    }
  } else {
    log("data-listen-missing", { dataKeys: keysOf(data) })
  }
  for (const type of eventNames) {
    try {
      if (typeof data?.on !== "function") {
        log("data-on-missing", { dataKeys: keysOf(data) })
        break
      }
      data.on(type, (ev) => {
        const rec = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {}
        log("data-on", {
          type,
          keys: keysOf(rec),
          dataKeys: keysOf(rec.data),
          sessionID: (rec.data as { sessionID?: unknown } | undefined)?.sessionID ?? null,
        })
      })
      log("data-on-subscribed", { type })
    } catch (err) {
      log("data-on-error", { type, error: String(err) })
    }
  }
}

function registerSlotsAndCommands(context: AnyCtx): void {
  const ui = context.ui as {
    slot?: (claim: unknown) => () => void
    panel?: { open?: (name: string) => boolean; current?: () => unknown }
    dialog?: {
      show?: (render: () => unknown, onClose?: () => void) => void
      set?: (opts: unknown) => void
      clear?: () => void
    }
  }
  const keymap = context.keymap as { layer?: (input: () => unknown) => void; dispatch?: (id: string) => void }

  if (typeof ui.slot === "function") {
    try {
      ui.slot({ append: "prompt.footer.status", render: ProbeChip })
      log("slot-chip-ok", { append: "prompt.footer.status" })
    } catch (err) {
      log("slot-chip-error", String(err))
    }
    try {
      ui.slot({ append: "session.panel", render: ProbePanel })
      log("slot-panel-ok", { append: "session.panel" })
    } catch (err) {
      log("slot-panel-error", String(err))
    }
    try {
      ui.slot({ append: "home.footer", render: () => <text>UCPROBE-HOME</text> })
      log("slot-home-ok", { append: "home.footer" })
    } catch (err) {
      log("slot-home-error", String(err))
    }
  } else {
    log("slot-api-missing", { uiKeys: keysOf(ui) })
  }

  try {
    keymap.layer?.(() => ({
      enabled: true,
      priority: 20,
      commands: [
        {
          id: "probe.layer.setup-z",
          title: "setup layer z (should compete with component)",
          bind: "z",
          run: (_input?: string, event?: unknown) => {
            log("layer-key", { from: "setup", key: "z", dialogOpen, event: shape(event, 1) })
          },
        },
      ],
    }))
    log("layer-from-setup-ok", {})
  } catch (err) {
    log("layer-from-setup-error", String(err))
  }

  dumpCommands(keymap as Record<string, unknown>, "after-layer-setup")
}

function openDialog(ui: {
  dialog?: {
    show?: (render: () => unknown, onClose?: () => void) => void
    set?: (opts: unknown) => void
  }
}): void {
  try {
    dialogOpen = true
    ui.dialog?.show?.(
      () => <ProbeDialog />,
      () => {
        dialogOpen = false
        log("dialog-onclose", { via: "callback" })
      },
    )
    log("dialog-show-ok", {})
    try {
      ui.dialog?.set?.({ size: "large", centered: true })
      log("dialog-set-ok", { size: "large", centered: true })
    } catch (err) {
      log("dialog-set-error", String(err))
    }
  } catch (err) {
    log("dialog-show-error", String(err))
  }
}

type PluginMod = { Plugin?: { define: (def: unknown) => unknown } }

let pluginMod: PluginMod | null = null
try {
  pluginMod = (await import("@opencode/plugin/tui")) as PluginMod
  log("tui-import-ok", { keys: Object.keys(pluginMod) })
} catch (err) {
  log("tui-import-error", String(err))
}

const define = pluginMod?.Plugin?.define
const plugin = define
  ? define({
      id: "probe",
      setup(context: AnyCtx) {
        ctxRef = context
        log("tui-setup", {
          version: context.app?.version,
          channel: context.app?.channel,
          contextKeys: keysOf(context),
          uiKeys: keysOf(context.ui),
          keymapKeys: keysOf(context.keymap),
          dataKeys: keysOf(context.data),
          clientKeys: keysOf(context.client),
          hasClient: typeof context.client === "object",
          options: context.options ?? null,
          location: shape(context.location, 2),
          entry: "tui.tsx",
        })
        subscribeData(context)
        registerSlotsAndCommands(context)
        log("tui-setup-done", { out: OUT })
        void afterSetup(context).catch((err) => log("after-setup-error", String(err)))
        return () => log("tui-dispose", {})
      },
    })
  : {
      id: "probe",
      setup(context: AnyCtx) {
        ctxRef = context
        log("tui-setup-without-define", { contextKeys: keysOf(context) })
        subscribeData(context)
        registerSlotsAndCommands(context)
        log("tui-setup-done", { out: OUT })
        void afterSetup(context).catch((err) => log("after-setup-error", String(err)))
        return () => log("tui-dispose", {})
      },
    }

export default plugin
