/**
 * Live paint wiring: load the real server plugin (src/index.ts) in place of
 * the probe server half. Used by `scripts/tui-probe.sh --live`.
 *
 * Wraps command.execute so x/p/s transport shows up as command-invoked jsonl.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import real from "../../../../../src/index.ts"

const OUT =
  process.env.PROBE_OUT ??
  "<repo>/spike/out/tui-live-server.jsonl"
const TUI_OUT =
  process.env.PROBE_TUI_OUT ??
  "<repo>/spike/out/tui-live.jsonl"

function logTo(path: string, kind: string, data: unknown = {}): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // best effort
  }
}

function log(kind: string, data: unknown = {}): void {
  logTo(OUT, kind, data)
  // Beacon on the TUI jsonl too — the server process may not inherit PROBE_OUT.
  if (
    kind === "setup" ||
    kind === "setup-done" ||
    kind === "index-live-module-evaluated" ||
    kind === "command-invoked" ||
    kind === "real-setup-error"
  ) {
    logTo(TUI_OUT, kind, { ...((data && typeof data === "object" ? data : { data }) as object), via: "index-live" })
  }
}

log("index-live-module-evaluated", { pid: process.pid, probeOut: OUT })

type AnyCtx = {
  command?: {
    transform?: (fn: (editor: { add?: (cmd: Record<string, unknown>) => unknown }) => void) => unknown
  }
}

type PluginDef = {
  id?: string
  setup: (context: AnyCtx) => Promise<(() => void) | void> | (() => void) | void
}

const realPlugin = real as unknown as PluginDef

const plugin: PluginDef = {
  // Keep id `probe` so setup runs even when a global `ultracode` plugin is already loaded.
  id: "probe",
  async setup(context: AnyCtx) {
    log("setup", { wrapped: true, hasTransform: typeof context.command?.transform === "function" })
    try {
      const orig = context.command?.transform?.bind(context.command)
      if (typeof orig === "function") {
        context.command!.transform = (fn) =>
          orig((editor) => {
            const add = editor.add?.bind(editor)
            if (typeof add === "function") {
              editor.add = (cmd) => {
                const exec = cmd?.execute
                if (typeof exec === "function") {
                  cmd = {
                    ...cmd,
                    execute: async (inv: { sessionID?: string; prompt?: { text?: string } }) => {
                      log("command-invoked", {
                        name: cmd.name ?? null,
                        sessionID: inv?.sessionID ?? null,
                        text: inv?.prompt?.text ?? null,
                        invocationKeys: inv && typeof inv === "object" ? Object.keys(inv) : [],
                      })
                      return (exec as (i: unknown) => unknown)(inv)
                    },
                  }
                }
                return add(cmd)
              }
            }
            fn(editor)
          })
      }
    } catch (err) {
      log("command-wrap-error", String(err))
    }
    try {
      const cleanup = await realPlugin.setup(context)
      log("setup-done", { realId: realPlugin.id ?? null })
      return cleanup
    } catch (err) {
      log("real-setup-error", String(err))
    }
  },
}

export default plugin
