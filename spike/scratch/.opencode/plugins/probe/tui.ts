/**
 * TUI probe fallback entry (no JSX syntax).
 * Used when package.json exports["./tui"] points here.
 *
 * Tries dynamic import of ./tui.tsx first (records loader error), then
 * solid-js createComponent / jsx-runtime helpers for paint.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Repo root derived from this file (spike/scratch/.opencode/plugins/probe/). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..")

const OUT = process.env.PROBE_TUI_OUT ?? join(REPO_ROOT, "spike", "out", "tui-probe.jsonl")

function log(kind: string, data: unknown = {}): void {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // best effort
  }
}

log("tui-module-evaluated", { out: OUT, cwd: process.cwd(), entry: "tui.ts" })

function shape(value: unknown, depth = 2): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "function") return "[fn]"
  if (t !== "object") return value
  if (depth <= 0) return Array.isArray(value) ? `[array:${(value as unknown[]).length}]` : "[object]"
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => shape(item, depth - 1))
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as object).sort()) {
    try {
      out[key] = shape((value as Record<string, unknown>)[key], depth - 1)
    } catch (e) {
      out[key] = `[throw:${String(e)}]`
    }
  }
  return out
}

function keysOf(value: unknown): string[] {
  if (value && typeof value === "object") return Object.keys(value as object).sort()
  return []
}

type AnyCtx = Record<string, unknown>
let jsxFn: ((type: unknown, props: unknown, ...rest: unknown[]) => unknown) | null = null
let createComponentFn: ((type: unknown, props: unknown) => unknown) | null = null
let dialogOpen = false
let parentSessionID: string | null = null
let layerEnabled = true

async function loadJsxHelpers(): Promise<void> {
  for (const spec of ["solid-js/jsx-runtime", "@opentui/solid/jsx-runtime"]) {
    try {
      const mod = (await import(spec)) as { jsx?: typeof jsxFn }
      if (typeof mod.jsx === "function") {
        jsxFn = mod.jsx
        log("jsx-helper-ok", { spec, keys: Object.keys(mod) })
        break
      }
    } catch (err) {
      log("jsx-helper-fail", { spec, error: String(err) })
    }
  }
  try {
    const solid = (await import("solid-js")) as { createComponent?: typeof createComponentFn }
    if (typeof solid.createComponent === "function") {
      createComponentFn = solid.createComponent
      log("createComponent-ok", { keys: Object.keys(solid).slice(0, 40) })
    }
  } catch (err) {
    log("createComponent-fail", String(err))
  }
}

function paint(tag: string, children: string): unknown {
  if (jsxFn) {
    try {
      return jsxFn(tag, { children })
    } catch (err) {
      log("jsx-call-error", { tag, error: String(err) })
    }
  }
  if (createComponentFn) {
    try {
      const Comp = (props: { children?: unknown }) => props.children
      return createComponentFn(Comp, { children })
    } catch (err) {
      log("createComponent-call-error", { tag, error: String(err) })
    }
  }
  return children
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
      return { id: rec.id ?? rec.name, title: rec.title, bind: rec.bind, palette: rec.palette, slash: rec.slash }
    })
    log("keymap-probeish", {
      label,
      commands: brief.filter((c) =>
        /ultracode|probe|inspect|palette|command/i.test(`${c.id} ${c.title ?? ""} ${c.bind ?? ""}`),
      ),
    })
  } catch (err) {
    log("keymap-commands-error", { label, error: String(err) })
  }
}

function subscribeData(context: AnyCtx): void {
  const data = context.data as {
    on?: (type: string, handler: (ev: unknown) => void) => () => void
    listen?: (handler: (ev: unknown) => void) => () => void
  }
  if (typeof data?.listen === "function") {
    try {
      data.listen((ev) => {
        const rec = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {}
        const details = rec.details && typeof rec.details === "object" ? (rec.details as Record<string, unknown>) : rec
        const type = String(details.type ?? rec.type ?? "unknown")
        if (!/^session\.|^command\./.test(type)) return
        log("data-listen", { type, keys: keysOf(details), dataKeys: keysOf(details.data) })
      })
      log("data-listen-ok", {})
    } catch (err) {
      log("data-listen-error", String(err))
    }
  }
  for (const type of [
    "session.created",
    "session.updated",
    "session.deleted",
    "session.execution.started",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.tool.called",
  ]) {
    try {
      data?.on?.(type, (ev) => {
        const rec = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {}
        log("data-on", { type, keys: keysOf(rec), dataKeys: keysOf(rec.data) })
      })
      log("data-on-subscribed", { type })
    } catch (err) {
      log("data-on-error", { type, error: String(err) })
    }
  }
}

function dumpSessionStore(data: unknown, label: string): void {
  const session = (data as { session?: { list?: () => unknown[] } } | undefined)?.session
  try {
    const list = typeof session?.list === "function" ? session.list() : []
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
          full: rec,
        }
      }),
    })
  } catch (err) {
    log("data-session-list-error", { label, error: String(err) })
  }
}

async function afterSetup(context: AnyCtx): Promise<void> {
  log("after-setup-start", { entry: "tui.ts" })
  await loadJsxHelpers()
  const client = context.client as {
    session?: {
      create?: (input?: unknown) => Promise<Record<string, unknown>>
      command?: (input: unknown) => Promise<unknown>
    }
  }
  const ui = context.ui as {
    router?: { navigate?: (d: unknown) => void }
    panel?: { current?: () => unknown }
  }
  try {
    const created = await client?.session?.create?.({ title: "probe-tui-parent" })
    parentSessionID = typeof created?.id === "string" ? created.id : null
    log("client-session-create", { id: parentSessionID, keys: keysOf(created), title: created?.title ?? null })
    if (parentSessionID) {
      ui.router?.navigate?.({ type: "session", sessionID: parentSessionID })
      log("router-navigate", { sessionID: parentSessionID })
    }
  } catch (err) {
    log("client-session-create-error", String(err))
  }
  await new Promise((r) => setTimeout(r, 800))
  dumpCommands(context.keymap as Record<string, unknown>, "after-navigate")
  dumpSessionStore(context.data, "after-navigate")
  if (parentSessionID && typeof client?.session?.command === "function") {
    const input = { sessionID: parentSessionID, command: "ultracode", text: "help" }
    try {
      const result = await client.session.command(input)
      log("client-session-command", { input, result: shape(result) })
    } catch (err) {
      log("client-session-command-error", { input, error: String(err) })
    }
  }
  log("ready-for-keys", { parentSessionID, panelCurrent: shape(ui.panel?.current?.()) })
}

function register(context: AnyCtx): void {
  const ui = context.ui as {
    slot?: (claim: unknown) => () => void
    panel?: { open?: (name: string) => boolean; current?: () => unknown }
    dialog?: {
      show?: (render: () => unknown, onClose?: () => void) => void
      set?: (opts: unknown) => void
    }
  }
  const keymap = context.keymap as { layer?: (input: () => unknown) => void }

  const chip = () => {
    try {
      keymap.layer?.(() => ({
        enabled: () => layerEnabled,
        priority: 80,
        commands: [
          {
            id: "probe.layer.z",
            title: "probe layer z",
            bind: "z",
            run: (_i?: string, event?: unknown) => {
              log("layer-key", { from: "component-chip", key: "z", dialogOpen, event: shape(event, 1) })
            },
          },
        ],
      }))
    } catch (err) {
      log("layer-from-component-error", String(err))
    }
    return paint("text", "UCPROBE-CHIP")
  }

  try {
    ui.slot?.({ append: "prompt.footer.status", render: chip })
    log("slot-chip-ok", { append: "prompt.footer.status", via: "tui.ts" })
  } catch (err) {
    log("slot-chip-error", String(err))
  }
  try {
    ui.slot?.({
      append: "session.panel",
      render: (input: { name?: string }) => {
        log("panel-render", { name: input?.name ?? null })
        return paint("text", "UCPROBE-PANEL")
      },
    })
    log("slot-panel-ok", { append: "session.panel" })
  } catch (err) {
    log("slot-panel-error", String(err))
  }
  try {
    ui.slot?.({ append: "home.footer", render: () => paint("text", "UCPROBE-HOME") })
    log("slot-home-ok", {})
  } catch (err) {
    log("slot-home-error", String(err))
  }

  try {
    keymap.layer?.(() => ({
      enabled: true,
      priority: 20,
      commands: [
        {
          id: "ultracode.inspect",
          title: "Ultracode inspect (probe)",
          palette: true,
          bind: "ctrl+g",
          slash: { name: "ucprobe" },
          run: () => {
            log("command-run", { id: "ultracode.inspect" })
            try {
              const ok = ui.panel?.open?.("ultracode.inspect")
              log("panel-open", { ok, current: shape(ui.panel?.current?.()) })
            } catch (e) {
              log("panel-open-error", String(e))
            }
          },
        },
        {
          id: "probe.dialog",
          title: "Probe dialog",
          palette: true,
          bind: "ctrl+f",
          run: () => {
            log("command-run", { id: "probe.dialog" })
            try {
              dialogOpen = true
              ui.dialog?.show?.(
                () => paint("text", "UCPROBE-DIALOG"),
                () => {
                  dialogOpen = false
                  log("dialog-onclose", { via: "callback" })
                },
              )
              ui.dialog?.set?.({ size: "large", centered: true })
              log("dialog-show-ok", { via: "tui.ts" })
            } catch (e) {
              log("dialog-show-error", String(e))
            }
          },
        },
        {
          id: "probe.layer.setup-z",
          bind: "z",
          run: () => log("layer-key", { from: "setup", key: "z", dialogOpen }),
        },
      ],
    }))
    log("layer-from-setup-ok", { via: "tui.ts" })
  } catch (err) {
    log("layer-from-setup-error", String(err))
  }
  dumpCommands(keymap as Record<string, unknown>, "after-layer-setup")
}

function buildFallbackPlugin(): unknown {
  type PluginMod = { Plugin?: { define: (def: unknown) => unknown } }
  let pluginMod: PluginMod | null = null
  return (async () => {
    try {
      pluginMod = (await import("@opencode/plugin/tui")) as PluginMod
      log("tui-import-ok", { keys: Object.keys(pluginMod) })
    } catch (err) {
      log("tui-import-error", String(err))
    }
    const define = pluginMod?.Plugin?.define
    const setup = (context: AnyCtx) => {
      log("tui-setup", {
        version: (context.app as { version?: string } | undefined)?.version,
        channel: (context.app as { channel?: string } | undefined)?.channel,
        contextKeys: keysOf(context),
        uiKeys: keysOf(context.ui),
        keymapKeys: keysOf(context.keymap),
        dataKeys: keysOf(context.data),
        entry: "tui.ts-fallback",
      })
      subscribeData(context)
      register(context)
      log("tui-setup-done", { out: OUT, entry: "tui.ts-fallback" })
      void afterSetup(context).catch((err) => log("after-setup-error", String(err)))
      return () => log("tui-dispose", {})
    }
    return define ? define({ id: "probe", setup }) : { id: "probe", setup }
  })()
}

let plugin: unknown
try {
  const tsx = await import("./tui.tsx")
  log("tsx-import-ok", { keys: Object.keys(tsx as object) })
  plugin = (tsx as { default: unknown }).default
} catch (err) {
  log("tsx-import-error", String(err))
  plugin = await buildFallbackPlugin()
}

export default plugin
