#!/usr/bin/env node
/** Ultracode's opt-in configuration editor. This CLI does not touch OpenCode agent pins. */
import { promises as fs } from "node:fs"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { fileURLToPath } from "node:url"
import { loadOptions } from "./config.ts"
import { ModelRouter } from "./model-routing.ts"
import { capacityFeed } from "./quota-command.ts"
import { parseModelPin } from "./agent-pins.ts"

const HELP = `opencode2 ultracode-config [--config PATH] [command]

No command opens the interactive menu. Edits apply to Ultracode plugin options only.
  list [--json]                          inspect roles, tiers, child limits and caps
  explain <role> [tier] [--at ISO]       simulate deterministic selection (no model call)
  limits set <model> <target> <hard>     working-context limits (estimated input tokens)
  limits remove <model>
  tier add <tier> <plans|payg> <model> [--group N] [--hours START-END] [--reserve PERCENT] [--blocked START-END,...] [--weight N] [--main-weight N]
  tier edit <tier> <model> [--hours START-END|none] [--reserve PERCENT|none] [--blocked START-END,...|none] [--weight N|none] [--main-weight N|none]
  tier move <tier> <model> <plans|payg> <group-index> [--position N]
  tier mode <tier> <ordered|weighted>    selection strategy (weighted draws by weight, not group order)
  tier fallback <tier> <other-tier|none> tier to try when nothing in this tier is eligible
  tier remove <tier> <model>
  tier create <tier> | tier delete <tier> | tier show <tier>
  role set <agent> <tier> | role remove <agent> | role defaults [--force] [--all-known]
  routing init <IANA timezone> | routing timezone <IANA timezone>
  quota-id set <provider> <feed-id> | quota-id remove <provider>
  capacity source <pool> <capacity-v1|check-rate> <executable> [args...]
  capacity status [pool] | capacity remove <pool> | capacity bind <tier> <model> <pool|none>
  provider set <provider> <1..16> | provider remove <provider>
  setting set <agent|concurrency|maxAgents|timeoutMs|permissions|childStallMs|failover|quotaCommand> <JSON value>

Group indices are zero-based. Groups run in order; models within one group rotate.
--weight applies in weighted tiers; --main-weight lets a PAYG model join the plans draw.
role defaults maps canonical agents (explore, general, reviewer) to lite/standard/strong.
Existing /ultracode set overlays for concurrency, maxAgents, timeoutMs, permissions
and providerconcurrency take precedence over plugin defaults in their project.
Changes to the copied plugin require an OpenCode service restart when safe.
`

const ROLE_DEFAULTS = [
  { agent: "explore", tier: "lite", always: true, why: "Every install has explore (read-only codebase search), so a cheap model is safe by construction." },
  { agent: "general", tier: "standard", always: true, why: "The default subagent and the agent used by shipped skeletons, including verifier and skeptic phases." },
  { agent: "reviewer", tier: "strong", always: false, why: "Independent review is judgment work; offered only when a reviewer agent file is detected." },
]

function fail(message) { throw new Error(message) }
function number(value, label, min, max) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail(`${label} must be an integer ${min}..${max}`)
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) fail(`${label} must be an integer ${min}..${max}`)
  return n
}
function weight(value, label) {
  const n = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0 || n > 10000) fail(`${label} must be a positive number up to 10000`)
  return n
}
function hours(value) {
  if (value === "none") return undefined
  const parts = /^([0-9]{1,2})-([0-9]{1,2})$/.exec(value ?? "")
  if (!parts) fail("hours must be START-END in the policy timezone (for example 22-8)")
  const start = number(parts[1], "hour", 0, 23), end = number(parts[2], "hour", 0, 23)
  if (start === end) fail("hours cannot have identical start and end")
  return [start, end]
}
function flags(args, allowed) {
  const result = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || args[i + 1] === undefined) fail(`unknown or incomplete flag: ${args[i]}`)
    result[args[i].slice(2)] = args[i + 1]
  }
  return result
}
function candidateLocation(routing, tier, model) {
  const found = []
  for (const kind of ["plans", "payg"]) routing.tiers[tier]?.[kind]?.forEach((group, index) => {
    group.forEach((entry, position) => { if (entry.model === model) found.push({ kind, index, position, entry }) })
  })
  if (found.length > 1) fail(`ambiguous model ${model}: present multiple times in ${tier}`)
  return found[0]
}
function ensureRouting(opts) {
  if (!opts.routing) fail("no routing policy configured; create one under the Ultracode plugin's routing options first")
  return opts.routing
}
function ensureTier(routing, name) {
  const tier = routing.tiers[name]
  if (!tier) fail(`unknown tier ${name}; available: ${Object.keys(routing.tiers).join(", ")}`)
  return tier
}
async function configure(opts, command) {
  const [area, verb, ...rest] = command
  if (area === "routing") {
    if (verb === "init" && rest.length === 1) {
      if (opts.routing) fail("routing policy already exists")
      // Names are user labels; init never writes a role or a model. A pre-existing policy is never migrated.
      opts.routing = { timezone: rest[0], roles: {}, tiers: Object.fromEntries(["lite", "standard", "strong", "frontier"].map((name) =>
        [name, { plans: [], payg: [] }])) }
    } else if (verb === "timezone" && rest.length === 1) ensureRouting(opts).timezone = rest[0]
    else fail("usage: routing init <timezone> | routing timezone <timezone>")
    return
  }
  if (area === "quota-id") {
    const routing = ensureRouting(opts)
    routing.quotaIDs ??= {}
    if (verb === "set" && rest.length === 2 && rest.every(Boolean)) routing.quotaIDs[rest[0]] = rest[1]
    else if (verb === "remove" && rest.length === 1 && rest[0]) delete routing.quotaIDs[rest[0]]
    else fail("usage: quota-id set <provider> <feed-id> | quota-id remove <provider>")
    return
  }
  if (area === "capacity") {
    opts.quotaSources ??= {}
    if (verb === "source" && rest.length >= 3 && ["capacity-v1", "check-rate"].includes(rest[1]) && rest.every(Boolean)) {
      opts.quotaSources[rest[0]] = { format: rest[1], command: rest.slice(2) }
    } else if (verb === "remove" && rest.length === 1) delete opts.quotaSources[rest[0]]
    else if (verb === "bind" && rest.length === 3) {
      const routing = ensureRouting(opts)
      ensureTier(routing, rest[0])
      const location = candidateLocation(routing, rest[0], rest[1])
      if (!location) fail(`${rest[1]} is not in tier ${rest[0]}`)
      if (rest[2] === "none") delete location.entry.capacityPool
      else { if (!opts.quotaSources[rest[2]] && !opts.quotaCommand) fail(`capacity source ${rest[2]} is not configured`); location.entry.capacityPool = rest[2] }
    } else fail("capacity source <pool> <capacity-v1|check-rate> <executable> [args...] | capacity bind <tier> <model> <pool|none> | capacity remove <pool>")
    return
  }
  if (area === "limits") {
    const [model, target, hard] = rest
    if (!parseModelPin(model ?? "")) fail("limits: use a provider/model[#variant] pin")
    if (verb === "set" && rest.length === 3) opts.childLimits[model] = {
      targetInput: number(target, "target", 1, 2_000_000), hardInput: number(hard, "hard", 1, 2_000_000),
    }
    else if (verb === "remove" && rest.length === 1) delete opts.childLimits[model]
    else fail("usage: limits set <model> <target> <hard> | limits remove <model>")
    return
  }
  if (area === "role") {
    const routing = ensureRouting(opts)
    if (verb === "set" && rest.length === 2) {
      if (!rest[0]) fail("agent id must be non-empty")
      ensureTier(routing, rest[1]); routing.roles[rest[0]] = rest[1]
    } else if (verb === "remove" && rest.length === 1) delete routing.roles[rest[0]]
    else if (verb === "defaults") return await applyRoleDefaults(routing, rest)
    else fail("usage: role set <agent> <tier> | role remove <agent> | role defaults [--force] [--all-known]")
    return
  }
  if (area === "provider") {
    if (verb === "set" && rest.length === 2) opts.providerConcurrency[rest[0]] = number(rest[1], "provider cap", 1, 16)
    else if (verb === "remove" && rest.length === 1) delete opts.providerConcurrency[rest[0]]
    else fail("usage: provider set <id> <1..16> | provider remove <id>")
    return
  }
  if (area === "setting") {
    const allowed = ["agent", "concurrency", "maxAgents", "timeoutMs", "permissions", "childStallMs", "failover", "quotaCommand"]
    if (verb !== "set" || rest.length < 2 || !allowed.includes(rest[0])) fail(`setting set <${allowed.join("|")}> <JSON value>`)
    try { opts[rest[0]] = JSON.parse(rest.slice(1).join(" ")) } catch { fail("setting value must be valid JSON, for example 4 or \"ask\"") }
    return
  }
  if (area === "tier") {
    const routing = ensureRouting(opts)
    if (verb === "create" && rest.length === 1) {
      if (!/^[a-z][a-z0-9_-]*$/.test(rest[0]) || routing.tiers[rest[0]]) fail("tier name must be new and lowercase alphanumeric")
      routing.tiers[rest[0]] = { plans: [], payg: [] }; return
    }
    if (verb === "delete" && rest.length === 1) {
      ensureTier(routing, rest[0])
      if (Object.values(routing.roles).includes(rest[0])) fail("remove role mappings to this tier first")
      const referrers = Object.entries(routing.tiers).filter(([, tier]) => tier.fallback === rest[0]).map(([name]) => name)
      if (referrers.length) fail(`clear the fallback reference from ${referrers.join(", ")} first (tier fallback ${referrers[0]} none)`)
      delete routing.tiers[rest[0]]; return
    }
    if (verb === "mode" && rest.length === 2) {
      const tier = ensureTier(routing, rest[0])
      if (!["ordered", "weighted"].includes(rest[1])) fail("tier mode <tier> <ordered|weighted>")
      // "ordered" is the default, so clearing the key keeps old configs identical.
      if (rest[1] === "ordered") delete tier.selection; else tier.selection = "weighted"
      return
    }
    if (verb === "fallback" && rest.length === 2) {
      const tier = ensureTier(routing, rest[0])
      if (rest[1] === "none") delete tier.fallback
      else {
        ensureTier(routing, rest[1])
        if (rest[1] === rest[0]) fail("a tier cannot fall back to itself")
        tier.fallback = rest[1]
      }
      return
    }
    const [name, first, ...tail] = rest
    const tier = ensureTier(routing, name)
    if (verb === "add") {
      const kind = first, model = tail[0]
      if (!["plans", "payg"].includes(kind) || !parseModelPin(model ?? "")) fail("tier add <tier> <plans|payg> <provider/model[#variant]> [flags]")
      if (candidateLocation(routing, name, model)) fail(`${model} is already in ${name}; use tier edit or tier move`)
      const f = flags(tail.slice(1), ["--group", "--hours", "--reserve", "--blocked", "--weight", "--main-weight"])
      const group = f.group === undefined ? tier[kind].length : number(f.group, "group", 0, tier[kind].length)
      const entry = { model }
      editEntry(entry, f)
      if (group === tier[kind].length) tier[kind].push([entry]); else tier[kind][group].push(entry)
      return
    }
    const model = first
    const location = candidateLocation(routing, name, model)
    if (!location) fail(`${model} is not in tier ${name}`)
    if (verb === "edit") { editEntry(location.entry, flags(tail, ["--hours", "--reserve", "--blocked", "--weight", "--main-weight"])); return }
    const remove = () => {
      const group = tier[location.kind][location.index]
      group.splice(location.position, 1)
      if (!group.length) tier[location.kind].splice(location.index, 1)
    }
    if (verb === "remove" && !tail.length) { remove(); return }
    if (verb === "move") {
      const [kind, index, ...other] = tail
      if (!["plans", "payg"].includes(kind)) fail("move requires plans or payg")
      const f = flags(other, ["--position"])
      remove()
      const groupIndex = number(index, "group", 0, tier[kind].length)
      if (groupIndex === tier[kind].length) tier[kind].push([])
      const group = tier[kind][groupIndex]
      group.splice(f.position === undefined ? group.length : number(f.position, "position", 0, group.length), 0, location.entry)
      return
    }
    fail("tier: use add, edit, move, mode, fallback, remove, create or delete")
  }
  fail("unknown command; run ultracode-config --help")
}
function editEntry(entry, f) {
  if (f.hours !== undefined) {
    const value = hours(f.hours); if (value) entry.hours = value; else delete entry.hours
  }
  if (f.reserve !== undefined) {
    if (f.reserve === "none") delete entry.reservePercent
    else entry.reservePercent = number(f.reserve, "reservePercent", 0, 100)
  }
  if (f.blocked !== undefined) {
    if (f.blocked === "none") delete entry.blockedWeekdayHours
    else entry.blockedWeekdayHours = f.blocked.split(",").map(hours)
  }
  if (f.weight !== undefined) {
    if (f.weight === "none") delete entry.weight
    else entry.weight = weight(f.weight, "weight")
  }
  if (f["main-weight"] !== undefined) {
    if (f["main-weight"] === "none") delete entry.mainWeight
    else entry.mainWeight = weight(f["main-weight"], "mainWeight")
  }
}

/**
 * Canonical role onboarding. Applies agent -> tier edges only, in one write;
 * never writes a model, hours, reserve or capacity pool. Positional `agent=tier`
 * arguments let the interactive confirm-each flow reuse the same batched engine.
 */
async function applyRoleDefaults(routing, rest) {
  const unknown = rest.filter((arg) => arg.startsWith("--") && !["--force", "--all-known"].includes(arg))
  if (unknown.length) fail(`unknown flag for role defaults: ${unknown[0]}`)
  const force = rest.includes("--force")
  const allKnown = rest.includes("--all-known")
  const explicit = rest.filter((arg) => !arg.startsWith("--"))
  const lines = []
  let candidates
  if (explicit.length) {
    candidates = explicit.map((pair) => {
      const at = pair.indexOf("=")
      if (at <= 0 || at === pair.length - 1) fail(`role defaults pairs must look like agent=tier: ${pair}`)
      return { agent: pair.slice(0, at), tier: pair.slice(at + 1) }
    })
  } else {
    const detection = await detectAgents()
    candidates = ROLE_DEFAULTS.filter((entry) => entry.always || allKnown || detection.ids.has(entry.agent))
      .map((entry) => ({ agent: entry.agent, tier: entry.tier }))
    for (const entry of ROLE_DEFAULTS) {
      if (!entry.always && !allKnown && !detection.ids.has(entry.agent)) {
        lines.push(`${entry.agent}: agent not detected — mapping is inert until you create it; pass --all-known to map anyway`)
      }
    }
  }
  const applied = []
  for (const pair of candidates) {
    if (!routing.tiers[pair.tier]) {
      lines.push(`${pair.agent}: tier ${pair.tier} is not configured; available: ${Object.keys(routing.tiers).join(", ")}`)
      continue
    }
    if (routing.roles[pair.agent] !== undefined && !force) {
      lines.push(`${pair.agent}: already mapped to ${routing.roles[pair.agent]}; use role set to change`)
      continue
    }
    routing.roles[pair.agent] = pair.tier
    applied.push(pair)
  }
  for (const pair of applied) {
    lines.push(`${pair.agent} -> ${pair.tier}  (undo: role remove ${pair.agent})`)
    const tier = routing.tiers[pair.tier]
    if (!tier.plans.length && !tier.payg.length) lines.push(`${pair.tier} has no model choices yet — ${pair.agent} keeps its agent pin until you add one`)
  }
  // Nothing confirmed -> skip the write entirely (no pointless backup).
  if (!applied.length) return { noWrite: true, lines: lines.length ? lines : ["no role mappings applied; nothing changed"] }
  return { lines }
}

async function readConfig(file) {
  let document
  try { document = JSON.parse(await fs.readFile(file, "utf8")) }
  catch (error) { fail(`cannot read JSON config ${file}: ${error.message}`) }
  const entries = (Array.isArray(document?.plugins) ? document.plugins : []).filter((entry) => entry && typeof entry === "object" &&
    typeof entry.package === "string" && /(^|\/)ultracode\/?$/.test(entry.package)) ?? []
  if (entries.length !== 1) fail(`expected exactly one Ultracode plugin entry in ${file}; found ${entries.length}`)
  if (!entries[0].options || typeof entries[0].options !== "object") entries[0].options = {}
  return { document, entry: entries[0] }
}
async function writeConfig(file, document, before) {
  // Refuse a concurrent editor instead of silently losing unrelated work.
  if (await fs.readFile(file, "utf8") !== before) fail("config changed while editing; retry")
  const stat = await fs.stat(file)
  const backup = `${file}.ultracode-config.bak`
  await fs.copyFile(file, backup)
  const name = path.join(path.dirname(file), `.ultracode-config-${process.pid}-${Date.now()}.tmp`)
  try {
    await fs.writeFile(name, JSON.stringify(document, null, 2) + "\n", { mode: stat.mode & 0o777 })
    await fs.rename(name, file)
  } finally { await fs.rm(name, { force: true }).catch(() => {}) }
  console.log(`saved ${file} (previous version: ${backup})`)
}
function summary(opts) {
  const { options: effective, warnings } = loadOptions(opts)
  return { settings: Object.fromEntries(["agent", "concurrency", "maxAgents", "timeoutMs", "permissions", "childStallMs", "failover", "providerConcurrency", "quotaCommand", "quotaSources"].map((k) => [k, effective[k]])),
    childLimits: effective.childLimits, routing: effective.routing, ...(warnings.length ? { warnings } : {}),
    note: "Plugin defaults only; project /ultracode set overlays can take precedence for panel settings and providerConcurrency." }
}
function tierSelection(tier) { return tier.selection === "weighted" ? "weighted" : "ordered" }
/** Configured (not eligibility-filtered) weighted pools: MAIN plans+mainWeight PAYG, then PAYG fallback. */
function configuredPools(tier) {
  const main = [
    ...tier.plans.flat().map((entry) => ({ entry, weight: entry.weight ?? 1 })),
    ...tier.payg.flat().filter((entry) => entry.mainWeight !== undefined).map((entry) => ({ entry, weight: entry.mainWeight })),
  ]
  const fallback = tier.payg.flat().map((entry) => ({ entry, weight: entry.weight ?? 1 }))
  return { main, fallback }
}
function poolPercents(members) {
  const total = members.reduce((sum, member) => sum + member.weight, 0)
  return new Map(members.map((member) => [member.entry, total > 0 ? (member.weight / total) * 100 : 0]))
}
/** Static pool share annotation, e.g. " w15 (43%)" or " w1* main (7%) / payg w5 (63%)". Only weighted tiers use weights. */
function weightAnnotation(entry, kind, tier, mainPct, fallbackPct) {
  if (tier.selection !== "weighted") return ""
  if (kind === "payg" && entry.mainWeight !== undefined) {
    // Both dials matter: mainWeight draws in the MAIN pool while plans are
    // eligible; `weight` decides the pure-PAYG fallback pool once they are not.
    const main = mainPct.get(entry)
    const payg = fallbackPct.get(entry)
    return ` w${entry.mainWeight}* main${main === undefined ? "" : ` (${Math.round(main)}%)`}` +
      ` / payg w${entry.weight ?? 1}${payg === undefined ? "" : ` (${Math.round(payg)}%)`}`
  }
  const pct = (kind === "plans" ? mainPct : fallbackPct).get(entry)
  return ` w${entry.weight ?? 1}${pct === undefined ? "" : ` (${Math.round(pct)}%)`}`
}
/** One-line tier contents for the confirm-each onboarding offer. */
function describeTier(tier, name, agent) {
  if (!tier) return `tier ${name} is not configured`
  if (!tier.plans.length && !tier.payg.length) return `no model choices yet — ${agent} keeps its agent pin until you add one`
  const parts = []
  for (const kind of ["plans", "payg"]) tier[kind].forEach((group, i) => parts.push(`${kind} ${i + 1}. ${group.map((entry) => entry.model).join(" ⇄ ")}`))
  return parts.join("; ")
}
/** Pool shares shown live while editing weights in the menu. */
function poolPreview(tier) {
  const { main, fallback } = configuredPools(tier)
  const lines = []
  if (main.length) lines.push(`main pool: ${main.map((m) => `${m.entry.model} w${m.weight}${tier.selection === "weighted" ? ` (${Math.round((m.weight / main.reduce((s, x) => s + x.weight, 0)) * 100)}%)` : ""}`).join(", ")}`)
  if (fallback.length) lines.push(`payg fallback pool: ${fallback.map((m) => `${m.entry.model} w${m.weight}${tier.selection === "weighted" ? ` (${Math.round((m.weight / fallback.reduce((s, x) => s + x.weight, 0)) * 100)}%)` : ""}`).join(", ")}`)
  if (!lines.length) lines.push("(no model choices)")
  return lines
}
function formatSummary(opts) {
  const { options, warnings } = loadOptions(opts)
  const lines = ["Ultracode settings (plugin defaults)",
    `  Agent: ${options.agent}     Children: ${Math.min(options.concurrency, 8)} concurrent / ${options.maxAgents} total`,
    `  Run timeout: ${Math.round(options.timeoutMs / 60000)} min     Idle child: ${Math.round(options.childStallMs / 60000)} min`,
    `  Permissions: ${options.permissions}     Failover: ${options.failover}`,
    `  Provider child caps: ${Object.entries(options.providerConcurrency).map(([id, cap]) => `${id}=${cap}`).join(", ") || "none"}`, "", "Roles"]
  const roles = options.routing?.roles ?? {}
  for (const [role, tier] of Object.entries(roles)) lines.push(`  ${role.padEnd(20)} ${tier}`)
  if (!options.routing) lines.push("  (routing off; agent pins decide)")
  else if (!Object.keys(roles).length) lines.push("  (no roles mapped; agent pins decide)")
  lines.push("", "Tiers (plans before payg; groups run in order, or weight-drawn when weighted)")
  for (const [name, tier] of Object.entries(options.routing?.tiers ?? {})) {
    lines.push(`  ${name}:  ${tierSelection(tier)}${tier.fallback ? `  fallback: ${tier.fallback}` : ""}`)
    if (!tier.plans.length && !tier.payg.length) {
      lines.push("    (no model choices — mapped agents keep their agent pins)")
      continue
    }
    const { main, fallback } = configuredPools(tier)
    const mainPct = poolPercents(main)
    const fallbackPct = poolPercents(fallback)
    for (const kind of ["plans", "payg"]) tier[kind].forEach((group, i) => {
      lines.push(`    ${kind} ${i + 1}. ${group.map((e) => `${e.model}${e.capacityPool ? ` [${e.capacityPool}]` : ""}${e.reservePercent === undefined ? "" : ` (keep ${e.reservePercent}%)`}${e.hours ? ` ${e.hours.join(":00–")}:00` : ""}${e.blockedWeekdayHours ? ` (weekday blocked ${e.blockedWeekdayHours.map((range) => `${range[0]}–${range[1]}`).join(", ")})` : ""}${weightAnnotation(e, kind, tier, mainPct, fallbackPct)}`).join(" ⇄ ")}`)
    })
  }
  if (options.routing) lines.push("  Set any agent with `role set <agent> <tier>`; pass `{ tier }` per call in a workflow to override.")
  lines.push("", "Model input limits (target → hard)")
  for (const [pin, limit] of Object.entries(options.childLimits)) lines.push(`  ${pin.padEnd(43)} ${limit.targetInput.toLocaleString()} → ${limit.hardInput.toLocaleString()}`)
  if (!Object.keys(options.childLimits).length) lines.push("  (none)")
  lines.push("", "Capacity sources")
  if (options.quotaCommand) lines.push(`  Legacy check-rate: ${options.quotaCommand.join(" ")}`)
  for (const [id, source] of Object.entries(options.quotaSources)) lines.push(`  ${id}: ${source.format} via ${source.command.join(" ")}`)
  if (!options.quotaCommand && !Object.keys(options.quotaSources).length) lines.push("  (none; reserved plans with unknown usage are skipped)")
  if (warnings.length) lines.push("", ...warnings.map((w) => `  Warning: ${w}`))
  lines.push("", "Project /ultracode set overrides may change panel settings and provider caps.")
  return lines.join("\n")
}
async function execute(file, args) {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") { console.log(HELP); return }
  const { document, entry } = await readConfig(file)
  const opts = entry.options
  const [area, verb] = args
  if (area === "list" || !area || area === "tier" && verb === "show") {
    if (area === "tier") console.log(JSON.stringify(ensureTier(ensureRouting(opts), args[2]), null, 2))
    else console.log(args.includes("--json") ? JSON.stringify(summary(opts)) : formatSummary(opts))
    return
  }
  if (area === "explain") {
    const json = args.includes("--json")
    args = args.filter((arg) => arg !== "--json")
    const role = args[1]
    if (!role) fail("explain requires an agent role")
    const atIndex = args.indexOf("--at")
    if (atIndex >= 0 && (args.length !== atIndex + 2 || atIndex > 3)) fail("usage: explain <role> [tier] [--at ISO]")
    const at = atIndex >= 0 ? new Date(args[atIndex + 1]) : new Date()
    if (Number.isNaN(at.getTime())) fail("--at requires a valid ISO date")
    const tier = atIndex >= 0 ? args.slice(2, atIndex)[0] : args[2]
    // Resolve the policy the way the plugin does, so a hand-edited policy (cycle,
    // unknown keys, invalid pin) fails loudly here instead of in the raw router.
    const validated = loadOptions(opts)
    if (validated.warnings.length) fail(validated.warnings.join("; "))
    const quota = capacityFeed(validated.options)
    let available
    try { available = new Set((await liveModels()).map((m) => `${m.providerID}/${m.id}`)) } catch { /* offline explanation still useful */ }
    const decision = await new ModelRouter(ensureRouting(validated.options)).select({ role, ...(tier ? { tier } : {}), now: at, quota, ...(available ? { available } : {}) })
    // Mirror primitives: an explicit hint that yields no model is an empty tier, and
    // the same hint in a workflow is a hard error. A role-based empty tier stays exit 0.
    if (tier !== undefined && decision.model === undefined) fail(`routing tier ${tier} is empty — configure it or drop the tier hint`)
    if (json) console.log(JSON.stringify({ time: at.toISOString(), ...decision }))
    else {
      const pool = decision.pool ? `\nPool:\n${decision.pool.map((entry) => `  - ${entry.model}  w${entry.weight} (${Math.round(entry.percent)}%)`).join("\n")}` : ""
      const chain = decision.fallbackChain ? `\nFallback chain: ${decision.fallbackChain.join(" -> ")}` : ""
      console.log(`${at.toISOString()}  ${role}${tier ? ` / ${tier}` : ""}\nSelected: ${decision.model ? `${decision.model.providerID}/${decision.model.id}${decision.model.variant ? `#${decision.model.variant}` : ""}` : "agent pin"}\n${decision.reason}${pool}${chain}${decision.skipped.length ? `\nSkipped:\n${decision.skipped.map((reason) => `  - ${reason}`).join("\n")}` : ""}\nSimulation: live rotations and provider availability may change the next pick.`)
    }
    return
  }
  if (area === "capacity" && verb === "status") {
    const configured = loadOptions(opts).options
    const pools = args[2] ? [args[2]] : Object.keys(configured.quotaSources)
    const quota = capacityFeed(configured)
    if (configured.quotaCommand && !pools.length) pools.push(...new Set(Object.values(configured.routing?.quotaIDs ?? {})))
    for (const id of pools) {
      const remaining = (await quota(id))?.remainingPercent
      console.log(`${id.padEnd(22)} ${remaining === undefined ? "unknown" : `${remaining}% remaining`}`)
    }
    if (!pools.length) console.log("No capacity sources configured.")
    return
  }
  const before = await fs.readFile(file, "utf8")
  const draft = structuredClone(document)
  // Locate the same entry in the clone (the live object is never mutated).
  const cloned = draft.plugins[document.plugins.indexOf(entry)]
  const effective = loadOptions(cloned.options)
  if (effective.warnings.length) fail(`existing Ultracode options have validation warnings: ${effective.warnings.join("; ")}`)
  cloned.options.childLimits ??= {}
  cloned.options.providerConcurrency ??= {}
  const outcome = await configure(cloned.options, args)
  // A no-op (for example an idempotent `role defaults`) short-circuits before the write gate.
  if (outcome?.noWrite) {
    for (const line of outcome.lines) console.log(line)
    return
  }
  const validated = loadOptions(cloned.options)
  if (validated.warnings.length) {
    // A refused write must not read like a state change: nothing was written and
    // routing is still live. Strip the runtime-only "— routing disabled" suffix.
    fail(`edit rejected, config unchanged: ${validated.warnings.map((w) => w.replace(/ — routing disabled$/, "")).join("; ")}`)
  }
  await writeConfig(file, draft, before)
  for (const line of outcome?.lines ?? []) console.log(line)
  if (area === "routing" && verb === "init" && !args.includes("--json")) {
    console.log(`Created tiers: ${Object.keys(cloned.options.routing.tiers).join(", ")}. No roles mapped yet — every child keeps its agent pin.`)
    console.log("Next: `opencode2 ultracode-config role defaults`, or the menu path `5. Roles & tiers → Suggest role defaults`.")
  }
  if (["concurrency", "maxAgents", "timeoutMs", "permissions"].includes(args[2]) || area === "provider") {
    console.log("Note: an existing /ultracode set runtime overlay may take precedence in a project.")
  }
}

/** Run `opencode2 api get <endpoint>` (same spawn+timeout pattern as the catalog) and parse the body. */
async function apiGetJson(endpoint) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ultracode-api-"))
  const name = path.join(directory, "body.json")
  try {
    const output = await fs.open(name, "w")
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.env.OPENCODE_BIN || "opencode2", ["api", "get", endpoint], { stdio: ["ignore", output.fd, "pipe"] })
        const timeout = setTimeout(() => child.kill(), 10_000)
        let error = ""
        child.stderr.on("data", (chunk) => { error = (error + chunk.toString()).slice(-1000) })
        child.once("error", (err) => { clearTimeout(timeout); reject(err) })
        child.once("close", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(error || `api get ${endpoint} exited ${code}`)) })
      })
    } finally { await output.close() }
    return JSON.parse(await fs.readFile(name, "utf8"))
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
}
async function liveModels() {
  const body = await apiGetJson("/api/model")
  const models = Array.isArray(body.data) ? body.data : []
  return models.filter((m) => typeof m?.providerID === "string" && typeof m?.id === "string" && m.enabled !== false)
}

/**
 * Best-effort agent roster for the onboarding offer. The live catalog wins;
 * otherwise scanned agent-file names; otherwise nothing (only the two
 * guaranteed built-ins are offered). Never throws and never changes a file.
 */
async function detectAgents() {
  try {
    const body = await apiGetJson("/api/agent")
    const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : []
    const ids = new Set(list.map((entry) => typeof entry === "string" ? entry : entry?.id ?? entry?.name).filter((id) => typeof id === "string" && id))
    if (ids.size) return { ids, source: "catalog" }
  } catch { /* offline: fall through to the agent files */ }
  const ids = new Set()
  for (const dir of [path.join(os.homedir(), ".config/opencode/agents"), path.join(process.cwd(), ".opencode/agents")]) {
    try {
      for (const file of await fs.readdir(dir)) if (file.endsWith(".md")) ids.add(file.slice(0, -3))
    } catch { /* missing or unreadable directory contributes nothing */ }
  }
  return { ids, source: ids.size ? "files" : "none" }
}

async function pick(rl, label, entries) {
  if (!entries.length) { console.log("  (none)"); return undefined }
  entries.forEach((entry, i) => console.log(`  ${i + 1}. ${entry}`))
  const answer = (await rl.question(`${label} (number or name, b=back): `)).trim()
  if (!answer || ["b", "q", "back"].includes(answer.toLowerCase())) return undefined
  const selected = /^\d+$/.test(answer) ? entries[Number(answer) - 1] : entries.find((entry) => entry === answer)
  if (!selected) throw new Error(`unknown ${label.toLowerCase()}: ${answer}`)
  return selected
}

async function chooseModel(rl) {
  let models
  try { models = await liveModels() }
  catch (error) {
    console.log(`Live catalog unavailable (${error.message}). You can enter a model pin manually.`)
    const manual = (await rl.question("provider/model[#variant] (b=back): ")).trim()
    if (!parseModelPin(manual)) { if (manual !== "b") console.log("Invalid model pin."); return undefined }
    return manual
  }
  const groups = [...new Set(models.map((m) => m.providerID))].sort()
  console.log("Providers (or /term to search all models):")
  groups.forEach((g, i) => console.log(`  ${i + 1}. ${g} (${models.filter((m) => m.providerID === g).length})`))
  const selection = (await rl.question("Provider number/name, /term, b=back: ")).trim()
  if (!selection || selection === "b") return undefined
  const provider = /^\d+$/.test(selection) ? groups[Number(selection) - 1] : selection
  const matching = selection.startsWith("/") ? models.filter((m) => `${m.providerID}/${m.id}`.toLowerCase().includes(selection.slice(1).toLowerCase())) :
    models.filter((m) => m.providerID === provider)
  if (!matching.length) { console.log("No matching models."); return undefined }
  const names = matching.map((m) => `${m.providerID}/${m.id}`)
  const chosen = await pick(rl, "Model", names)
  if (!chosen) return undefined
  const model = matching[names.indexOf(chosen)]
  const variants = (model.variants ?? []).map((v) => typeof v === "string" ? v : v.id).filter(Boolean)
  if (!variants.length) return chosen
  console.log("  0. default effort")
  const variant = await pick(rl, "Effort", variants)
  return variant ? `${chosen}#${variant}` : chosen
}

async function manageLimits(file, rl) {
  const opts = (await readConfig(file)).entry.options
  const pins = Object.keys(opts.childLimits ?? {})
  console.log("Model input limits (estimated active request, not cumulative usage):")
  pins.forEach((pin, i) => console.log(`  ${i + 1}. ${pin}: ${opts.childLimits[pin].targetInput} → ${opts.childLimits[pin].hardInput}`))
  const action = await pick(rl, "Action", ["Set or update limit", "Remove limit"])
  if (!action) return
  const model = action === "Remove limit" ? await pick(rl, "Model", pins) : await chooseModel(rl)
  if (!model) return
  if (action === "Remove limit") return execute(file, ["limits", "remove", model])
  const current = opts.childLimits?.[model]
  const target = (await rl.question(`Target input tokens [${current?.targetInput ?? 250000}]: `)).trim() || String(current?.targetInput ?? 250000)
  const hard = (await rl.question(`Hard input tokens [${current?.hardInput ?? 300000}]: `)).trim() || String(current?.hardInput ?? 300000)
  await execute(file, ["limits", "set", model, target, hard])
}

async function manageTiers(file, rl) {
  const opts = (await readConfig(file)).entry.options
  const routing = ensureRouting(opts)
  const name = await pick(rl, "Tier", Object.keys(routing.tiers))
  if (!name) return
  const tier = routing.tiers[name]
  console.log(`\n${name} (top group first; models in a group rotate):`)
  for (const kind of ["plans", "payg"]) tier[kind].forEach((group, i) =>
    console.log(`  ${kind} ${i + 1}: ${group.map((entry) => entry.model).join(" ⇄ ")}`))
  const action = await pick(rl, "Action", ["Add model", "Change model rules", "Move model", "Remove model", "Weights & selection"])
  if (!action) return
  if (action === "Weights & selection") return editSelection(file, rl, name)
  const entries = [...tier.plans.flat(), ...tier.payg.flat()]
  const model = action === "Add model" ? await chooseModel(rl) : await pick(rl, "Model", entries.map((e) => e.model))
  if (!model) return
  if (action === "Remove model") return execute(file, ["tier", "remove", name, model])
  if (action === "Move model" || action === "Add model") {
    const className = await pick(rl, "Capacity class", ["Subscription plan", "Pay as you go"])
    if (!className) return
    const kind = className === "Subscription plan" ? "plans" : "payg"
    const groups = tier[kind].map((g, i) => `Rotate with group ${i + 1}: ${g.map((e) => e.model).join(", ")}`)
    const destination = await pick(rl, "Preference", [...groups, "New lowest-priority group"])
    if (!destination) return
    const index = groups.indexOf(destination) < 0 ? groups.length : groups.indexOf(destination)
    if (action === "Move model") return execute(file, ["tier", "move", name, model, kind, String(index)])
    await execute(file, ["tier", "add", name, kind, model, "--group", String(index)])
  }
  const current = candidateLocation(ensureRouting((await readConfig(file)).entry.options), name, model)?.entry
  const change = await pick(rl, "Rule", ["Keep as shown", "Set reserve", "Set allowed hours", "Set blocked weekday hours", "Bind capacity pool"])
  if (!change || change === "Keep as shown") return
  if (change === "Bind capacity pool") {
    const pools = Object.keys((await readConfig(file)).entry.options.quotaSources ?? {})
    if (!pools.length) { console.log("First configure a capacity source under Capacity & usage."); return }
    const pool = await pick(rl, "Capacity pool", pools)
    if (pool) await execute(file, ["capacity", "bind", name, model, pool])
    return
  }
  const flag = change === "Set reserve" ? "--reserve" : change === "Set allowed hours" ? "--hours" : "--blocked"
  const prompt = flag === "--reserve" ? `Reserve percentage [${current?.reservePercent ?? "none"}]: ` :
    flag === "--hours" ? "Allowed local hours (e.g. 22-8, or none): " : "Blocked weekday hours (e.g. 9-12,14-18, or none): "
  const value = (await rl.question(prompt)).trim()
  if (value) await execute(file, ["tier", "edit", name, model, flag, value])
}

/** Weight editing with live pool-share feedback, inside the tier editor's Weights & selection flow. */
async function editSelection(file, rl, name) {
  while (true) {
    const routing = ensureRouting((await readConfig(file)).entry.options)
    const tier = routing.tiers[name]
    console.log(`\n${name}: ${tierSelection(tier)}${tier.fallback ? `  fallback: ${tier.fallback}` : ""}`)
    for (const line of poolPreview(tier)) console.log(`  ${line}`)
    const action = await pick(rl, "Weights & selection", ["Set selection mode", "Edit model weight", "Set fallback tier", "Back"])
    if (!action || action === "Back") return
    if (action === "Set selection mode") {
      const mode = await pick(rl, "Mode", ["ordered", "weighted"])
      if (mode) await execute(file, ["tier", "mode", name, mode])
    } else if (action === "Set fallback tier") {
      const others = Object.keys(routing.tiers).filter((candidate) => candidate !== name)
      const target = await pick(rl, "Fallback when nothing is eligible", ["none", ...others])
      if (target !== undefined) await execute(file, ["tier", "fallback", name, target])
    } else {
      const model = await pick(rl, "Model", [...tier.plans.flat(), ...tier.payg.flat()].map((entry) => entry.model))
      if (!model) continue
      const location = candidateLocation(routing, name, model)
      // Label the field by kind: a plans candidate's `weight` is its MAIN-pool
      // draw, while a payg candidate has both a fallback-pool `weight` and an
      // optional `mainWeight`. The flags stay `--weight` / `--main-weight`.
      const field = location.kind === "payg"
        ? await pick(rl, "Weight to edit", ["payg fallback weight", "main pool weight (mainWeight)"])
        : "main weight"
      if (!field) continue
      const main = field === "main pool weight (mainWeight)"
      const current = main ? location.entry.mainWeight : location.entry.weight
      const raw = (await rl.question(`Weight [${current ?? "default 1"}], positive up to 10000, or none: `)).trim()
      if (!raw) continue
      const clone = structuredClone(tier)
      const edited = [...clone.plans.flat(), ...clone.payg.flat()].find((entry) => entry.model === model)
      if (raw === "none") { if (main) delete edited.mainWeight; else delete edited.weight }
      else if (main) edited.mainWeight = weight(raw, "mainWeight"); else edited.weight = weight(raw, "weight")
      for (const line of poolPreview(clone)) console.log(`  projected ${line}`)
      await execute(file, ["tier", "edit", name, model, main ? "--main-weight" : "--weight", raw])
    }
  }
}

/** Confirm-each onboarding offer; one batched write of the accepted agent -> tier edges. */
async function offerRoleDefaults(file, rl) {
  const routing = ensureRouting((await readConfig(file)).entry.options)
  const detection = await detectAgents()
  const selected = []
  let all = false
  for (const entry of ROLE_DEFAULTS) {
    if (routing.roles[entry.agent] !== undefined) {
      console.log(`  ${entry.agent}: already mapped to ${routing.roles[entry.agent]} (use Set role tier to change)`)
      continue
    }
    if (!routing.tiers[entry.tier]) {
      console.log(`  ${entry.agent}: tier ${entry.tier} is not configured (available: ${Object.keys(routing.tiers).join(", ")})`)
      continue
    }
    if (!entry.always && !detection.ids.has(entry.agent)) {
      console.log(`  ${entry.agent}: agent not detected — mapping is inert until you create it (skipped)`)
      continue
    }
    if (!all) {
      console.log(`\n  ${entry.agent} -> ${entry.tier}   (${entry.tier}: ${describeTier(routing.tiers[entry.tier], entry.tier, entry.agent)})`)
      console.log(`    ${entry.why}`)
      const answer = (await rl.question("    y / n / s(skip rest) / a(all remaining): ")).trim().toLowerCase()
      if (answer === "s") break
      if (answer === "a") all = true
      else if (answer !== "y") continue
    }
    selected.push(entry)
  }
  if (!selected.length) { console.log("No role mappings applied."); return }
  await execute(file, ["role", "defaults", ...selected.map((entry) => `${entry.agent}=${entry.tier}`)])
}

async function manageCapacity(file, rl) {
  const opts = (await readConfig(file)).entry.options
  console.log("Named pools provide remaining quota independently of a model or provider.")
  if (opts.quotaCommand) console.log("  Existing check-rate adapter (legacy; preserved): " + opts.quotaCommand.join(" "))
  for (const [id, source] of Object.entries(opts.quotaSources ?? {})) console.log(`  ${id}: ${source.format} ${source.command.join(" ")}`)
  const action = await pick(rl, "Action", ["Add usage checker", "Bind a model to a pool", "Remove usage checker"])
  if (!action) return
  if (action === "Add usage checker") {
    const format = await pick(rl, "Checker output", ["Portable capacity-v1", "My opencode2 check-rate --json"])
    if (!format) return
    const id = (await rl.question(format === "Portable capacity-v1" ? "Pool id emitted by your checker: " : "Provider id in check-rate output (e.g. alibaba-token-plan): ")).trim()
    if (!id) return
    const command = format === "My opencode2 check-rate --json" ? ["opencode2", "check-rate", "--json"] :
      [(await rl.question("Executable path: ")).trim(), ...(await rl.question("Arguments (space-separated; blank for none): ")).trim().split(/\s+/).filter(Boolean)]
    await execute(file, ["capacity", "source", id, format === "Portable capacity-v1" ? "capacity-v1" : "check-rate", ...command])
    await execute(file, ["capacity", "status", id])
    console.log("Bind a tier's model to this pool under Capacity & usage → Bind a model to a pool.")
  } else if (action === "Remove usage checker") {
    const id = await pick(rl, "Capacity pool", Object.keys(opts.quotaSources ?? {}))
    if (id) await execute(file, ["capacity", "remove", id])
  } else {
    const routing = ensureRouting(opts)
    const tier = await pick(rl, "Tier", Object.keys(routing.tiers))
    if (!tier) return
    const model = await pick(rl, "Model", [...routing.tiers[tier].plans.flat(), ...routing.tiers[tier].payg.flat()].map((e) => e.model))
    if (!model) return
    const pool = await pick(rl, "Capacity pool", Object.keys(opts.quotaSources ?? {}))
    if (pool) await execute(file, ["capacity", "bind", tier, model, pool])
  }
}

async function interactive(file) {
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    console.log("Ultracode settings (ordinary subagent pins are separate). Changes are backed up.\n")
    while (true) {
      console.log("1. Overview  2. Explain a route  3. Model input limits  4. Model choices")
      console.log("5. Roles & tiers  6. Provider concurrency  7. General settings  8. Capacity & usage  q. Quit")
      const choice = (await rl.question("choice: ")).trim()
      if (choice === "q" || choice === "quit") break
      try {
        if (choice === "1") await execute(file, ["list"])
        else if (choice === "2") {
          const options = (await readConfig(file)).entry.options
          const routing = ensureRouting(options)
          const roles = Object.keys(routing.roles)
          if (roles.length) {
            const role = await pick(rl, "Role", roles)
            if (role) await execute(file, ["explain", role])
          } else {
            console.log("No roles mapped yet. Pick a tier to explain an explicit route.")
            const tier = await pick(rl, "Tier", Object.keys(routing.tiers))
            if (tier) await execute(file, ["explain", loadOptions(options).options.agent, tier])
          }
        } else if (choice === "3") await manageLimits(file, rl)
        else if (choice === "4") await manageTiers(file, rl)
        else if (choice === "5") {
          const options = (await readConfig(file)).entry.options
          if (!options.routing) {
            console.log("No routing policy yet. Initializing creates empty lite/standard/strong/frontier tiers; you choose every model.")
            const zone = (await rl.question("IANA timezone for the routing policy (e.g. Asia/Hong_Kong): ")).trim()
            if (zone) { await execute(file, ["routing", "init", zone]); await offerRoleDefaults(file, rl) }
          } else {
            const routing = ensureRouting(options)
            const action = await pick(rl, "Action", ["Set role tier", "Remove role mapping", "Create tier", "Delete tier", "Set timezone", "Suggest role defaults"])
            if (action === "Create tier") {
              const name = (await rl.question("New tier name: ")).trim()
              if (name) await execute(file, ["tier", "create", name])
            } else if (action === "Delete tier") {
              const name = await pick(rl, "Tier", Object.keys(routing.tiers))
              if (name) await execute(file, ["tier", "delete", name])
            } else if (action === "Set timezone") {
              const zone = (await rl.question(`Timezone [${routing.timezone}]: `)).trim()
              if (zone) await execute(file, ["routing", "timezone", zone])
            } else if (action === "Suggest role defaults") {
              await offerRoleDefaults(file, rl)
            } else if (action === "Set role tier" || action === "Remove role mapping") {
              const role = await pick(rl, "Role", [...new Set([...Object.keys(routing.roles), "New role…"])])
              if (!role) continue
              const id = role === "New role…" ? (await rl.question("Agent id: ")).trim() : role
              if (!id) continue
              if (action === "Remove role mapping") await execute(file, ["role", "remove", id])
              else {
                const tier = await pick(rl, "Tier", Object.keys(routing.tiers))
                if (tier) await execute(file, ["role", "set", id, tier])
              }
            }
          }
        } else if (choice === "6") {
          const options = (await readConfig(file)).entry.options
          const action = await pick(rl, "Action", ["Set", "Remove"])
          if (!action) continue
          const selected = await pick(rl, "Provider", [...Object.keys(options.providerConcurrency ?? {}), ...(action === "Set" ? ["New provider…"] : [])])
          if (!selected) continue
          const name = selected === "New provider…" ? (await rl.question("Provider id: ")).trim() : selected
          if (!name) continue
          const args = ["provider", action.toLowerCase(), name]
          if (action === "Set") {
            const value = (await rl.question("Maximum concurrent children for this provider (1–16): ")).trim()
            if (!value) continue
            args.push(value)
          }
          await execute(file, args)
        } else if (choice === "7") {
          const key = await pick(rl, "Setting", ["concurrency", "maxAgents", "timeoutMs", "childStallMs", "permissions", "failover", "agent"])
          if (!key) continue
          const raw = (await rl.question(`${key} (number or name): `)).trim()
          if (raw) await execute(file, ["setting", "set", key, JSON.stringify(/^\d+$/.test(raw) ? Number(raw) : raw)])
        } else if (choice === "8") await manageCapacity(file, rl)
        else console.log("Unknown choice; use q to quit.")
      } catch (error) { console.error(`error: ${error.message}`) }
      console.log("")
    }
  } finally { rl.close() }
}

async function main(argv) {
  let file = path.join(os.homedir(), ".config/opencode/opencode.json")
  if (argv[0] === "--config") {
    if (!argv[1]) fail("--config requires a JSON file path")
    file = path.resolve(argv[1]); argv = argv.slice(2)
  }
  if (!argv.length) await interactive(file)
  else await execute(file, argv)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(`ultracode-config: ${error.message}`); process.exitCode = 1 })
}
