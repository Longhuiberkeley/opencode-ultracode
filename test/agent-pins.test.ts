/**
 * Agent model-pin resolution: frontmatter parsing, project-beats-global
 * lookup, AgentRunner pass-through, and driver create-time application.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { lookupAgentPin, parseAgentFrontmatterModel, parseModelPin } from "../src/agent-pins.ts"
import { AgentRunner } from "../src/primitives.ts"
import { createSessionDriver } from "../src/sessions.ts"
import type { AgentRunHooks, AgentRunInput, SessionDriver } from "../src/sessions.ts"
import type { FsLike, SessionCtx } from "../src/types.ts"
import { FakeRegistry } from "./fakes.ts"

// ---------------------------------------------------------------------------
// Fake fs
// ---------------------------------------------------------------------------

function fakeFs(files: Record<string, string>): FsLike {
  return {
    mkdir: async () => {},
    writeFile: async () => {},
    readFile: async (path) => {
      const hit = files[path]
      if (hit === undefined) throw new Error("ENOENT")
      return hit
    },
    exists: async (path) => path in files,
    readdir: async () => Object.keys(files),
    realpath: async (path) => path,
    lstat: async () => undefined,
  }
}

// ---------------------------------------------------------------------------
// parseAgentFrontmatterModel
// ---------------------------------------------------------------------------

test("parseAgentFrontmatterModel: reads model with effort suffix", () => {
  const md = `---
description: "x"
mode: subagent
model: xai/grok-4.6#medium
---
body`
  assert.equal(parseAgentFrontmatterModel(md), "xai/grok-4.6#medium")
})

test("parseAgentFrontmatterModel: no frontmatter or no model key -> undefined", () => {
  assert.equal(parseAgentFrontmatterModel("just body"), undefined)
  assert.equal(parseAgentFrontmatterModel("---\nmode: subagent\n---\nbody"), undefined)
})

// ---------------------------------------------------------------------------
// parseModelPin
// ---------------------------------------------------------------------------

test("parseModelPin: provider/id and provider/id#variant forms", () => {
  assert.deepEqual(parseModelPin("xai/grok-4.6#medium"), { providerID: "xai", id: "grok-4.6", variant: "medium" })
  assert.deepEqual(parseModelPin("zai-coding-plan/glm-5.3-flash#max"), {
    providerID: "zai-coding-plan",
    id: "glm-5.3-flash",
    variant: "max",
  })
  assert.deepEqual(parseModelPin("openrouter/mistral-8b"), { providerID: "openrouter", id: "mistral-8b" })
  assert.equal(parseModelPin("no-slash"), undefined)
  assert.equal(parseModelPin(""), undefined)
})

// ---------------------------------------------------------------------------
// lookupAgentPin
// ---------------------------------------------------------------------------

const HOME = "/home/tester"
const ROOT = "/proj"

test("lookupAgentPin: project pin beats global; global used otherwise", async () => {
  const fs = fakeFs({
    [`${HOME}/.config/opencode/agents/explore.md`]: "---\nmodel: zai-coding-plan/glm-5.3-flash#max\n---\n",
    [`${ROOT}/.opencode/agents/explore.md`]: "---\nmodel: xai/grok-4.6\n---\n",
    [`${HOME}/.config/opencode/agents/general.md`]: "---\nmodel: xai/grok-4.6#medium\n---\n",
  })
  assert.equal(await lookupAgentPin(fs, ROOT, HOME, "explore"), "xai/grok-4.6")
  assert.equal(await lookupAgentPin(fs, ROOT, HOME, "general"), "xai/grok-4.6#medium")
  assert.equal(await lookupAgentPin(fs, ROOT, HOME, "reviewer"), undefined)
})

test("lookupAgentPin: odd agent ids never reach the filesystem", async () => {
  const fs = fakeFs({})
  assert.equal(await lookupAgentPin(fs, ROOT, HOME, "../escape"), undefined)
  assert.equal(await lookupAgentPin(fs, ROOT, HOME, ""), undefined)
})

// ---------------------------------------------------------------------------
// AgentRunner pass-through
// ---------------------------------------------------------------------------

test("AgentRunner: pinForAgent model rides into the driver input", async () => {
  const registry = new FakeRegistry()
  const run = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  const inputs: AgentRunInput[] = []
  const driver: SessionDriver = {
    runAgent: async (input) => {
      inputs.push(input)
      return { text: "ok", sessionID: "ses_c", agent: "explore", model: null, tokens: undefined }
    },
  }
  const runner = new AgentRunner({
    driver,
    registry,
    runID: run.id,
    defaultAgent: "general",
    availableAgents: ["general", "explore"],
    concurrency: 8,
    maxAgents: 200,
    report: () => {},
    ambientPhase: () => undefined,
    pinForAgent: async (id) =>
      id === "explore"
        ? { providerID: "zai-coding-plan", id: "glm-5.3-flash", variant: "max" }
        : id === "general"
          ? { providerID: "xai", id: "grok-4.6", variant: "medium" }
          : undefined,
  })
  await runner.call("hi", { agent: "explore" })
  await runner.call("hi")
  assert.deepEqual(inputs[0]!.model, { providerID: "zai-coding-plan", id: "glm-5.3-flash", variant: "max" })
  assert.deepEqual(inputs[1]!.model, { providerID: "xai", id: "grok-4.6", variant: "medium" })
})

test("AgentRunner: no pin -> no model field; failing resolver never breaks the call", async () => {
  const registry = new FakeRegistry()
  const run = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  const inputs: AgentRunInput[] = []
  const driver: SessionDriver = {
    runAgent: async (input) => {
      inputs.push(input)
      return { text: "ok", sessionID: "ses_c", agent: "general", model: null, tokens: undefined }
    },
  }
  const runner = new AgentRunner({
    driver,
    registry,
    runID: run.id,
    defaultAgent: "general",
    availableAgents: ["general"],
    concurrency: 8,
    maxAgents: 200,
    report: () => {},
    ambientPhase: () => undefined,
    pinForAgent: async () => {
      throw new Error("disk exploded")
    },
  })
  const result = await runner.call("hi")
  assert.equal(result.text, "ok")
  assert.equal(inputs[0]!.model, undefined)
})

// ---------------------------------------------------------------------------
// Driver create-time application
// ---------------------------------------------------------------------------

test("session driver: pinned model is passed to session.create; omitted when absent", async () => {
  const creates: Array<Record<string, unknown>> = []
  const noop = async () => {}
  const sessions: SessionCtx = {
    create: async (input) => {
      creates.push({ ...input })
      return { id: "ses_child" }
    },
    get: async () => ({ id: "ses_child", outcome: "succeeded" }),
    prompt: async () => ({ id: "msg_1" }),
    wait: async () => {},
    context: async () => [{ id: "msg_1", type: "assistant", text: "ok" }],
    interrupt: async () => {},
  }
  const driver = createSessionDriver(sessions)
  const hooks: AgentRunHooks = { onSessionID: () => {}, signal: new AbortController().signal }
  await driver.runAgent(
    { prompt: "p", agent: "explore", model: { providerID: "xai", id: "grok-4.6", variant: "medium" }, defaultAgent: "general" },
    ["explore"],
    hooks,
  )
  await driver.runAgent({ prompt: "p", defaultAgent: "general" }, ["general"], hooks)
  assert.deepEqual(creates[0]!.model, { providerID: "xai", id: "grok-4.6", variant: "medium" })
  assert.equal("model" in (creates[1] as object), false)
})
