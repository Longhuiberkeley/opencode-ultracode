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

function log(kind: string, data: unknown = {}): void {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // best effort
  }
}

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
  id: realPlugin.id ?? "ultracode",
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
    return realPlugin.setup(context)
  },
}

export default plugin
