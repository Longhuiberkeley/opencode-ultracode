// code-audit: one explorer per module, merge and dedupe findings, then an
// adversarial reviewer re-examines each batch and rejects weak findings.
// Findings whose reviewer FAILED are returned separately as unverified —
// never silently promoted to reviewed findings.
// Tool input: { workflow: "code-audit", args: { modules: ["auth", "db"], focus?: "error handling" } }
// Agents (stock): explore for scanning, general for adversarial review.

const input = args && typeof args === "object" ? args : {}
const modules = (Array.isArray(input.modules) ? input.modules : [])
  .map((m) => String(m).trim())
  .filter(Boolean)
  .slice(0, 12)
if (modules.length === 0) throw new Error("args.modules is needed: an array of module paths to audit")
const focus =
  typeof input.focus === "string" && input.focus.trim()
    ? input.focus.trim()
    : "correctness, security, error handling, and maintainability"

const findingsSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "severity", "issue", "suggestion"],
        properties: {
          file: { type: "string" },
          line_hint: { type: "string" },
          severity: { type: "string" },
          issue: { type: "string" },
          suggestion: { type: "string" },
        },
      },
    },
  },
}
const reviewSchema = {
  type: "object",
  required: ["kept", "rejected"],
  properties: {
    kept: { type: "array", items: { type: "number" } },
    rejected: {
      type: "array",
      items: {
        type: "object",
        required: ["index", "reason"],
        properties: { index: { type: "number" }, reason: { type: "string" } },
      },
    },
  },
}
const SEVERITIES = ["low", "medium", "high", "critical"]
const BATCH = 10

phase("scan")
progress("scanning " + modules.length + " modules; focus: " + focus)
const scans = await parallel(
  modules.map((m) => () =>
    agent(
      "Audit ONE module of a codebase for real, actionable defects.\n" +
        "Module: " + m + "\nFocus: " + focus + "\n" +
        "Read the code in that module only. Return up to 10 findings; each needs file, an optional " +
        "line_hint, severity (low, medium, high, critical), a one-sentence issue, and a concrete " +
        "suggestion. No style nits, no hypotheticals.",
      { agent: "explore", label: "scan:" + m, phase: "scan", schema: findingsSchema },
    ),
  ),
)

// merge + dedupe on file + normalized issue text
const seen = new Set()
const findings = []
for (const run of scans) {
  for (const f of (run && run.data && run.data.findings) || []) {
    const file = String(f.file || "").trim()
    const issue = String(f.issue || "").trim()
    if (!file || !issue) continue
    const key = file.toLowerCase() + "|" + issue.toLowerCase().slice(0, 60)
    if (seen.has(key)) continue
    seen.add(key)
    const sev = String(f.severity || "").toLowerCase()
    findings.push({
      file: file,
      line_hint: f.line_hint == null ? "" : String(f.line_hint),
      severity: SEVERITIES.indexOf(sev) >= 0 ? sev : "medium",
      issue: issue,
      suggestion: String(f.suggestion || "").trim(),
    })
  }
}
if (findings.length === 0) {
  return {
    findings: [],
    unverified: [],
    stats: { modules: modules, scanned: modules.length, raw: 0, kept: 0, rejected: 0, unverified: 0 },
  }
}

phase("review")
const batches = []
for (let i = 0; i < findings.length; i += BATCH) batches.push(findings.slice(i, i + BATCH))
progress("adversarial review of " + findings.length + " findings in " + batches.length + " batches")
const reviews = await parallel(
  batches.map((batch, bi) => () =>
    agent(
      "Adversarially re-examine audit findings. Keep only defects that are real, present in the " +
        "code as written, and worth fixing. Reject duplicates, false positives, style nits, and " +
        "anything you cannot confirm.\nFindings JSON (indexes are 0-based within this batch):\n" +
        JSON.stringify(batch) +
        "\nReturn kept as an array of batch indexes, and rejected as index and reason pairs.",
      { agent: "general", label: "review:batch" + (bi + 1), phase: "review", schema: reviewSchema },
    ),
  ),
)
const kept = []
const rejected = []
const unverified = []
reviews.forEach((run, bi) => {
  const batch = batches[bi]
  if (!run || !run.data) {
    // reviewer failed: surface the batch as unverified instead of silently promoting it
    for (const f of batch) unverified.push({ ...f, unverified: true })
    return
  }
  const keepIdx = new Set((run.data.kept || []).map((n) => Math.trunc(Number(n))))
  const why = new Map()
  for (const r of run.data.rejected || []) why.set(Math.trunc(Number(r.index)), String(r.reason || "rejected"))
  batch.forEach((f, i) => {
    if (keepIdx.has(i)) kept.push(f)
    else rejected.push({ file: f.file, issue: f.issue, reason: why.get(i) || "not kept" })
  })
})
kept.sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity))

return {
  findings: kept.slice(0, 40),
  unverified: unverified.slice(0, 40),
  stats: {
    modules: modules,
    scanned: modules.length,
    raw: findings.length,
    kept: kept.length,
    rejected: rejected.length,
    unverified: unverified.length,
  },
}
