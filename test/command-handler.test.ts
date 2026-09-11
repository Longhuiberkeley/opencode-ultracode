/**
 * Phase 1b command surface: implicit targets, pause/resume/untrust, rerun
 * trust/nested gates, show golden table, event→toolCalls wiring.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import {
  MIN_SUPPORTED_BUILD,
  NESTED_RUN_REFUSED,
  NO_ACTIVE_RUN,
  PLUGIN_VERSION,
  SOURCE_STILL_ACTIVE,
  feedToolEvent,
  formatShowRun,
  handleUltracodeCommand,
  multipleActiveMessage,
  resolveRunStatus,
  type CommandDeps,
  type CommandStorage,
  type CommandSupervisor,
} from "../src/command.ts"
import { emptyToolEventState, toolCallsFor } from "../src/run-events.ts"
import { agentCells, runHeaderCells } from "../src/run-format.ts"
import type { AgentRecord, Json, ParentContext, RunOutcome, RunRecord, SavedWorkflow } from "../src/types.ts"
import { DEFAULT_OPTIONS } from "../src/types.ts"
import { applyOverlay, overlayFromPanel, panelSettingsFrom, parseSettingsAckPayload } from "../src/settings.ts"
import { FakeRegistry } from "./fakes.ts"

function digest(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex")
}

function baseRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run_x",
    parentSessionID: "ses_parent",
    status: "running",
    script: "return 1",
    startedAt: 1_000,
    agents: [],
    ...overrides,
  }
}

class MemoryStorage implements CommandStorage {
  workflows = new Map<string, SavedWorkflow>()
  trust = new Map<string, string>()
  artifacts = new Map<string, Json>()
  throwsOnLoad = new Map<string, Error>()

  listWorkflows(): SavedWorkflow[] {
    return [...this.workflows.values()]
  }
  loadWorkflow(name: string): SavedWorkflow | undefined {
    const forced = this.throwsOnLoad.get(name)
    if (forced) throw forced
    const w = this.workflows.get(name)
    if (!w) return undefined
    if (this.trust.get(name) !== digest(w.script)) {
      throw new Error(
        `workflow "${name}" is not trusted (new or changed since approval). Run /ultracode trust ${name} to approve the current version.`,
      )
    }
    return w
  }
  async saveWorkflow(
    name: string,
    script: string,
    manifest: {
      name: string
      description?: string
      phases?: string[]
      requires?: string[]
      savedFromRunID?: string
      source: "project" | "personal"
    },
  ): Promise<SavedWorkflow> {
    const saved: SavedWorkflow = {
      manifest: {
        version: 1,
        name,
        description: manifest.description,
        phases: manifest.phases,
        requires: manifest.requires,
        hash: digest(script),
        source: manifest.source,
        savedAt: Date.now(),
        ...(manifest.savedFromRunID ? { savedFromRunID: manifest.savedFromRunID } : {}),
      },
      script,
    }
    this.workflows.set(name, saved)
    return saved
  }
  fileScripts = new Map<string, string>()
  async saveWorkflowFromFile(name: string): Promise<SavedWorkflow> {
    const script = this.fileScripts.get(name)
    if (!script) throw new Error(`workflow "${name}" not found`)
    return this.saveWorkflow(name, script, { name, source: "project" })
  }
  async trustWorkflow(name: string): Promise<{ workflow: SavedWorkflow; digest: string } | undefined> {
    const w = this.workflows.get(name)
    if (!w) return undefined
    const d = digest(w.script)
    this.trust.set(name, d)
    return { workflow: w, digest: d }
  }
  async revokeTrust(name: string): Promise<void> {
    if (!this.trust.has(name)) {
      const names = [...this.trust.keys()].sort()
      throw new Error(
        `workflow "${name}" is not trusted.` +
          (names.length ? ` Trusted workflows: ${names.join(", ")}.` : " No workflows are trusted."),
      )
    }
    this.trust.delete(name)
  }
  workflowTrustState(name: string): "trusted" | "untrusted" | "unknown" {
    const w = this.workflows.get(name)
    if (!w) return "unknown"
    return this.trust.get(name) === digest(w.script) ? "trusted" : "untrusted"
  }
  async refreshWorkflows(): Promise<void> {}
  async loadResultArtifactFresh(key: string): Promise<Json | undefined> {
    return this.artifacts.get(key)
  }
}

class MemorySupervisor implements CommandSupervisor {
  startCalls: Array<{ input: unknown; parent: ParentContext }> = []
  pendingDone: Array<(value: RunOutcome) => void> = []
  private readonly registry: FakeRegistry
  constructor(registry: FakeRegistry) {
    this.registry = registry
  }
  pause(runID: string): boolean {
    const run = this.registry.get(runID)
    if (!run || run.status !== "running") return false
    return this.registry.setStatus(runID, "paused")
  }
  resume(runID: string): boolean {
    const run = this.registry.get(runID)
    if (!run || run.status !== "paused") return false
    return this.registry.setStatus(runID, "running")
  }
  stop(runID: string, reason: string): boolean {
    const run = this.registry.get(runID)
    if (!run || (run.status !== "running" && run.status !== "paused" && run.status !== "stopping")) return false
    return this.registry.setStatus(runID, "stopped", { stopReason: reason })
  }
  startDetached(
    input: { script: string; meta?: RunRecord["meta"]; args?: Json; name?: string; workflowName?: string },
    parent: ParentContext,
  ): { runID: string; done: Promise<RunOutcome> } {
    this.startCalls.push({ input, parent })
    const run = this.registry.create({
      parentSessionID: parent.sessionID,
      script: input.script,
      meta: input.meta,
      args: input.args,
      name: input.name,
      workflowName: input.workflowName,
    })
    let resolve!: (value: RunOutcome) => void
    const done = new Promise<RunOutcome>((r) => {
      resolve = r
    })
    this.pendingDone.push(resolve)
    return { runID: run.id, done }
  }
  activeRuns(): RunRecord[] {
    return this.registry.activeRuns()
  }
}

function seed(registry: FakeRegistry, run: RunRecord): RunRecord {
  registry.runs.set(run.id, run)
  return run
}

async function invoke(
  text: string,
  opts: {
    registry?: FakeRegistry
    storage?: MemoryStorage
    supervisor?: MemorySupervisor
    sessionID?: string
  } = {},
): Promise<{ texts: string[]; registry: FakeRegistry; storage: MemoryStorage; supervisor: MemorySupervisor }> {
  const registry = opts.registry ?? new FakeRegistry()
  const storage = opts.storage ?? new MemoryStorage()
  const supervisor = opts.supervisor ?? new MemorySupervisor(registry)
  const texts: string[] = []
  const deps: CommandDeps = {
    registry,
    supervisor,
    storage,
    say: async (_sid, t) => {
      texts.push(t)
    },
    projectRoot: "/project",
    personalWorkflowDir: "/home/u/.config/opencode/workflows",
    listAgents: async () => ({ ok: true, agents: [{ id: "general" }, { id: "explore" }] }),
    defaultAgent: "general",
  }
  await handleUltracodeCommand({ sessionID: opts.sessionID ?? "ses_parent", prompt: { text } }, deps)
  return { texts, registry, storage, supervisor }
}

const RUN_SCOPED = ["show", "status", "result", "pause", "resume", "stop"] as const

for (const verb of RUN_SCOPED) {
  test(`implicit target: ${verb} × 0 active`, async () => {
    const { texts } = await invoke(verb)
    assert.equal(texts.length, 1)
    assert.equal(texts[0], NO_ACTIVE_RUN)
  })

  test(`implicit target: ${verb} × 1 active`, async () => {
    const registry = new FakeRegistry()
    seed(registry, baseRun({ id: "run_only", status: verb === "resume" ? "paused" : "running" }))
    const { texts } = await invoke(verb, { registry })
    assert.ok(texts[0])
    assert.doesNotMatch(texts[0]!, new RegExp(NO_ACTIVE_RUN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.doesNotMatch(texts[0]!, /multiple active runs/)
    if (verb === "show") assert.match(texts[0]!, /run_only/)
    if (verb === "status") assert.match(texts[0]!, /run_only/)
    if (verb === "pause") assert.match(texts[0]!, /Paused run `run_only`/)
    if (verb === "resume") assert.match(texts[0]!, /Resumed run `run_only`/)
    if (verb === "stop") assert.match(texts[0]!, /Stopping run `run_only`/)
  })

  test(`implicit target: ${verb} × many active`, async () => {
    const registry = new FakeRegistry()
    seed(registry, baseRun({ id: "run_a", status: "running", startedAt: 2 }))
    seed(registry, baseRun({ id: "run_b", status: "paused", startedAt: 1 }))
    const { texts } = await invoke(verb, { registry })
    assert.equal(texts[0], multipleActiveMessage(["run_a", "run_b"]))
  })
}

test("status unknown id uses the not-found line", async () => {
  const { texts } = await invoke("status run_missing")
  assert.match(texts[0]!, /Run `run_missing` not found/)
})

test("status transitions: running → paused → running → interrupted via /ultracode status and ultracode_status", async () => {
  const registry = new FakeRegistry()
  const run = seed(
    registry,
    baseRun({
      id: "run_bg",
      status: "running",
      startedAt: 1_000,
      agents: [
        { id: "a1", status: "succeeded" },
        { id: "a2", status: "running" },
      ],
    }),
  )
  const now = 2_500
  const cmd = await invoke("status run_bg", { registry })
  assert.match(cmd.texts[0]!, /^run_bg · running · agents 1\/2 · /)

  assert.equal(registry.setStatus("run_bg", "paused"), true)
  const pausedCmd = await invoke("status run_bg", { registry })
  assert.match(pausedCmd.texts[0]!, /^run_bg · paused · agents 1\/2 · /)
  const pausedTool = resolveRunStatus(registry, "run_bg", registry.activeRuns())
  assert.equal(pausedTool.ok, true)
  if (pausedTool.ok) {
    assert.deepEqual(pausedTool.payload, {
      runID: "run_bg",
      status: "paused",
      agents: { done: 1, total: 2, failed: 0 },
      startedAt: 1_000,
    })
  }

  assert.equal(registry.setStatus("run_bg", "running"), true)
  const resumedTool = resolveRunStatus(registry, "run_bg", registry.activeRuns())
  assert.equal(resumedTool.ok && resumedTool.payload.status, "running")

  run.agents[1] = { id: "a2", status: "interrupted" }
  run.endedAt = now
  assert.equal(registry.setStatus("run_bg", "interrupted"), true)
  const doneCmd = await invoke("status run_bg", { registry })
  assert.match(doneCmd.texts[0]!, /^run_bg · interrupted · agents 2\/2 · /)
  const doneTool = resolveRunStatus(registry, "run_bg", registry.activeRuns())
  assert.equal(doneTool.ok, true)
  if (doneTool.ok) {
    assert.equal(doneTool.payload.status, "interrupted")
    assert.deepEqual(doneTool.payload.agents, { done: 2, total: 2, failed: 0 })
  }
})

test("pause-on-paused is refused with an explicit error", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_p", status: "paused" }))
  const { texts } = await invoke("pause run_p", { registry })
  assert.match(texts[0]!, /already paused/)
})

test("resume-on-non-paused is refused with an explicit error", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_r", status: "running" }))
  const { texts } = await invoke("resume run_r", { registry })
  assert.match(texts[0]!, /is not paused \(status: running\)/)
})

test("untrust ack and unknown-name error listing trusted names", async () => {
  const storage = new MemoryStorage()
  storage.workflows.set("alpha", {
    manifest: {
      version: 1,
      name: "alpha",
      hash: digest("return 1"),
      source: "project",
      savedAt: 0,
    },
    script: "return 1",
  })
  storage.trust.set("alpha", digest("return 1"))
  const ok = await invoke("untrust alpha", { storage })
  assert.match(ok.texts[0]!, /Revoked trust for workflow `alpha`/)
  const miss = await invoke("untrust nope", { storage })
  assert.match(miss.texts[0]!, /could not untrust workflow/)
  assert.match(miss.texts[0]!, /No workflows are trusted/)
})

test("rerun ack shape and never awaits done before acking", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_old", status: "succeeded", script: "return 7", name: "demo" }))
  const { texts, supervisor } = await invoke("rerun run_old", { registry })
  assert.equal(texts.length, 1)
  assert.match(texts[0]!, /^rerun started: (\S+) \(from run_old\)$/)
  const newID = /^rerun started: (\S+) \(from run_old\)$/.exec(texts[0]!)![1]!
  assert.equal(supervisor.startCalls.length, 1)
  const envelope: RunOutcome = {
    run: registry.get(newID)!,
    envelope: {
      runID: newID,
      status: "succeeded",
      durationMs: 1,
      agents: { total: 0, succeeded: 0, failed: 0, interrupted: 0 },
      truncated: false,
    },
  }
  supervisor.pendingDone[0]!(envelope)
  await Promise.resolve()
  assert.equal(texts.length, 2)
  assert.ok(texts[1]!.includes(newID))
  assert.ok(texts[1]!.includes("succeeded"))
})

test("rerun of still-active run is refused", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_live", status: "running" }))
  const { texts, supervisor } = await invoke("rerun run_live", { registry })
  assert.equal(texts[0], SOURCE_STILL_ACTIVE)
  assert.equal(supervisor.startCalls.length, 0)
})

test("rerun omit picks the most recent FINAL run", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_old", status: "succeeded", startedAt: 1, script: "return 1" }))
  seed(registry, baseRun({ id: "run_new", status: "failed", startedAt: 9, script: "return 2" }))
  seed(registry, baseRun({ id: "run_live", status: "running", startedAt: 99, script: "return 3" }))
  const { texts, supervisor } = await invoke("rerun", { registry })
  assert.match(texts[0]!, /rerun started: \S+ \(from run_new\)/)
  assert.equal((supervisor.startCalls[0]!.input as { script: string }).script, "return 2")
})

test("rerun omit with no final run errors", async () => {
  const { texts } = await invoke("rerun")
  assert.match(texts[0]!, /no final run to rerun/)
})

test("rerun trust-gate refuses an edited workflow", async () => {
  const registry = new FakeRegistry()
  seed(
    registry,
    baseRun({
      id: "run_wf",
      status: "succeeded",
      script: "return 1",
      workflowName: "flow",
    }),
  )
  const storage = new MemoryStorage()
  const edited = "return 2 // changed"
  storage.workflows.set("flow", {
    manifest: {
      version: 1,
      name: "flow",
      hash: digest(edited),
      source: "project",
      savedAt: 1,
    },
    script: edited,
  })
  storage.trust.set("flow", digest(edited))
  const { texts, supervisor } = await invoke("rerun run_wf", { registry, storage })
  assert.match(texts[0]!, /has changed since this run/)
  assert.match(texts[0]!, /\/ultracode trust flow/)
  assert.equal(supervisor.startCalls.length, 0)
})

test("rerun refuses after edit-.js-then-trust-B of a run whose script is A", async () => {
  const scriptA = "return 1 // A"
  const scriptB = "return 2 // B"
  const registry = new FakeRegistry()
  seed(
    registry,
    baseRun({
      id: "run_a",
      status: "succeeded",
      script: scriptA,
      workflowName: "flow",
    }),
  )
  const storage = new MemoryStorage()
  storage.workflows.set("flow", {
    manifest: {
      version: 1,
      name: "flow",
      hash: digest(scriptB),
      source: "project",
      savedAt: 2,
    },
    script: scriptB,
  })
  storage.trust.set("flow", digest(scriptB))
  const { texts, supervisor } = await invoke("rerun run_a", { registry, storage })
  assert.match(texts[0]!, /has changed since this run/)
  assert.match(texts[0]!, /\/ultracode trust flow/)
  assert.equal(supervisor.startCalls.length, 0)
})

test("rerun allows a trusted-unchanged workflow even with empty manifest hash", async () => {
  const script = "return 1"
  const registry = new FakeRegistry()
  seed(
    registry,
    baseRun({
      id: "run_wf",
      status: "succeeded",
      script,
      workflowName: "flow",
    }),
  )
  const storage = new MemoryStorage()
  storage.workflows.set("flow", {
    manifest: {
      version: 1,
      name: "flow",
      hash: "",
      source: "project",
      savedAt: 1,
    },
    script,
  })
  storage.trust.set("flow", digest(script))
  const { texts, supervisor } = await invoke("rerun run_wf", { registry, storage })
  assert.match(texts[0]!, /^rerun started: \S+ \(from run_wf\)$/)
  assert.equal(supervisor.startCalls.length, 1)
})

test("rerun with meta.requires listing a missing agent fails fast and spawns nothing", async () => {
  const registry = new FakeRegistry()
  seed(
    registry,
    baseRun({
      id: "run_req",
      status: "succeeded",
      script: "return 1",
      meta: { requires: ["reviewer"] },
    }),
  )
  const { texts, supervisor } = await invoke("rerun run_req", { registry })
  assert.match(texts[0]!, /requires agent\(s\) not available: reviewer/)
  assert.match(texts[0]!, /Available agents: general, explore/)
  assert.equal(supervisor.startCalls.length, 0)
})

test("rerun nested-run rejection (R15) while non-starting verbs stay allowed", async () => {
  const registry = new FakeRegistry()
  const child = seed(registry, baseRun({ id: "run_child", status: "running" }))
  registry.markOwned(child.id, "ses_owned")
  seed(registry, baseRun({ id: "run_done", status: "succeeded", startedAt: 1 }))
  const nested = await invoke("rerun run_done", { registry, sessionID: "ses_owned" })
  assert.equal(nested.texts[0], NESTED_RUN_REFUSED)
  const show = await invoke("show run_child", { registry, sessionID: "ses_owned" })
  assert.match(show.texts[0]!, /run_child/)
})

test("show golden table uses agentCells + sessionID and runHeaderCells", () => {
  const tokens = { input: 40_000, output: 2_600, reasoning: 0, cache: { read: 0, write: 0 } }
  const agent: AgentRecord = {
    id: "a3",
    label: "seeker",
    phase: "extract",
    requestedAgent: "explore",
    effectiveAgent: "explore",
    effectiveModel: { providerID: "openrouter", id: "kimi" },
    status: "running",
    tokens,
    toolCalls: 4,
    sessionID: "ses_1",
  }
  const run = baseRun({
    id: "run_abc",
    name: "audit",
    meta: { description: "scan modules" },
    startedAt: 1_000,
    endedAt: 2_500,
    agents: [agent],
    script: "return 1",
  })
  const text = formatShowRun(run)
  const header = runHeaderCells(run).join(" · ")
  assert.ok(text.includes(header), text)
  const row = [...agentCells(agent), "ses_1"].join(" | ")
  assert.ok(text.includes(`| ${row} |`), text)
  assert.ok(text.includes("### Script"))
  assert.ok(text.includes("return 1"))
  assert.match(text, /status: \*\*running\*\*/)
})

test("dashboard lists paused runs as active, not recent, and shows plugin version + min build", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_p", name: "paused-one", status: "paused", startedAt: 5 }))
  seed(registry, baseRun({ id: "run_d", name: "done-one", status: "succeeded", startedAt: 4 }))
  const { texts } = await invoke("", { registry })
  const body = texts[0]!
  const activeIdx = body.indexOf("**Active runs**")
  const recentIdx = body.indexOf("**Recent runs**")
  const active = body.slice(activeIdx, recentIdx)
  const recent = body.slice(recentIdx)
  assert.match(active, /run_p/)
  assert.doesNotMatch(active, /run_d/)
  assert.match(recent, /run_d/)
  assert.doesNotMatch(recent, /run_p/)
  assert.ok(body.includes(PLUGIN_VERSION), body)
  assert.ok(body.includes(String(MIN_SUPPORTED_BUILD)), body)
})

test("event→toolCalls wiring: mapped sessions count, unmapped ignored, older-than-startedAt ignored, deduped", () => {
  const registry = new FakeRegistry()
  const run = registry.create({ parentSessionID: "p", script: "return 1" })
  const agent = registry.addAgent(run.id, { status: "running", startedAt: 1000, sessionID: "ses_a" })!
  registry.bindAgentSession(run.id, agent.id, "ses_a")
  let state = emptyToolEventState()
  state = feedToolEvent(state, { type: "session.tool.called", data: { sessionID: "ses_a", id: "c1" }, created: 2000 }, registry)
  assert.equal(registry.getAgent(run.id, agent.id)?.toolCalls, 1)
  state = feedToolEvent(state, { type: "session.tool.called", data: { sessionID: "ses_other", id: "c2" }, created: 2000 }, registry)
  assert.equal(registry.getAgent(run.id, agent.id)?.toolCalls, 1)
  assert.equal(toolCallsFor(state, "ses_other"), 0)
  state = feedToolEvent(state, { type: "session.tool.called", data: { sessionID: "ses_a", id: "c0" }, created: 500 }, registry)
  assert.equal(registry.getAgent(run.id, agent.id)?.toolCalls, 1)
  state = feedToolEvent(state, { type: "session.tool.success", data: { sessionID: "ses_a", id: "c1" }, created: 2100 }, registry)
  assert.equal(registry.getAgent(run.id, agent.id)?.toolCalls, 1)
  state = feedToolEvent(state, { type: "session.tool.failed", data: { sessionID: "ses_a", id: "c3" }, created: 2200 }, registry)
  assert.equal(registry.getAgent(run.id, agent.id)?.toolCalls, 2)
})

test("settings query ack includes overlay and captured run snapshot", async () => {
  const registry = new FakeRegistry()
  const run = seed(
    registry,
    baseRun({
      id: "run_set",
      effective: { concurrency: 4, maxAgents: 200, timeoutMs: 3_600_000, permissions: "ask" },
    }),
  )
  const texts: string[] = []
  const next = panelSettingsFrom({ ...DEFAULT_OPTIONS, concurrency: 3 })
  const deps: CommandDeps = {
    registry,
    supervisor: new MemorySupervisor(registry),
    storage: new MemoryStorage(),
    say: async (_sid, t) => {
      texts.push(t)
    },
    projectRoot: "/project",
    personalWorkflowDir: "/home/u/.config/opencode/workflows",
    listAgents: async () => ({ ok: true, agents: [{ id: "general" }] }),
    defaultAgent: "general",
    nextRunSettings: () => next,
  }
  await handleUltracodeCommand({ sessionID: "ses_parent", prompt: { text: "settings run_set" } }, deps)
  const ack = parseSettingsAckPayload(texts[0]!)
  assert.ok(ack)
  assert.equal(ack.overlay.concurrency, 3)
  assert.equal(ack.runID, run.id)
  assert.equal(ack.effective?.concurrency, 4)
})

test("set persists overlay, refreshes defaults, and emits settings ack", async () => {
  const registry = new FakeRegistry()
  let holder = { ...DEFAULT_OPTIONS }
  let persisted: ReturnType<typeof overlayFromPanel> | undefined
  const texts: string[] = []
  const deps: CommandDeps = {
    registry,
    supervisor: new MemorySupervisor(registry),
    storage: new MemoryStorage(),
    say: async (_sid, t) => {
      texts.push(t)
    },
    projectRoot: "/project",
    personalWorkflowDir: "/home/u/.config/opencode/workflows",
    listAgents: async () => ({ ok: true, agents: [{ id: "general" }] }),
    defaultAgent: "general",
    nextRunSettings: () => panelSettingsFrom(holder),
    persistAndRefreshSettings: async (overlay) => {
      persisted = overlay
      holder = applyOverlay(DEFAULT_OPTIONS, overlay)
      return panelSettingsFrom(holder)
    },
  }
  await handleUltracodeCommand({ sessionID: "ses_parent", prompt: { text: "set concurrency 4" } }, deps)
  assert.equal(persisted?.concurrency, 4)
  assert.equal(holder.concurrency, 4)
  const ack = parseSettingsAckPayload(texts[0]!)
  assert.equal(ack?.overlay.concurrency, 4)
})

test("set missing value emits usage; unknown keys still ack", async () => {
  let holder = { ...DEFAULT_OPTIONS }
  const texts: string[] = []
  const deps: CommandDeps = {
    registry: new FakeRegistry(),
    supervisor: new MemorySupervisor(new FakeRegistry()),
    storage: new MemoryStorage(),
    say: async (_sid, t) => {
      texts.push(t)
    },
    projectRoot: "/project",
    personalWorkflowDir: "/home/u/.config/opencode/workflows",
    listAgents: async () => ({ ok: true, agents: [{ id: "general" }] }),
    defaultAgent: "general",
    nextRunSettings: () => panelSettingsFrom(holder),
    persistAndRefreshSettings: async (overlay) => {
      holder = applyOverlay(DEFAULT_OPTIONS, overlay)
      return panelSettingsFrom(holder)
    },
  }
  await handleUltracodeCommand({ sessionID: "ses_parent", prompt: { text: "set concurrency" } }, deps)
  assert.match(texts[0]!, /Usage: \/ultracode set <key> <value>/)
  texts.length = 0
  await handleUltracodeCommand({ sessionID: "ses_parent", prompt: { text: "set sizeGuideline 1" } }, deps)
  assert.equal(parseSettingsAckPayload(texts[0]!)?.overlay.concurrency, DEFAULT_OPTIONS.concurrency)
})

test("two-token save sets savedFromRunID", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_src", script: "return 99", name: "from-run" }))
  const { texts, storage } = await invoke("save run_src from-run", { registry })
  assert.match(texts[0]!, /Saved workflow `from-run`/)
  const saved = storage.workflows.get("from-run")
  assert.equal(saved?.manifest.savedFromRunID, "run_src")
  assert.equal(saved?.script, "return 99")
})

test("one-token save of a known run id routes to two-token usage", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_src", script: "return 1" }))
  const { texts, storage } = await invoke("save run_src", { registry })
  assert.match(texts[0]!, /Usage: \/ultracode save/)
  assert.match(texts[0]!, /\/ultracode save <runID> <name>/)
  assert.equal(storage.workflows.size, 0)
})

test("one-token save without runID omits savedFromRunID", async () => {
  const storage = new MemoryStorage()
  storage.fileScripts.set("plan-flow", "return 7")
  const { texts } = await invoke("save plan-flow", { storage })
  assert.match(texts[0]!, /Saved workflow `plan-flow`/)
  const saved = storage.workflows.get("plan-flow")
  assert.equal(saved?.script, "return 7")
  assert.equal(saved?.manifest.savedFromRunID, undefined)
  assert.equal("savedFromRunID" in (saved?.manifest ?? {}), false)
})

test("one-token save invalid names fail closed", async () => {
  const { texts } = await invoke("save UPPER")
  assert.match(texts[0]!, /error: could not save workflow/)
})

test("dashboard empty saved-workflows mentions one-token and two-token save", async () => {
  const { texts } = await invoke("")
  assert.match(texts[0]!, /\/ultracode save <name>/)
  assert.match(texts[0]!, /\/ultracode save <runID> <name>/)
})

// ---------------------------------------------------------------------------
// Orchestrator status enrichment + settle notice (v0.5.0 control plane)
// ---------------------------------------------------------------------------

import { buildResultChunk, enrichStatusPayload, formatSettleNotice } from "../src/command.ts"

const payloadOf = (run: RunRecord) => ({
  runID: run.id,
  status: run.status,
  agents: { done: 0, total: 0, failed: 0 },
  startedAt: run.startedAt,
})

test("enrichStatusPayload: running run carries identity, elapsed, children detail, no preview", () => {
  const run = baseRun({
    name: "panel-demo",
    agents: [
      { id: "a1", status: "succeeded", sessionID: "ses_a1", label: "first", phase: "scan" },
      { id: "a2", status: "running" },
    ],
  })
  const out = enrichStatusPayload(payloadOf(run), run, 3_000)
  assert.equal(out.name, "panel-demo")
  assert.equal(out.elapsedMs, 2_000)
  assert.deepEqual(out.children, [
    { agentID: "a1", status: "succeeded", sessionID: "ses_a1", label: "first", phase: "scan" },
    { agentID: "a2", status: "running" },
  ])
  assert.equal("resultPreview" in out, false)
})

test("enrichStatusPayload: settled run gets the FULL result inline when it fits the cap", () => {
  const small = baseRun({ status: "failed", endedAt: 2_000, result: { ok: 1 }, error: "boom" })
  const flat = enrichStatusPayload(payloadOf(small), small, 5_000)
  assert.deepEqual(flat.result, { ok: 1 })
  assert.equal(flat.resultPreview, undefined)
  assert.equal(flat.resultTruncated, false)
  assert.equal(flat.resultChars, '{"ok":1}'.length)
  assert.equal(flat.error, "boom")

  // 2–64 KB background results were previously invisible past 2000 chars.
  const medium = baseRun({ status: "succeeded", endedAt: 2_000, result: { blob: "x".repeat(5_000) } })
  const wide = enrichStatusPayload(payloadOf(medium), medium, 5_000)
  assert.deepEqual(wide.result, { blob: "x".repeat(5_000) })
  assert.equal(wide.resultTruncated, false)
})

test("enrichStatusPayload: oversized results get a bounded preview + recovery hint", () => {
  const big = { blob: "x".repeat(5_000) }
  const run = baseRun({
    status: "succeeded",
    endedAt: 2_000,
    result: big,
    resultTruncated: true,
    resultArtifactKey: "results/p1/run_x",
  })
  const out = enrichStatusPayload(payloadOf(run), run, 5_000, 100)
  assert.equal(out.result, undefined)
  assert.ok((out.resultPreview ?? "").length <= 2_000)
  assert.ok((out.resultPreview ?? "").startsWith('{"blob"'))
  assert.equal(out.resultTruncated, true)
  assert.ok(out.resultChars! > 2_000)
  assert.equal(out.resultArtifactKey, "results/p1/run_x")
  assert.match(out.resultHint ?? "", /ultracode_result/)
  assert.match(out.resultHint ?? "", /\/ultracode result run_x/)
  assert.equal(out.elapsedMs, 1_000)
})

test("enrichStatusPayload: legacy non-truncated flag with oversized result still previews (length decides)", () => {
  const legacy = baseRun({
    status: "succeeded",
    endedAt: 2_000,
    result: { blob: "x".repeat(5_000) },
    resultTruncated: false, // stale flag from the old artifact-key semantics
  })
  const out = enrichStatusPayload(payloadOf(legacy), legacy, 5_000, 100)
  assert.equal(out.result, undefined)
  assert.equal(out.resultTruncated, true)
  assert.ok(out.resultPreview !== undefined)
})

test("enrichStatusPayload: preview cap follows a small maxResultChars (no complete-but-truncated payloads)", () => {
  // Configured cap below the 2000-char default preview: a result between the
  // two must NOT ship its complete serialization while claiming truncated.
  const run = baseRun({ status: "succeeded", endedAt: 2_000, result: { blob: "x".repeat(1_800) } })
  const out = enrichStatusPayload(payloadOf(run), run, 5_000, 1_000)
  assert.equal(out.result, undefined)
  assert.equal(out.resultTruncated, true)
  assert.ok((out.resultPreview ?? "").length <= 1_000)
  assert.ok(out.resultChars! > 1_000)
})

test("enrichStatusPayload: missing record degrades to counts + empty children", () => {
  const out = enrichStatusPayload({ runID: "run_x", status: "running", agents: { done: 0, total: 0, failed: 0 }, startedAt: 1 }, undefined)
  assert.deepEqual(out.children, [])
  assert.equal(out.elapsedMs, 0)
})

test("formatSettleNotice: status, agents, brief result, detail pointer", () => {
  const line = formatSettleNotice({
    runID: "run_abc",
    status: "succeeded",
    durationMs: 10,
    agents: { total: 2, succeeded: 2, failed: 0, interrupted: 0 },
    truncated: false,
    result: { report: "ok" },
  })
  assert.match(line, /\[ultracode\] background run run_abc succeeded/)
  assert.match(line, /agents 2\/2/)
  assert.match(line, /result: \{"report":"ok"\}/)
  assert.match(line, /ultracode_status/)
})

test("formatSettleNotice: truncated result points at the recovery paths", () => {
  const line = formatSettleNotice({
    runID: "run_abc",
    status: "succeeded",
    durationMs: 10,
    agents: { total: 2, succeeded: 2, failed: 0, interrupted: 0 },
    truncated: true,
    preview: '{"firstKey":"valueThatIsLongEnoughToBeCut","more"',
    resultChars: 90_000,
  })
  assert.match(line, /result truncated \(90000 chars\)/)
  assert.match(line, /full result: ultracode_result \{ runID: "run_abc", offset, maxLength \}/)
  assert.match(line, /\/ultracode result run_abc/)
  assert.match(line, /detail: ultracode_status \/ ctrl\+g/)
})

test("formatSettleNotice: failed run surfaces the error; long results are capped", () => {
  const line = formatSettleNotice({
    runID: "run_bad",
    status: "failed",
    durationMs: 10,
    agents: { total: 3, succeeded: 0, failed: 3, interrupted: 0 },
    truncated: true,
    preview: "y".repeat(900),
    error: "worker exploded",
  })
  assert.match(line, /failed/)
  assert.match(line, /error: worker exploded/)
  assert.ok(line.length < 700, "notice stays one bounded line")
})

test("PLUGIN_VERSION stays in sync with package.json (drift guard)", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
  assert.equal(PLUGIN_VERSION, pkg.version)
})

test("enrichStatusPayload caps the children list and reports the overflow", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `a${i + 1}`, status: "succeeded" as const }))
  const run = baseRun({ agents: many })
  const out = enrichStatusPayload(payloadOf(run), run)
  assert.equal(out.children.length, 50)
  assert.equal(out.childrenTruncated, true)
  assert.equal(out.childrenOmitted, 10)
})

test("formatSettleNotice surfaces the stop reason (control plane / timeout stops)", () => {
  const line = formatSettleNotice({
    runID: "run_stopped",
    status: "stopped",
    durationMs: 10,
    agents: { total: 4, succeeded: 2, failed: 0, interrupted: 2 },
    truncated: true,
    stopReason: "orchestrator stop via ultracode_control",
  })
  assert.match(line, /reason: orchestrator stop via ultracode_control/)
})

// ---------------------------------------------------------------------------
// buildResultChunk (ultracode_result paging)
// ---------------------------------------------------------------------------

test("buildResultChunk: prefers the artifact, pages with nextOffset until complete", () => {
  const value = { report: "z".repeat(100) }
  const compact = JSON.stringify(value)
  const run = baseRun({
    status: "succeeded",
    result: value,
    resultTruncated: true,
    resultArtifactKey: "results/p1/run_x",
  })
  const first = buildResultChunk(run, value, { offset: 0, maxLength: 50 })
  assert.ok(first.ok)
  assert.equal(first.view.source, "artifact")
  assert.equal(first.view.totalChars, compact.length)
  assert.equal(first.view.offset, 0)
  assert.equal(first.view.chunk, compact.slice(0, 50))
  assert.equal(first.view.complete, false)
  assert.equal(first.view.nextOffset, 50)
  assert.equal(first.view.resultArtifactKey, "results/p1/run_x")

  const second = buildResultChunk(run, value, { offset: first.view.nextOffset!, maxLength: 50 })
  assert.ok(second.ok)
  assert.equal(second.view.offset, 50)
  // Walking nextOffset to the end reassembles the exact serialization.
  let acc = first.view.chunk
  let cursor = second
  let guard = 0
  while (cursor.ok && !cursor.view.complete && guard++ < 100) {
    acc += cursor.view.chunk
    const next = buildResultChunk(run, value, { offset: cursor.view.nextOffset!, maxLength: 50 })
    if (!next.ok) break
    cursor = next
  }
  assert.ok(cursor.ok && cursor.view.complete)
  acc += cursor.view.chunk
  assert.equal(acc, compact)
})

test("buildResultChunk: falls back to the run record when no artifact exists", () => {
  const run = baseRun({ status: "succeeded", result: { a: 1 }, resultTruncated: true })
  const out = buildResultChunk(run, undefined, {})
  assert.ok(out.ok)
  assert.equal(out.view.source, "record")
  assert.equal(out.view.chunk, '{"a":1}')
  assert.equal(out.view.complete, true)
  assert.equal(out.view.nextOffset, null)
})

test("buildResultChunk: no result is a typed error; past-the-end offset clamps", () => {
  const empty = baseRun({ status: "failed", error: "boom" })
  const err = buildResultChunk(empty, undefined, {})
  assert.ok(!err.ok)
  assert.match(err.error, /has no result/)

  const run = baseRun({ status: "succeeded", result: { a: 1 } })
  const beyond = buildResultChunk(run, undefined, { offset: 999, maxLength: 10 })
  assert.ok(beyond.ok)
  assert.equal(beyond.view.chunk, "")
  assert.equal(beyond.view.complete, true)
})

test("buildResultChunk: pair-splitting offsets are adjusted back one code unit", () => {
  const value = { faces: "😀😀😀😀😀" } // 2 code units per emoji in the serialization
  const compact = JSON.stringify(value)
  // Find an offset that splits a surrogate pair inside the string body.
  const facesStart = compact.indexOf("😀")
  const splitOffset = facesStart + 1 // between high and low surrogate
  const run = baseRun({ status: "succeeded", result: value })
  const out = buildResultChunk(run, undefined, { offset: splitOffset, maxLength: 20 })
  assert.ok(out.ok)
  assert.equal(out.view.offset, splitOffset - 1)
  assert.equal(compact.slice(out.view.offset, out.view.offset + out.view.chunk.length), out.view.chunk)
})

test("buildResultChunk: progress invariant — every incomplete page advances (review regression)", () => {
  const value = { faces: "😀😀😀😀😀😀😀😀", tail: "x" }
  const compact = JSON.stringify(value)
  const run = baseRun({ status: "succeeded", result: value })
  // maxLength:1 (below the floor) clamps to 2; every walk must terminate and
  // reassemble exactly — the degenerate case where a lone-unit page used to
  // return chunk:"" and a nextOffset that never advanced (client hang).
  for (const maxLength of [1, 2, 3]) {
    let offset = 0
    let acc = ""
    let steps = 0
    for (;;) {
      const page = buildResultChunk(run, undefined, { offset, maxLength })
      assert.ok(page.ok)
      const view = page.view
      if (!view.complete) {
        assert.ok(view.chunk.length > 0, `maxLength=${maxLength}: zero-progress page at offset ${offset}`)
        assert.notEqual(view.nextOffset, null)
        assert.ok(view.nextOffset! > offset || (view.nextOffset === offset && view.chunk.length > 0))
      }
      assert.equal(compact.slice(view.offset, view.offset + view.chunk.length), view.chunk)
      acc = compact.slice(0, view.offset) + view.chunk + compact.slice(view.offset + view.chunk.length)
      if (view.complete || ++steps > 500) break
      offset = view.nextOffset!
    }
    assert.ok(steps <= 500, `maxLength=${maxLength}: walk did not terminate`)
    assert.equal(acc, compact)
  }
})

// ---------------------------------------------------------------------------
// /ultracode result — artifact first, run-record fallback
// ---------------------------------------------------------------------------

test("/ultracode result: prints from the artifact when present", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({
    id: "run_done",
    status: "succeeded",
    result: { big: "x".repeat(80_000) },
    resultTruncated: true,
    resultArtifactKey: "results/p1/run_done",
  }))
  const storage = new MemoryStorage()
  storage.artifacts.set("results/p1/run_done", { big: "x".repeat(80_000) })
  const { texts } = await invoke("result run_done", { registry, storage })
  assert.match(texts[0]!, /## Full result — `run_done` \(from artifact\)/)
})

test("/ultracode result: falls back to the run record when the artifact is missing", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({
    id: "run_done",
    status: "succeeded",
    result: { big: "y".repeat(80_000) },
    resultTruncated: true,
    resultArtifactKey: "results/p1/run_done", // claimed but never persisted
  }))
  const { texts } = await invoke("result run_done", { registry, storage: new MemoryStorage() })
  assert.match(texts[0]!, /## Full result — `run_done` \(from run record\)/)
})

test("/ultracode result: honest messages for no-result runs", async () => {
  const registry = new FakeRegistry()
  seed(registry, baseRun({ id: "run_failed", status: "failed", error: "kaboom" }))
  const failed = await invoke("result run_failed", { registry })
  assert.match(failed.texts[0]!, /produced no result \(status: failed — kaboom\)/)

  const registry2 = new FakeRegistry()
  seed(registry2, baseRun({ id: "run_done", status: "succeeded", result: { ok: 1 } }))
  const ok = await invoke("result run_done", { registry: registry2 })
  assert.match(ok.texts[0]!, /"ok": 1/) // fits — printed directly, background or not
})
