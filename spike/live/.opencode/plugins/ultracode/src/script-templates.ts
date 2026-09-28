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

/** Hard cap on a served body — includes the research evidence/memory contract.
 * All four current bodies together remain below the 64 KB result envelope. */
export const MAX_SCRIPT_TEMPLATE_CHARS = 20_000

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
// own artifacts dir, judge metrics from evidence, retain scores and learnings.
// Tool input: { args: { goal: "best CV score", components: ["data", "features", "model"], metric: "cv", metricDirection: "max", target: 0.9, evalCommand: "python eval.py", dataRoot: "/data", judge: "general", deadline: "2026-09-18T08:00:00", maxIterations: 8, agentsPerIteration: 12 } }
if (!args || typeof args.goal !== "string" || args.goal.trim() === "") {
  throw new Error("kaggle-ml: args.goal is required (what to optimize)")
}
if (!Array.isArray(args.components) || args.components.length === 0) {
  throw new Error("kaggle-ml: args.components must be a non-empty array, e.g. [\\"data\\", \\"features\\", \\"model\\"]")
}
const goal = args.goal.trim()
const components = args.components.slice(0, 5).map(String)
const metric = typeof args.metric === "string" && args.metric.trim() ? args.metric.trim() : "score"
if (args.metricDirection !== undefined && args.metricDirection !== "min" && args.metricDirection !== "max") {
  throw new Error("kaggle-ml: args.metricDirection must be min or max")
}
const minimize = args.metricDirection === "min"
const better = function (a, b) { return minimize ? a < b : a > b }
const target = Number(args.target)
const hasTarget = args.target !== null && args.target !== undefined && args.target !== "" && Number.isFinite(target)
const targetText = hasTarget ? " (target " + (minimize ? "<= " : ">= ") + target + ")" : ""
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

const MPLAN = { type: "object", required: ["strategy", "components", "formulations", "selectionReason", "baseline", "evaluation"], properties: { strategy: { type: "string" }, formulations: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } }, selectionReason: { type: "string" }, baseline: { type: "string" }, evaluation: { type: "string" }, components: { type: "array", items: { type: "object", required: ["id", "focus"], properties: { id: { type: "string" }, focus: { type: "string" }, status: { type: "string", enum: ["active", "dropped", "new"] } } } } } }
const MIDEA = { type: "object", required: ["variations"], properties: { variations: { type: "array", items: { type: "object", required: ["idea", "rationale"], properties: { idea: { type: "string" }, rationale: { type: "string" } } } } } }
const MSELECT = { type: "object", required: ["configs"], properties: { configs: { type: "array", items: { type: "object", required: ["id", "chosen", "why"], properties: { id: { type: "string" }, chosen: { type: "array", items: { type: "object", required: ["componentId", "variationId"], properties: { componentId: { type: "string" }, variationId: { type: "string" } } } }, why: { type: "string" } } } } } }
const MEVIDENCE = { type: "object", required: ["command", "exitCode", "outputQuote"], properties: { command: { type: "string" }, exitCode: { type: "number" }, outputQuote: { type: "string" } } }
const MBUILD = { type: "object", required: ["candidateId", "metrics", "evidence"], properties: { candidateId: { type: "string" }, metrics: { type: "object" }, evidence: MEVIDENCE, artifactsRef: { type: "string" } } }
const MVERDICT = { type: "object", required: ["status", "candidateId", "metrics", "evidence"], properties: { status: { type: "string", enum: ["improve", "done", "blocked"] }, metrics: { type: "object" }, candidateId: { type: "string" }, learning: { type: "object", required: ["question", "finding", "nextDecision", "evidenceRef"], properties: { question: { type: "string" }, finding: { type: "string" }, nextDecision: { type: "string" }, evidenceRef: { type: "string" } } }, evidence: MEVIDENCE } }

// Substantive progress is separate from growing bookkeeping state. Only the
// independent judge can establish a score or an evidence-linked learning.
let verifiedBest = null
let stalled = 0
const knowledge = []
const seenLearning = {}
const seenEvidence = {}
const acceptVerdict = function (v) {
  const verdict = v.verdict
  if (!verdict || !verdict.evidence || verdict.evidence.exitCode !== 0 || !verdict.evidence.command.trim() || !verdict.evidence.outputQuote.trim()) return false
  const candidate = ((v.result && v.result.candidates) || []).find(function (c) { return c.id === verdict.candidateId })
  if (!candidate) return false
  let progress = false
  const value = verdict.metrics && verdict.metrics[metric]
  if (typeof value === "number" && Number.isFinite(value) && (!verifiedBest || better(value, verifiedBest.metrics[metric]))) {
    verifiedBest = Object.assign({}, candidate, { metrics: verdict.metrics, evidence: verdict.evidence })
    progress = true
  }
  const learned = verdict.learning
  if (learned && [learned.question, learned.finding, learned.nextDecision, learned.evidenceRef].every(function (x) { return typeof x === "string" && x.trim() })) {
    const signature = [learned.question, learned.finding, learned.nextDecision].join("|").toLowerCase().trim()
    if (learned.evidenceRef === candidate.artifactsRef && !seenLearning[signature] && !seenEvidence[learned.evidenceRef]) {
      seenLearning[signature] = true
      seenEvidence[learned.evidenceRef] = true
      knowledge.push(learned)
      progress = true
    }
  }
  return progress
}

const summary = await loop({
  key: "kaggle-ml",
  goal: goal,
  state: { plan: null, trials: [], recent: [], best: null, rounds: [] },
  budget: {
    iterations: maxIterations,
    agentsPerIteration: agentsPerIteration,
    ...(typeof args.deadline === "string" && args.deadline ? { deadline: args.deadline } : {}),
  },
  stop: { predicate: function (v) {
    stalled = acceptVerdict(v) ? 0 : stalled + 1
    // A stall ends this runtime episode; it does not falsify the research idea.
    return stalled >= 3 ? "stall" : false
  }, stallK: 3 },
  verdict: {
    agent: judge,
    schema: MVERDICT,
    prompt: function (c) {
      return "Judge ML round " + c.i + " for: " + goal +
        ".\\nMetric: " + metric + targetText + "; " + (minimize ? "minimize" : "maximize") +
        ".\\nRound result: " + JSON.stringify(c.result) +
        ".\\nBest metrics: " + JSON.stringify(c.state.best && c.state.best.metrics ? c.state.best.metrics : null) +
        ".\\nRE-DERIVE a round candidate's metric: run the evaluation and report evidence {command, exitCode, outputQuote}. status=done ONLY if your own successful re-derivation meets the target." +
        ".\\nSet candidateId to the exact round candidate id; metrics = YOUR numbers. If no candidate can be evaluated, use candidateId='', metrics={}, evidence with a nonzero exitCode and the actual limitation. No target means status=improve, unless blocked." +
        ".\\nOptionally record learning {question, finding, nextDecision, evidenceRef}: inspect the candidate artifact, cite its artifactsRef exactly, and state the scoped new evidence and how it changes the next decision. A poor score alone is not a falsification. Repetition, new wording, or a new file path is not new knowledge."
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
  const recent = (state.recent || []).slice(-6)
  const plan = (await agent(
    "Improve: " + goal + ".\\nMetric: " + metric + targetText + "; " + (minimize ? "minimize" : "maximize") +
    ".\\nRead-only planning: inspect prerequisites as needed, then return the formulation and evaluation plan. Candidate implementation and runs belong to the later execution phase." +
    ".\\nInitial component suggestions (revisable): " + JSON.stringify(components) +
    ".\\nIndependently verified best: " + JSON.stringify(verifiedBest) +
    ".\\nRecent trials: " + JSON.stringify(recent) +
    ".\\nRecent runtime outcomes (including errors and refutations): " + JSON.stringify(ctx.history.slice(-3)) +
    ".\\nCurrent plan: " + JSON.stringify(state.plan) +
    ".\\nVerified learnings: " + JSON.stringify(knowledge.slice(-12)) +
    ".\\nBefore proposing experiments, reason across the plausible formulations of this mission: component-based, joint or end-to-end when relevant. State assumptions, tradeoffs, a credible baseline and how evaluation can distinguish the alternatives. Breadth is proportional to uncertainty, not a fixed quota. A decomposition is a hypothesis, not an imposed architecture; a joint formulation may be one component. Reuse this reasoning until evidence warrants revision." +
    ".\\nChoose the highest-value next investigation. Prioritize focus; activate only components needed for it, including coupled changes for one coherent hypothesis. Dropped means deprioritized, not falsified; budgets and weak results do not kill a whole approach. Respond JSON: strategy, formulations, selectionReason, baseline, evaluation, components [{id, focus, status}].",
    { schema: MPLAN, key: "kaggle-ml:i" + ctx.i + ":reflect", label: "reflect", phase: "kaggle-ml" }
  )).data || { strategy: "", components: components.map(function (id) { return { id: id, focus: "", status: "active" } }) }

  const active = (plan.components || []).filter(function (c) { return c.status !== "dropped" }).slice(0, Math.min(4, ctx.budgetLeft.agentsPerIteration - 3))
  const candidateLimit = Math.min(3, ctx.budgetLeft.agentsPerIteration - 2 - active.length)
  const incumbent = verifiedBest || state.best
  const variations = {}
  for (let vi = 0; vi < active.length; vi++) {
    const comp = active[vi]
    try {
      const idea = (await agent(
        "Propose 2-3 concrete variations for the '" + comp.id + "' component.\\nGoal: " + goal +
        ".\\nRead-only ideation; return proposals for the later execution phase." +
        ".\\nComponent focus: " + String(comp.focus || "") +
        ".\\nChosen formulation and evaluation: " + JSON.stringify(plan) +
        ".\\nHistory (do not repeat failures; exploit what helped): " + JSON.stringify(recent) +
        ".\\nVerified learnings: " + JSON.stringify(knowledge.slice(-12)) +
        ".\\nRespond JSON: variations [{idea, rationale}].",
        { schema: MIDEA, key: "kaggle-ml:i" + ctx.i + ":var:" + String(comp.id).slice(0, 20), label: "variations:" + comp.id, phase: "kaggle-ml" }
      )).data
      variations[comp.id] = idea && Array.isArray(idea.variations) ? idea.variations.slice(0, 3).map(function (v, idx) { return { id: String(comp.id) + "-v" + (idx + 1), idea: v.idea, rationale: v.rationale } }) : []
    } catch (e) {
      variations[comp.id] = []
    }
  }

  const select = (await agent(
    "Select AT MOST " + candidateLimit + " full configs to run this round.\\nGoal: " + goal +
    ".\\nRead-only selection; return configurations without implementing them." +
    ".\\nPlan: " + JSON.stringify(plan) +
    ".\\nVariations per component: " + JSON.stringify(variations) +
    ".\\nIncumbent best config: " + JSON.stringify(incumbent ? incumbent.config : null) +
    ".\\nRules: NEVER enumerate the cross product. Establish the named baseline first. Each candidate tests one coherent hypothesis; coupled changes are allowed when the hypothesis requires them. Preserve the incumbent as a comparator with its artifact reference: " + JSON.stringify(incumbent && incumbent.artifactsRef) + ". " +
    "Respond JSON: configs [{id, chosen: [{componentId, variationId}], why}].",
    { schema: MSELECT, key: "kaggle-ml:i" + ctx.i + ":select", label: "select", phase: "kaggle-ml" }
  )).data || { configs: [] }
  // Dedupe by chosen-variation signature.
  const seenSig = {}
  const configs = []
  const rawConfigs = Array.isArray(select.configs) ? select.configs : []
  for (let sci = 0; sci < rawConfigs.length && configs.length < candidateLimit; sci++) {
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
  const rejected = []
  for (let ci = 0; ci < configs.length; ci++) {
    const cfg = configs[ci]
    const cfgId = (ctx.i ? "r" + ctx.i + "-" : "") + sanitizeId(cfg.id, "c" + (ci + 1)) + "-" + ci
    const dir = baseDir + "/cand-" + cfgId
    // Resolve selector ids to actual ideas (the runner must know WHAT to build).
    const resolved = []
    const chosen = Array.isArray(cfg.chosen) ? cfg.chosen : []
    for (let ri = 0; ri < chosen.length; ri++) {
      const pick = chosen[ri] || {}
      const pool = variations[String(pick.componentId)] || []
      let match = null
      for (let pi = 0; pi < pool.length; pi++) if (pool[pi].id === pick.variationId) match = pool[pi]
      if (!match) {
        rejected.push({ config: cfg, note: "unresolvable selection", reason: "unknown variation: " + pick.variationId })
        break
      }
      resolved.push({ componentId: String(pick.componentId), variationId: String(pick.variationId), idea: match.idea })
    }
    if (resolved.length !== chosen.length) continue
    const build = (await agent(
      "Run this ML configuration.\\nGoal: " + goal +
      ".\\nConfig: " + JSON.stringify(cfg) +
      ".\\nBaseline, formulation, and evaluation contract: " + JSON.stringify(plan) +
      ".\\nIncumbent comparator: " + JSON.stringify(incumbent) +
      ".\\nResolved variations (what each chosen component must implement): " + JSON.stringify(resolved) +
      ".\\nWork ONLY inside (create it): " + dir +
      (dataRoot ? ". Read data read-only from: " + dataRoot : "") +
      (evalCommand ? ".\\nThen run exactly: " + evalCommand : ".\\nUse the plan's baseline evaluation, preserving data split, population, metric and budget across candidates; cite the exact command") +
      ".\\nProbe data/measurement feasibility before expensive work. Preserve diagnostics including null or adverse results in the artifact. Failed measurement is inconclusive, not evidence against the whole formulation." +
      ".\\nRespond JSON: candidateId (exactly " + JSON.stringify(cfgId) + "), metrics (numbers keyed by name, include '" + metric + "'), evidence {command, exitCode, outputQuote (the line with the metric)}, artifactsRef.",
      { schema: MBUILD, key: "kaggle-ml:i" + ctx.i + ":run:" + cfgId, label: "run:" + cfgId, phase: "kaggle-ml" }
    )).data
    if (build) {
      nextTrials.push({ round: ctx.i, config: cfg, resolved: resolved, metrics: build.metrics || {}, evidence: build.evidence || null, artifactsRef: build.artifactsRef || dir, note: cfgId, metricsSource: "runner" })
    }
  }

  const scored = nextTrials.filter(function (t) { return t.evidence && t.evidence.exitCode === 0 && t.metrics && typeof t.metrics[metric] === "number" && Number.isFinite(t.metrics[metric]) })
  scored.sort(function (a, b) { return minimize ? a.metrics[metric] - b.metrics[metric] : b.metrics[metric] - a.metrics[metric] })
  const kept = scored.length > 0 ? scored.slice(0, 5) : nextTrials.slice(-5)
  const best = scored.length > 0 ? scored[0] : state.best
  const rounds = (state.rounds || []).concat([{ r: ctx.i, configs: configs.length, best: best && best.metrics ? best.metrics[metric] : null }])
  return {
    state: { plan: plan, variations: variations, trials: kept, recent: recent.concat(nextTrials.slice(trials.length), rejected).slice(-6), best: best, rounds: rounds },
    result: {
      configs: configs.length,
      rejected: rejected,
      candidates: nextTrials.slice(trials.length).map(function (t) { return { id: t.note, config: t.config, resolved: t.resolved, metric: t.metrics ? t.metrics[metric] : null, artifactsRef: t.artifactsRef, evidence: t.evidence } }),
      best: best && best.metrics ? best.metrics[metric] : null,
    },
  }
})

// Terminating verdicts bypass the stop predicate; fold the final verified result
// too. A refuted termination is null and cannot promote a candidate here.
acceptVerdict({ verdict: summary.lastVerdict, result: summary.lastResult })
const finalVerdict = summary.lastVerdict
const finalScore = finalVerdict && finalVerdict.metrics && finalVerdict.metrics[metric]
const targetVerified = hasTarget && typeof finalScore === "number" && Number.isFinite(finalScore) &&
  (minimize ? finalScore <= target : finalScore >= target) &&
  finalVerdict.evidence && finalVerdict.evidence.exitCode === 0 && finalVerdict.evidence.command.trim() && finalVerdict.evidence.outputQuote.trim() &&
  ((summary.lastResult && summary.lastResult.candidates) || []).some(function (c) { return c.id === finalVerdict.candidateId })
const invalidTarget = summary.stopReason === "target" && !targetVerified
return {
  stopReason: invalidTarget ? "blocked" : summary.stopReason,
  ...(invalidTarget ? { terminationIssue: "Judge termination did not establish the configured target on a round candidate" } : {}),
  iterations: summary.iterations,
  metric: metric,
  best: verifiedBest ? verifiedBest.metrics : null,
  bestConfig: verifiedBest ? verifiedBest.config : null,
  bestResolved: verifiedBest ? verifiedBest.resolved : null,
  bestArtifact: verifiedBest ? verifiedBest.artifactsRef : null,
  recent: (summary.state && summary.state.recent) || [],
  knowledge: knowledge.slice(-12),
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
      "Research refinement with provisional formulations, a baseline evaluation, focused variations and ≤3 coherent configurations. Retains recent negatives and evidence-linked learnings separately from top scores; independent verdict/skeptic checks. Stops on target, substantive stall, deadline or budget. No SpecFlow dependency.",
    args: ["goal", "components", "metric", "metricDirection", "target", "evalCommand", "dataRoot", "judge", "deadline", "maxIterations", "agentsPerIteration"],
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
