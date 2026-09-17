/**
 * Script templates: ready-to-adapt script bodies for the shapes that keep
 * being hand-rolled in script mode (sequential write stages with verify-fix
 * gates; a bounded fix loop). Graph mode got served templates first because
 * authoring a DAG from a blank page is the most expensive path; script mode
 * pays the same tax per session — these remove the machinery, leaving prompts
 * and args to edit.
 *
 * Rules these obey (enforced by test/script-templates.test.ts):
 *  - every body passes validateScriptSource (no module syntax, no banned
 *    identifiers) — they run as-is via ultracode_run { script };
 *  - every loop is bounded and every fan-in capped (slice) — a template can
 *    never expand into an unbounded run;
 *  - anything the script branches on comes back through opts.schema;
 *  - write agents run sequentially (one write agent at a time);
 *  - every deterministic agent call carries a stable opts.key so a warm rerun
 *    replays finished children;
 *  - stock agents only; no provider or model ids;
 *  - each body declares its args in a `// Tool input:` header so a saved copy
 *    reports proper params in ultracode_catalog.
 *
 * Pure module: no plugin imports, no I/O.
 */

export interface ScriptTemplate {
  /** Stable id used by `ultracode_catalog { scriptTemplate: "<name>" }`. */
  name: string
  /** One-line "use this when" — the catalog shows this without the body. */
  description: string
  /** The args the template reads (names only; see src/params.ts). */
  args: string[]
  /** A complete async-function-body script. */
  script: string
}

/** Hard cap on a served body — the catalog returns these whole. */
export const MAX_SCRIPT_TEMPLATE_CHARS = 12_000

const STAGED_DELIVERY = `// staged-delivery — sequential write stages, each gated by an independent
// verifier with bounded fix rounds. One write agent at a time; a stage that
// cannot pass stops the run with a partial report instead of continuing.
// Budget before running: each stage costs ~2 child calls (more with fixes) at
// ~5-10 min each — if stages × ~10 min exceeds the configured timeout, pass
// timeoutMs in the run call (ultracode_catalog reports the live cap).
// Tool input: { args: { goal: "one sentence every child prompt carries", stages: [{ id: "short-id", work: "self-contained brief for the writer", verify: "self-contained check list for the verifier" }], maxFixes: 2 } }
if (!args || !Array.isArray(args.stages) || args.stages.length === 0) {
  throw new Error("staged-delivery: args.stages must be a non-empty array of { id, work, verify }")
}
const goal = String(args.goal || "")
const seen = Object.create(null)
const stages = args.stages
  .slice(0, 12)
  .map((s) => ({ id: String((s && s.id) || "stage"), work: String((s && s.work) || ""), verify: String((s && s.verify) || "") }))
  .map((s) => {
    // Distinct keys per stage (duplicate ids collide on "<id>:write" in the
    // warm cache) and bounded (opt keys truncate past 128 chars). Base keeps
    // room for a "-N" suffix, and the loop guards a user id like "dup-2".
    const base = s.id.slice(0, 44) || "stage"
    if (!seen[base]) {
      seen[base] = 1
      return { id: base, work: s.work, verify: s.verify }
    }
    let n = ++seen[base]
    let id = base + "-" + n
    while (seen[id]) {
      id = (base + "-" + ++n).slice(0, 48)
    }
    seen[id] = 1
    return { id: id, work: s.work, verify: s.verify }
  })
const maxFixes = Math.max(1, Math.min(Number.isFinite(Number(args.maxFixes)) ? Number(args.maxFixes) : 2, 4))

const DONE = { type: "object", required: ["done", "summary"], properties: {
  done: { type: "boolean" }, summary: { type: "string" }, commit: { type: "string" } } }
const VERIFY = { type: "object", required: ["pass", "issues"], properties: {
  pass: { type: "boolean" },
  issues: { type: "array", items: { type: "object", required: ["severity", "issue"], properties: {
    severity: { type: "string", enum: ["blocker", "major", "minor"] }, issue: { type: "string" } } } },
  summary: { type: "string" } } }

const out = { goal: goal, passedStages: 0, total: stages.length, stages: [] }
for (const st of stages) {
  progress(st.id + ": write")
  const w = await agent(
    goal + "\\nStage " + st.id + ": " + st.work +
    "\\nFinish the stage completely, then report. Include the commit hash if you committed.",
    { agent: "general", phase: st.id, label: st.id + ":write", key: st.id + ":write", schema: DONE }
  ).catch(() => null)
  if (!w || !w.data || !w.data.done) {
    out.stages.push({ id: st.id, passed: false, rounds: 0,
      summary: "writer did not finish: " + ((w && w.data && w.data.summary) || "no report") })
    break
  }
  let ok = false
  let rounds = 0
  let summary = ""
  for (let round = 0; round <= maxFixes; round++) {
    rounds = round
    const v = await agent(
      "You did not write these changes — verify them fresh.\\n" + goal +
      "\\nStage " + st.id + " brief: " + st.work + "\\nWriter reported commit: " + (w.data.commit || "none") +
      "\\nCheck: " + st.verify +
      "\\npass=false only when a blocker or major issue remains; record minors in issues.",
      { agent: "general", phase: st.id, label: st.id + ":verify" + round, key: st.id + ":verify" + round, schema: VERIFY }
    ).catch(() => null)
    if (!v || !v.data) { summary = "verifier unavailable"; break }
    const hard = (v.data.issues || []).filter((i) => i.severity !== "minor")
    summary = v.data.summary || ""
    if (v.data.pass && hard.length === 0) { ok = true; break }
    if (!v.data.pass && (v.data.issues || []).length === 0) {
      // A fail verdict that names no issue cannot drive a fix pass — treat the
      // stage as failed rather than spawning a fix child over an empty list.
      summary = summary || "verifier failed without naming issues"
      break
    }
    if (round === maxFixes) break
    progress(st.id + ": fix round " + (round + 1) + " (" + hard.length + " hard issues)")
    await agent(
      "Fix exactly these issues in stage " + st.id + "; change nothing else.\\n" + goal +
      "\\nStage brief: " + st.work + "\\nIssues:\\n" + JSON.stringify(hard.length ? hard : v.data.issues || [], null, 1),
      { agent: "general", phase: st.id, label: st.id + ":fix" + (round + 1), key: st.id + ":fix" + (round + 1), schema: DONE }
    ).catch(() => null)
  }
  out.stages.push({ id: st.id, passed: ok, rounds: rounds, summary: summary })
  checkpoint("stage-" + st.id, { passed: ok })
  if (!ok) break
  out.passedStages++
}
return out`

const VERIFY_FIX = `// verify-fix — bounded fix loop over a known issue list: one write agent
// per pass, one independent recheck after each pass, survivors carry forward.
// Budget: 2 child calls per pass; pass timeoutMs if passes × ~10 min exceeds
// the configured timeout (ultracode_catalog reports the live cap).
// Tool input: { args: { goal: "what the fixes serve", issues: ["issue", "..."], maxPasses: 3 } }
if (!args || !Array.isArray(args.issues) || args.issues.length === 0) {
  throw new Error("verify-fix: args.issues must be a non-empty array of issue strings")
}
const goal = String(args.goal || "")
const start = args.issues.map(String).slice(0, 50)
const maxPasses = Math.max(1, Math.min(Number.isFinite(Number(args.maxPasses)) ? Number(args.maxPasses) : 3, 5))

const ISSUES = { type: "object", required: ["issues"], properties: {
  issues: { type: "array", items: { type: "string" } } } }

let open = start
let passesUsed = 0
const passes = []
for (let pass = 1; pass <= maxPasses && open.length > 0; pass++) {
  passesUsed = pass
  progress("pass " + pass + ": " + open.length + " open")
  const fix = await agent(
    goal + "\\nFix exactly these issues; change nothing else.\\n" + JSON.stringify(open, null, 1),
    { agent: "general", phase: "fix", label: "fix" + pass, key: "fix:" + pass }
  ).catch(() => null)
  const recheck = await agent(
    "You did not write these fixes — check them fresh. List the issues that still exist, survivors only.\\n" +
    goal + "\\nIssues:\\n" + JSON.stringify(open, null, 1),
    { agent: "general", phase: "recheck", label: "recheck" + pass, key: "recheck:" + pass, schema: ISSUES }
  ).catch(() => null)
  if (!recheck || !recheck.data) {
    passes.push({ pass: pass, fixOk: !!fix, verified: false })
    break // cannot verify — keep the pass, stop looping
  }
  open = recheck.data.issues || []
  passes.push({ pass: pass, fixOk: !!fix, verified: true, remaining: open.length })
  checkpoint("fix-pass-" + pass, { open: open.length })
}
return { goal: goal, remaining: open.length, open: open, passesUsed: passesUsed, passes: passes }`

// ---------------------------------------------------------------------------
// Loop templates (loop() runtime: engine-owned budgets, verdicts, stall)
// ---------------------------------------------------------------------------

const KANBAN = `// kanban — worklist loop: pull ONE ticket at a time and run it through a team
// pipeline (plan -> implement -> review); review findings become follow-up
// tickets; the queue drains or budgets stop the run. One writer per iteration.
// Seed note: tickets can come from any tracker — a first explore agent can
// parse a markdown/CSV board into args.tickets; the engine never reads files.
// Tool input: { args: { goal: "what done means", tickets: [{ text: "ticket", id: "T-1", deps: [], tags: ["ui"] }], maxIterations: 12, agentsPerIteration: 6, reviewer: "general" } }
if (!args || !Array.isArray(args.tickets) || args.tickets.length === 0) {
  throw new Error("kanban: args.tickets must be a non-empty array of { text }")
}
const goal = String(args.goal || "")
const maxIterations = Math.max(
  1,
  Math.min(Number.isFinite(Number(args.maxIterations)) ? Math.floor(Number(args.maxIterations)) : args.tickets.length + 8, 50)
)
const agentsPerIteration = Math.max(
  4,
  Math.min(Number.isFinite(Number(args.agentsPerIteration)) ? Math.floor(Number(args.agentsPerIteration)) : 6, 12)
)
const reviewer = typeof args.reviewer === "string" && args.reviewer.trim() ? args.reviewer.trim() : "general"

// Build the seed queue once and reject dangling dependencies up front: a dep
// on an unknown id can never become ready, and the loop would otherwise sit
// idle until the stall stop with nothing actionable to report.
const seedQueue = queue(args.tickets, { id: "id" })
const seedItems = seedQueue.items()
const seedIds = {}
for (let svi = 0; svi < seedItems.length; svi++) seedIds[seedItems[svi].id] = true
const dangling = []
for (let sdi = 0; sdi < seedItems.length; sdi++) {
  const depList = seedItems[sdi].deps || []
  for (let sdj = 0; sdj < depList.length; sdj++) {
    if (!seedIds[depList[sdj]]) dangling.push(seedItems[sdi].id + " -> " + depList[sdj])
  }
}
if (dangling.length > 0) {
  throw new Error("kanban: tickets depend on unknown ids (would never become ready): " + dangling.slice(0, 5).join(", "))
}

const KPLAN = { type: "object", required: ["approach", "steps"], properties: {
  approach: { type: "string" },
  steps: { type: "array", items: { type: "string" } },
  risks: { type: "array", items: { type: "string" } } } }
const KWORK = { type: "object", required: ["done", "summary"], properties: {
  done: { type: "boolean" }, summary: { type: "string" },
  files: { type: "array", items: { type: "string" } } } }
const KREVIEW = { type: "object", required: ["pass", "issues"], properties: {
  pass: { type: "boolean" },
  issues: { type: "array", items: { type: "object", required: ["issue"], properties: {
    issue: { type: "string" }, suggestion: { type: "string" }, severity: { type: "string" } } } },
  evidence: { type: "string" } } }

const summary = await loop({
  key: "kanban",
  goal: goal || "process the ticket queue",
  state: { tickets: seedItems, processed: [], followUps: 0 },
  budget: { iterations: maxIterations, agentsPerIteration: agentsPerIteration },
  stop: { predicate: function (v) {
    const open = (v.state.tickets || []).filter(function (t) { return t.status !== "done" && t.status !== "blocked" })
    return open.length === 0 ? "queue-empty" : false
  }, stallK: 4 },
}, async function (ctx) {
  const q = queue(ctx.state.tickets, { id: "id" })
  const ticket = q.pop()
  if (!ticket) return { state: ctx.state, result: { idle: true, queue: q.sizes() } }
  const tid = ticket.id.slice(0, 22)
  progress("ticket: " + String(ticket.text).slice(0, 100))
  const ticketJson = JSON.stringify({ id: ticket.id, text: ticket.text })
  const plan = (await agent(
    goal + "\\nPlan ONE ticket before any changes. Inspect the repo as needed.\\nTicket: " + ticketJson +
    "\\nRespond JSON: approach, ordered steps, risks.",
    { agent: "explore", schema: KPLAN, key: "kanban:" + tid + ":plan", label: tid + ":plan", phase: "kanban" }
  )).data || {}
  const work = (await agent(
    goal + "\\nImplement the ticket now; change only what it needs.\\nTicket: " + ticketJson +
    "\\nPlan:\\n" + JSON.stringify(plan) + "\\nRespond JSON: done, summary, files.",
    { schema: KWORK, key: "kanban:" + tid + ":work", label: tid + ":work", phase: "kanban" }
  )).data || { done: false, summary: "no structured reply" }
  let review = { pass: false, issues: [], evidence: "reviewer unavailable" }
  try {
    review = (await agent(
      goal + "\\nReview the completed ticket as an adversary; verify the claims against the actual diff/files.\\nTicket: " + ticketJson +
      "\\nClaims:\\n" + JSON.stringify(work) +
      "\\nRespond JSON: pass, issues [{issue, suggestion, severity}], evidence (quote what you checked).",
      { agent: reviewer, schema: KREVIEW, key: "kanban:" + tid + ":review", label: tid + ":review", phase: "kanban" }
    )).data || review
  } catch (e) {
    review = { pass: false, issues: [], evidence: "reviewer unavailable: " + (e && e.message ? e.message : String(e)) }
  }
  let followUps = 0
  const openIssues = Array.isArray(review.issues) ? review.issues.slice(0, 6) : []
  if (work.done === true && review.pass === true) {
    q.done(ticket.id, "review passed")
  } else if (work.done === true && openIssues.length > 0) {
    q.done(ticket.id, "findings deferred to a follow-up")
    const text = "Address review findings for " + ticket.id + ": " +
      openIssues.map(function (i) { return i.issue + (i.suggestion ? " (" + i.suggestion + ")" : "") }).join("; ")
    q.push({ text: text, tags: (ticket.tags || []).concat(["follow-up"]), meta: { from: ticket.id } })
    followUps = 1
  } else if (work.done !== true) {
    q.block(ticket.id, "implementation incomplete")
  } else {
    q.done(ticket.id, "review did not pass cleanly")
  }
  const processed = ctx.state.processed.concat([{ id: ticket.id, workOk: work.done === true, reviewPass: review.pass === true, followUps: followUps }])
  return {
    state: { tickets: q.items(), processed: processed, followUps: ctx.state.followUps + followUps },
    result: processed[processed.length - 1],
  }
})

const tickets = (summary.state && summary.state.tickets) || []
const sizes = queue(tickets).sizes()
return {
  stopReason: summary.stopReason,
  iterations: summary.iterations,
  processed: ((summary.state && summary.state.processed) || []).length,
  reviewPassed: ((summary.state && summary.state.processed) || []).filter(function (p) { return p.reviewPass === true }).length,
  queue: sizes,
  spent: summary.spent,
  remaining: tickets
    .filter(function (t) { return t.status !== "done" })
    .map(function (t) { return { id: t.id, text: t.text, status: t.status, note: t.note } }),
}`

const KAGGLE_ML = `// kaggle-ml — refinement loop for ML/quant work: reflect, propose per-component
// variations, SELECT <=3 full configs (never the cross product), run each in its
// own artifacts dir, judge metrics from evidence, keep the best. Not grid search.
// Tool input: { args: { goal: "best CV score", components: ["data", "features", "model"], metric: "cv", target: 0.9, evalCommand: "python eval.py", dataRoot: "/data", judge: "general", deadline: "2026-09-18T08:00:00", maxIterations: 8, agentsPerIteration: 12 } }
if (!args || typeof args.goal !== "string" || args.goal.trim() === "") {
  throw new Error("kaggle-ml: args.goal is required (what to optimize)")
}
if (!Array.isArray(args.components) || args.components.length === 0) {
  throw new Error("kaggle-ml: args.components must be a non-empty array, e.g. [\\"data\\", \\"features\\", \\"model\\"]")
}
const goal = args.goal.trim()
const components = args.components.slice(0, 5).map(String)
const metric = typeof args.metric === "string" && args.metric.trim() ? args.metric.trim() : "score"
const target = Number(args.target)
const hasTarget = Number.isFinite(target)
const evalCommand = typeof args.evalCommand === "string" && args.evalCommand.trim() ? args.evalCommand.trim() : ""
const dataRoot = typeof args.dataRoot === "string" && args.dataRoot.trim() ? args.dataRoot.trim() : ""
const judge = typeof args.judge === "string" && args.judge.trim() ? args.judge.trim() : "general"
const maxIterations = Math.max(
  1,
  Math.min(Number.isFinite(Number(args.maxIterations)) ? Math.floor(Number(args.maxIterations)) : 8, 20)
)
const agentsPerIteration = Math.max(
  6,
  Math.min(Number.isFinite(Number(args.agentsPerIteration)) ? Math.floor(Number(args.agentsPerIteration)) : 12, 20)
)

const MPLAN = { type: "object", required: ["strategy", "components"], properties: { strategy: { type: "string" }, components: { type: "array", items: { type: "object", required: ["id", "focus"], properties: { id: { type: "string" }, focus: { type: "string" }, status: { type: "string", enum: ["active", "dropped", "new"] } } } } } }
const MIDEA = { type: "object", required: ["variations"], properties: { variations: { type: "array", items: { type: "object", required: ["idea", "rationale"], properties: { idea: { type: "string" }, rationale: { type: "string" } } } } } }
const MSELECT = { type: "object", required: ["configs"], properties: { configs: { type: "array", items: { type: "object", required: ["id", "chosen", "why"], properties: { id: { type: "string" }, chosen: { type: "array", items: { type: "object", required: ["componentId", "variationId"], properties: { componentId: { type: "string" }, variationId: { type: "string" } } } }, why: { type: "string" } } } } } }
const MBUILD = { type: "object", required: ["candidateId", "metrics", "evidence"], properties: { candidateId: { type: "string" }, metrics: { type: "object" }, evidence: { type: "object", required: ["command", "outputQuote"], properties: { command: { type: "string" }, exitCode: { type: "number" }, outputQuote: { type: "string" } } }, artifactsRef: { type: "string" } } }
const MVERDICT = { type: "object", required: ["status", "metrics", "evidence"], properties: { status: { type: "string", enum: ["improve", "done", "blocked"] }, metrics: { type: "object" }, candidateId: { type: "string" }, evidence: { type: "object", required: ["command", "outputQuote"], properties: { command: { type: "string" }, exitCode: { type: "number" }, outputQuote: { type: "string" } } } } }

const summary = await loop({
  key: "kaggle-ml",
  goal: goal,
  state: { plan: null, trials: [], best: null, rounds: [] },
  budget: {
    iterations: maxIterations,
    agentsPerIteration: agentsPerIteration,
    ...(typeof args.deadline === "string" && args.deadline ? { deadline: args.deadline } : {}),
  },
  stop: { predicate: function (v) {
    if (!hasTarget || !v.verdict || !v.verdict.metrics) return false
    const got = Number(v.verdict.metrics[metric])
    return Number.isFinite(got) && got >= target ? "target" : false
  }, stallK: 3 },
  verdict: {
    agent: judge,
    schema: MVERDICT,
    prompt: function (c) {
      return "Judge ML round " + c.i + " for: " + goal +
        ".\\nMetric: " + metric + (hasTarget ? " (target >= " + target + ")" : "") +
        ".\\nRound result: " + JSON.stringify(c.result) +
        ".\\nBest metrics: " + JSON.stringify(c.state.best && c.state.best.metrics ? c.state.best.metrics : null) +
        ".\\nRE-DERIVE the best candidate's metric: run the evaluation, quote the command and the number. status=done ONLY if your own re-derivation meets the target." +
        ".\\nSet candidateId to the id of the round candidate you re-derived (see round result); metrics = YOUR numbers."
    },
  },
}, async function (ctx) {
  const state = ctx.state || {}
  const trials = (state.trials || []).slice()
  // Fold judge metrics into the trials.
  if (
    ctx.lastVerdict && ctx.lastVerdict.metrics && Number.isFinite(Number(ctx.lastVerdict.metrics[metric])) &&
    typeof ctx.lastVerdict.candidateId === "string"
  ) {
    for (let fti = 0; fti < trials.length; fti++) {
      if (trials[fti].note === ctx.lastVerdict.candidateId) {
        trials[fti] = Object.assign({}, trials[fti], {
          metrics: Object.assign({}, trials[fti].metrics, ctx.lastVerdict.metrics),
          metricsSource: "judge",
        })
      }
    }
  }
  const recent = trials.slice(-5).map(function (t) {
    return { config: t.config, metric: t.metrics ? t.metrics[metric] : null, source: t.metricsSource || "runner", note: t.note }
  })
  const plan = (await agent(
    "Improve: " + goal + ".\\nMetric: " + metric + (hasTarget ? " (target >= " + target + ")" : "") +
    ".\\nKnown best: " + JSON.stringify(state.best && state.best.metrics ? state.best.metrics : null) +
    ".\\nRecent trials: " + JSON.stringify(recent) +
    ".\\nCurrent plan: " + JSON.stringify(state.plan) +
    ".\\nRevise it from the evidence. Respond JSON: strategy, components [{id, focus, status}].",
    { schema: MPLAN, key: "kaggle-ml:i" + ctx.i + ":reflect", label: "reflect", phase: "kaggle-ml" }
  )).data || { strategy: "", components: components.map(function (id) { return { id: id, focus: "", status: "active" } }) }

  const active = (plan.components || []).filter(function (c) { return c.status !== "dropped" }).slice(0, 4)
  const variations = {}
  for (let vi = 0; vi < active.length; vi++) {
    const comp = active[vi]
    try {
      const idea = (await agent(
        "Propose 2-3 concrete variations for the '" + comp.id + "' component.\\nGoal: " + goal +
        ".\\nComponent focus: " + String(comp.focus || "") +
        ".\\nHistory (do not repeat failures; exploit what helped): " + JSON.stringify(recent) +
        ".\\nRespond JSON: variations [{idea, rationale}].",
        { schema: MIDEA, key: "kaggle-ml:i" + ctx.i + ":var:" + String(comp.id).slice(0, 20), label: "variations:" + comp.id, phase: "kaggle-ml" }
      )).data
      variations[comp.id] = idea && Array.isArray(idea.variations) ? idea.variations.slice(0, 3).map(function (v, idx) { return { id: String(comp.id) + "-v" + (idx + 1), idea: v.idea, rationale: v.rationale } }) : []
    } catch (e) {
      variations[comp.id] = []
    }
  }

  const select = (await agent(
    "Select AT MOST 3 full configs to run this round.\\nGoal: " + goal +
    ".\\nPlan: " + JSON.stringify(plan) +
    ".\\nVariations per component: " + JSON.stringify(variations) +
    ".\\nIncumbent best config: " + JSON.stringify(state.best ? state.best.config : null) +
    ".\\nRules: NEVER enumerate combinations (no grid search). Carry the incumbent forward as one config, changing at most one component. " +
    "Respond JSON: configs [{id, chosen: [{componentId, variationId}], why}] (<=3).",
    { schema: MSELECT, key: "kaggle-ml:i" + ctx.i + ":select", label: "select", phase: "kaggle-ml" }
  )).data || { configs: [] }
  // Dedupe by chosen-variation signature.
  const seenSig = {}
  const configs = []
  const rawConfigs = Array.isArray(select.configs) ? select.configs : []
  for (let sci = 0; sci < rawConfigs.length && configs.length < 3; sci++) {
    const cfg = rawConfigs[sci]
    const sig = JSON.stringify((Array.isArray(cfg.chosen) ? cfg.chosen : []).map(function (c) { return String(c && c.componentId) + "=" + String(c && c.variationId) }).sort())
    if (seenSig[sig]) continue
    seenSig[sig] = true
    configs.push(cfg)
  }

  const baseDir = ctx.artifactsDir || ctx.runDir
  if (!baseDir) {
    const noDir = new Error("kaggle-ml: no run artifacts dir (storage.runDirFor unavailable)")
    noDir.__ucStructural = true
    throw noDir
  }
  const sanitizeId = function (raw, fallback) {
    const cleaned = String(raw === undefined || raw === null ? "" : raw).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32)
    return cleaned || fallback
  }
  const nextTrials = trials.slice()
  for (let ci = 0; ci < configs.length; ci++) {
    const cfg = configs[ci]
    const cfgId = sanitizeId(cfg.id, "c" + ctx.i + "-" + (ci + 1))
    const dir = baseDir + "/cand-" + cfgId
    // Resolve selector ids to actual ideas (the runner must know WHAT to build).
    const resolved = []
    const chosen = Array.isArray(cfg.chosen) ? cfg.chosen : []
    for (let ri = 0; ri < chosen.length; ri++) {
      const pick = chosen[ri] || {}
      const pool = variations[String(pick.componentId)] || []
      let match = null
      for (let pi = 0; pi < pool.length; pi++) if (pool[pi].id === pick.variationId) match = pool[pi]
      resolved.push({ componentId: String(pick.componentId), variationId: String(pick.variationId), idea: match ? match.idea : "(no matching proposal)" })
    }
    const build = (await agent(
      "Run this ML configuration.\\nGoal: " + goal +
      ".\\nConfig: " + JSON.stringify(cfg) +
      ".\\nResolved variations (what each chosen component must implement): " + JSON.stringify(resolved) +
      ".\\nWork ONLY inside (create it): " + dir +
      (dataRoot ? ". Read data read-only from: " + dataRoot : "") +
      (evalCommand ? ".\\nThen run exactly: " + evalCommand : ".\\nUse your own evaluation and cite the exact command you ran") +
      ".\\nRespond JSON: candidateId (exactly " + JSON.stringify(cfgId) + "), metrics (numbers keyed by name, include '" + metric + "'), evidence {command, exitCode, outputQuote (the line with the metric)}, artifactsRef.",
      { schema: MBUILD, key: "kaggle-ml:i" + ctx.i + ":run:" + cfgId, label: "run:" + cfgId, phase: "kaggle-ml" }
    )).data
    if (build) {
      nextTrials.push({ round: ctx.i, config: cfg, metrics: build.metrics || {}, evidence: build.evidence || null, artifactsRef: build.artifactsRef || dir, note: build.candidateId || cfgId, metricsSource: "runner" })
    }
  }

  const scored = nextTrials.filter(function (t) { return t.metrics && Number.isFinite(Number(t.metrics[metric])) })
  scored.sort(function (a, b) { return Number(b.metrics[metric]) - Number(a.metrics[metric]) })
  const kept = scored.length > 0 ? scored.slice(0, 5) : nextTrials.slice(-5)
  const best = scored.length > 0 ? scored[0] : state.best
  const rounds = (state.rounds || []).concat([{ r: ctx.i, configs: configs.length, best: best && best.metrics ? best.metrics[metric] : null }])
  return {
    state: { plan: plan, variations: variations, trials: kept, best: best, rounds: rounds },
    result: {
      configs: configs.length,
      candidates: nextTrials.slice(trials.length).map(function (t) { return { id: t.note, metric: t.metrics ? t.metrics[metric] : null } }),
      best: best && best.metrics ? best.metrics[metric] : null,
    },
  }
})

return {
  stopReason: summary.stopReason,
  iterations: summary.iterations,
  metric: metric,
  best: summary.state && summary.state.best ? summary.state.best.metrics : null,
  bestConfig: summary.state && summary.state.best ? summary.state.best.config : null,
  rounds: (summary.state && summary.state.rounds) || [],
  lastVerdict: summary.lastVerdict,
  spent: summary.spent,
}`

export const SCRIPT_TEMPLATES: readonly ScriptTemplate[] = [
  {
    name: "staged-delivery",
    description:
      "Sequential write stages (story-by-story or layer-by-layer delivery), each gated by an independent verifier with bounded fix rounds; a failing stage stops the run with a partial report. ~2 child calls per stage — budget the wall clock (pass timeoutMs when stages exceed the configured timeout).",
    args: ["goal", "stages", "maxFixes"],
    script: STAGED_DELIVERY,
  },
  {
    name: "verify-fix",
    description:
      "Bounded fix loop over a known issue list: one write agent per pass, an independent recheck after each pass, survivors carry forward. 2 child calls per pass — pass timeoutMs for long lists.",
    args: ["goal", "issues", "maxPasses"],
    script: VERIFY_FIX,
  },
  {
    name: "kanban",
    description:
      "Worklist loop over a ticket queue (loop()+queue()): pull ONE ticket per iteration, plan → implement → review with an independent reviewer, follow-up tickets from review findings, deps gate readiness, stop when the queue drains. ~3 child calls per ticket; pass timeoutMs for boards larger than ~10 tickets.",
    args: ["goal", "tickets", "maxIterations", "agentsPerIteration", "reviewer"],
    script: KANBAN,
  },
  {
    name: "kaggle-ml",
    description:
      "Refinement loop for ML/quant work (loop() + verdict/skeptic): reflect on the plan, propose per-component variations, select ≤3 full configurations (never a cross product), run each in its own artifacts dir, judge metrics from verbatim evidence, keep the best. Stops on the target metric, deadline, or budgets. ~6 child calls per round.",
    args: ["goal", "components", "metric", "target", "evalCommand", "dataRoot", "judge", "deadline", "maxIterations", "agentsPerIteration"],
    script: KAGGLE_ML,
  },
]

/** One template by name (undefined when unknown). */
export function scriptTemplate(name: string): ScriptTemplate | undefined {
  return SCRIPT_TEMPLATES.find((t) => t.name === name)
}

/** Compact rows for the no-input catalog view. */
export function scriptTemplateSummaries(): Array<{
  name: string
  description: string
  args: string[]
  chars: number
}> {
  return SCRIPT_TEMPLATES.map((t) => ({
    name: t.name,
    description: t.description,
    args: [...t.args],
    chars: t.script.length,
  }))
}
