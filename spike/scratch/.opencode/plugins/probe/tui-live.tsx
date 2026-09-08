/** @jsxImportSource solid-js */
/**
 * Live paint wiring: load the real TUI plugin (src/tui.tsx), then seed a
 * parent session plus `[uc:]` children and open the inspect panel so the
 * two-column inspector paints. Fake children are paint-proof only (no live
 * supervisor run).
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import real from "../../../../../src/tui.tsx"

const OUT =
  process.env.PROBE_TUI_OUT ??
  "<repo>/spike/out/tui-probe.jsonl"
const SERVER_OUT =
  process.env.PROBE_OUT ??
  "<repo>/spike/out/tui-live-server.jsonl"

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
}

log("tui-module-evaluated", { entry: "tui-live.tsx", jsxImportSource: "solid-js", pragma: true })

type AnyCtx = {
  app?: { version?: string; channel?: string }
  ui?: {
    panel?: { open?: (name: string) => boolean }
    router?: { navigate?: (d: unknown) => void }
  }
  client?: {
    session?: {
      create?: (input?: unknown) => Promise<{ id?: string }>
      command?: (input: unknown) => Promise<unknown>
    }
  }
  data?: {
    session?: {
      sync?: (id: string) => Promise<void>
      list?: () => unknown[]
    }
  }
}

type PluginDef = {
  id?: string
  setup: (context: AnyCtx) => Promise<(() => void) | void> | (() => void) | void
}

const realPlugin = real as unknown as PluginDef

async function seed(context: AnyCtx): Promise<void> {
  let parentID: string | undefined
  try {
    const parent = await context.client?.session?.create?.({ title: "uc-live-parent" })
    parentID = typeof parent?.id === "string" ? parent.id : undefined
    log("live-session-create", { id: parentID ?? null, title: "uc-live-parent", role: "parent" })
  } catch (err) {
    log("live-session-create-error", String(err))
  }
  if (parentID) {
    try {
      context.ui?.router?.navigate?.({ type: "session", sessionID: parentID })
      log("live-navigate", { sessionID: parentID })
    } catch (err) {
      log("live-navigate-error", String(err))
    }
  }

  const titles = [
    "[uc:run_livepaint a1 research] seeker",
    "[uc:run_livepaint a2 research] retry",
    "[uc:run_livepaint a3 extract] judge",
  ]
  for (const title of titles) {
    try {
      const created = await context.client?.session?.create?.({ title })
      const id = typeof created?.id === "string" ? created.id : undefined
      log("live-session-create", { id: id ?? null, title, role: "child" })
      if (id) {
        try {
          await context.data?.session?.sync?.(id)
        } catch (err) {
          log("live-sync-error", String(err))
        }
      }
    } catch (err) {
      log("live-session-create-error", String(err))
    }
  }

  await new Promise((r) => setTimeout(r, 800))
  try {
    const ok = context.ui?.panel?.open?.("ultracode.inspect")
    log("live-panel-open", { ok: ok ?? null })
  } catch (err) {
    log("live-panel-open-error", String(err))
  }
  await new Promise((r) => setTimeout(r, 1200))
  log("ready-for-keys", {
    sessionID: parentID ?? null,
    listCount: (() => {
      try {
        return context.data?.session?.list?.()?.length ?? null
      } catch {
        return null
      }
    })(),
    note: "fake [uc:] children for paint proof; transport session = parent",
  })
}

const plugin: PluginDef = {
  id: realPlugin.id ?? "ultracode-tui",
  async setup(context: AnyCtx) {
    log("tui-setup", {
      version: context.app?.version,
      channel: context.app?.channel,
      entry: "tui-live.tsx",
    })
    let cleanup: (() => void) | void
    try {
      cleanup = await realPlugin.setup(context)
    } catch (err) {
      log("real-setup-error", String(err))
    }
    try {
      const session = context.client?.session
      const orig = session?.command?.bind(session)
      if (typeof orig === "function" && session) {
        session.command = async (input: unknown) => {
          log("client-session-command", { input })
          const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
          logTo(SERVER_OUT, "command-invoked", {
            name: rec.command ?? "ultracode",
            sessionID: rec.sessionID ?? null,
            text: rec.text ?? null,
            via: "tui-client-wrap",
          })
          try {
            const result = await orig(input)
            log("client-session-command-done", { input, result: result ?? null })
            return result
          } catch (err) {
            log("client-session-command-error", { input, error: String(err) })
            throw err
          }
        }
      }
    } catch (err) {
      log("client-command-wrap-error", String(err))
    }
    log("tui-setup-done", { out: OUT })
    void seed(context).catch((err) => log("live-seed-error", String(err)))
    return cleanup
  },
}

export default plugin
