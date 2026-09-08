/**
 * Keyword matcher + /ultracode arg parsing.
 *
 * Run: node --experimental-strip-types --test test/command.test.ts
 */
import test from "node:test"
import assert from "node:assert/strict"
import { commandArgs, helpText, matchesUltracodeKeyword, parseSubcommand } from "../src/command.ts"

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
})
