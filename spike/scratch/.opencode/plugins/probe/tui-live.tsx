/** @jsxImportSource solid-js */
/**
 * Live wiring: load the real TUI plugin (src/tui.tsx), navigate to a parent
 * session, wait for REAL `[uc:]` children from an authoring prompt typed into
 * the PTY, then open the inspect panel.
 *
 * Fake `run_livepaint` children are a paint-only fallback when no real run
 * spawns — transport assertions must then be skipped.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import real from "../../../../../src/tui.tsx"

const OUT =
  process.env.PROBE_TUI_OUT ??
  "<repo>/spike/out/tui-probe.jsonl"

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
    on?: (type: string, handler: (ev: unknown) => void) => () => void
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

function ucTitles(context: AnyCtx): string[] {
  try {
    const list = context.data?.session?.list?.() ?? []
    const out: string[] = []
    for (const item of list) {
      const title = item && typeof item === "object" ? (item as { title?: string }).title : undefined
      if (typeof title === "string" && title.includes("[uc:")) out.push(title)
    }
    return out
  } catch {
    return []
  }
}

function isPaintFallback(titles: string[]): boolean {
  return titles.some((t) => t.includes("run_livepaint"))
}

async function seedPaintFallback(context: AnyCtx, parentID: string | undefined): Promise<void> {
  log("WARNING", {
    message: "no real [uc:] run spawned — seeding run_livepaint paint-only fallback; SKIP transport assertions",
  })
  const titles = [
    `[uc:run_livepaint a1 research${parentID ? ` p:${parentID}` : ""}] seeker`,
    `[uc:run_livepaint a2 research${parentID ? ` p:${parentID}` : ""}] retry`,
    `[uc:run_livepaint a3 extract${parentID ? ` p:${parentID}` : ""}] judge`,
  ]
  for (const title of titles) {
    try {
      const created = await context.client?.session?.create?.({ title })
      const id = typeof created?.id === "string" ? created.id : undefined
      log("live-session-create", { id: id ?? null, title, role: "child", fallback: true })
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
}

async function openInspect(context: AnyCtx): Promise<void> {
  try {
    const ok = context.ui?.panel?.open?.("ultracode.inspect")
    log("live-panel-open", { ok: ok ?? null })
  } catch (err) {
    log("live-panel-open-error", String(err))
  }
}

async function watchForRun(context: AnyCtx, parentID: string | undefined): Promise<void> {
  const deadline = Date.now() + 90_000
  let opened = false
  let fallback = false
  let loggedReal = false
  const tick = async (): Promise<void> => {
    const titles = ucTitles(context)
    const realTitles = titles.filter((t) => !t.includes("run_livepaint"))
    if (realTitles.length > 0) {
      if (!loggedReal) {
        loggedReal = true
        log("live-real-uc-children", { titles: realTitles, parentID: parentID ?? null })
      }
      if (!opened) {
        opened = true
        await openInspect(context)
      }
      return
    }
    if (!fallback && Date.now() > deadline - 15_000) {
      fallback = true
      await seedPaintFallback(context, parentID)
      await new Promise((r) => setTimeout(r, 800))
      await openInspect(context)
      opened = true
    }
  }

  try {
    context.data?.on?.("session.created", () => {
      void tick()
    })
    context.data?.on?.("session.execution.started", () => {
      void tick()
    })
    context.data?.on?.("session.execution.succeeded", (ev: unknown) => {
      log("live-child-complete", { event: ev ?? null, titles: ucTitles(context) })
      void tick()
    })
    context.data?.on?.("session.synthetic", (ev: unknown) => {
      log("live-session-synthetic", { event: ev ?? null })
    })
  } catch (err) {
    log("live-watch-error", String(err))
  }

  while (Date.now() < deadline) {
    await tick()
    if (opened && ucTitles(context).length > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }

  const titles = ucTitles(context)
  const paintOnly = isPaintFallback(titles) && realTitlesEmpty(titles)
  log("live-watch-done", {
    sessionID: parentID ?? null,
    ucTitles: titles,
    paintFallback: paintOnly,
    note: paintOnly
      ? "WARNING: paint-only run_livepaint fallback — skip transport assertions"
      : "real [uc:] children; transport session = parent",
  })
}

function realTitlesEmpty(titles: string[]): boolean {
  return !titles.some((t) => t.includes("[uc:") && !t.includes("run_livepaint"))
}

async function boot(context: AnyCtx): Promise<void> {
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
  await new Promise((r) => setTimeout(r, 600))
  log("ready-for-keys", {
    sessionID: parentID ?? null,
    listCount: (() => {
      try {
        return context.data?.session?.list?.()?.length ?? null
      } catch {
        return null
      }
    })(),
    note: "parent ready; type authoring prompt for a real run",
  })
  await watchForRun(context, parentID)
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
    void boot(context).catch((err) => log("live-seed-error", String(err)))
    return cleanup
  },
}

export default plugin
