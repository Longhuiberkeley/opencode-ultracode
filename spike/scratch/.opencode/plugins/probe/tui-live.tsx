/** @jsxImportSource solid-js */
/**
 * Live paint wiring: load the real TUI plugin (src/tui.tsx), then seed a
 * `[uc:]` child session and open the inspect panel so chip+panel paint.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import real from "../../../../../src/tui.tsx"

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
  let sessionID: string | undefined
  try {
    const created = await context.client?.session?.create?.({
      title: "[uc:run_livepaint a1 research] seeker",
    })
    sessionID = typeof created?.id === "string" ? created.id : undefined
    log("live-session-create", { id: sessionID ?? null })
  } catch (err) {
    log("live-session-create-error", String(err))
  }
  if (sessionID) {
    try {
      context.ui?.router?.navigate?.({ type: "session", sessionID })
      log("live-navigate", { sessionID })
    } catch (err) {
      log("live-navigate-error", String(err))
    }
    try {
      await context.data?.session?.sync?.(sessionID)
    } catch (err) {
      log("live-sync-error", String(err))
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
    sessionID: sessionID ?? null,
    listCount: (() => {
      try {
        return context.data?.session?.list?.()?.length ?? null
      } catch {
        return null
      }
    })(),
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
    log("tui-setup-done", { out: OUT })
    void seed(context).catch((err) => log("live-seed-error", String(err)))
    return cleanup
  },
}

export default plugin
