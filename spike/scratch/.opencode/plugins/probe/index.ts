// Spike probe plugin — verifies undocumented OpenCode v2 plugin API shapes.
// Writes JSONL events to spike/out/probe-log.jsonl (PROBE_OUT overrides).
import { Plugin } from "@opencode/plugin"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

const OUT =
  process.env.PROBE_OUT ??
  "<repo>/spike/out/probe-log.jsonl"

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
  return JSON.stringify(
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
  )?.slice(0, 6000) ?? "unserializable"
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), ms).unref?.()),
  ])
}

async function step<T>(label: string, fn: () => Promise<T>, ms = 240_000): Promise<T | undefined> {
  try {
    const result = await withTimeout(fn(), 90_000, label)
    log(label, result as unknown)
    return result
  } catch (e) {
    log(`${label}-error`, String(e))
    return undefined
  }
}

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    log("setup", { version: ctx.app.version, location: ctx.location as unknown })

    // ---- registrations FIRST (so they exist even if the drill dies) ----

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
          if (input && typeof input === "object" && (input as { x?: string }).x === "drill") {
            log("drill-from-tool-start", {})
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
              log("drill-from-tool-done", {})
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
    })

    try {
      await ctx.skill.transform((editor) => {
        editor.add({
          id: "probe-skill",
          name: "Probe Skill",
          description: "Spike skill registration",
          location:
            "<repo>/spike/scratch/.opencode/skills/probe-skill.md",
          content: "Probe skill content.",
        })
      })
    } catch (e) {
      log("skill-transform-error", String(e))
    }
    log("registrations-done", {})

    // ---- drills run from tool executors (never block setup) ----

    await step("agents", async () => {
      const result = (await ctx.agent.list()) as unknown
      // log raw shape; handle envelope or array
      let brief: unknown = result
      if (Array.isArray(result)) {
        brief = result.map((a) => ({ id: a.id, mode: a.mode, model: a.model }))
      } else if (result && typeof result === "object") {
        const data = (result as { data?: unknown }).data
        brief = {
          envelopeKeys: Object.keys(result as object),
          dataType: Array.isArray(data) ? "array" : typeof data,
          data:
            Array.isArray(data)
              ? data.map((a) => ({ id: a.id, mode: a.mode, model: a.model }))
              : safeJson(data).slice(0, 2000),
        }
      }
      return brief
    })

    // Child-session drill lives inside probe_tool (x="drill") — never block setup.
    log("setup-done", {})
  },
})
