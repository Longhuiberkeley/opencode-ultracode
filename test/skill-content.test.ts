/**
 * Builder C tests: skill content coverage + sample workflow integrity.
 *
 * Checks that the authoring skill teaches every injected global (and nothing
 * model-shaped), and that the shipped sample workflows parse as async bodies,
 * avoid module syntax, route only via stock agents, carry valid manifests, and
 * actually execute end-to-end against fake agent responses.
 *
 * Run: node --experimental-strip-types --test test/skill-content.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

import { SKILL_NAME, SKILL_DESCRIPTION, SKILL_CONTENT } from "../src/skill-content.ts"

const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "samples")

const SAMPLE_NAMES = ["deep-research", "code-audit", "fact-check"] as const
const STOCK_AGENTS = new Set(["general", "explore"])

function readSample(name: string, ext: "js" | "json"): string {
  return readFileSync(path.join(samplesDir, `${name}.${ext}`), "utf8")
}

// ---------------------------------------------------------------------------
// Skill metadata + content coverage
// ---------------------------------------------------------------------------

test("skill metadata: name and one-sentence trigger description", () => {
  assert.equal(SKILL_NAME, "Ultracode")
  assert.ok(typeof SKILL_DESCRIPTION === "string" && SKILL_DESCRIPTION.length > 80)
  assert.match(SKILL_DESCRIPTION, /ultracode/i)
  assert.match(SKILL_DESCRIPTION, /workflow/i)
  // one sentence: no sentence-terminator followed by more text
  assert.equal(SKILL_DESCRIPTION.split(/(?<=[.!?])\s+[A-Z]/).length, 1)
})

test("skill content covers every injected global", () => {
  const lines = SKILL_CONTENT.split("\n")
  assert.ok(
    lines.length >= 120 && lines.length <= 320,
    `expected a lean 120-320 line skill, got ${lines.length}`,
  )
  for (const name of ["agent", "parallel", "pipeline", "phase", "progress", "workflow", "sleep", "args", "meta", "console"]) {
    assert.match(SKILL_CONTENT, new RegExp(`\\b${name}\\b`), `SKILL_CONTENT must mention the global \`${name}\``)
  }
})

test("skill content teaches routing + preflight + structure knobs", () => {
  assert.ok(SKILL_CONTENT.includes("meta.requires"), "must explain meta.requires preflight")
  assert.ok(SKILL_CONTENT.includes("opts.agent"), "must explain opts.agent routing")
  assert.ok(SKILL_CONTENT.includes("opts.phase"), "must explain explicit opts.phase")
  assert.ok(SKILL_CONTENT.includes("opts.schema"), "must explain opts.schema structured output")
})

test("skill content contains no provider or model ids", () => {
  const modelRef = SKILL_CONTENT.match(/[a-z-]+\/[a-z0-9.:-]+/)
  assert.equal(modelRef, null, `provider/model-looking ref in skill: ${modelRef?.[0]}`)
  assert.doesNotMatch(SKILL_CONTENT, /\b(opus|sonnet)\b|\b(gpt|claude)-/i, "model family name in skill")
})

test("skill content teaches coexistence with domain skills", () => {
  assert.ok(SKILL_CONTENT.includes("execution mechanism"), "must position the skill as mechanism-only")
  assert.ok(SKILL_CONTENT.includes("ONE orchestration mechanism"), "must forbid double fan-out")
  assert.match(SKILL_CONTENT, /do NOT inherit/i, "children must not be assumed to inherit skills")
})

test("skill content names the ultracode_run tool and start-of-prompt trigger examples", () => {
  assert.ok(SKILL_CONTENT.includes("ultracode_run"), "tool is invoked as ultracode_run")
  assert.doesNotMatch(SKILL_CONTENT, /`workflow` tool/, "stale tool name")
  assert.match(SKILL_CONTENT, /starts with ultracode/, "trigger is start-of-prompt only")
  assert.ok(SKILL_CONTENT.includes("ultracode: audit the auth module"), "start-of-prompt example")
})

test("static skill file skills/ultracode.md mirrors SKILL_CONTENT exactly", () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
  const file = readFileSync(path.join(repoRoot, "skills", "ultracode.md"), "utf8")
  assert.equal(file, SKILL_CONTENT, "skills/ultracode.md is the registered skill location — keep it in sync")
})

// ---------------------------------------------------------------------------
// Sample scripts: syntax, module-free, stock agents only
// ---------------------------------------------------------------------------

for (const name of SAMPLE_NAMES) {
  test(`sample ${name}.js parses as an async function body`, () => {
    const src = readSample(name, "js")
    assert.doesNotThrow(() => {
      // same wrapping the runtime uses: plain JS async body, no module scope
      new Function('"use strict"; return (async () => {\n' + src + "\n});")
    })
  })

  test(`sample ${name}.js contains no module syntax tokens`, () => {
    assert.doesNotMatch(readSample(name, "js"), /\b(import|export|require)\b/)
  })

  test(`sample ${name}.js routes only via stock agents and no model ids`, () => {
    const src = readSample(name, "js")
    const used = [...src.matchAll(/agent:\s*"([a-z0-9][a-z0-9_-]*)"/g)].map((m) => m[1])
    assert.ok(used.length > 0, "sample must pass explicit agent ids to agent()")
    for (const id of used) {
      assert.ok(STOCK_AGENTS.has(id), `sample references non-stock agent id: ${id}`)
    }
    const modelRef = src.match(/[a-z-]+\/[a-z0-9.:-]+/)
    assert.equal(modelRef, null, `provider/model-looking ref in sample: ${modelRef?.[0]}`)
    assert.doesNotMatch(src, /\b(opus|sonnet)\b|\b(gpt|claude)-/i)
  })
}

// ---------------------------------------------------------------------------
// Sample manifests: SavedWorkflowManifest shape (samples ship hash: "")
// ---------------------------------------------------------------------------

const MANIFEST_KEYS = new Set([
  "version",
  "name",
  "description",
  "phases",
  "requires",
  "hash",
  "source",
  "savedAt",
  "savedFromRunID",
])

for (const name of SAMPLE_NAMES) {
  test(`sample ${name}.json is a valid SavedWorkflowManifest`, () => {
    const manifest = JSON.parse(readSample(name, "json")) as Record<string, unknown>
    for (const key of Object.keys(manifest)) {
      assert.ok(MANIFEST_KEYS.has(key), `unknown manifest key: ${key}`)
    }
    assert.equal(manifest.version, 1)
    assert.equal(manifest.name, name)
    assert.match(String(manifest.name), /^[a-z0-9][a-z0-9-_]{0,63}$/)
    assert.equal(typeof manifest.description, "string")
    assert.ok((manifest.description as string).length > 10)
    const phases = manifest.phases as unknown[]
    assert.ok(Array.isArray(phases) && phases.length > 0)
    for (const p of phases) assert.equal(typeof p, "string")
    const requires = manifest.requires as unknown[]
    assert.ok(Array.isArray(requires))
    for (const a of requires) assert.ok(STOCK_AGENTS.has(String(a)), `non-stock agent in requires: ${String(a)}`)
    assert.equal(manifest.hash, "", "samples ship an empty hash (loader tolerates it)")
    assert.equal(manifest.source, "project")
    assert.equal(manifest.savedAt, 0)
    // the manifest must describe the script it ships with
    const src = readSample(name, "js")
    for (const p of phases as string[]) {
      assert.ok(src.includes(`"${p}"`), `script never references phase "${p}"`)
    }
  })
}

// ---------------------------------------------------------------------------
// Execution smoke tests: run each sample against fake agent responses
// ---------------------------------------------------------------------------

interface FakeAgentResult {
  text: string
  data?: unknown
}
type FakeAgent = (prompt: string, opts: Record<string, unknown>) => Promise<FakeAgentResult>

interface Harness {
  calls: Array<{ prompt: string; opts: Record<string, unknown> }>
  phases: string[]
  logs: string[]
  run(src: string, argsValue: unknown): Promise<unknown>
}

/**
 * Mirrors the worker's injected globals (src/worker-script.ts semantics):
 * parallel swallows thunk failures as null, pipeline isolates item failures.
 */
function makeHarness(agentFn: FakeAgent): Harness {
  const calls: Array<{ prompt: string; opts: Record<string, unknown> }> = []
  const phases: string[] = []
  const logs: string[] = []
  const agent = async (prompt: string, opts: Record<string, unknown> = {}): Promise<FakeAgentResult> => {
    assert.equal(typeof prompt, "string")
    assert.ok(prompt.length > 20, "prompts must be self-contained, not bare fragments")
    calls.push({ prompt, opts })
    return agentFn(prompt, opts)
  }
  const parallel = (thunks: ReadonlyArray<() => unknown>): Promise<Array<unknown>> =>
    Promise.all(thunks.map((t) => Promise.resolve().then(() => t()).catch(() => null)))
  const pipeline = async (
    items: readonly unknown[],
    ...stages: Array<(item: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    const out: unknown[] = []
    for (let i = 0; i < items.length; i++) {
      let value: unknown = items[i]
      try {
        for (const stage of stages) value = await stage(value, i)
        out.push(value)
      } catch {
        out.push(null)
      }
    }
    return out
  }
  const phase = (name: string): void => {
    phases.push(name)
  }
  const progress = (text: string): void => {
    logs.push(text)
  }
  const workflow = async (name: string): Promise<never> => {
    throw new Error(`composition not under test here: ${name}`)
  }
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)))
  const run = (src: string, argsValue: unknown): Promise<unknown> => {
    const fn = new Function(
      "agent",
      "parallel",
      "pipeline",
      "phase",
      "progress",
      "workflow",
      "sleep",
      "console",
      "args",
      "meta",
      '"use strict"; return (async () => {\n' + src + "\n});",
    ) as (...xs: unknown[]) => () => Promise<unknown>
    const runner = fn(agent, parallel, pipeline, phase, progress, workflow, sleep, { log() {} }, argsValue, {
      name: "test",
    })
    return runner()
  }
  return { calls, phases, logs, run }
}

function stat(result: unknown, key: string): unknown {
  const stats = (result as { stats?: Record<string, unknown> }).stats
  assert.ok(stats, "result must carry a stats object")
  return stats[key]
}

/** Extract the first "claim" value after a "Claims JSON:" marker (canned data has no escaped quotes). */
function firstClaimAfter(prompt: string, marker: string): string | undefined {
  const idx = prompt.indexOf(marker)
  if (idx < 0) return undefined
  const m = /"claim":\s*"([^"]+)"/.exec(prompt.slice(idx))
  return m?.[1]
}

test("deep-research sample executes end to end (dedupe, verify, skeptic)", async () => {
  let verifyCalls = 0
  const h = makeHarness(async (prompt, opts) => {
    switch (String(opts.phase)) {
      case "research":
        return {
          text: "",
          data: {
            findings:
              String(opts.label) === "research:technical"
                ? [
                    { claim: "Claim A shared", source_hint: "spec", confidence: 0.9 },
                    { claim: "Claim B", source_hint: "spec", confidence: 0.7 },
                  ]
                : [
                    { claim: "claim a shared", source_hint: "paper", confidence: 0.8 }, // dupe of A
                    { claim: "Claim C", source_hint: "paper", confidence: 0.6 },
                  ],
          },
        }
      case "verify": {
        const verdict = ["supported", "unverifiable", "refuted"][verifyCalls++ % 3]
        return { text: "", data: { claim: "irrelevant", verdict, evidence: `evidence ${verdict}` } }
      }
      case "skeptic": {
        const claim = firstClaimAfter(prompt, "Claims JSON:")
        return { text: "", data: { overturned: claim ? [{ claim, reason: "single weak source" }] : [] } }
      }
      case "synthesize":
        return { text: "MOCK REPORT: the topic, verified." }
      default:
        throw new Error(`unexpected phase ${String(opts.phase)}`)
    }
  })
  const result = (await h.run(readSample("deep-research", "js"), { topic: "quantum error correction" })) as {
    report: string
  }
  assert.equal(result.report, "MOCK REPORT: the topic, verified.")
  assert.equal(stat(result, "claimsFound"), 3, "duplicate claim across angles collapses")
  assert.equal(stat(result, "supported"), 1, "highest-confidence claim verified first -> supported")
  assert.equal(stat(result, "overturned"), 1, "skeptic overturns the survivor")
  assert.equal(stat(result, "kept"), 0)
  assert.equal(h.calls.length, 8, "3 research + 3 verify + 1 skeptic + 1 synthesize")
  for (const c of h.calls) assert.equal(typeof c.opts.phase, "string", "every call pins an explicit phase")
  for (const p of ["research", "verify", "skeptic", "synthesize"]) assert.ok(h.phases.includes(p))
})

test("deep-research sample fails fast on missing topic", async () => {
  const h = makeHarness(async () => ({ text: "" }))
  await assert.rejects(() => h.run(readSample("deep-research", "js"), {}), /args\.topic/)
  assert.equal(h.calls.length, 0, "no agent spawns before validation")
})

test("code-audit sample executes end to end (dedupe, batch review, severity sort)", async () => {
  let scanCalls = 0
  const h = makeHarness(async (_prompt, opts) => {
    if (String(opts.phase) === "scan") {
      scanCalls++
      return scanCalls === 1
        ? {
            text: "",
            data: {
              findings: [
                { file: "src/auth.ts", line_hint: "12", severity: "high", issue: "Off-by-one in retry loop", suggestion: "use <= attempts" },
                { file: "src/auth.ts", line_hint: "12", severity: "high", issue: "off-by-one in retry loop", suggestion: "duplicate" },
                { file: "src/db.ts", severity: "critical", issue: "SQL string concatenation", suggestion: "parameterize" },
              ],
            },
          }
        : { text: "", data: { findings: [] } }
    }
    if (String(opts.phase) === "review") {
      return { text: "", data: { kept: [0], rejected: [{ index: 1, reason: "not reproducible as written" }] } }
    }
    throw new Error(`unexpected phase ${String(opts.phase)}`)
  })
  const result = (await h.run(readSample("code-audit", "js"), { modules: ["src/auth", "src/db"] })) as {
    findings: Array<{ file: string; severity: string }>
    unverified: unknown[]
  }
  assert.equal(stat(result, "raw"), 2, "case-insensitive dup collapses")
  assert.equal(stat(result, "kept"), 1)
  assert.equal(stat(result, "rejected"), 1)
  assert.equal(stat(result, "unverified"), 0, "happy path: nothing unverified")
  assert.deepEqual(result.unverified, [])
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].file, "src/auth.ts")
  assert.equal(result.findings[0].severity, "high")
})

test("code-audit marks reviewer-failed batches as unverified instead of promoting them", async () => {
  const h = makeHarness(async (_prompt, opts) => {
    if (String(opts.phase) === "scan") {
      return {
        text: "",
        data: {
          findings: [
            { file: "src/auth.ts", severity: "high", issue: "Off-by-one in retry loop", suggestion: "use <= attempts" },
            { file: "src/db.ts", severity: "critical", issue: "SQL string concatenation", suggestion: "parameterize" },
          ],
        },
      }
    }
    if (String(opts.phase) === "review") throw new Error("reviewer unavailable")
    throw new Error(`unexpected phase ${String(opts.phase)}`)
  })
  const result = (await h.run(readSample("code-audit", "js"), { modules: ["src/auth"] })) as {
    findings: unknown[]
    unverified: Array<{ file: string; unverified: boolean }>
  }
  assert.equal(result.findings.length, 0, "nothing is silently promoted to reviewed findings")
  assert.equal(result.unverified.length, 2, "the failed batch surfaces as unverified")
  assert.ok(result.unverified.every((f) => f.unverified === true), "each item carries the flag")
  assert.equal(stat(result, "raw"), 2)
  assert.equal(stat(result, "kept"), 0)
  assert.equal(stat(result, "rejected"), 0)
  assert.equal(stat(result, "unverified"), 2)
})

test("code-audit sample returns early when scans find nothing", async () => {
  const h = makeHarness(async (_prompt, opts) =>
    String(opts.phase) === "scan" ? { text: "", data: { findings: [] } } : { text: "" },
  )
  const result = (await h.run(readSample("code-audit", "js"), { modules: ["src/empty"] })) as {
    findings: unknown[]
    unverified: unknown[]
  }
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.unverified, [])
  assert.equal(stat(result, "raw"), 0)
  assert.equal(stat(result, "unverified"), 0)
})

test("code-audit sample fails fast on missing modules", async () => {
  const h = makeHarness(async () => ({ text: "" }))
  await assert.rejects(() => h.run(readSample("code-audit", "js"), {}), /args\.modules/)
})

test("fact-check sample executes end to end (extract, dedupe, skeptic, table)", async () => {
  let verifyCalls = 0
  const h = makeHarness(async (prompt, opts) => {
    switch (String(opts.phase)) {
      case "extract":
        return {
          text: "",
          data: { claims: ["The service launched in 2021", "It serves 10M requests daily", "it serves 10m requests daily"] },
        }
      case "verify": {
        const verdict = ["supported", "refuted"][verifyCalls++ % 2]
        return { text: "", data: { claim: "irrelevant", verdict, quote: `quote ${verdict}` } }
      }
      case "skeptic": {
        const claim = firstClaimAfter(prompt, "Claims JSON:")
        return { text: "", data: { overturned: claim ? [{ claim, reason: "quote does not entail the claim" }] : [] } }
      }
      case "report":
        return { text: "| Claim | Verdict |\n| --- | --- |\n| launched | unverifiable |" }
      default:
        throw new Error(`unexpected phase ${String(opts.phase)}`)
    }
  })
  const result = (await h.run(readSample("fact-check", "js"), {
    draft: "Draft text containing claims.",
    sources: ["source one", "source two"],
  })) as { report: string; verdicts: Array<{ verdict: string; overturned: boolean }> }
  assert.equal(stat(result, "claims"), 2, "duplicate claim collapses before verification")
  assert.equal(result.verdicts.length, 2)
  // claim one: supported then overturned by skeptic -> unverifiable; claim two: refuted
  assert.deepEqual(
    result.verdicts.map((v) => v.verdict).sort(),
    ["refuted", "unverifiable"],
  )
  assert.equal(result.verdicts.find((v) => v.overturned)?.verdict, "unverifiable")
  assert.equal(stat(result, "overturned"), 1)
  assert.ok(result.report.startsWith("| Claim"), "reporter output is a markdown table")
  const verifyCall = h.calls.find((c) => String(c.opts.phase) === "verify")
  assert.ok(verifyCall?.prompt.includes("source one"), "verify prompts embed the sources (self-contained)")
})

test("fact-check sample fails fast on missing draft or sources", async () => {
  const h = makeHarness(async () => ({ text: "" }))
  await assert.rejects(() => h.run(readSample("fact-check", "js"), { sources: ["s"] }), /args\.draft/)
  await assert.rejects(() => h.run(readSample("fact-check", "js"), { draft: "d" }), /args\.sources/)
})
