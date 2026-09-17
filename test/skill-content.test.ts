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

import {
  EMPTY_CATALOG,
  SKILL_NAME,
  SKILL_DESCRIPTION,
  SKILL_CONTENT,
  buildSkillContent,
} from "../src/skill-content.ts"

const samplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "workflows", "samples")

const SAMPLE_NAMES = ["deep-research", "code-audit", "fact-check", "dev-loop", "partitioned-review"] as const
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
    lines.length >= 120 && lines.length <= 450,
    // 320 → 380 (2026-09-12): the sizing/partitioning contract added after
    // production runs blew single-child contexts to 300-400k.
    // 380 → 430 (2026-09-17): the loop()/queue() runtime — engine-owned loop
    // disciplines, queue worklists, verdict/skeptic contract — needs its rules
    // where the authoring model reads them.
    // 430 → 450 (2026-09-17): per-run loop-cap inputs (maxLoopDepth,
    // maxLoopIterations) + the remaining-as-args handoff convention.
    `expected a lean 120-450 line skill, got ${lines.length}`,
  )
  for (const name of ["agent", "parallel", "pipeline", "phase", "progress", "workflow", "loop", "queue", "sleep", "args", "meta", "console"]) {
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
  // Dot-relative paths (.opencode/workflows/…) are config paths, not pins.
  const stripped = SKILL_CONTENT.replace(/\S*opencode\S*/g, " ")
  const modelRef = stripped.match(/[a-z-]+\/[a-z0-9.:-]+/)
  assert.equal(modelRef, null, `provider/model-looking ref in skill: ${modelRef?.[0]}`)
  assert.doesNotMatch(SKILL_CONTENT, /\b(opus|sonnet)\b|\b(gpt|claude)-/i, "model family name in skill")
})

test("skill content teaches Plan to Build named-workflow handoff", () => {
  assert.match(SKILL_CONTENT, /Plan → Build/)
  assert.match(SKILL_CONTENT, /\/ultracode save <name>/)
  assert.match(SKILL_CONTENT, /\/ultracode trust <name>/)
  assert.match(SKILL_CONTENT, /\{\s*workflow:\s*"name"/)
  assert.match(SKILL_CONTENT, /Do not call `ultracode_run` inline from Plan/)
  assert.doesNotMatch(SKILL_CONTENT, /ultracode-skill\.md/)
})

test("skill content is graph-first: structure before plumbing", () => {
  const graph = SKILL_CONTENT.indexOf("## Graph mode")
  const script = SKILL_CONTENT.indexOf("## Script mode")
  assert.ok(graph > -1, "graph mode must have its own section")
  assert.ok(script > -1, "script mode must remain documented as the escape hatch")
  assert.ok(graph < script, "graph mode must come first — order teaches priority")
  assert.match(SKILL_CONTENT, /Graph first, script when you must/, "hard rule 1 states the preference")
  // Every node kind the compiler understands is named, so the model can reach
  // for partition and gate instead of hand-rolling them in JS.
  for (const kind of ["agent", "fanout", "partition", "merge", "gate", "checkpoint", "workflow"]) {
    assert.match(SKILL_CONTENT, new RegExp(`\`${kind}\``), `node kind \`${kind}\` must be documented`)
  }
  assert.match(SKILL_CONTENT, /compiles as a root/, "a write node referencing no node is a root — the parallel-writer trap")
  assert.match(SKILL_CONTENT, /\{\{\s*item\s*\}\}|\{\{item\}\}/, "fanout templates must be shown")
  assert.match(SKILL_CONTENT, /auto `key` on every call/, "auto-keying is the warm-rerun story")
})

test("skill content teaches the catalog tool and graph templates", () => {
  assert.ok(SKILL_CONTENT.includes("ultracode_catalog"), "discovery tool must be named")
  assert.match(SKILL_CONTENT, /Discovery first/, "catalog comes before authoring")
  assert.match(SKILL_CONTENT, /params \(names always; JSON types only when declared/, "the catalog answers 'what args does it take'")
  assert.match(SKILL_CONTENT, /\{ workflow: "name" \}/, "detail drill-down")
  assert.match(SKILL_CONTENT, /\{ template: "name" \}/, "single-template drill-down")
  assert.match(SKILL_CONTENT, /template/, "templates are the anti-blank-page answer")
  assert.match(SKILL_CONTENT, /\{ scriptTemplate: "name" \}/, "script-template drill-down")
  assert.match(SKILL_CONTENT, /Trust gates SAVED workflows only/, "the trust boundary is precise")
  assert.match(SKILL_CONTENT, /relay that and wait/, "trust is user-only")
  assert.match(SKILL_CONTENT, /runs\s+without saving or trusting/, "inline scripts are not trust-gated — no agonizing over it")
  assert.match(SKILL_CONTENT, /Never dodge an untrusted saved workflow by inlining its content/, "the anti-bypass guard stands")
})

test("skill content teaches graph review, saving and the graph handoff", () => {
  assert.match(SKILL_CONTENT, /\/ultracode graph <name>/, "render before trusting")
  assert.match(SKILL_CONTENT, /works before\s+trust/, "review is not trust-gated")
  assert.match(SKILL_CONTENT, /<name>\.graph\.json/, "the plan-mode graph artifact")
  assert.match(SKILL_CONTENT, /a graph run saves its spec, not the compiled script/, "no laundering")
})

test("skill content teaches coexistence with domain skills", () => {
  assert.ok(SKILL_CONTENT.includes("execution mechanism"), "must position the skill as mechanism-only")
  assert.ok(SKILL_CONTENT.includes("ONE orchestration mechanism"), "must forbid double fan-out")
  assert.match(SKILL_CONTENT, /do NOT inherit/i, "children must not be assumed to inherit skills")
})

test("skill content names the ultracode_run tool and keyword trigger examples", () => {
  assert.ok(SKILL_CONTENT.includes("ultracode_run"), "tool is invoked as ultracode_run")
  assert.doesNotMatch(SKILL_CONTENT, /`workflow` tool/, "stale tool name")
  assert.match(SKILL_CONTENT, /standalone keyword/, "trigger is a standalone keyword anywhere")
  assert.doesNotMatch(SKILL_CONTENT, /starts with ultracode/, "must not claim start-of-prompt only")
  assert.ok(SKILL_CONTENT.includes("ultracode: audit the auth module"), "leading-keyword example")
  assert.ok(SKILL_CONTENT.includes("please ultracode this"), "mid-prompt example")
})

test("static skill file skills/ultracode.md mirrors SKILL_CONTENT exactly", () => {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
  const file = readFileSync(path.join(repoRoot, "skills", "ultracode.md"), "utf8")
  assert.equal(file, SKILL_CONTENT, "skills/ultracode.md is the registered skill location — keep it in sync")
})

test("buildSkillContent empty catalog is byte-identical to SKILL_CONTENT", () => {
  assert.equal(buildSkillContent(EMPTY_CATALOG), SKILL_CONTENT)
  assert.equal(buildSkillContent({ agents: [], workflows: [] }), SKILL_CONTENT)
})

test("buildSkillContent appends live catalogs when non-empty", () => {
  const text = buildSkillContent({
    agents: [
      { id: "general", description: "general-purpose subagent" },
      { id: "explore" },
    ],
    workflows: [
      {
        name: "deep-research",
        description: "multi-source research",
        phases: ["research", "verify"],
        trusted: true,
      },
      { name: "scratch", trusted: false },
    ],
  })
  assert.ok(text.startsWith(SKILL_CONTENT))
  assert.ok(text.includes("## Live catalogs in this install"))
  assert.ok(text.includes("`general` — general-purpose subagent"))
  assert.ok(text.includes("`explore`"))
  assert.ok(text.includes("`deep-research` — multi-source research"))
  assert.ok(text.includes("phases: research, verify"))
  assert.ok(text.includes("trusted: yes"))
  assert.ok(text.includes("`scratch`"))
  assert.ok(text.includes("trusted: no"))
  assert.notEqual(text, SKILL_CONTENT)
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
  // v0.9.0 (graph workflows) and v0.10.0 (params) — the shipped samples do not
  // use them yet, but a hand-authored pair may.
  "kind",
  "params",
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

test("dev-loop sample executes end to end (explore, implement, verify, review, bounded fix)", async () => {
  let fixRechecks = 0
  const h = makeHarness(async (_prompt, opts) => {
    switch (String(opts.phase)) {
      case "explore":
        return {
          text: "",
          data: { findings: [{ file: "src/a.ts", note: "add guard", symbol: "fn" }] },
        }
      case "implement":
        return { text: "", data: { ok: true, summary: "implemented" } }
      case "verify":
        return { text: "", data: { ok: true, checks: ["test", "typecheck"], issues: [] } }
      case "review":
        return {
          text: "",
          data: { blockers: [{ file: "src/a.ts", severity: "high", issue: "missing null check" }] },
        }
      case "fix":
        if (String(opts.label).startsWith("recheck")) {
          fixRechecks++
          return { text: "", data: { blockers: [] } }
        }
        return { text: "fixed" }
      default:
        throw new Error(`unexpected phase ${String(opts.phase)}`)
    }
  })
  const result = (await h.run(readSample("dev-loop", "js"), {
    task: "add a null check",
    repo: ".",
    scope: "src/a.ts",
    fixPasses: 3,
  })) as { ok: boolean; blockers: unknown[]; stats: { findings: number; fixPasses: number } }
  assert.equal(result.ok, true)
  assert.deepEqual(result.blockers, [])
  assert.equal(stat(result, "findings"), 1)
  assert.equal(stat(result, "fixPasses"), 1)
  assert.equal(fixRechecks, 1)
  const phases = h.calls.map((c) => String(c.opts.phase))
  assert.deepEqual(
    [...new Set(phases)],
    ["explore", "implement", "verify", "review", "fix"],
  )
  assert.equal(
    h.calls.filter((c) => String(c.opts.phase) === "implement").length,
    1,
    "exactly one implement write agent",
  )
})

test("dev-loop sample fails fast on missing task", async () => {
  const h = makeHarness(async () => ({ text: "" }))
  await assert.rejects(() => h.run(readSample("dev-loop", "js"), {}), /args\.task/)
  assert.equal(h.calls.length, 0)
})

test("dev-loop sample fails closed when implementer does not confirm green", async () => {
  const h = makeHarness(async (_prompt, opts) => {
    switch (String(opts.phase)) {
      case "explore":
        return { text: "", data: { findings: [] } }
      case "implement":
        return { text: "", data: { ok: false, summary: "tests failed" } }
      case "verify":
        return { text: "", data: { ok: true, checks: [], issues: [] } }
      case "review":
        return { text: "", data: { blockers: [] } }
      case "fix":
        if (String(opts.label).startsWith("recheck")) return { text: "", data: { blockers: [] } }
        return { text: "fixed" }
      default:
        throw new Error(`unexpected phase ${String(opts.phase)}`)
    }
  })
  const result = (await h.run(readSample("dev-loop", "js"), { task: "x", repo: "." })) as {
    ok: boolean
    stats: { implementOk: boolean }
  }
  // implementer failed; the fix pass "cleared" it, so the re-verify gate must
  // run — and its non-green result must fail the whole loop closed.
  assert.equal(result.ok, false)
  assert.equal(result.stats.implementOk, false)
})

test("partitioned-review executes end to end (partition, coverage assertion, overflow gap-fill, batched merge)", async () => {
  const h = makeHarness(async (_prompt, opts) => {
    const phase = String(opts.phase)
    if (phase === "scout") {
      return {
        text: "",
        data: {
          files: [
            { path: "src/a.ts", lines: 1200 },
            { path: "src/b.ts", lines: 1500 },
            { path: "src/c.ts", lines: 400 },
          ],
        },
      }
    }
    if (phase === "lanes") {
      // lane2 (b.ts + c.ts) cannot cover c.ts within budget → overflow
      return {
        text: "",
        data: {
          summary: "lane report",
          covered: [],
          overflow: String(opts.label) === "lane2" ? ["src/c.ts"] : [],
        },
      }
    }
    if (phase.startsWith("lanes-gap")) {
      return { text: "", data: { summary: "gap lane report", covered: ["src/c.ts"], overflow: [] } }
    }
    if (phase === "cross") {
      return { text: "", data: { summary: "cross-cutting report", covered: ["(greps)"], overflow: [] } }
    }
    if (phase === "merge") return { text: "MERGED" }
    throw new Error(`unexpected phase ${phase}`)
  })
  const result = (await h.run(readSample("partitioned-review", "js"), { area: "src", budget: 25000 })) as {
    report: string
    stats: Record<string, unknown>
  }
  assert.equal(result.report, "MERGED")
  assert.equal(result.stats.files, 3)
  assert.equal(result.stats.lanes, 2, "two lanes under the 25k-token budget")
  assert.equal(result.stats.reports, 4, "2 lanes + 1 overflow gap lane + 1 cross-cutting lane")
  assert.equal(result.stats.mergeBatches, 1)
  // call shape: 1 scout + 2 lanes + 1 gap + 1 cross + 1 merge; every call pins a phase
  assert.equal(h.calls.length, 6)
  for (const c of h.calls) assert.equal(typeof c.opts.phase, "string")
  // read discipline reaches the child prompts
  const laneCall = h.calls.find((c) => String(c.opts.phase) === "lanes")
  assert.ok(laneCall?.prompt.includes("ranged reads"), "lane prompts carry the read-discipline rule")
})

test("partitioned-review fails fast when the scout returns no files", async () => {
  const h = makeHarness(async () => ({ text: "", data: { files: [] } }))
  await assert.rejects(() => h.run(readSample("partitioned-review", "js"), { area: "empty" }), /no files/)
  assert.equal(h.calls.length, 1, "only the scout ran")
})
