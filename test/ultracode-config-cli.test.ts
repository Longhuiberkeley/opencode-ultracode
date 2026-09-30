import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"

const cli = path.resolve("src/ultracode-config-cli.mjs")
function runIn(options: { env?: NodeJS.ProcessEnv; cwd?: string }, file: string, ...args: string[]) {
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--experimental-strip-types", cli, "--config", file, ...args],
    { encoding: "utf8", env: { ...process.env, ...options.env }, ...(options.cwd ? { cwd: options.cwd } : {}) })
}
function run(file: string, ...args: string[]) { return runIn({}, file, ...args) }
// Offline catalog: force model/agent discovery to read-only file scans instead of spawning opencode2.
function offline(dir: string): { env: NodeJS.ProcessEnv; cwd: string } {
  return { env: { OPENCODE_BIN: path.join(dir, "missing-opencode2"), HOME: path.join(dir, "home") }, cwd: dir }
}

test("CLI edits only Ultracode options, backs up, rejects invalid edits and explains without tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-config-"))
  const file = path.join(dir, "opencode.json")
  const original = { theme: "custom", plugins: ["another-plugin", { package: "./plugins/ultracode", options: {
    routing: { timezone: "Asia/Hong_Kong", roles: { reviewer: "strong" }, tiers: {
      strong: { plans: [], payg: [[{ model: "xiaomi/mimo-v2.6-pro" }]] },
    } }, childLimits: {}, providerConcurrency: {},
  } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    assert.equal(runIn(offline(dir), file, "limits", "set", "xiaomi/mimo-v2.6-pro", "250000", "300000").status, 0)
    assert.equal(runIn(offline(dir), file, "tier", "add", "strong", "plans", "openai/gpt-6-sol#high", "--reserve", "20", "--group", "0").status, 0)
    assert.equal(runIn(offline(dir), file, "tier", "edit", "strong", "openai/gpt-6-sol#high", "--hours", "8-22").status, 0)
    const explain = runIn(offline(dir), file, "explain", "reviewer", "--at", "2026-09-23T15:30:00Z", "--json")
    assert.equal(explain.status, 0, explain.stderr)
    assert.equal(JSON.parse(explain.stdout).model.id, "mimo-v2.6-pro")
    const beforeInvalid = await readFile(file, "utf8")
    assert.notEqual(runIn(offline(dir), file, "limits", "set", "xiaomi/mimo-v2.6-pro", "300000", "250000").status, 0)
    assert.equal(await readFile(file, "utf8"), beforeInvalid)
    assert.equal(JSON.parse(await readFile(file, "utf8")).theme, "custom")
    assert.deepEqual(JSON.parse(await readFile(file + ".ultracode-config.bak", "utf8")).plugins[1].options.routing.roles, { reviewer: "strong" })
    assert.equal(runIn(offline(dir), file, "tier", "move", "strong", "openai/gpt-6-sol#high", "payg", "0", "--position", "0").status, 0)
    const listed = JSON.parse(runIn(offline(dir), file, "list", "--json").stdout)
    assert.equal(listed.routing.tiers.strong.payg[0][0].model, "openai/gpt-6-sol#high")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("installer adds dispatch to a compatible shim without replacing existing commands", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-shim-"))
  const shim = path.join(dir, "opencode2")
  const plugin = path.join(dir, "plugin")
  try {
    await writeFile(shim, '#!/bin/bash\nif [[ "${1:-}" == "update" ]]; then\n  exit 0\nfi\necho original\n')
    const { mkdir } = await import("node:fs/promises")
    await mkdir(path.join(plugin, "src"), { recursive: true })
    await writeFile(path.join(plugin, "src/ultracode-config-cli.mjs"), "// installed")
    const script = path.resolve("scripts/install-config-cli.sh")
    execFileSync("bash", [script, shim, plugin])
    execFileSync("bash", [script, shim, plugin])
    const text = await readFile(shim, "utf8")
    assert.equal(text.match(/# ultracode-config dispatch/g)?.length, 1)
    assert.match(text, /echo original/)
    assert.ok((await readFile(shim + ".ultracode-config.bak", "utf8")).includes("echo original"))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("CLI binds portable quota pool without changing provider pin or legacy checker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-pool-"))
  const file = path.join(dir, "opencode.json")
  const checker = path.join(dir, "checker.mjs")
  const original = { plugins: [{ package: "./plugins/ultracode", options: {
    quotaCommand: ["opencode2", "check-rate", "--json"],
    routing: { timezone: "UTC", roles: { reviewer: "strong" }, tiers: { strong: {
      plans: [[{ model: "provider/model", reservePercent: 20 }]], payg: [],
    } } },
  } }] }
  try {
    await writeFile(file, JSON.stringify(original))
    await writeFile(checker, 'console.log(JSON.stringify({ pools: [{ id: "team-monthly", windows: [{ remainingPercent: 33 }] }] }))')
    assert.equal(run(file, "capacity", "source", "team-monthly", "capacity-v1", process.execPath, checker).status, 0)
    assert.equal(run(file, "capacity", "bind", "strong", "provider/model", "team-monthly").status, 0)
    assert.match(run(file, "capacity", "status", "team-monthly").stdout, /33% remaining/)
    const policy = JSON.parse(await readFile(file, "utf8")).plugins[0].options
    assert.equal(policy.routing.tiers.strong.plans[0][0].capacityPool, "team-monthly")
    assert.deepEqual(policy.quotaCommand, original.plugins[0].options.quotaCommand)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("CLI sets weighted mode, weights, mainWeight and fallback; rejects invalid values", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-weighted-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC", roles: { general: "strong" }, tiers: {
    strong: { plans: [], payg: [] },
    standard: { plans: [[{ model: "p/s" }]], payg: [] },
  } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    assert.equal(run(file, "tier", "add", "strong", "plans", "p/a", "--weight", "15").status, 0)
    assert.equal(run(file, "tier", "add", "strong", "payg", "p/b", "--weight", "6").status, 0)
    assert.equal(run(file, "tier", "add", "strong", "payg", "p/c", "--weight", "2", "--main-weight", "1").status, 0)
    assert.equal(run(file, "tier", "mode", "strong", "weighted").status, 0)
    assert.equal(run(file, "tier", "fallback", "strong", "standard").status, 0)
    let tier = JSON.parse(await readFile(file, "utf8")).plugins[0].options.routing.tiers.strong
    assert.equal(tier.selection, "weighted")
    assert.equal(tier.fallback, "standard")
    assert.equal(tier.plans[0][0].weight, 15)
    assert.equal(tier.payg[0][0].weight, 6)
    assert.equal(tier.payg[1][0].mainWeight, 1)
    // Invalid edits fail closed and never write.
    const before = await readFile(file, "utf8")
    assert.notEqual(run(file, "tier", "add", "strong", "plans", "p/z", "--main-weight", "2").status, 0)
    assert.notEqual(run(file, "tier", "mode", "strong", "random").status, 0)
    assert.notEqual(run(file, "tier", "fallback", "strong", "missing").status, 0)
    assert.notEqual(run(file, "tier", "fallback", "strong", "strong").status, 0)
    assert.notEqual(run(file, "tier", "edit", "strong", "p/a", "--weight", "0").status, 0)
    assert.notEqual(run(file, "tier", "edit", "strong", "p/a", "--weight", "10001").status, 0)
    assert.equal(await readFile(file, "utf8"), before)
    // Explicit clears remove optional keys so ordered/old configs stay identical.
    assert.equal(run(file, "tier", "edit", "strong", "p/a", "--weight", "none").status, 0)
    assert.equal(run(file, "tier", "edit", "strong", "p/c", "--main-weight", "none").status, 0)
    assert.equal(run(file, "tier", "fallback", "strong", "none").status, 0)
    assert.equal(run(file, "tier", "mode", "strong", "ordered").status, 0)
    tier = JSON.parse(await readFile(file, "utf8")).plugins[0].options.routing.tiers.strong
    assert.equal(tier.selection, undefined)
    assert.equal(tier.fallback, undefined)
    assert.equal(tier.plans[0][0].weight, undefined)
    assert.equal(tier.payg[1][0].mainWeight, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("routing init seeds lite/standard/strong/frontier and role defaults maps canonical agents in one write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-onboard-"))
  const file = path.join(dir, "opencode.json")
  const { mkdir } = await import("node:fs/promises")
  try {
    await writeFile(file, JSON.stringify({ plugins: [{ package: "./plugins/ultracode", options: {} }] }, null, 2) + "\n")
    const init = run(file, "routing", "init", "UTC")
    assert.equal(init.status, 0, init.stderr)
    assert.match(init.stdout, /Created tiers: lite, standard, strong, frontier/)
    assert.match(init.stdout, /no roles mapped yet — every child keeps its agent pin/i)
    assert.match(init.stdout, /role defaults/)
    const options = JSON.parse(await readFile(file, "utf8")).plugins[0].options
    assert.deepEqual(Object.keys(options.routing.tiers), ["lite", "standard", "strong", "frontier"])
    assert.deepEqual(options.routing.roles, {})
    assert.notEqual(run(file, "routing", "init", "UTC").status, 0) // no overwrite/migration
    const empty = run(file, "list")
    assert.match(empty.stdout, /\(no roles mapped; agent pins decide\)/)
    assert.match(empty.stdout, /lite:\s+ordered/)
    assert.match(empty.stdout, /\(no model choices — mapped agents keep their agent pins\)/)
    // A detected reviewer file lets all three canonical pairs apply in a single write.
    await mkdir(path.join(dir, ".opencode/agents"), { recursive: true })
    await writeFile(path.join(dir, ".opencode/agents/reviewer.md"), "---\nmodel: p/r\n---\n")
    const applied = runIn(offline(dir), file, "role", "defaults")
    assert.equal(applied.status, 0, applied.stderr)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugins[0].options.routing.roles,
      { explore: "lite", general: "standard", reviewer: "strong" })
    assert.match(applied.stdout, /explore -> lite\s+\(undo: role remove explore\)/)
    assert.match(applied.stdout, /lite has no model choices yet — explore keeps its agent pin/)
    // Idempotent: the second run changes nothing and produces no backup.
    await rm(file + ".ultracode-config.bak", { force: true })
    const again = runIn(offline(dir), file, "role", "defaults")
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /explore: already mapped to lite/)
    await assert.rejects(readFile(file + ".ultracode-config.bak", "utf8"))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("list renders weighted pools and empty tiers; explain prints the pool and fallback chain", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-render-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC",
    roles: { general: "strong", reviewer: "frontier" },
    tiers: {
      strong: { selection: "weighted", plans: [[{ model: "p/a", weight: 4 }, { model: "p/b", weight: 2 }]], payg: [[{ model: "p/c", weight: 2, mainWeight: 1 }]] },
      frontier: { selection: "weighted", fallback: "strong", plans: [[{ model: "p/x", hours: [22, 8] }]], payg: [] },
      empty: { plans: [], payg: [] },
    } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    const listed = runIn(offline(dir), file, "list")
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /strong:\s+weighted/)
    assert.match(listed.stdout, /frontier:\s+weighted\s+fallback: strong/)
    assert.match(listed.stdout, /p\/a w4 \(57%\)/)
    assert.match(listed.stdout, /p\/b w2 \(29%\)/)
    assert.match(listed.stdout, /p\/c w1\* main \(14%\)/)
    assert.match(listed.stdout, /empty:\s+ordered/)
    assert.match(listed.stdout, /\(no model choices — mapped agents keep their agent pins\)/)
    // A fresh router draws the first weighted pick, with the eligible pool and percentages.
    const explain = runIn(offline(dir), file, "explain", "general")
    assert.equal(explain.status, 0, explain.stderr)
    assert.match(explain.stdout, /Selected: p\/a/)
    assert.match(explain.stdout, /weighted strong: p\/a \(w4 of 7\)/)
    assert.match(explain.stdout, /Pool:\n {2}- p\/a {2}w4 \(57%\)/)
    assert.match(explain.stdout, /- p\/c {2}w1 \(14%\)/)
    // A gated tier falls through to its fallback and reports the chain.
    const fallback = runIn(offline(dir), file, "explain", "reviewer", "--at", "2026-09-23T12:00:00Z")
    assert.equal(fallback.status, 0, fallback.stderr)
    assert.match(fallback.stdout, /frontier exhausted -> strong/)
    assert.match(fallback.stdout, /Fallback chain: frontier -> strong/)
    // The successful hop still reports why the gate fired.
    assert.match(fallback.stdout, /Skipped:\n {2}- p\/x: outside allowed hours/)
    const json = JSON.parse(runIn(offline(dir), file, "explain", "reviewer", "--at", "2026-09-23T12:00:00Z", "--json").stdout)
    assert.deepEqual(json.fallbackChain, ["frontier", "strong"])
    assert.deepEqual(json.skipped, ["p/x: outside allowed hours"])
    assert.equal(json.pool.length, 3)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("CLI explain mirrors runtime on empty tiers; tier delete refuses a fallback referrer", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-explain-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC",
    roles: { general: "empty", reviewer: "frontier", deep: "chain" },
    tiers: {
      empty: { plans: [], payg: [] },
      chain: { plans: [], payg: [], fallback: "tail" },
      tail: { plans: [], payg: [] },
      frontier: { plans: [[{ model: "p/x", hours: [22, 8] }]], payg: [] },
      strong: { plans: [[{ model: "p/a" }]], payg: [] },
    } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    // An explicit hint on an empty tier degrades to the nearest populated tier, as a workflow run would...
    const explicit = runIn(offline(dir), file, "explain", "general", "empty", "--at", "2026-09-23T23:00:00Z")
    assert.equal(explicit.status, 0, explicit.stderr)
    assert.match(explicit.stdout, /Selected: p\/x/)
    assert.match(explicit.stdout, /empty empty -> frontier: plan frontier: p\/x/)
    // ...and fails loud when that tier is populated but gated out.
    const gated = runIn(offline(dir), file, "explain", "general", "empty", "--at", "2026-09-23T12:00:00Z")
    assert.notEqual(gated.status, 0)
    assert.match(gated.stderr, /empty empty -> frontier: no eligible frontier model for general: p\/x: outside allowed hours/)
    // An unknown tier name is dropped in favour of the role default.
    const unknown = runIn(offline(dir), file, "explain", "general", "not-a-tier")
    assert.equal(unknown.status, 0, unknown.stderr)
    assert.match(unknown.stdout, /unknown tier not-a-tier; using role default: tier empty is empty; use agent pin/)
    // A role mapped directly to an empty tier still reports the agent pin at exit 0.
    const role = runIn(offline(dir), file, "explain", "general")
    assert.equal(role.status, 0, role.stderr)
    assert.match(role.stdout, /Selected: agent pin/)
    assert.match(role.stdout, /tier empty is empty; use agent pin/)
    // An empty tier whose fallback is ALSO empty degrades the same way (spec 4).
    const chained = runIn(offline(dir), file, "explain", "deep")
    assert.equal(chained.status, 0, chained.stderr)
    assert.match(chained.stdout, /Selected: agent pin/)
    assert.match(chained.stdout, /tier chain is empty; use agent pin/)
    // Deleting a tier another tier references in `fallback` is an actionable refusal, not a corruption report.
    assert.equal(runIn(offline(dir), file, "tier", "fallback", "frontier", "strong").status, 0)
    const before = await readFile(file, "utf8")
    const refused = runIn(offline(dir), file, "tier", "delete", "strong")
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /clear the fallback reference from frontier first \(tier fallback frontier none\)/)
    assert.equal(await readFile(file, "utf8"), before)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("CLI explain validates a hand-edited policy instead of bypassing parse", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-badpolicy-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC",
    roles: { general: "a" }, tiers: { a: { plans: [[{ model: "not-a-pin" }]], payg: [] } } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    const explained = runIn(offline(dir), file, "explain", "general")
    assert.notEqual(explained.status, 0)
    assert.match(explained.stderr, /invalid routing model: not-a-pin/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("CLI refuses an invalid edit without claiming routing was disabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-refuse-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC", roles: {}, tiers: {
    a: { plans: [], payg: [[{ model: "p/a" }]] },
    b: { plans: [], payg: [] },
    c: { plans: [], payg: [] },
  } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    // mainWeight is invalid on a plans candidate: refused, nothing written, and the
    // message must not read as though routing had been disabled at runtime.
    const before = await readFile(file, "utf8")
    const refused = runIn(offline(dir), file, "tier", "add", "a", "plans", "p/plan", "--main-weight", "2")
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /edit rejected, config unchanged:/)
    assert.doesNotMatch(refused.stderr, /routing disabled/)
    assert.equal(await readFile(file, "utf8"), before)
    // A two-edge fallback cycle is refused the same way (byte-identical file).
    assert.equal(runIn(offline(dir), file, "tier", "fallback", "a", "b").status, 0)
    const withEdge = await readFile(file, "utf8")
    const cycle = runIn(offline(dir), file, "tier", "fallback", "b", "a")
    assert.notEqual(cycle.status, 0)
    assert.match(cycle.stderr, /edit rejected, config unchanged:/)
    assert.match(cycle.stderr, /routing fallback cycle: a -> b -> a/)
    assert.equal(await readFile(file, "utf8"), withEdge)
    // A three-edge cycle is refused at the third edge too.
    assert.equal(runIn(offline(dir), file, "tier", "fallback", "b", "c").status, 0)
    const threeEdges = await readFile(file, "utf8")
    const thirdEdge = runIn(offline(dir), file, "tier", "fallback", "c", "a")
    assert.notEqual(thirdEdge.status, 0)
    assert.match(thirdEdge.stderr, /routing fallback cycle: a -> b -> c -> a/)
    assert.equal(await readFile(file, "utf8"), threeEdges)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("routing disable/enable round-trips the master switch; list and explain reflect it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-switch-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC",
    roles: { general: "strong" }, tiers: { strong: { plans: [[{ model: "p/a" }]], payg: [] } } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    const on = runIn(offline(dir), file, "explain", "general", "--json")
    assert.equal(on.status, 0, on.stderr)
    assert.equal(JSON.parse(on.stdout).model.id, "a")
    const disabled = runIn(offline(dir), file, "routing", "disable")
    assert.equal(disabled.status, 0, disabled.stderr)
    assert.equal(JSON.parse(await readFile(file, "utf8")).plugins[0].options.routing.enabled, false)
    const listed = runIn(offline(dir), file, "list")
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /routing disabled; every child keeps its agent pin/)
    assert.match(listed.stdout, /general\s+strong/)
    assert.equal(JSON.parse(runIn(offline(dir), file, "list", "--json").stdout).routing.enabled, false)
    // A role mapping and an explicit tier hint both report the agent pin at exit 0.
    const role = runIn(offline(dir), file, "explain", "general")
    assert.equal(role.status, 0, role.stderr)
    assert.match(role.stdout, /Selected: agent pin/)
    assert.match(role.stdout, /routing disabled; use agent pin/)
    const hint = runIn(offline(dir), file, "explain", "general", "strong")
    assert.equal(hint.status, 0, hint.stderr)
    assert.match(hint.stdout, /Selected: agent pin/)
    assert.match(hint.stdout, /routing disabled; use agent pin/)
    // enable clears the default key, restoring the original policy and routing.
    assert.equal(runIn(offline(dir), file, "routing", "enable").status, 0)
    const restored = JSON.parse(await readFile(file, "utf8")).plugins[0].options.routing
    assert.equal(restored.enabled, undefined)
    assert.equal(JSON.parse(runIn(offline(dir), file, "explain", "general", "--json").stdout).model.id, "a")
    // The switch lives inside an existing policy: a policy-less config refuses.
    const bare = path.join(dir, "bare.json")
    await writeFile(bare, JSON.stringify({ plugins: [{ package: "./plugins/ultracode", options: {} }] }))
    assert.notEqual(runIn(offline(dir), bare, "routing", "disable").status, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("role defaults names the available tiers when a target tier is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-role-skip-"))
  const file = path.join(dir, "opencode.json")
  const original = { plugins: [{ package: "./plugins/ultracode", options: { routing: { timezone: "UTC", roles: {}, tiers: {
    standard: { plans: [], payg: [] },
    strong: { plans: [], payg: [] },
  } } } }] }
  try {
    await writeFile(file, JSON.stringify(original, null, 2) + "\n")
    const applied = runIn(offline(dir), file, "role", "defaults")
    assert.equal(applied.status, 0, applied.stderr)
    // explore -> lite is skipped because lite was never configured; the line names
    // the tiers that DO exist. general -> standard still applies.
    assert.match(applied.stdout, /explore: tier lite is not configured; available: standard, strong/)
    assert.match(applied.stdout, /general -> standard/)
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).plugins[0].options.routing.roles, { general: "standard" })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("tier describe and routing ladder round-trip; init seeds descriptions; list shows ladder order", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-ladder-"))
  const file = path.join(dir, "opencode.json")
  try {
    await writeFile(file, JSON.stringify({ plugins: [{ package: "./plugins/ultracode", options: {} }] }))
    assert.equal(runIn(offline(dir), file, "routing", "init", "UTC").status, 0)
    const routing = () => readFile(file, "utf8").then((text) => JSON.parse(text).plugins[0].options.routing)
    assert.equal((await routing()).tiers.strong.description, "hard coding, review, merging findings")
    assert.equal(runIn(offline(dir), file, "tier", "describe", "strong", "opus-class:", "hard", "review").status, 0)
    assert.equal((await routing()).tiers.strong.description, "opus-class: hard review")
    assert.equal(runIn(offline(dir), file, "tier", "describe", "strong", "none").status, 0)
    assert.equal((await routing()).tiers.strong.description, undefined)
    assert.notEqual(runIn(offline(dir), file, "tier", "describe", "strong", "x".repeat(201)).status, 0)

    assert.notEqual(runIn(offline(dir), file, "routing", "ladder", "lite", "nope").status, 0)
    assert.equal(runIn(offline(dir), file, "routing", "ladder", "frontier", "lite").status, 0)
    assert.deepEqual((await routing()).ladder, ["frontier", "lite"])
    const listed = runIn(offline(dir), file, "list").stdout
    assert.ok(listed.indexOf("  frontier:") < listed.indexOf("  lite:") && listed.indexOf("  lite:") < listed.indexOf("  standard:"), listed)
    assert.match(listed, /lite: {2}ordered {2}— mechanical work/)
    // Deleting a tier drops it from the ladder instead of leaving a dangling name.
    assert.equal(runIn(offline(dir), file, "tier", "delete", "frontier").status, 0)
    assert.deepEqual((await routing()).ladder, ["lite"])
    assert.equal(runIn(offline(dir), file, "routing", "ladder", "none").status, 0)
    assert.equal((await routing()).ladder, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("tier add warns, without refusing, when the live catalog lacks the model or variant", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ultracode-catalog-warn-"))
  const file = path.join(dir, "opencode.json")
  const bin = path.join(dir, "fake-opencode2")
  try {
    await writeFile(file, JSON.stringify({ plugins: [{ package: "./plugins/ultracode", options: {
      routing: { timezone: "UTC", roles: {}, tiers: { strong: { plans: [], payg: [] } } } } }] }))
    await writeFile(bin, `#!/bin/sh\necho '{"data":[{"providerID":"p","id":"a","variants":["high"]}]}'\n`, { mode: 0o755 })
    const env = { env: { OPENCODE_BIN: bin }, cwd: dir }
    const known = runIn(env, file, "tier", "add", "strong", "plans", "p/a#high")
    assert.equal(known.status, 0, known.stderr)
    assert.doesNotMatch(known.stdout, /Warning/)
    const variant = runIn(env, file, "tier", "add", "strong", "plans", "p/a#ultra")
    assert.equal(variant.status, 0, variant.stderr)
    assert.match(variant.stdout, /Warning: p\/a has no variant "ultra" \(available: high\)/)
    const missing = runIn(env, file, "tier", "add", "strong", "payg", "p/zzz")
    assert.equal(missing.status, 0, missing.stderr)
    assert.match(missing.stdout, /Warning: p\/zzz is not in the live catalog/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
