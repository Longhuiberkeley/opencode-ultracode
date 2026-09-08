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
  )?.slice(0, 4000) ?? "unserializable"
}

export default Plugin.define({
  id: "probe",
  async setup(ctx) {
    log("setup", {
      version: ctx.app.version,
      location: ctx.location as unknown,
      options: ctx.options as unknown,
    })

    try {
      const agents = await ctx.agent.list()
      log("agents", agents.map((a) => ({ id: a.id, mode: a.mode, model: a.model as unknown, hidden: a.hidden })))
    } catch (e) {
      log("agents-error", String(e))
    }

    // Child-session drill: create with agent -> prompt -> wait -> get -> context
    try {
      const s = await ctx.session.create({ title: "probe-child", agent: "general" })
      log("session.create", s as unknown)
      const after = await ctx.session.get({ sessionID: s.id })
      log("session.after-create", {
        id: after.id,
        agent: after.agent,
        model: after.model as unknown,
        outcome: after.outcome,
        tokens: after.tokens as unknown,
      })

      const p = await ctx.session.prompt({ sessionID: s.id, text: "Reply with exactly: PROBE_OK" })
      log("session.prompt", p as unknown)

      await ctx.session.wait({ sessionID: s.id })
      const done = await ctx.session.get({ sessionID: s.id })
      log("session.after-wait", {
        id: done.id,
        agent: done.agent,
        model: done.model as unknown,
        outcome: done.outcome,
        tokens: done.tokens as unknown,
        cost: done.cost as unknown,
      })

      const msgs = await ctx.session.context({ sessionID: s.id })
      log("session.context", JSON.parse(safeJson(msgs)))
    } catch (e) {
      log("drill-error", String(e))
    }

    // Tools: dump the executor's 2nd arg; slow tool for stop-while-pending test
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "probe_tool",
        description: "Probe tool. Call with any object.",
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

    // Prompt hook: dump the admission event shape (esp. skills elements)
    await ctx.session.hook("prompt", (event) => {
      log("prompt-hook", {
        text: event.prompt.text?.slice(0, 120),
        files: event.prompt.files as unknown,
        agents: (event.prompt as { agents?: unknown }).agents,
        skills: (event.prompt as { skills?: unknown }).skills,
        delivery: event.delivery,
        metadata: event.metadata as unknown,
      })
    })

    // Command: can a command execute while a tool call is pending in the same session?
    await ctx.command.transform((editor) => {
      editor.add({
        name: "probe_stop",
        description: "Interrupt the current session to test command-while-tool-pending",
        execute: async ({ sessionID }) => {
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

    // Skill registration check
    await ctx.skill.transform((editor) => {
      editor.add({
        id: "probe-skill",
        name: "Probe Skill",
        description: "Spike skill registration",
        content: "Probe skill content.",
      })
    })
    log("setup-done", {})
  },
})
