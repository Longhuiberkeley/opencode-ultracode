/**
 * Keyword matcher + /ultracode arg parsing.
 *
 * Run: node --experimental-strip-types --test test/command.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  D2_VERBS,
  TOOL_DESCRIPTION,
  TOOL_DESCRIPTION_MAX_LINES,
  commandArgs,
  helpText,
  matchesUltracodeKeyword,
  parseResumeArgs,
  parseSubcommand,
  verbsListedInHelp,
} from "../src/command.ts"

test("keyword: start-of-prompt forms attach", () => {
  assert.equal(matchesUltracodeKeyword("ultracode: audit src/auth"), true)
  assert.equal(matchesUltracodeKeyword("ultracode do X"), true)
  assert.equal(matchesUltracodeKeyword("ultracode"), true)
  assert.equal(matchesUltracodeKeyword("  ULTRACODE: go"), true)
})

test("keyword: mid-prompt standalone forms attach", () => {
  assert.equal(matchesUltracodeKeyword("please ultracode this"), true)
  assert.equal(matchesUltracodeKeyword("foo ultracode: bar"), true)
  assert.equal(matchesUltracodeKeyword("first line\nultracode the rest"), true)
})

test("keyword: paths, ids, and punctuation-glued forms do not attach", () => {
  assert.equal(matchesUltracodeKeyword("look at opencode-ultracode/docs"), false)
  assert.equal(matchesUltracodeKeyword("/path/ultracode"), false)
  assert.equal(matchesUltracodeKeyword("ultracode/docs"), false)
  assert.equal(matchesUltracodeKeyword("ultracode_run"), false)
  assert.equal(matchesUltracodeKeyword("ultracode.js"), false)
  assert.equal(matchesUltracodeKeyword("please (ultracode)"), false)
  assert.equal(matchesUltracodeKeyword("ultracode, please"), false)
  assert.equal(matchesUltracodeKeyword("use a workflow to fact-check this"), false)
  assert.equal(matchesUltracodeKeyword(""), false)
})

test("commandArgs strips only /ultracode, not /workflow aliases", () => {
  assert.equal(commandArgs("/ultracode"), "")
  assert.equal(commandArgs("/ultracode show run_1"), "show run_1")
  assert.equal(commandArgs("/ULTRACODE stop x"), "stop x")
  assert.equal(commandArgs("show run_1"), "show run_1")
  assert.equal(commandArgs("/workflow show run_1"), "/workflow show run_1")
  assert.equal(commandArgs("/workflows"), "/workflows")
  assert.equal(commandArgs(undefined), "")
})

test("parseSubcommand splits on any whitespace", () => {
  assert.deepEqual(parseSubcommand(""), { sub: "", rest: "" })
  assert.deepEqual(parseSubcommand("show run_1"), { sub: "show", rest: "run_1" })
  assert.deepEqual(parseSubcommand("show\trun_1"), { sub: "show", rest: "run_1" })
  assert.deepEqual(parseSubcommand("save run_1 my-flow"), { sub: "save", rest: "run_1 my-flow" })
  assert.deepEqual(parseSubcommand("HELP"), { sub: "help", rest: "" })
  assert.deepEqual(parseSubcommand("can"), { sub: "can", rest: "" })
})

test("helpText is management-only and points at the keyword", () => {
  assert.match(helpText(), /\/ultracode help/)
  assert.match(helpText(), /no leading slash/)
  assert.doesNotMatch(helpText(), /\/workflows?\b/)
  assert.match(helpText(), /resume \[runID\] \[--model provider\/id#variant\] \[--remember\]/)
})

test("parseResumeArgs: runID, --model pin and --remember flags", () => {
  assert.deepEqual(parseResumeArgs(""), { ok: true, target: "", remember: false })
  assert.deepEqual(parseResumeArgs("run_ab12cd34ef56"), { ok: true, target: "run_ab12cd34ef56", remember: false })
  assert.deepEqual(parseResumeArgs("run_x --model openai/gpt-6#high --remember"), {
    ok: true,
    target: "run_x",
    model: "openai/gpt-6#high",
    remember: true,
  })
  assert.deepEqual(parseResumeArgs("--remember --model google/gemini-3.7-flash"), {
    ok: true,
    target: "",
    model: "google/gemini-3.7-flash",
    remember: true,
  })
  // Malformed flags fail loudly instead of being dropped.
  assert.match((parseResumeArgs("run_x --model") as { error: string }).error, /--model needs a value/)
  assert.match((parseResumeArgs("run_x --model not-a-pin") as { error: string }).error, /provider\/id/)
  assert.match((parseResumeArgs("run_x run_y") as { error: string }).error, /unexpected argument/)
})

test("helpText lists exactly the D2 verb set", () => {
  const listed = verbsListedInHelp()
  assert.deepEqual(new Set(listed), new Set(D2_VERBS))
  assert.equal(listed.length, D2_VERBS.length, "each D2 verb listed once")
})

test("helpText documents the set providerconcurrency key and its value forms", () => {
  assert.match(helpText(), /providerconcurrency/)
  assert.match(helpText(), /<providerID>=<N>/)
  assert.match(helpText(), /<providerID>=none/)
  assert.match(helpText(), /1\.\.16/)
})

test("palette command description lists D2 verbs including set and settings", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(src, /D2_VERBS\.join/)
  assert.ok(D2_VERBS.includes("set"))
  assert.ok(D2_VERBS.includes("settings"))
  const description = `Inspect and manage ultracode workflow runs (${D2_VERBS.join(", ")})`
  assert.match(description, /\bset\b/)
  assert.match(description, /\bsettings\b/)
  assert.match(helpText(), /\/ultracode set /)
  assert.match(helpText(), /\/ultracode settings /)
})

test("tool description names every primitive and stays within the line cap", () => {
  const lines = TOOL_DESCRIPTION.split("\n")
  assert.ok(
    lines.length <= TOOL_DESCRIPTION_MAX_LINES,
    `tool description is ${lines.length} lines (cap ${TOOL_DESCRIPTION_MAX_LINES})`,
  )
  for (const name of ["agent", "parallel", "pipeline", "phase", "progress", "workflow", "sleep", "console", "args", "meta"]) {
    assert.match(TOOL_DESCRIPTION, new RegExp(`\\b${name}\\b`), `tool description must name ${name}`)
  }
  assert.ok(
    TOOL_DESCRIPTION.includes(
      "Full patterns + live catalogs load with the Ultracode skill (auto-attaches on the standalone keyword 'ultracode')",
    ),
  )
  assert.match(TOOL_DESCRIPTION, /[Rr]oute by agent/)
})

test("index.ts registers the agent-callable save tool with a gated trust recording", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  // Namespaced registration with its own try/catch + warn (per-tool isolation).
  assert.match(src, /name: "save",\s*\n\s*options: \{ namespace: "ultracode" \}/)
  assert.match(src, /failed to register the ultracode_save tool/)
  assert.match(src, /validateSaveToolInput/)
  // The handler delegates to the host-free executor the command tests cover.
  assert.match(src, /executeSaveTool\(\{ registry, storage \}, tool\.sessionID, parsed\)/)
  // The description carries the exact user-approval-only sentence.
  assert.ok(
    src.includes(
      "trust: true is ONLY for immediately after the user explicitly approved saving and trusting in chat; otherwise omit trust and tell the user to review with /ultracode graph then /ultracode trust",
    ),
    "the save tool description must gate trust on immediate explicit chat approval",
  )
})

test("index.ts wires the provider-concurrency set seams through the settings path", () => {
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  assert.match(src, /nextRunOverlay: \(\) => overlay/)
  assert.match(src, /effectiveProviderConcurrency: \(\) => \(\{ \.\.\.options\.providerConcurrency \}\)/)
  // The overlay persist path stays the ONE KV seam every set key shares.
  assert.match(src, /storage\.saveSettingsOverlay\(merged\)/)
})
