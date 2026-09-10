// dev-loop: map the affected code, implement until tests and typecheck are green,
// independently verify, review for blockers, then a bounded fix-and-recheck loop.
// Tool input: { workflow: "dev-loop", args: { task: "...", repo?: ".", scope?: "...", fixPasses?: 3 } }
// Agents (stock): explore for mapping, general for implement, verify, review, and fix.
// Reviewer specialist: pass args.reviewer when the host has one; default is general.

const input = args && typeof args === "object" ? args : {}
const task = typeof input.task === "string" ? input.task.trim() : ""
if (!task) throw new Error("args.task is needed: the change to implement")
const repo =
  typeof input.repo === "string" && input.repo.trim() ? input.repo.trim() : "."
const scope =
  typeof input.scope === "string" && input.scope.trim()
    ? input.scope.trim()
    : "only the files required for this task"
const requestedPasses = Number(input.fixPasses)
const fixPasses =
  Number.isFinite(requestedPasses) && requestedPasses > 0 ? Math.min(3, Math.trunc(requestedPasses)) : 3
const reviewAgent =
  typeof input.reviewer === "string" && input.reviewer.trim() ? input.reviewer.trim() : "general"

const findingsSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "note"],
        properties: {
          file: { type: "string" },
          note: { type: "string" },
          symbol: { type: "string" },
        },
      },
    },
  },
}
const implementSchema = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    summary: { type: "string" },
  },
}
const verifySchema = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    checks: { type: "array", items: { type: "string" } },
    issues: { type: "array", items: { type: "string" } },
  },
}
const blockersSchema = {
  type: "object",
  required: ["blockers"],
  properties: {
    blockers: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "issue"],
        properties: {
          file: { type: "string" },
          severity: { type: "string" },
          issue: { type: "string" },
        },
      },
    },
  },
}

const contextBlock =
  "Repo: " +
  repo +
  "\nTask: " +
  task +
  "\nScope notes: " +
  scope +
  "\nStay inside that scope. Do not commit unless the task says to."

phase("explore")
progress("mapping affected code")
const explored = await agent(
  "Map the code this task will touch. Read the repo; do not edit files.\n" +
    contextBlock +
    "\nReturn up to 12 findings: file, optional symbol, and a short note on what must change.",
  { agent: "explore", label: "explore", phase: "explore", schema: findingsSchema },
)
const findings = ((explored && explored.data && explored.data.findings) || [])
  .map((f) => ({
    file: String(f.file || "").trim(),
    note: String(f.note || "").trim(),
    symbol: f.symbol == null ? "" : String(f.symbol),
  }))
  .filter((f) => f.file && f.note)
  .slice(0, 12)

phase("implement")
progress("implementing with tests and typecheck")
const implemented = await agent(
  "Implement the task. You are the ONLY writer — do not spawn other write agents.\n" +
    contextBlock +
    "\nAffected code map:\n" +
    JSON.stringify(findings) +
    "\nAdd or update tests. Run the project's tests and typecheck. Keep going until both are green " +
    "or you cannot make progress. Return ok true only if tests and typecheck passed.",
  { agent: "general", label: "implement", phase: "implement", schema: implementSchema },
)

phase("verify")
progress("independent verify")
const verified = await agent(
  "Independently re-run tests and static checks for this task. Do not trust the implementer.\n" +
    contextBlock +
    "\nImplementer summary: " +
    JSON.stringify((implemented && implemented.data) || {}) +
    "\nRerun tests and typecheck (or the repo's equivalent static checks). Return ok true only if " +
    "they pass, plus checks you ran and any issues.",
  { agent: "general", label: "verify", phase: "verify", schema: verifySchema },
)

phase("review")
progress("review for blockers")
const reviewed = await agent(
  "Review the change for blockers (bugs, missing tests, type errors, scope violations). " +
    "This is a reviewer pass; use general if no reviewer specialist is configured.\n" +
    contextBlock +
    "\nFindings map: " +
    JSON.stringify(findings) +
    "\nVerify result: " +
    JSON.stringify((verified && verified.data) || {}) +
    "\nReturn blockers only. Empty blockers means shippable.",
  { agent: reviewAgent, label: "review", phase: "review", schema: blockersSchema },
)

let blockers = ((reviewed && reviewed.data && reviewed.data.blockers) || [])
  .map((b) => ({
    file: b.file == null ? "" : String(b.file),
    severity: String(b.severity || "medium"),
    issue: String(b.issue || "").trim(),
  }))
  .filter((b) => b.issue)
if (verified && verified.data && verified.data.ok === false) {
  let pushed = 0
  for (const issue of verified.data.issues || []) {
    const text = String(issue || "").trim()
    if (text) {
      blockers.push({ file: "", severity: "high", issue: text })
      pushed++
    }
  }
  if (pushed === 0 && blockers.length === 0) {
    blockers.push({ file: "", severity: "high", issue: "verify reported failure without listing issues" })
  }
}
if (!(implemented && implemented.data && implemented.data.ok)) {
  blockers.push({
    file: "",
    severity: "high",
    issue: "implementer did not confirm green tests and typecheck",
  })
}

phase("fix")
let passes = 0
for (let pass = 1; pass <= fixPasses && blockers.length > 0; pass++) {
  passes = pass
  progress("fix pass " + pass + ": " + blockers.length + " blockers")
  await agent(
    "Fix exactly these blockers. Change no unrelated code. Re-run tests and typecheck.\n" +
      contextBlock +
      "\nBlockers JSON:\n" +
      JSON.stringify(blockers),
    { agent: "general", label: "fix" + pass, phase: "fix" },
  )
  const recheck = await agent(
    "Recheck whether these blockers still exist. List survivors only.\n" +
      contextBlock +
      "\nBlockers JSON:\n" +
      JSON.stringify(blockers),
    { agent: reviewAgent, label: "recheck" + pass, phase: "fix", schema: blockersSchema },
  )
  blockers = ((recheck && recheck.data && recheck.data.blockers) || [])
    .map((b) => ({
      file: b.file == null ? "" : String(b.file),
      severity: String(b.severity || "medium"),
      issue: String(b.issue || "").trim(),
    }))
    .filter((b) => b.issue)
}

// Fail closed: if implement or verify never confirmed green, a cleared
// blockers list is not enough — re-run the checks once after the fixes.
const implementOk = !!(implemented && implemented.data && implemented.data.ok)
const verifyOk = !!(verified && verified.data && verified.data.ok)
let finalVerifyOk = true
if (blockers.length === 0 && (!implementOk || !verifyOk)) {
  const reverified = await agent(
    "Re-run the project's tests and typecheck (or equivalents) after the fixes. " +
      "Do not trust earlier reports. Return ok true only if they pass.",
    { agent: "general", label: "reverify", phase: "fix", schema: verifySchema },
  )
  finalVerifyOk = !!(reverified && reverified.data && reverified.data.ok)
  if (!finalVerifyOk) {
    blockers.push({ file: "", severity: "high", issue: "re-verify after fixes was not green" })
  }
}

return {
  ok: blockers.length === 0 && finalVerifyOk && (implementOk || passes > 0) && (verifyOk || passes > 0),
  task: task,
  blockers: blockers.slice(0, 20),
  stats: {
    repo: repo,
    findings: findings.length,
    implementOk: implementOk,
    verifyOk: verifyOk,
    fixPasses: passes,
    remaining: blockers.length,
  },
}
