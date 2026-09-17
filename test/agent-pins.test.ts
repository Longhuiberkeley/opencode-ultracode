/**
 * Agent model-pin resolution: frontmatter parsing, project-beats-global
 * lookup, AgentRunner pass-through, and driver create-time application.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  agentConfigured,
  agentUsable,
  lookupAgentPin,
  parseAgentFrontmatterDisabled,
  parseAgentFrontmatterModel,
  parseModelPin,
  readDisabledProviders,
} from "../src/agent-pins.ts"
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
// agentConfigured (agentScope: "configured")
// ---------------------------------------------------------------------------

test("agentConfigured: true only with a definition file, project or global", async () => {
  const fs = fakeFs({
    [`${HOME}/.config/opencode/agents/general.md`]: "---\nmodel: xai/grok-4.6#high\n---\n",
    [`${ROOT}/.opencode/agents/local.md`]: "---\ndescription: x\n---\n",
  })
  assert.equal(await agentConfigured(fs, ROOT, HOME, "general"), true)
  assert.equal(await agentConfigured(fs, ROOT, HOME, "local"), true)
  // Shipped, file-less agents (build) are NOT configured.
  assert.equal(await agentConfigured(fs, ROOT, HOME, "build"), false)
  assert.equal(await agentConfigured(fs, ROOT, HOME, "../escape"), false)
  assert.equal(await agentConfigured(fs, ROOT, HOME, ""), false)
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

test("AgentRunner: no pin anywhere -> no model field; failing resolver never breaks the call", async () => {
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

test("AgentRunner: unpinned requested agent inherits the default agent's pin", async () => {
  const registry = new FakeRegistry()
  const run = registry.create({ parentSessionID: "ses_p", script: "return 1" })
  const inputs: AgentRunInput[] = []
  const driver: SessionDriver = {
    runAgent: async (input) => {
      inputs.push(input)
      return { text: "ok", sessionID: "ses_c", agent: "build", model: null, tokens: undefined }
    },
  }
  const runner = new AgentRunner({
    driver,
    registry,
    runID: run.id,
    defaultAgent: "general",
    availableAgents: ["general", "build"],
    concurrency: 8,
    maxAgents: 200,
    report: () => {},
    ambientPhase: () => undefined,
    pinForAgent: async (id) =>
      id === "general" ? { providerID: "xai", id: "grok-4.6", variant: "high" } : undefined,
  })
  await runner.call("hi", { agent: "build" })
  assert.deepEqual(inputs[0]!.model, { providerID: "xai", id: "grok-4.6", variant: "high" })
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

// ---------------------------------------------------------------------------
// Disabled agents + offline providers (v0.12 subagent-config respect)
// ---------------------------------------------------------------------------

test("parseAgentFrontmatterDisabled: true (quoted/unquoted/case), false/absent", () => {
  const mk = (v: string) => `---\nmodel: xai/m\n${v}\n---\nbody`
  assert.equal(parseAgentFrontmatterDisabled(mk("disabled: true")), true)
  assert.equal(parseAgentFrontmatterDisabled(mk("disabled: TRUE")), true)
  assert.equal(parseAgentFrontmatterDisabled(mk('disabled: "true"')), true)
  assert.equal(parseAgentFrontmatterDisabled(mk("disabled: false")), false)
  assert.equal(parseAgentFrontmatterDisabled(mk("enabled: true")), false)
  assert.equal(parseAgentFrontmatterDisabled("---\n---\nbody"), false)
  assert.equal(parseAgentFrontmatterDisabled("no frontmatter"), false)
})

test("lookupAgentPin: disabled agent yields undefined; project-disabled blocks global", async () => {
  const fs = fakeFs({
    "/p/.opencode/agents/off.md": "---\nmodel: xai/a\ndisabled: true\n---\n",
    "/h/.config/opencode/agents/off.md": "---\nmodel: xai/b\n---\n",
    "/h/.config/opencode/agents/on.md": "---\nmodel: xai/c\n---\n",
  })
  assert.equal(await lookupAgentPin(fs, "/p", "/h", "off"), undefined)
  assert.equal(await lookupAgentPin(fs, "/p", "/h", "on"), "xai/c")
})

test("agentConfigured: disabled file does not count as configured", async () => {
  const fs = fakeFs({
    "/h/.config/opencode/agents/dis.md": "---\nmodel: xai/a\ndisabled: true\n---\n",
    "/h/.config/opencode/agents/en.md": "---\nmodel: xai/b\n---\n",
  })
  assert.equal(await agentConfigured(fs, "/p", "/h", "dis"), false)
  assert.equal(await agentConfigured(fs, "/p", "/h", "en"), true)
})

test("readDisabledProviders: union of global and project config; malformed contributes nothing", async () => {
  const fs = fakeFs({
    "/h/.config/opencode/opencode.json": JSON.stringify({ disabled_providers: ["anthropic"] }),
    "/p/opencode.json": JSON.stringify({ disabled_providers: ["neuralwatt", "anthropic", 42] }),
    "/p/.opencode/opencode.json": "{ not json",
  })
  const set = await readDisabledProviders(fs, "/p", "/h")
  assert.equal(set.has("anthropic"), true)
  assert.equal(set.has("neuralwatt"), true)
  assert.equal(set.size, 2)
  assert.equal((await readDisabledProviders(fakeFs({}), "/p", "/h")).size, 0)
})

test("agentUsable: configured + not disabled + pin provider not offline", async () => {
  const fs = fakeFs({
    "/h/.config/opencode/agents/ok.md": "---\nmodel: xai/a\n---\n",
    "/h/.config/opencode/agents/off-provider.md": "---\nmodel: deepseek/b\n---\n",
    "/h/.config/opencode/agents/unpinned.md": "---\ndescription: x\n---\n",
    "/h/.config/opencode/agents/dis.md": "---\nmodel: xai/a\ndisabled: true\n---\n",
  })
  const disabled = new Set(["deepseek"])
  assert.equal(await agentUsable(fs, "/p", "/h", "ok", disabled), true)
  assert.equal(await agentUsable(fs, "/p", "/h", "unpinned", disabled), true)
  assert.equal(await agentUsable(fs, "/p", "/h", "off-provider", disabled), false)
  assert.equal(await agentUsable(fs, "/p", "/h", "dis", disabled), false)
  assert.equal(await agentUsable(fs, "/p", "/h", "missing", disabled), false)
})

test("agentConfigured: unreadable project file falls through to the global check", async () => {
  const fs = {
    ...fakeFs({}),
    exists: async (path: string) =>
      path === "/p/.opencode/agents/broken.md" ||
      path === "/h/.config/opencode/agents/broken.md" ||
      path === "/h/.config/opencode/agents/fallback.md",
    readFile: async (path: string) => {
      if (path === "/p/.opencode/agents/broken.md") throw new Error("EACCES")
      return "---\nmodel: xai/a\n---\n"
    },
  } as unknown as import("../src/types.ts").FsLike
  assert.equal(await agentConfigured(fs, "/p", "/h", "broken"), true, "global file answers when the project file is unreadable")
  assert.equal(await agentConfigured(fs, "/p", "/h", "fallback"), true)
  assert.equal(await agentConfigured(fs, "/p", "/h", "absent"), false)
})
