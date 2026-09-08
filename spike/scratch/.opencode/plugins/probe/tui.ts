/**
 * TUI/CLI plugin probe — dumps the live OpenCode2 TUI plugin API on load.
 * Writes JSONL to spike/out/tui-probe.jsonl (PROBE_TUI_OUT overrides).
 *
 * Loaded as the TUI half of `.opencode/plugins/probe/` (sibling of index.ts).
 * Does not register a lasting keymap or steal `down`.
 *
 * Imports `@opencode/plugin/tui` dynamically so a missing export still leaves
 * a log line (ESM static imports are hoisted and would skip the file write).
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const OUT =
  process.env.PROBE_TUI_OUT ??
  "<repo>/spike/out/tui-probe.jsonl"

function log(kind: string, data: unknown): void {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // best effort
  }
}

log("tui-module-evaluated", { out: OUT, cwd: process.cwd() })

function shape(value: unknown, depth = 2): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "function") return "[fn]"
  if (t !== "object") return value
  if (depth <= 0) return Array.isArray(value) ? `[array:${value.length}]` : "[object]"
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => shape(item, depth - 1))
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

function tryCall(label: string, fn: () => unknown): void {
  try {
    log(label, shape(fn()))
  } catch (err) {
    log(`${label}-error`, String(err))
  }
}

function dumpContext(context: Record<string, unknown>): void {
  const ui = (context.ui ?? {}) as Record<string, unknown>
  const keymap = (context.keymap ?? {}) as Record<string, unknown>
  const data = (context.data ?? {}) as Record<string, unknown>
  const app = (context.app ?? {}) as Record<string, unknown>
  log("tui-setup", {
    version: app.version,
    channel: app.channel,
    contextKeys: Object.keys(context).sort(),
    uiKeys: Object.keys(ui).sort(),
    keymapKeys: Object.keys(keymap).sort(),
    dataKeys: Object.keys(data).sort(),
    hasClient: typeof context.client === "object",
    options: context.options ?? null,
    location: shape(context.location, 2),
  })
  log("ui-shape", {
    slot: typeof ui.slot,
    panel: shape(ui.panel, 2),
    router: shape(ui.router, 2),
    dialog: shape(ui.dialog, 2),
    toast: shape(ui.toast, 2),
    tabs: shape(ui.tabs, 2),
    format: shape(ui.format, 2),
  })
  if (typeof keymap.commands === "function") {
    try {
      const commands = (keymap.commands as () => unknown)()
      const list = Array.isArray(commands) ? commands : []
      log("keymap-commands-count", list.length)
      const interesting = list
        .map((c) => {
          const rec = c as Record<string, unknown>
          return { id: rec.id ?? rec.name, title: rec.title, bind: rec.bind, slash: rec.slash }
        })
        .filter((c) => {
          const id = String(c.id ?? "")
          return /tab|child|ultracode|session|down|panel|inspect/i.test(id + String(c.bind ?? "") + String(c.title ?? ""))
        })
      log("keymap-interesting", interesting)
    } catch (err) {
      log("keymap-commands-error", String(err))
    }
  } else {
    log("keymap-commands-missing", { keymapKeys: Object.keys(keymap) })
  }
  const mode = keymap.mode as { current?: () => unknown } | undefined
  tryCall("keymap-mode", () => mode?.current?.())

  const slotNames = [
    "prompt.footer.status",
    "prompt.footer",
    "session.panel",
    "session.composer.top",
    "sidebar.content",
    "sidebar.footer",
    "app",
    "app_bottom",
    "home.footer",
    "session_prompt_right",
  ]
  if (typeof ui.slot === "function") {
    const slot = ui.slot as (input: unknown) => unknown
    for (const name of slotNames) {
      try {
        const dispose = slot({ append: name, render: () => null })
        log("slot-append-ok", { name, dispose: typeof dispose })
        if (typeof dispose === "function") {
          try {
            ;(dispose as () => void)()
          } catch (err) {
            log("slot-dispose-error", { name, error: String(err) })
          }
        }
      } catch (err) {
        log("slot-append-error", { name, error: String(err) })
      }
    }
  } else {
    log("slot-api-missing", { uiKeys: Object.keys(ui) })
  }
  const panel = ui.panel as { open?: Function; close?: Function; current?: Function } | undefined
  if (panel) {
    tryCall("panel-current", () => panel.current?.())
    log("panel-api", { open: typeof panel.open, close: typeof panel.close, current: typeof panel.current })
  }
  log("tui-setup-done", { out: OUT })
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
      setup(context: Record<string, unknown>) {
        dumpContext(context)
        return () => log("tui-dispose", {})
      },
    })
  : {
      id: "probe",
      setup(context: Record<string, unknown>) {
        log("tui-setup-without-define", { contextKeys: Object.keys(context) })
        dumpContext(context)
        return () => log("tui-dispose", {})
      },
    }

export default plugin
