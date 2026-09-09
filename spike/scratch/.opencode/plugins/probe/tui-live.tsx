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
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import real from "../../../../../src/tui.tsx"
import { parseRunAck } from "../../../../../src/tui-render.ts"

/** Repo root derived from this file (spike/scratch/.opencode/plugins/probe/). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..")

const OUT = process.env.PROBE_TUI_OUT ?? join(REPO_ROOT, "spike", "out", "tui-probe.jsonl")
const PARENT_MSG_OUT =
  process.env.PROBE_PARENT_MSG_OUT ?? join(REPO_ROOT, "spike", "out", "tui-live-parent-messages.jsonl")
const ALLOW_PAINT_FALLBACK = process.env.TUI_PROBE_ALLOW_PAINT_FALLBACK === "1"

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
    message?: { list?: (input: unknown) => Promise<unknown> }
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

function runIDFromTitles(titles: string[]): string | undefined {
  for (const title of titles) {
    if (title.includes("run_livepaint")) continue
    const m = /\[uc:([^\s\]]+)/.exec(title)
    if (m?.[1]) return m[1]
  }
  return undefined
}

/** Pull RunEnvelope-shaped { runID, status } objects out of parent message text. */
function extractEnvelopeRecords(texts: string[]): Array<{ runID: string; status: string }> {
  const records: Array<{ runID: string; status: string }> = []
  const seen = new Set<string>()
  const consider = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const item of value) consider(item)
      return
    }
    const rec = value as { runID?: unknown; status?: unknown }
    if (typeof rec.runID === "string" && typeof rec.status === "string") {
      const key = `${rec.runID}\0${rec.status}`
      if (!seen.has(key)) {
        seen.add(key)
        records.push({ runID: rec.runID, status: rec.status })
      }
    }
  }
  for (const text of texts) {
    const trimmed = text.trim()
    if (!trimmed) continue
    try {
      consider(JSON.parse(trimmed))
      continue
    } catch {
      // surrounding prose / acks
    }
    const start = trimmed.indexOf("{")
    const end = trimmed.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        consider(JSON.parse(trimmed.slice(start, end + 1)))
      } catch {
        // ignore non-envelope text
      }
    }
  }
  return records
}

function messageTexts(raw: unknown): string[] {
  const rec = raw && typeof raw === "object" ? (raw as { data?: unknown }) : undefined
  const list = Array.isArray(rec?.data) ? rec.data : Array.isArray(raw) ? raw : []
  const texts: string[] = []
  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const msg = item as { content?: unknown; text?: unknown; parts?: unknown }
    if (typeof msg.text === "string") texts.push(msg.text)
    const content = Array.isArray(msg.content) ? msg.content : Array.isArray(msg.parts) ? msg.parts : []
    for (const part of content) {
      if (part && typeof part === "object") {
        const text = (part as { text?: unknown; content?: unknown }).text ?? (part as { content?: unknown }).content
        if (typeof text === "string") texts.push(text)
      }
    }
  }
  return texts
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

async function dumpParentMessages(context: AnyCtx, parentID: string | undefined, runID: string | undefined): Promise<void> {
  if (!parentID) return
  let raw: unknown
  try {
    raw = await context.client?.message?.list?.({ sessionID: parentID })
  } catch (err) {
    log("live-parent-messages-error", String(err))
    return
  }
  const texts = messageTexts(raw)
  for (const text of texts) {
    const ack = parseRunAck(text)
    if (ack) {
      log("live-run-ack", ack)
      logTo(PARENT_MSG_OUT, "live-run-ack", ack)
    }
  }
  const records = extractEnvelopeRecords(texts)
  const payload = { sessionID: parentID, runID: runID ?? null, records, texts, raw: raw ?? null }
  log("live-parent-final-messages", payload)
  logTo(PARENT_MSG_OUT, "live-parent-final-messages", payload)
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
        const runID = runIDFromTitles(realTitles)
        log("live-real-uc-children", { titles: realTitles, parentID: parentID ?? null, runID: runID ?? null })
        log("live-run-id", { runID: runID ?? null })
      }
      if (!opened) {
        opened = true
        await openInspect(context)
      }
      return
    }
    if (ALLOW_PAINT_FALLBACK && !fallback) {
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
    context.data?.on?.("session.execution.interrupted", (ev: unknown) => {
      log("live-child-complete", { event: ev ?? null, titles: ucTitles(context), interrupted: true })
      void tick()
    })
    context.data?.on?.("session.synthetic", (ev: unknown) => {
      log("live-session-synthetic", { event: ev ?? null })
      const rec = ev && typeof ev === "object" ? (ev as { data?: { text?: string }; text?: string }) : undefined
      const text = rec?.data?.text ?? rec?.text
      if (typeof text === "string") {
        const ack = parseRunAck(text)
        if (ack) log("live-run-ack", ack)
      }
    })
  } catch (err) {
    log("live-watch-error", String(err))
  }

  while (Date.now() < deadline) {
    await tick()
    const titles = ucTitles(context)
    if (opened && titles.length > 0) {
      const runID = runIDFromTitles(titles)
      await dumpParentMessages(context, parentID, runID)
      // keep polling so stop acks after p/x are captured
    }
    await new Promise((r) => setTimeout(r, 500))
    if (opened && titles.length > 0 && Date.now() > deadline - 5_000) break
  }

  const titles = ucTitles(context)
  const paintOnly = isPaintFallback(titles) && realTitlesEmpty(titles)
  const runID = runIDFromTitles(titles)
  await dumpParentMessages(context, parentID, runID)
  log("live-watch-done", {
    sessionID: parentID ?? null,
    ucTitles: titles,
    paintFallback: paintOnly,
    runID: runID ?? null,
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
