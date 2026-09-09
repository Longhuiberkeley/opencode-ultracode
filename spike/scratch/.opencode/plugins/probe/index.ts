// Spike probe plugin — verifies undocumented OpenCode v2 plugin API shapes.
// Writes JSONL events to spike/out/probe-log.jsonl (PROBE_OUT overrides).
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Repo root derived from this file (spike/scratch/.opencode/plugins/probe/). */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..")

const OUT = process.env.PROBE_OUT ?? join(REPO_ROOT, "spike", "out", "probe-log.jsonl")

const SKILL_LOCATION = join(REPO_ROOT, "spike", "scratch", ".opencode", "skills", "probe-skill.md")

const UC_META = { uc: { v: 1, run: "run_probe", ord: "a1" } }

function log(kind: string, data: unknown) {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, JSON.stringify({ time: new Date().toISOString(), kind, data }) + "\n")
  } catch {
    // ignore — best effort
  }
}

function safeJson(value: unknown): string {
  const seen = new WeakSet()
  return (
    JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === "function") return "[fn]"
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[circular]"
          seen.add(v)
        }
        return v
      },
      1,
    )?.slice(0, 8000) ?? "unserializable"
  )
}

function keysOf(value: unknown): string[] {
  if (value && typeof value === "object") return Object.keys(value as object).sort()
  return []
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label}`)), ms).unref?.(),
    ),
  ])
}

async function step<T>(label: string, fn: () => Promise<T>, ms = 90_000): Promise<T | undefined> {
  try {
    const result = await withTimeout(fn(), ms, label)
    log(label, result as unknown)
    return result
  } catch (e) {
    log(`${label}-error`, String(e))
    return undefined
  }
}

function compactEvent(ev: unknown): Record<string, unknown> {
  const rec = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {}
  const data = rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : undefined
  const durable = rec.durable && typeof rec.durable === "object" ? (rec.durable as Record<string, unknown>) : undefined
  return {
    type: rec.type ?? null,
    id: rec.id ?? null,
    created: rec.created ?? null,
    keys: keysOf(rec),
    durable: durable ?? null,
    durableKeys: durable ? keysOf(durable) : null,
    seq: durable?.seq ?? rec.seq ?? null,
    version: durable?.version ?? rec.version ?? null,
    aggregateID: durable?.aggregateID ?? null,
    dataKeys: data ? keysOf(data) : null,
    sessionID: data?.sessionID ?? rec.sessionID ?? null,
    partId: data?.id ?? null,
    assistantMessageID: data?.assistantMessageID ?? null,
    status: data?.status ?? null,
    outcome: data?.outcome ?? rec.outcome ?? null,
    executed: data?.executed ?? null,
  }
}

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    log("setup", {
      version: ctx.app.version,
      location: ctx.location as unknown,
      ctxKeys: keysOf(ctx),
      sessionKeys: keysOf(ctx.session),
      skillKeys: keysOf(ctx.skill),
      eventKeys: keysOf(ctx.event),
      pluginKeys: keysOf(ctx.plugin),
      hasSkillReload: typeof (ctx.skill as { reload?: unknown }).reload === "function",
      hasEventSubscribe: typeof (ctx.event as { subscribe?: unknown }).subscribe === "function",
      out: OUT,
    })

    let skillTransformInvocations = 0
    const eventTypeCounts = new Map<string, number>()
    let eventLogCount = 0
    const EVENT_LOG_CAP = 200
    const ALWAYS_LOG = /session\.tool\.|session\.status|session\.idle|session\.created|session\.updated|session\.deleted|session\.error/

    // ---- event subscribe FIRST (must not block setup) ----
    try {
      const subscribe = (ctx.event as { subscribe?: (opts?: unknown) => AsyncIterable<unknown> }).subscribe
      if (typeof subscribe !== "function") {
        log("event-subscribe-missing", { eventKeys: keysOf(ctx.event) })
      } else {
        const stream = subscribe()
        void (async () => {
          try {
            for await (const ev of stream) {
              const type = String((ev as { type?: unknown })?.type ?? "unknown")
              eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1)
              const important = ALWAYS_LOG.test(type)
              if (!important && eventLogCount >= EVENT_LOG_CAP) continue
              if (!important) eventLogCount++
              log("event", compactEvent(ev))
            }
            log("event-subscribe-ended", { counts: Object.fromEntries(eventTypeCounts) })
          } catch (e) {
            log("event-subscribe-iter-error", String(e))
          }
        })()
        log("event-subscribe-ok", {})
      }
    } catch (e) {
      log("event-subscribe-error", String(e))
    }

    // ---- registrations FIRST (so they exist even if the drill dies) ----

    const runServerDrill = async (): Promise<void> => {
      log("server-drill-start", { skillTransformInvocations })

      // (a) D12: metadata on create + readable via get / list
      const created = await step("d12.session.create", () =>
        ctx.session.create({
          title: "probe-child-meta",
          agent: "general",
          metadata: UC_META,
        } as Parameters<typeof ctx.session.create>[0]),
      )
      const createdRec = created && typeof created === "object" ? (created as Record<string, unknown>) : undefined
      log("d12.create-shape", {
        ok: Boolean(created),
        keys: createdRec ? keysOf(createdRec) : null,
        metadata: createdRec?.metadata ?? null,
        title: createdRec?.title ?? null,
        agent: createdRec?.agent ?? null,
        model: createdRec?.model ?? null,
        tokens: createdRec?.tokens ?? null,
      })

      if (createdRec && typeof createdRec.id === "string") {
        const sid = createdRec.id
        const afterCreate = await step("d12.session.get-after-create", () => ctx.session.get({ sessionID: sid }))
        const afterRec =
          afterCreate && typeof afterCreate === "object" ? (afterCreate as Record<string, unknown>) : undefined
        log("d12.get-after-create-shape", {
          keys: afterRec ? keysOf(afterRec) : null,
          metadata: afterRec?.metadata ?? null,
        })

        const sessionAny = ctx.session as unknown as { list?: (input?: unknown) => Promise<unknown> }
        if (typeof sessionAny.list === "function") {
          await step("d12.session.list", async () => {
            const listed = await sessionAny.list!()
            const envelope =
              listed && typeof listed === "object" ? (listed as { data?: unknown; sessions?: unknown }) : undefined
            const items = Array.isArray(listed)
              ? listed
              : Array.isArray(envelope?.data)
                ? envelope.data
                : Array.isArray(envelope?.sessions)
                  ? envelope.sessions
                  : []
            const mine = (items as Array<Record<string, unknown>>).filter((s) => s && s.id === sid)
            return {
              listedType: Array.isArray(listed) ? "array" : typeof listed,
              envelopeKeys: envelope && !Array.isArray(listed) ? keysOf(envelope) : null,
              count: Array.isArray(items) ? items.length : null,
              match: mine[0] ?? null,
              matchKeys: mine[0] ? keysOf(mine[0]) : null,
              matchMetadata: mine[0]?.metadata ?? null,
            }
          })
        } else {
          log("d12.session.list-absent", { sessionKeys: keysOf(ctx.session) })
        }

        // (c) child: trivial prompt, then ask it to call one tool
        const prompted = await step(
          "d6.session.prompt-trivial",
          () => ctx.session.prompt({ sessionID: sid, text: "Reply with exactly: PROBE_OK" }),
          150_000,
        )
        if (prompted) {
          await step("d6.session.wait-trivial", () => ctx.session.wait({ sessionID: sid }), 150_000)
        }
        await step(
          "d6.session.prompt-tool",
          () =>
            ctx.session.prompt({
              sessionID: sid,
              text: "Read the file .opencode/skills/probe-skill.md using the read tool. Reply with its first non-empty line only.",
            }),
          150_000,
        )
        await step("d6.session.wait-tool", () => ctx.session.wait({ sessionID: sid }), 150_000)

        // (b) session record shape after child completes
        const finalGet = await step("d12.session.final-get", () => ctx.session.get({ sessionID: sid }))
        const finalRec = finalGet && typeof finalGet === "object" ? (finalGet as Record<string, unknown>) : undefined
        log("session-record-shape", {
          keys: finalRec ? keysOf(finalRec) : null,
          hasTokens: finalRec ? "tokens" in finalRec : false,
          hasAgent: finalRec ? "agent" in finalRec : false,
          hasModel: finalRec ? "model" in finalRec : false,
          hasMetadata: finalRec ? "metadata" in finalRec : false,
          hasTitle: finalRec ? "title" in finalRec : false,
          hasOutcome: finalRec ? "outcome" in finalRec : false,
          tokens: finalRec?.tokens ?? null,
          agent: finalRec?.agent ?? null,
          model: finalRec?.model ?? null,
          metadata: finalRec?.metadata ?? null,
          title: finalRec?.title ?? null,
          outcome: finalRec?.outcome ?? null,
        })
        await step("d6.session.context", async () => {
          const msgs = (await ctx.session.context({ sessionID: sid })) as unknown
          return JSON.parse(safeJson(msgs))
        })
      } else {
        log("d12.create-failed-skip-child", {})
      }

      // (d) D1: late re-transform from executor (NOT setup)
      log("d1.skill-before-late", { skillTransformInvocations })
      try {
        const skillAny = ctx.skill as {
          list?: () => Promise<unknown>
          reload?: () => Promise<void>
          transform: (cb: (editor: Record<string, unknown>) => void) => Promise<unknown>
        }
        if (typeof skillAny.list === "function") {
          await step("d1.skill.list-before", async () => {
            const listed = await skillAny.list!()
            const data =
              listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
                ? (listed as { data: Array<Record<string, unknown>> }).data
                : Array.isArray(listed)
                  ? listed
                  : []
            const mine = data.find((s) => s && s.id === "probe-skill")
            return {
              envelopeKeys: listed && typeof listed === "object" && !Array.isArray(listed) ? keysOf(listed) : null,
              ids: data.map((s) => s?.id),
              probeSkill: mine ?? null,
            }
          })
        } else {
          log("d1.skill.list-absent", { skillKeys: keysOf(ctx.skill) })
        }

        await step("d1.skill.late-transform", async () => {
          let editorMethods: string[] | null = null
          let getBefore: unknown = null
          let getAfter: unknown = null
          let updateThrew: string | null = null
          await ctx.skill.transform((editor) => {
            skillTransformInvocations++
            const ed = editor as {
              list?: () => unknown[]
              get?: (id: string) => unknown
              add?: (s: unknown) => void
              update?: (id: string, fn: (s: Record<string, unknown>) => void) => void
              remove?: (id: string) => void
            }
            editorMethods = keysOf(ed)
            log("d1.skill-late-transform-callback", {
              n: skillTransformInvocations,
              methods: editorMethods,
              listIds: typeof ed.list === "function" ? ed.list().map((s) => (s as { id?: unknown }).id) : null,
            })
            getBefore = typeof ed.get === "function" ? ed.get("probe-skill") : null
            try {
              if (typeof ed.update !== "function") throw new Error("editor.update is not a function")
              ed.update("probe-skill", (s) => {
                s.content = "Probe skill content UPDATED late from executor."
              })
            } catch (e) {
              updateThrew = String(e)
            }
            getAfter = typeof ed.get === "function" ? ed.get("probe-skill") : null
          })
          return {
            editorMethods,
            getBefore: JSON.parse(safeJson(getBefore)),
            getAfter: JSON.parse(safeJson(getAfter)),
            updateThrew,
            skillTransformInvocations,
          }
        })

        log("d1.skill-after-late-transform", { skillTransformInvocations })

        if (typeof skillAny.reload === "function") {
          await step("d1.skill.reload", async () => {
            await skillAny.reload!()
            return { skillTransformInvocations }
          })
        } else {
          log("d1.skill.reload-absent", { skillKeys: keysOf(ctx.skill) })
        }
        log("d1.skill-after-reload", { skillTransformInvocations })

        if (typeof skillAny.list === "function") {
          await step("d1.skill.list-after", async () => {
            const listed = await skillAny.list!()
            const data =
              listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
                ? (listed as { data: Array<Record<string, unknown>> }).data
                : Array.isArray(listed)
                  ? listed
                  : []
            const mine = data.find((s) => s && s.id === "probe-skill")
            return {
              ids: data.map((s) => s?.id),
              probeContent: typeof mine?.content === "string" ? String(mine.content).slice(0, 200) : null,
              probeSkill: mine ?? null,
            }
          })
        }
      } catch (e) {
        log("d1.skill-late-error", String(e))
      }

      log("event-type-counts", {
        counts: Object.fromEntries([...eventTypeCounts.entries()].sort()),
        logged: eventLogCount,
      })
      log("server-drill-done", { skillTransformInvocations })
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "probe_tool",
        description: "Probe tool. Call when asked.",
        input: {
          type: "object",
          properties: { x: { type: "string" } },
          additionalProperties: false,
        },
        execute: async (input: unknown, tool: unknown) => {
          log("probe_tool", {
            input,
            toolKeys: tool && typeof tool === "object" ? Object.keys(tool) : null,
            toolJson: safeJson(tool),
          })
          const x = input && typeof input === "object" ? (input as { x?: string }).x : undefined
          if (x === "server") {
            log("drill-from-tool-start", { mode: "server" })
            try {
              await runServerDrill()
            } catch (e) {
              log("server-drill-error", String(e))
            }
            log("drill-from-tool-done", { mode: "server" })
          } else if (x === "drill") {
            log("drill-from-tool-start", { mode: "drill" })
            const created = await step("session.create", () =>
              ctx.session.create({ title: "probe-child", agent: "general" }),
            )
            if (created) {
              await step("session.after-create", () => ctx.session.get({ sessionID: created.id }))
              const prompted = await step(
                "session.prompt",
                () => ctx.session.prompt({ sessionID: created.id, text: "Reply with exactly: PROBE_OK" }),
                150_000,
              )
              if (prompted) {
                await step("session.wait", () => ctx.session.wait({ sessionID: created.id }), 150_000)
              }
              await step("session.final-get", () => ctx.session.get({ sessionID: created.id }))
              await step("session.context", async () => {
                const msgs = (await ctx.session.context({ sessionID: created.id })) as unknown
                return JSON.parse(safeJson(msgs))
              })
              log("drill-from-tool-done", { mode: "drill" })
            }
          }
          return { content: "probe_tool executed" }
        },
      })
      editor.add({
        name: "probe_slow",
        description: "Sleeps 60 seconds. Use when asked to test cancellation.",
        input: { type: "object", properties: {}, additionalProperties: false },
        execute: async (input: unknown, tool: unknown) => {
          log("probe_slow-start", {
            input,
            toolKeys: tool && typeof tool === "object" ? Object.keys(tool) : null,
            toolJson: safeJson(tool),
          })
          await new Promise((resolve) => setTimeout(resolve, 60_000))
          log("probe_slow-end", { note: "slept full 60s — no abort observed" })
          return { content: "slept 60s" }
        },
      })
    })
    log("tools-registered", {})

    await ctx.session.hook("prompt", (event) => {
      log("prompt-hook", {
        text: event.prompt.text?.slice(0, 120),
        files: event.prompt.files as unknown,
        agents: (event.prompt as { agents?: unknown }).agents,
        skills: (event.prompt as { skills?: unknown }).skills,
        delivery: event.delivery,
      })
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "probe_stop",
        description: "Interrupt the current session to test command-while-tool-pending",
        execute: async ({ sessionID }: { sessionID: string }) => {
          log("probe_stop-invoked", { sessionID })
          try {
            await ctx.session.interrupt({ sessionID, continue: false })
            log("probe_stop-interrupted", { sessionID })
          } catch (e) {
            log("probe_stop-error", String(e))
          }
        },
      })
      editor.add({
        name: "probe_server",
        description: "Run the phase-0-server spike drill (metadata/events/skill-reload)",
        execute: async () => {
          log("probe_server-invoked", {})
          try {
            await runServerDrill()
            log("probe_server-done", {})
          } catch (e) {
            log("probe_server-error", String(e))
          }
        },
      })
      let tuiChildStarted = false
      const runTuiChild = async (invocation: { sessionID?: string; prompt?: { text?: string } }, name: string) => {
        log("command-invoked", {
          name,
          sessionID: invocation?.sessionID ?? null,
          text: invocation?.prompt?.text ?? null,
          invocationKeys: keysOf(invocation),
          invocation: JSON.parse(safeJson(invocation)),
        })
        if (tuiChildStarted) {
          log("tui-child-skip-duplicate", { name })
          return
        }
        tuiChildStarted = true
        try {
          const created = await ctx.session.create({
            title: "probe-tui-child",
            agent: "general",
            metadata: UC_META,
          } as Parameters<typeof ctx.session.create>[0])
          log("tui-child-created", {
            id: created?.id,
            keys: keysOf(created),
            metadata: (created as { metadata?: unknown })?.metadata ?? null,
            title: created?.title ?? null,
          })
          if (created?.id) {
            await step(
              "tui-child-prompt",
              () => ctx.session.prompt({ sessionID: created.id, text: "Reply with exactly: PROBE_OK" }),
              60_000,
            )
            await step("tui-child-wait", () => ctx.session.wait({ sessionID: created.id }), 60_000)
            const got = await ctx.session.get({ sessionID: created.id })
            log("tui-child-final", {
              keys: keysOf(got),
              title: (got as { title?: unknown })?.title ?? null,
              outcome: (got as { outcome?: unknown })?.outcome ?? null,
              tokens: (got as { tokens?: unknown })?.tokens ?? null,
              metadata: (got as { metadata?: unknown })?.metadata ?? null,
            })
          }
        } catch (e) {
          log("tui-child-error", String(e))
        }
        log("command-invoked-done", { name })
      }
      try {
        editor.add({
          name: "ultracode",
          description: "Phase 0-tui probe: log command invocation + spawn a child session",
          execute: async (invocation: { sessionID?: string; prompt?: { text?: string } }) => {
            await runTuiChild(invocation, "ultracode")
          },
        })
        log("command-add-ultracode-ok", {})
      } catch (e) {
        log("command-add-ultracode-error", String(e))
      }
      try {
        editor.add({
          name: "probe_tui",
          description: "Phase 0-tui probe fallback command (same as ultracode log+child)",
          execute: async (invocation: { sessionID?: string; prompt?: { text?: string } }) => {
            await runTuiChild(invocation, "probe_tui")
          },
        })
        log("command-add-probe_tui-ok", {})
      } catch (e) {
        log("command-add-probe_tui-error", String(e))
      }
    })

    try {
      await ctx.skill.transform((editor) => {
        skillTransformInvocations++
        log("skill-transform-callback", {
          n: skillTransformInvocations,
          methods: keysOf(editor),
          from: "setup-registration",
        })
        editor.add({
          id: "probe-skill",
          name: "Probe Skill",
          description: "Spike skill registration",
          location: SKILL_LOCATION,
          content: "Probe skill content.",
        })
      })
    } catch (e) {
      log("skill-transform-error", String(e))
    }
    log("registrations-done", { skillTransformInvocations })

    await step("plugin.list", async () => {
      const result = (await ctx.plugin.list()) as unknown
      return JSON.parse(safeJson(result))
    })

    await step("agents", async () => {
      const result = (await ctx.agent.list()) as unknown
      let brief: unknown = result
      if (Array.isArray(result)) {
        brief = result.map((a) => ({ id: a.id, mode: a.mode, model: a.model }))
      } else if (result && typeof result === "object") {
        const data = (result as { data?: unknown }).data
        brief = {
          envelopeKeys: Object.keys(result as object),
          dataType: Array.isArray(data) ? "array" : typeof data,
          data: Array.isArray(data)
            ? data.map((a) => ({ id: a.id, mode: a.mode, model: a.model }))
            : safeJson(data).slice(0, 2000),
        }
      }
      return brief
    })

    log("setup-done", {})
  },
})
