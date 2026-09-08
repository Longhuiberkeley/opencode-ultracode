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
import {
  TOOL_DESCRIPTION,
  feedToolEvent,
  handleUltracodeCommand,
  matchesUltracodeKeyword,
  prepareRunLaunch,
} from "./command.ts"
import { loadOptions } from "./config.ts"
import { RegistryImpl } from "./registry.ts"
import { emptyToolEventState } from "./run-events.ts"
import { EMPTY_CATALOG, SKILL_CONTENT, SKILL_DESCRIPTION, SKILL_NAME, buildSkillContent } from "./skill-content.ts"
import { StorageImpl, normalizePath, resolveContainedPath } from "./storage.ts"
import { validateToolInput } from "./tool-input.ts"
import type {
  FsLike,
  Json,
  KvLike,
  ParentContext,
  SessionCtx,
  Supervisor,
  WorkflowMeta,
} from "./types.ts"

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
    let catalogInjected = false

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
        (await ctx.session.create({
          title: input.title,
          agent: input.agent,
          ...(input.metadata ? { metadata: input.metadata as { readonly [k: string]: never } } : {}),
        })) as unknown as {
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
    async function listAgents(): Promise<
      | { ok: true; agents: Array<{ id: string; description?: string }> }
      | { ok: false; error: string }
    > {
      try {
        const result = (await ctx.agent.list()) as unknown
        const agents: Array<{ id: string; description?: string }> = []
        for (const a of unwrapList(result)) {
          if (!a || typeof a !== "object") continue
          const id = (a as { id?: unknown }).id
          if (typeof id !== "string" || id === "") continue
          const description = (a as { description?: unknown }).description
          const name = (a as { name?: unknown }).name
          const desc =
            typeof description === "string"
              ? description
              : typeof name === "string" && name !== id
                ? name
                : undefined
          agents.push(desc ? { id, description: desc } : { id })
        }
        return { ok: true, agents }
      } catch (err) {
        return { ok: false, error: describeError(err) }
      }
    }

    /** D1: first non-empty agent.list() rebuilds the in-memory skill (never the shipped file). */
    async function maybeInjectCatalog(agents: Array<{ id: string; description?: string }>): Promise<void> {
      if (catalogInjected || !skillInstalled || agents.length === 0) return
      const prior = skillInstalled
      try {
        await storage.refreshWorkflows()
        const workflows = storage.listWorkflows().map((w) => ({
          name: w.manifest.name,
          description: w.manifest.description,
          phases: w.manifest.phases,
          trusted: storage.workflowTrustState(w.manifest.name) === "trusted",
        }))
        const content = buildSkillContent({ agents, workflows })
        await ctx.skill.transform((editor) => {
          try {
            editor.update("ultracode", (skill) => {
              skill.content = content
            })
          } catch (err) {
            warn("skill editor.update failed during catalog injection", err)
            throw err
          }
        })
        catalogInjected = true
      } catch (err) {
        skillInstalled = prior
        warn("live catalog injection failed — skill left at prior content", err)
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
            description: TOOL_DESCRIPTION,
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

                const prep = await prepareRunLaunch({
                  listAgents,
                  defaultAgent: options.agent,
                  requires: meta?.requires,
                })
                if (!prep.ok) return { content: prep.error }
                await maybeInjectCatalog(prep.agents)

                const parent: ParentContext = {
                  sessionID: tool.sessionID,
                  agent: tool.agent,
                  messageID: tool.messageID,
                  report: makeReporter(tool.progress as (update: Record<string, unknown>) => Promise<void>),
                  availableAgents: prep.availableAgents,
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

    // ---- /ultracode command (no /workflow aliases — avoid OpenCode name collisions) ----
    const commandHandler = async (invocation: { sessionID: string; prompt: { text?: string } }): Promise<void> => {
      try {
        if (disposed) return
        await handleUltracodeCommand(invocation, {
          registry,
          supervisor,
          supervisorError,
          storage,
          say,
          projectRoot,
          personalWorkflowDir,
          pendingPermissions,
          prepare: async () => {
            await runsReconciled
            await storage.refreshWorkflows()
          },
          listAgents,
          defaultAgent: options.agent,
        })
      } catch (err) {
        warn("/ultracode command failed", err)
      }
    }

    try {
      await ctx.command.transform((editor) => {
        try {
          editor.add({
            name: "ultracode",
            description:
              "Inspect and manage ultracode workflow runs (show, result, stop, pause, resume, rerun, save, trust, untrust, help)",
            execute: commandHandler,
          })
        } catch (err) {
          warn("failed to register commands", err)
        }
      })
    } catch (err) {
      warn("command transform failed — /ultracode not registered", err)
    }

    // ---- prompt hook: attach the authoring skill on a standalone "ultracode" keyword ----
    try {
      const reg = await ctx.session.hook("prompt", (event) => {
        try {
          if (!skillInstalled) return // never push an unregistered skill id
          const ev = event as unknown as {
            sessionID?: string
            prompt?: { text?: string; skills?: Array<{ id: string }> }
          }
          // Standalone keyword anywhere: "ultracode: do X" / "please ultracode this".
          // Paths like opencode-ultracode and ids like ultracode_run do not fire.
          if (!matchesUltracodeKeyword(ev.prompt?.text ?? "")) return
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
      // The skill markdown ships inside the plugin package (skills/ultracode.md).
      // Derive the plugin dir from this module's URL; never write into the
      // user's project. Catalog injection later updates in-memory content only.
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
          await fs.writeFile(skillPath, SKILL_CONTENT)
          filePresent = true
        } catch (err) {
          warn(`skill file ${skillPath} is missing and could not be created`, err)
        }
      }
      if (filePresent) {
        await ctx.skill.transform((editor) => {
          try {
            const existing = editor.get("ultracode") as { location?: string } | undefined
            if (existing && existing.location !== skillPath) {
              warn(`skill id "ultracode" is already registered at ${String(existing.location)} — not overriding it`)
              return
            }
            if (existing) {
              // Replay of this transform (late catalog inject / reload): keep ours.
              skillInstalled = true
              return
            }
            editor.add({
              id: "ultracode",
              name: SKILL_NAME,
              description: SKILL_DESCRIPTION,
              location: skillPath,
              content: buildSkillContent(EMPTY_CATALOG),
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

    // ---- session.tool.* event stream → AgentRecord.toolCalls (D6/A2) ----
    try {
      const subscribe = (ctx.event as { subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<unknown> })
        .subscribe
      if (typeof subscribe !== "function") {
        warn("event.subscribe unavailable — tool-call counts disabled")
      } else {
        const stream = subscribe({ signal: controller.signal })
        void (async () => {
          let state = emptyToolEventState()
          try {
            for await (const raw of stream) {
              if (controller.signal.aborted) break
              const ev = raw as { type?: string; created?: number; data?: { sessionID?: string; id?: string } }
              if (typeof ev?.type !== "string") continue
              state = feedToolEvent(
                state,
                { type: ev.type, created: ev.created, data: ev.data },
                registry,
              )
            }
          } catch (err) {
            if (!controller.signal.aborted) warn("event subscription ended", err)
          }
        })()
      }
    } catch (err) {
      warn("event subscribe failed — tool-call counts disabled", err)
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
