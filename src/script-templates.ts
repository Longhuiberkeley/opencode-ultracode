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
