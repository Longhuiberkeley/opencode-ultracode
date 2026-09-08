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
import { fileURLToPath } from "node:url"
import { loadOptions } from "./config.ts"
import { RegistryImpl } from "./registry.ts"
import { StorageImpl, normalizePath, resolveContainedPath } from "./storage.ts"
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

/** Unwrap a list response that is either a bare array or a { location, data } envelope. */
function unwrapList(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === "object") {
    const data = (result as { data?: unknown }).data
    if (Array.isArray(data)) return data
  }
  return []
}

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
        name: { type: "string", description: "Optional run name shown in /ultracode summaries." },
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
        workflow: {
          type: "string",
          description: "Saved workflow name (see /ultracode for the list; project dir beats personal dir). Trusted via /ultracode trust <name>.",
        },
        args: { description: "JSON value exposed to the script as `args` (max 64 KB serialized)." },
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

    let disposed = false
    // Instance-local skill state: the prompt hook must never push an
    // unregistered skill id into prompts (it can break admission). Never
    // inherited across plugin reloads.
    let skillInstalled = false

    // ---- capabilities (plain interfaces; everything stays node-testable) ----
    const projectRoot = normalizePath(String(ctx.location?.project?.directory ?? process.cwd()))
    const projectID = String(ctx.location?.project?.id ?? projectRoot)
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
      realpath: async (path) => await fsp.realpath(path),
      lstat: async (path) => {
        try {
          const stats = await fsp.lstat(path)
          return { isSymbolicLink: () => stats.isSymbolicLink() }
        } catch (err) {
          if (err instanceof Error && (err as { code?: string }).code === "ENOENT") return undefined
          throw err
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

    const storage = new StorageImpl({ kv, fs, projectRoot, personalWorkflowDir, projectID })
    const registry = new RegistryImpl({
      persist: (record) => storage.saveRun(record),
      loader: () => storage.loadRuns(),
    })

    const controller = new AbortController()
    const registrations: RegistrationLike[] = []

    // Async warm-up (never blocks setup on session admission; kv only).
    const runsReconciled = storage
      .loadRunsAsync()
      .then(() => {
        const flipped = registry.reconcileOrphans()
        if (flipped > 0) warn(`marked ${flipped} orphaned run(s) as interrupted (server restart)`)
      })
      .catch((err) => warn("failed to reconcile persisted runs", err))

    // ---- agent availability (fresh per invocation; failures fail the run) ----
    async function listAgentIDs(): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
      try {
        const result = (await ctx.agent.list()) as unknown
        const ids = unwrapList(result)
          .map((a) =>
            a && typeof a === "object" && typeof (a as { id?: unknown }).id === "string"
              ? (a as { id: string }).id
              : "",
          )
          .filter((id) => id !== "")
        return { ok: true, ids }
      } catch (err) {
        return { ok: false, error: describeError(err) }
      }
    }

    // ---- supervisor (Builder B module; guarded dynamic import) ----
    let supervisor: Supervisor | undefined
    let supervisorError: string | undefined
    try {
      const mod = await import("./supervisor.ts")
      // Composition seam (Builder B): workflow() bridge calls go through this
      // async loader — snapshot-per-call fresh disk reads, trust-checked.
      supervisor = new mod.SupervisorImpl({
        registry,
        storage,
        sessions,
        options,
        loadWorkflowFresh: (name: string) => storage.loadWorkflowFresh(name),
      })
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

    /** Best-effort pending-permission summary for a child session. */
    async function pendingPermissions(sessionID: string): Promise<string | undefined> {
      try {
        const result = (await ctx.permission.list({ sessionID })) as unknown
        const items = unwrapList(result) as Array<{ action?: string; resources?: unknown; message?: string }>
        if (items.length === 0) return undefined
        return items
          .map((p) => {
            const resources = Array.isArray(p.resources) ? p.resources.join(", ") : "?"
            return `${p.action ?? "?"} on ${resources}`
          })
          .join("; ")
      } catch {
        return undefined
      }
    }

    // ---- ultracode_run tool (namespaced: unique vs future opencode/plugin tools) ----
    try {
      await ctx.tool.transform((editor) => {
        try {
          editor.namespace({ name: "ultracode", description: "Dynamic workflow orchestration (ultracode)" })
          editor.add({
            name: "run",
            options: { namespace: "ultracode" },
            description:
              "Run an ultracode workflow (invoke this tool as ultracode_run) — a plain-JS async-function-body script that " +
              "orchestrates multiple AI agents (agent(), parallel(), pipeline(), phase(), progress(), workflow(name), sleep()) " +
              "and returns a small JSON value. Input is { script, meta?, args? } (inline) or { workflow: name, args? } " +
              "(saved workflow — must be trusted first via /ultracode trust <name>). " +
              "Use when a task outgrows one context window or needs fan-out / verification / repeatable orchestration. " +
              "Blocks until every agent settles, then returns an envelope { runID, status, agents, tokens, result | preview }. " +
              "Say 'ultracode' at the start of your prompt to load the authoring skill.",
            input: WORKFLOW_TOOL_INPUT_SCHEMA,
            execute: async (rawInput: unknown, tool) => {
              if (supervisor?.isOwnedSession(tool.sessionID)) {
                return { content: "nested workflow runs are not allowed" }
              }
              try {
                if (disposed) return { content: "error: the ultracode plugin is shutting down" }
                if (!supervisor) {
                  return { content: `error: ${supervisorError ?? "workflow tool unavailable"}` }
                }
                const parsed = validateToolInput(rawInput)
                if (!parsed.ok) {
                  return { content: `error: invalid workflow input — ${parsed.error}` }
                }
                const input = parsed.input

                // Agent availability: fresh fetch on EVERY invocation; a failed
                // fetch fails the run (no silent stale reuse).
                const agents = await listAgentIDs()
                if (!agents.ok) {
                  return {
                    content: `error: could not list available agents (${agents.error}) — refusing to start the run`,
                  }
                }
                const availableAgents = agents.ids

                let script: string
                let meta: WorkflowMeta | undefined
                let name: string | undefined
                let workflowName: string | undefined
                let args: Json | undefined

                if ("workflow" in input) {
                  // Fresh disk scan so edits made while the server runs are seen.
                  await storage.refreshWorkflows()
                  await runsReconciled
                  let saved: ReturnType<StorageImpl["loadWorkflow"]>
                  try {
                    saved = storage.loadWorkflow(input.workflow)
                  } catch (err) {
                    return { content: `error: ${describeError(err)}` }
                  }
                  if (!saved) {
                    const available = storage
                      .listWorkflows()
                      .map((w) => w.manifest.name)
                      .join(", ")
                    return {
                      content:
                        `error: workflow "${input.workflow}" not found.` +
                        (available ? ` Saved workflows: ${available}.` : " No saved workflows exist yet — run one inline, then use /ultracode save <runID> <name>."),
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
                const missingRequires = [...new Set(requires)].filter((id) => !availableAgents.includes(id))
                if (missingRequires.length > 0) {
                  return {
                    content:
                      `error: workflow requires agent(s) not available: ${missingRequires.join(", ")}. ` +
                      `Available agents: ${availableAgents.join(", ") || "(none — create agents or check your install)"}`,
                  }
                }

                // Validate the configured default agent for this run.
                if (!availableAgents.includes(options.agent)) {
                  return {
                    content:
                      `error: default agent "${options.agent}" is not available in this location. ` +
                      `Available agents: ${availableAgents.join(", ") || "(none — create agents or check your install)"}. ` +
                      `Set the "agent" plugin option to an available agent id.`,
                  }
                }

                const parent: ParentContext = {
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  messageID: tool.messageID,
                  report: makeReporter(tool.progress as (update: Record<string, unknown>) => Promise<void>),
                  availableAgents,
                }
                const outcome = await supervisor.start({ script, meta, args, name, workflowName }, parent)
                return { content: JSON.stringify(outcome.envelope, null, 1) }
              } catch (err) {
                return { content: `error: workflow run failed — ${describeError(err)}` }
              }
            },
          })
        } catch (err) {
          warn("failed to register the ultracode_run tool", err)
        }
      })
    } catch (err) {
      warn("tool transform failed — ultracode_run not registered", err)
    }

    // ---- /ultracode command (+ /workflow, /workflows aliases when free) ----
    function commandArgs(promptText: string | undefined): string {
      const text = (promptText ?? "").trim()
      const token = /^\/(?:ultracode|workflows|workflow)\b/i.exec(text)
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

    async function showRun(run: RunRecord): Promise<string> {
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
      if (run.resultTruncated && run.resultArtifactKey) {
        lines.push(`- result truncated — full result: /ultracode result \`${run.id}\` (artifact key \`${run.resultArtifactKey}\`)`)
      }
      lines.push("")
      lines.push("### Agents")
      lines.push("")
      if (run.agents.length === 0) {
        lines.push("(no agents were started)")
      } else {
        lines.push("| id | label / phase | agent | model | status | tokens in/out | session |")
        lines.push("| --- | --- | --- | --- | --- | --- | --- |")
        for (const a of run.agents) {
          const label = [a.label, a.phase].filter(Boolean).join(" · ") || "-"
          const agent = a.effectiveAgent ?? a.requestedAgent ?? "-"
          const model = a.effectiveModel ? `${a.effectiveModel.providerID}/${a.effectiveModel.id}` : "-"
          const tokens = a.tokens ? `${fmtTokens(a.tokens.input)}/${fmtTokens(a.tokens.output)}` : "-"
          const error = a.error ? ` — ${a.error.slice(0, 60)}` : ""
          lines.push(`| ${a.id} | ${label} | ${agent} | ${model} | ${a.status}${error} | ${tokens} | ${a.sessionID ?? "-"} |`)
        }
      }
      // Pending permissions for children of an active run (best-effort).
      if (run.status === "running" || run.status === "stopping") {
        const pending: string[] = []
        for (const a of run.agents) {
          if (a.status !== "running" || !a.sessionID) continue
          const text = await pendingPermissions(a.sessionID)
          if (text) pending.push(`- \`${a.id}\` (\`${a.sessionID}\`): ${text}`)
        }
        if (pending.length > 0) {
          lines.push("")
          lines.push("**Waiting for permission**")
          lines.push(...pending)
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
        "Usage (command: /ultracode; /workflow and /workflows work as aliases when not taken):",
        "- `/ultracode` — active + recent runs and saved workflows",
        "- `/ultracode show <runID>` — full run report (agents, sessions, tokens, script)",
        "- `/ultracode stop <runID>` — stop an active run",
        "- `/ultracode save <runID> <name>` — save a run's script as a reusable workflow",
        "- `/ultracode trust <name>` — approve the current version of a saved workflow",
        "- `/ultracode result <runID>` — print a truncated run's full result",
      ].join("\n")
    }

    const commandHandler = async (invocation: { sessionID: string; prompt: { text?: string } }): Promise<void> => {
      try {
        if (disposed) return
        const { sessionID } = invocation
        const argsText = commandArgs(invocation.prompt?.text)
        if (argsText === "") {
          await runsReconciled
          await storage.refreshWorkflows() // fresh from disk on every invocation
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
              ? saved
                  .map((w) => {
                    const state = storage.workflowTrustState(w.manifest.name)
                    const stateText =
                      state === "trusted" ? "trusted" : state === "untrusted" ? "untrusted (changed)" : "unknown"
                    return `- \`${w.manifest.name}\` — ${w.manifest.description ?? "(no description)"} [${w.manifest.source} · ${stateText}]`
                  })
                  .join("\n")
              : "(none — save one with `/ultracode save <runID> <name>`)",
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
            await say(sessionID, "Usage: /ultracode stop <runID>")
            return
          }
          if (!supervisor) {
            await say(sessionID, `error: ${supervisorError ?? "supervisor unavailable"}`)
            return
          }
          const stopped = supervisor.stop(rest, "user requested (/ultracode stop)")
          await say(
            sessionID,
            stopped ? `Stopping run \`${rest}\` — in-flight agents will be interrupted.` : `Run \`${rest}\` is unknown or already finished. See /ultracode for the list.`,
          )
          return
        }

        if (sub === "show") {
          if (!rest) {
            await say(sessionID, "Usage: /ultracode show <runID>")
            return
          }
          await runsReconciled
          const run = registry.get(rest)
          if (!run) {
            await say(sessionID, `Run \`${rest}\` not found. See /ultracode for known runs.`)
            return
          }
          await say(sessionID, await showRun(run))
          return
        }

        if (sub === "save") {
          const saveMatch = /^(\S+)\s+(\S+)$/.exec(rest)
          if (!saveMatch) {
            await say(sessionID, "Usage: /ultracode save <runID> <name>\n(name: lowercase alphanumerics, `-`/`_`, max 64 chars)")
            return
          }
          const runID = saveMatch[1]!
          const name = saveMatch[2]!
          const run = registry.get(runID)
          if (!run) {
            await say(sessionID, `Run \`${runID}\` not found. See /ultracode for known runs.`)
            return
          }
          try {
            // manifest.name is ALWAYS the lookup key; the run's display name
            // only enriches the description.
            const display = run.meta?.name ?? run.name
            const saved = await storage.saveWorkflow(name, run.script, {
              name,
              description: display && display !== name ? `saved from run ${run.id} (${display})` : `saved from run ${run.id}`,
              phases: run.meta?.phases,
              requires: run.meta?.requires,
              savedFromRunID: run.id,
              source: "project",
            })
            await say(
              sessionID,
              `Saved workflow \`${saved.manifest.name}\` (${saved.manifest.source}) — approve it once with \`/ultracode trust ${saved.manifest.name}\`, then run it with { workflow: "${saved.manifest.name}" }`,
            )
          } catch (err) {
            await say(sessionID, `error: could not save workflow — ${describeError(err)}`)
          }
          return
        }

        if (sub === "trust") {
          if (!rest || /\s/.test(rest)) {
            await say(sessionID, "Usage: /ultracode trust <name>")
            return
          }
          try {
            const trusted = await storage.trustWorkflow(rest)
            if (!trusted) {
              await say(sessionID, `Workflow \`${rest}\` not found on disk. See /ultracode for the list.`)
              return
            }
            await say(
              sessionID,
              `Trusted workflow \`${rest}\` (current version, sha256 ${trusted.digest.slice(0, 12)}…) — it can now be run with { workflow: "${rest}" }.`,
            )
          } catch (err) {
            await say(sessionID, `error: could not trust workflow — ${describeError(err)}`)
          }
          return
        }

        if (sub === "result") {
          if (!rest) {
            await say(sessionID, "Usage: /ultracode result <runID>")
            return
          }
          await runsReconciled
          const run = registry.get(rest)
          if (!run) {
            await say(sessionID, `Run \`${rest}\` not found. See /ultracode for known runs.`)
            return
          }
          if (!run.resultArtifactKey) {
            await say(
              sessionID,
              run.resultTruncated
                ? `Run \`${rest}\` was truncated but no result artifact was recorded.`
                : `Run \`${rest}\` was not truncated — its result is already in the tool output (see /ultracode show).`,
            )
            return
          }
          const result = await storage.loadResultArtifactFresh(run.resultArtifactKey)
          if (result === undefined) {
            await say(sessionID, `No stored result found for run \`${rest}\` (key \`${run.resultArtifactKey}\`).`)
            return
          }
          await say(sessionID, `## Full result — \`${rest}\`\n\n\`\`\`json\n${JSON.stringify(result, null, 1)}\n\`\`\``)
          return
        }

        await say(sessionID, `Unknown /ultracode argument: ${JSON.stringify(sub)}\n\n${helpText()}`)
      } catch (err) {
        warn("/ultracode command failed", err)
      }
    }

    try {
      // Fetch existing commands BEFORE the transform: register /workflow and
      // /workflows aliases only when the names are free (last-wins clobbering).
      let aliasNames: ReadonlySet<string> = new Set(["workflow", "workflows"])
      try {
        const listed = unwrapList((await ctx.command.list()) as unknown) as Array<{ name?: unknown }>
        aliasNames = new Set(
          ["workflow", "workflows"].filter((name) => !listed.some((c) => c && typeof c === "object" && (c as { name?: unknown }).name === name)),
        )
      } catch (err) {
        aliasNames = new Set()
        warn("could not list existing commands — /workflow aliases skipped", err)
      }
      await ctx.command.transform((editor) => {
        try {
          editor.add({
            name: "ultracode",
            description: "Inspect and manage ultracode workflow runs (summary, show, stop, save, trust, result)",
            execute: commandHandler,
          })
          if (aliasNames.has("workflow")) {
            editor.add({
              name: "workflow",
              description: "Alias of /ultracode",
              execute: commandHandler,
            })
          } else {
            warn("skipping /workflow alias — a command with that name already exists")
          }
          if (aliasNames.has("workflows")) {
            editor.add({
              name: "workflows",
              description: "Alias of /ultracode",
              execute: commandHandler,
            })
          } else {
            warn("skipping /workflows alias — a command with that name already exists")
          }
        } catch (err) {
          warn("failed to register commands", err)
        }
      })
    } catch (err) {
      warn("command transform failed — /ultracode not registered", err)
    }

    // ---- prompt hook: attach the authoring skill on a leading "ultracode" keyword ----
    try {
      const reg = await ctx.session.hook("prompt", (event) => {
        try {
          if (!skillInstalled) return // never push an unregistered skill id
          const ev = event as unknown as {
            sessionID?: string
            prompt?: { text?: string; skills?: Array<{ id: string }> }
          }
          // Start-of-prompt trigger only: "ultracode: do X" / "ultracode do X".
          // Mid-sentence mentions and paths like opencode-ultracode do not fire.
          if (!/^\s*ultracode(?=\s|:|$)/i.test(ev.prompt?.text ?? "")) return
          // sessionID must be present; without it we cannot check ownership —
          // don't mutate the prompt at all.
          const sessionID = ev.sessionID
          if (typeof sessionID !== "string" || sessionID === "") return
          // Don't re-attach inside workflow-owned child sessions.
          if (supervisor?.isOwnedSession(sessionID) || registry.isOwnedActive(sessionID)) return
          const prompt = ev.prompt
          if (!prompt || typeof prompt !== "object") return
          prompt.skills ??= []
          if (!prompt.skills.some((s) => s?.id === "ultracode")) {
            prompt.skills.push({ id: "ultracode" })
          }
        } catch {
          // never throw from a hook
        }
      })
      registrations.push(reg as unknown as RegistrationLike)
    } catch (err) {
      warn("prompt hook registration failed — keyword skill attach disabled", err)
    }

    // ---- skill registration (Builder C content; static file in the plugin package) ----
    try {
      const content = await import("./skill-content.ts")
      // The skill markdown ships inside the plugin package (skills/ultracode.md).
      // Derive the plugin dir from this module's URL; never write into the
      // user's project.
      const skillPath = fileURLToPath(new URL("../skills/ultracode.md", import.meta.url))
      let filePresent = false
      try {
        filePresent = await fs.exists(skillPath)
      } catch {
        filePresent = false
      }
      if (!filePresent) {
        // Best effort: materialize it inside the PLUGIN dir (not the project).
        // Read-only installs simply skip skill registration.
        try {
          await fs.mkdir(normalizePath(`${skillPath}/..`), true)
          await fs.writeFile(skillPath, content.SKILL_CONTENT)
          filePresent = true
        } catch (err) {
          warn(`skill file ${skillPath} is missing and could not be created`, err)
        }
      }
      if (filePresent) {
        await ctx.skill.transform((editor) => {
          try {
            skillInstalled = false // defensive: reset before any replay
            const existing = editor.get("ultracode") as { location?: string } | undefined
            if (existing && existing.location !== skillPath) {
              warn(`skill id "ultracode" is already registered at ${String(existing.location)} — not overriding it`)
              return
            }
            editor.add({
              id: "ultracode",
              name: content.SKILL_NAME,
              description: content.SKILL_DESCRIPTION,
              location: skillPath,
              content: content.SKILL_CONTENT,
            } as unknown as Skill.Info)
            skillInstalled = true
          } catch (err) {
            warn("skill editor.add failed", err)
          }
        })
      } else {
        warn("skill not registered — its location file is unavailable")
      }
    } catch (err) {
      warn("skill registration failed — keyword skill attach will not resolve", err)
    }

    // ---- permission hook (only when NOT delegating every ask to the user) ----
    if (options.permissions !== "ask") {
      /**
       * Symlink-aware containment via the shared lstat resolver: file: URLs
       * parsed with fileURLToPath (no string slicing), components walked with
       * lstat, symlinks realpath'd. Resolution failure (dangling link, fs
       * error, unclassifiable resource) FAILS CLOSED — no auto-allow.
       */
      const resourceInsideProject = async (resource: string): Promise<boolean> => {
        try {
          let path: string | undefined
          if (resource.startsWith("file:")) {
            path = fileURLToPath(new URL(resource))
          } else if (resource.startsWith("/")) {
            path = resource
          } else {
            return false // relative/opaque — unclassifiable => fail closed
          }
          const resolved = await resolveContainedPath(fs, projectRoot, path)
          return resolved.ok
        } catch {
          return false
        }
      }
      try {
        const reg = await ctx.permission.hook("evaluate", async (event) => {
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
              const inside = await Promise.all(resources.map((r) => (typeof r === "string" ? resourceInsideProject(r) : Promise.resolve(false))))
              if (!inside.every(Boolean)) return
              // The async fs checks above open a window where the run could
              // have finalized — re-verify active ownership immediately
              // before allowing.
              if (!registry.isOwnedActive(sessionID)) return
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
      disposed = true
      skillInstalled = false
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
