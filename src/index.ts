/**
 * opencode-ultracode plugin entry (Builder A).
 *
 * The ONLY module allowed to import `@opencode/plugin` (CONTRACTS.md); every
 * other module receives capabilities via plain interfaces for testability.
 *
 * Hard rules honored here (docs/SPIKE-FINDINGS.md):
 *  - never await ctx.session.prompt/create/get inside setup (admission deadlock)
 *  - every ctx.*.transform / ctx.session.hook / ctx.permission.hook wrapped in
 *    try/catch — a throwing transform disables the whole plugin
 *  - ctx.agent.list() returns { location, data } — unwrap .data
 *  - tool executor 2nd arg: { sessionID, agent, messageID, id, progress }
 */
import { Plugin } from "@opencode/plugin"
import type { Skill } from "@opencode/plugin"
import { promises as fsp } from "node:fs"
import { homedir } from "node:os"
import { loadOptions } from "./config.ts"
import { RegistryImpl } from "./registry.ts"
import { StorageImpl, normalizePath } from "./storage.ts"
import { validateToolInput } from "./tool-input.ts"
import type {
  FsLike,
  Json,
  KvLike,
  ParentContext,
  RunRecord,
  SessionCtx,
  Supervisor,
  WorkflowMeta,
} from "./types.ts"
import { countAgents } from "./types.ts"

/** Minimal shape of a plugin hook/transform registration (for cleanup). */
interface RegistrationLike {
  dispose(): Promise<void> | void
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function warn(message: string, err?: unknown): void {
  try {
    const detail = err === undefined ? "" : `: ${err instanceof Error ? err.message : String(err)}`
    console.warn(`[ultracode] ${message}${detail}`)
  } catch {
    // never throw from logging
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err) ?? String(err)
  } catch {
    return String(err)
  }
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "n/a"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined) return "-"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Permission actions treated as "edits" (spike: exact names unverified — keep small + code-local). */
const EDIT_ACTIONS: ReadonlySet<string> = new Set(["edit", "write"])

/** JSON Schema for the workflow tool input union (inline script vs saved workflow). */
const WORKFLOW_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["script"],
      properties: {
        script: {
          type: "string",
          description:
            "Workflow source: a plain-JS async function body (no import/export). Injected globals: agent(prompt, opts?) -> {text, data?, tokens}, parallel(thunks), pipeline(items, ...stages), phase(name), progress(text), workflow(name, args), sleep(ms), console.log, args, meta. Return a small JSON value.",
        },
        name: { type: "string", description: "Optional run name shown in /workflow summaries." },
        meta: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            phases: { type: "array", items: { type: "string" } },
            requires: {
              type: "array",
              items: { type: "string" },
              description: "Agent ids that must exist before the run starts (preflight, fail-fast).",
            },
          },
        },
        args: { description: "JSON value exposed to the script as `args` (max 64 KB serialized)." },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["workflow"],
      properties: {
        workflow: { type: "string", description: "Saved workflow name (see /workflow for the list; project dir beats personal dir)." },
        args: { description: "JSON value exposed to the script as `args` (max 64 KB serialized)." },
        confirm: {
          type: "boolean",
          description: "Run despite a script/manifest hash mismatch (script changed on disk since it was saved).",
        },
      },
    },
  ],
}

/** ~500ms-throttled, never-throwing wrapper over tool.progress({ status }). */
function makeReporter(progress: (update: Record<string, unknown>) => Promise<void>): (status: string) => void {
  const INTERVAL = 500
  let last = 0
  let latest = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  const emit = (status: string): void => {
    last = Date.now()
    try {
      void progress({ status }).catch(() => {})
    } catch {
      // never throw
    }
  }
  return (status: string) => {
    latest = status
    const elapsed = Date.now() - last
    if (elapsed >= INTERVAL) {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      emit(latest)
      return
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        emit(latest)
      }, INTERVAL - elapsed)
      timer.unref?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "ultracode",
  async setup(ctx) {
    // ---- options ----
    const { options, warnings } = loadOptions(ctx.options)
    for (const w of warnings) warn(`config warning — ${w}`)

    // ---- capabilities (plain interfaces; everything stays node-testable) ----
    const projectRoot = normalizePath(String(ctx.location?.project?.directory ?? process.cwd()))
    const personalWorkflowDir = normalizePath(
      `${process.env["HOME"] ?? homedir()}/.config/opencode/workflows`,
    )

    const kv: KvLike = {
      get: async (key) => (await ctx.storage.get(key)) as Json | undefined,
      set: async (key, value) => {
        await ctx.storage.set(key, value as unknown as Parameters<typeof ctx.storage.set>[1])
      },
      remove: async (key) => {
        await ctx.storage.remove(key)
      },
      scan: async (scanOptions) =>
        (await ctx.storage.scan(scanOptions)) as unknown as {
          entries: ReadonlyArray<{ key: string; value: Json }>
          next?: string
        },
    }

    const fs: FsLike = {
      mkdir: async (path, _recursive) => {
        await fsp.mkdir(path, { recursive: true })
      },
      writeFile: async (path, content) => {
        await fsp.writeFile(path, content, "utf8")
      },
      readFile: async (path) => await fsp.readFile(path, "utf8"),
      exists: async (path) => {
        try {
          await fsp.stat(path)
          return true
        } catch {
          return false
        }
      },
      readdir: async (path) => {
        try {
          return (await fsp.readdir(path)) as string[]
        } catch {
          return []
        }
      },
    }

    const sessions: SessionCtx = {
      create: async (input) =>
        (await ctx.session.create({ title: input.title, agent: input.agent })) as unknown as {
          id: string
          agent?: string
        },
      get: async (input) =>
        (await ctx.session.get({ sessionID: input.sessionID })) as unknown as Awaited<ReturnType<SessionCtx["get"]>>,
      prompt: async (input) =>
        (await ctx.session.prompt({ sessionID: input.sessionID, text: input.text })) as unknown as { id: string },
      wait: async (input) => {
        await ctx.session.wait({ sessionID: input.sessionID })
      },
      context: async (input) =>
        (await ctx.session.context({ sessionID: input.sessionID })) as unknown as ReadonlyArray<
          import("./types.ts").ContextMessage
        >,
      interrupt: async (input) => {
        await ctx.session.interrupt({ sessionID: input.sessionID, continue: false })
      },
    }

    const storage = new StorageImpl({ kv, fs, projectRoot, personalWorkflowDir })
    const registry = new RegistryImpl({
      persist: (record) => storage.saveRun(record),
      loader: () => storage.loadRuns(),
    })

    const controller = new AbortController()
    const registrations: RegistrationLike[] = []

    // Async warm-ups (never block setup on session admission; kv/fs only).
    const runsReconciled = storage
      .loadRunsAsync()
      .then(() => {
        const flipped = registry.reconcileOrphans()
        if (flipped > 0) warn(`marked ${flipped} orphaned run(s) as interrupted (server restart)`)
      })
      .catch((err) => warn("failed to reconcile persisted runs", err))
    const workflowsReady = storage.refreshWorkflows().then(() => undefined, () => undefined)

    // ---- agent availability (cached async fn; refreshed on every tool call) ----
    let agentIds: string[] = []
    let agentsInFlight: Promise<string[]> | undefined
    function fetchAgentIDs(): Promise<string[]> {
      if (agentsInFlight) return agentsInFlight
      agentsInFlight = (async () => {
        try {
          const result = (await ctx.agent.list()) as unknown
          let list: unknown[] = []
          if (Array.isArray(result)) list = result
          else if (result && typeof result === "object") {
            const data = (result as { data?: unknown }).data // verified envelope
            if (Array.isArray(data)) list = data
          }
          agentIds = list
            .map((a) =>
              a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string"
                ? (a as { id: string }).id
                : "",
            )
            .filter((id) => id !== "")
        } catch (err) {
          if (controller.signal.aborted) return agentIds
          if (agentIds.length === 0) warn("failed to list agents (preflight degraded)", err)
        }
        return agentIds
      })()
      const done = agentsInFlight
      void done.then(() => {
        agentsInFlight = undefined
      })
      return done
    }

    // ---- supervisor (Builder B module; guarded dynamic import) ----
    let supervisor: Supervisor | undefined
    let supervisorError: string | undefined
    try {
      const mod = await import("./supervisor.ts")
      supervisor = new mod.SupervisorImpl({ registry, storage, sessions, options })
    } catch (err) {
      supervisorError =
        "workflow tool unavailable: the supervisor module failed to load " +
        `(${describeError(err)}). Reinstall the plugin or check src/supervisor.ts.`
      warn("supervisor module unavailable — workflow tool disabled", err)
    }

    // ---- session access from executors only (deadlock rule) ----
    async function say(sessionID: string, text: string): Promise<void> {
      try {
        await ctx.session.synthetic({ sessionID, text })
      } catch (err) {
        warn(`failed to deliver message to session ${sessionID}`, err)
      }
    }

    // ---- workflow tool ----
    try {
      await ctx.tool.transform((editor) => {
        try {
          editor.add({
            name: "workflow",
            description:
              "Run an ultracode workflow — a plain-JS async-function-body script that orchestrates multiple AI agents " +
              "(agent(), parallel(), pipeline(), phase(), progress(), workflow(name), sleep()) and returns a small JSON value. " +
              "Input is { script, meta?, args? } (inline) or { workflow: name, args?, confirm? } (saved workflow). " +
              "Use when a task outgrows one context window or needs fan-out / verification / repeatable orchestration. " +
              "Blocks until every agent settles, then returns an envelope { runID, status, agents, tokens, result | preview }. " +
              "Say 'ultracode' in the conversation to load the authoring skill.",
            input: WORKFLOW_TOOL_INPUT_SCHEMA,
            execute: async (rawInput: unknown, tool) => {
              if (supervisor?.isOwnedSession(tool.sessionID)) {
                return { content: "nested workflow runs are not allowed" }
              }
              try {
                if (!supervisor) {
                  return { content: `error: ${supervisorError ?? "workflow tool unavailable"}` }
                }
                const parsed = validateToolInput(rawInput)
                if (!parsed.ok) {
                  return { content: `error: invalid workflow input — ${parsed.error}` }
                }
                const input = parsed.input

                let script: string
                let meta: WorkflowMeta | undefined
                let name: string | undefined
                let workflowName: string | undefined
                let args: Json | undefined

                if ("workflow" in input) {
                  await Promise.all([workflowsReady, runsReconciled])
                  let saved
                  try {
                    saved = storage.loadWorkflow(input.workflow)
                  } catch (err) {
                    const message = describeError(err)
                    if (input.confirm === true) {
                      saved = storage.loadWorkflowTolerant(input.workflow)
                    } else {
                      return { content: `error: ${message}` }
                    }
                  }
                  if (!saved) {
                    const available = storage
                      .listWorkflows()
                      .map((w) => w.manifest.name)
                      .join(", ")
                    return {
                      content:
                        `error: workflow "${input.workflow}" not found.` +
                        (available ? ` Saved workflows: ${available}.` : " No saved workflows exist yet — run one inline, then use /workflow save <runID> <name>."),
                    }
                  }
                  script = saved.script
                  workflowName = input.workflow
                  name = saved.manifest.name
                  meta = {
                    name: saved.manifest.name,
                    description: saved.manifest.description,
                    phases: saved.manifest.phases,
                    requires: saved.manifest.requires,
                  }
                  args = input.args
                } else {
                  script = input.script
                  meta = input.meta
                  name = input.name
                  args = input.args
                }

                // Preflight required agents (fail fast, list what's available).
                const requires = meta?.requires ?? []
                if (requires.length > 0) {
                  const available = await fetchAgentIDs() // refresh on every tool call
                  const missing = [...new Set(requires)].filter((id) => !available.includes(id))
                  if (missing.length > 0) {
                    return {
                      content:
                        `error: workflow requires agent(s) not available: ${missing.join(", ")}. ` +
                        `Available agents: ${available.join(", ") || "(none — create agents or check your install)"}`,
                    }
                  }
                }

                const parent: ParentContext = {
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  messageID: tool.messageID,
                  report: makeReporter(tool.progress as (update: Record<string, unknown>) => Promise<void>),
                }
                const outcome = await supervisor.start({ script, meta, args, name, workflowName }, parent)
                return { content: JSON.stringify(outcome.envelope, null, 1) }
              } catch (err) {
                return { content: `error: workflow run failed — ${describeError(err)}` }
              }
            },
          })
        } catch (err) {
          warn("failed to register workflow tool", err)
        }
      })
    } catch (err) {
      warn("tool transform failed — workflow tool not registered", err)
    }

    // ---- /workflow + /workflows commands ----
    function commandArgs(promptText: string | undefined): string {
      const text = (promptText ?? "").trim()
      const token = /^\/(?:workflows|workflow)\b/i.exec(text)
      return (token ? text.slice(token[0].length) : text).trim()
    }

    function summarizeRun(run: RunRecord): string {
      const counts = countAgents(run)
      const bits = [
        `\`${run.id}\``,
        run.name ?? run.workflowName ?? "(unnamed)",
        `[${run.status}]`,
        `agents ${counts.succeeded + counts.failed + counts.interrupted}/${counts.total}`,
      ]
      const tokens = run.totalTokens
      if (tokens) bits.push(`~${fmtTokens(tokens.input + tokens.output + tokens.reasoning)} tok`)
      if (run.error) bits.push(`error: ${run.error.slice(0, 80)}`)
      return `- ${bits.join(" · ")}`
    }

    function showRun(run: RunRecord): string {
      const lines: string[] = []
      lines.push(`## Run \`${run.id}\`${run.name ? ` — ${run.name}` : ""}`)
      lines.push("")
      lines.push(`- status: **${run.status}**`)
      if (run.workflowName) lines.push(`- workflow: ${run.workflowName}`)
      lines.push(`- duration: ${fmtDuration((run.endedAt ?? Date.now()) - run.startedAt)}`)
      if (run.error) lines.push(`- error: ${run.error}`)
      if (run.stopReason) lines.push(`- stop reason: ${run.stopReason}`)
      if (run.totalTokens) {
        const t = run.totalTokens
        lines.push(
          `- tokens: in ${fmtTokens(t.input)} · out ${fmtTokens(t.output)} · reasoning ${fmtTokens(t.reasoning)} · cache read ${fmtTokens(t.cache.read)}`,
        )
      }
      if (run.scriptPath) lines.push(`- script artifact: ${run.scriptPath}`)
      lines.push("")
      lines.push("### Agents")
      lines.push("")
      if (run.agents.length === 0) {
        lines.push("(no agents were started)")
      } else {
        lines.push("| id | label / phase | agent | model | status | tokens in/out |")
        lines.push("| --- | --- | --- | --- | --- | --- |")
        for (const a of run.agents) {
          const label = [a.label, a.phase].filter(Boolean).join(" · ") || "-"
          const agent = a.effectiveAgent ?? a.requestedAgent ?? "-"
          const model = a.effectiveModel ? `${a.effectiveModel.providerID}/${a.effectiveModel.id}` : "-"
          const tokens = a.tokens ? `${fmtTokens(a.tokens.input)}/${fmtTokens(a.tokens.output)}` : "-"
          const error = a.error ? ` — ${a.error.slice(0, 60)}` : ""
          lines.push(`| ${a.id} | ${label} | ${agent} | ${model} | ${a.status}${error} | ${tokens} |`)
        }
      }
      lines.push("")
      lines.push("### Script")
      lines.push("")
      lines.push("```js")
      lines.push(run.script)
      lines.push("```")
      return lines.join("\n")
    }

    function helpText(): string {
      return [
        "Usage:",
        "- `/workflow` — active + recent runs and saved workflows",
        "- `/workflow show <runID>` — full run report (agents, tokens, script)",
        "- `/workflow stop <runID>` — stop an active run",
        "- `/workflow save <runID> <name>` — save a run's script as a reusable workflow",
      ].join("\n")
    }

    const commandHandler = async (invocation: { sessionID: string; prompt: { text?: string } }): Promise<void> => {
      try {
        const { sessionID } = invocation
        const argsText = commandArgs(invocation.prompt?.text)
        if (argsText === "") {
          const active = supervisor?.activeRuns() ?? registry.activeRuns()
          const finished = registry
            .listRecent(50)
            .filter((r) => r.status !== "running" && r.status !== "stopping")
            .slice(0, 5)
          const saved = storage.listWorkflows()
          const parts: string[] = ["## Ultracode workflows", ""]
          parts.push("**Active runs**")
          parts.push(active.length ? active.map(summarizeRun).join("\n") : "(none)")
          parts.push("")
          parts.push("**Recent runs**")
          parts.push(finished.length ? finished.map(summarizeRun).join("\n") : "(none)")
          parts.push("")
          parts.push("**Saved workflows**")
          parts.push(
            saved.length
              ? saved.map((w) => `- \`${w.manifest.name}\` — ${w.manifest.description ?? "(no description)"} [${w.manifest.source}]`).join("\n")
              : "(none — save one with `/workflow save <runID> <name>`)",
          )
          parts.push("")
          parts.push(`Workflow dirs: project \`${normalizePath(`${projectRoot}/.opencode/workflows`)}\` (wins) · personal \`${personalWorkflowDir}\``)
          await say(sessionID, parts.join("\n"))
          return
        }

        const spaceIdx = argsText.indexOf(" ")
        const sub = (spaceIdx === -1 ? argsText : argsText.slice(0, spaceIdx)).toLowerCase()
        const rest = spaceIdx === -1 ? "" : argsText.slice(spaceIdx + 1).trim()

        if (sub === "stop") {
          if (!rest) {
            await say(sessionID, "Usage: /workflow stop <runID>")
            return
          }
          if (!supervisor) {
            await say(sessionID, `error: ${supervisorError ?? "supervisor unavailable"}`)
            return
          }
          const stopped = supervisor.stop(rest, "user requested (/workflow stop)")
          await say(
            sessionID,
            stopped ? `Stopping run \`${rest}\` — in-flight agents will be interrupted.` : `Run \`${rest}\` is unknown or already finished. See /workflow for the list.`,
          )
          return
        }

        if (sub === "show") {
          if (!rest) {
            await say(sessionID, "Usage: /workflow show <runID>")
            return
          }
          await Promise.all([runsReconciled])
          const run = registry.get(rest)
          if (!run) {
            await say(sessionID, `Run \`${rest}\` not found. See /workflow for known runs.`)
            return
          }
          await say(sessionID, showRun(run))
          return
        }

        if (sub === "save") {
          const saveMatch = /^(\S+)\s+(\S+)$/.exec(rest)
          if (!saveMatch) {
            await say(sessionID, "Usage: /workflow save <runID> <name>\n(name: lowercase alphanumerics, `-`/`_`, max 64 chars)")
            return
          }
          const runID = saveMatch[1]!
          const name = saveMatch[2]!
          const run = registry.get(runID)
          if (!run) {
            await say(sessionID, `Run \`${runID}\` not found. See /workflow for known runs.`)
            return
          }
          try {
            const saved = await storage.saveWorkflow(name, run.script, {
              name: run.meta?.name ?? run.name ?? name,
              description: run.meta?.description,
              phases: run.meta?.phases,
              requires: run.meta?.requires,
              savedFromRunID: run.id,
              source: "project",
            })
            await say(
              sessionID,
              `Saved workflow \`${saved.manifest.name}\` (${saved.manifest.source}) — run it with the workflow tool: { workflow: "${saved.manifest.name}" }`,
            )
          } catch (err) {
            await say(sessionID, `error: could not save workflow — ${describeError(err)}`)
          }
          return
        }

        await say(sessionID, `Unknown /workflow argument: ${JSON.stringify(sub)}\n\n${helpText()}`)
      } catch (err) {
        warn("/workflow command failed", err)
      }
    }

    try {
      await ctx.command.transform((editor) => {
        try {
          editor.add({
            name: "workflow",
            description: "Inspect and manage ultracode workflow runs (summary, show, stop, save)",
            execute: commandHandler,
          })
          editor.add({
            name: "workflows",
            description: "Alias of /workflow",
            execute: commandHandler,
          })
        } catch (err) {
          warn("failed to register commands", err)
        }
      })
    } catch (err) {
      warn("command transform failed — /workflow not registered", err)
    }

    // ---- prompt hook: attach the authoring skill on the "ultracode" keyword ----
    try {
      const reg = await ctx.session.hook("prompt", (event) => {
        try {
          const ev = event as unknown as {
            sessionID?: string
            prompt?: { text?: string; skills?: Array<{ id: string }> }
          }
          const text = ev.prompt?.text ?? ""
          if (!/\bultracode\b/i.test(text)) return
          const sessionID = ev.sessionID
          // Don't re-attach inside workflow-owned child sessions.
          if (typeof sessionID === "string" && sessionID !== "") {
            if (supervisor?.isOwnedSession(sessionID) || registry.isOwnedActive(sessionID)) return
          }
          if (!ev.prompt) return
          ev.prompt.skills ??= []
          if (!ev.prompt.skills.some((s) => s?.id === "ultracode")) {
            ev.prompt.skills.push({ id: "ultracode" })
          }
        } catch {
          // never throw from a hook
        }
      })
      registrations.push(reg as unknown as RegistrationLike)
    } catch (err) {
      warn("prompt hook registration failed — keyword skill attach disabled", err)
    }

    // ---- skill registration (Builder C content; guarded) ----
    try {
      const content = await import("./skill-content.ts")
      const skillPath = storage.skillMarkdownPath()
      let fileWritten = false
      try {
        await fs.mkdir(normalizePath(`${skillPath}/..`), true)
        await fs.writeFile(skillPath, content.SKILL_CONTENT)
        fileWritten = true
      } catch (err) {
        warn(`failed to write skill file ${skillPath}`, err)
      }
      if (fileWritten) {
        await ctx.skill.transform((editor) => {
          try {
            editor.add({
              id: "ultracode",
              name: content.SKILL_NAME,
              description: content.SKILL_DESCRIPTION,
              location: skillPath,
              content: content.SKILL_CONTENT,
            } as unknown as Skill.Info)
          } catch (err) {
            warn("skill editor.add failed", err)
          }
        })
      } else {
        warn("skill not registered — its location file could not be written")
      }
    } catch (err) {
      warn("skill registration failed — keyword skill attach will not resolve", err)
    }

    // ---- permission hook (only when NOT delegating every ask to the user) ----
    if (options.permissions !== "ask") {
      const projectRootNormalized = normalizePath(projectRoot)
      const isInsideProject = (resource: string): boolean => {
        let path = resource
        if (path.startsWith("file://")) path = path.slice("file://".length)
        const normalized = normalizePath(path)
        return normalized === projectRootNormalized || normalized.startsWith(projectRootNormalized + "/")
      }
      try {
        const reg = await ctx.permission.hook("evaluate", (event) => {
          try {
            const ev = event as unknown as {
              sessionID?: string
              action?: string
              resources?: ReadonlyArray<string>
              effect?: string
              message?: string
            }
            const sessionID = ev.sessionID
            if (typeof sessionID !== "string" || !registry.isOwnedActive(sessionID)) return
            const action = ev.action
            if (typeof action !== "string" || !EDIT_ACTIONS.has(action)) return

            if (options.permissions === "autoEditsWorkflow") {
              const resources = Array.isArray(ev.resources) ? ev.resources : []
              if (resources.length === 0) return
              if (!resources.every((r) => typeof r === "string" && isInsideProject(r))) return
              ev.effect = "allow"
              return
            }
            // noEditTools: workflow children never edit, regardless of path.
            ev.effect = "deny"
            ev.message = "workflow run is in noEditTools mode"
          } catch {
            // never throw from a permission hook
          }
        })
        registrations.push(reg as unknown as RegistrationLike)
      } catch (err) {
        warn("permission hook registration failed — child edits will use normal permission flow", err)
      }
    }

    // ---- cleanup ----
    return () => {
      controller.abort()
      for (const reg of registrations) {
        try {
          void reg.dispose()
        } catch {
          // best effort
        }
      }
      registry.dispose()
      if (supervisor) void supervisor.dispose()
    }
  },
})
