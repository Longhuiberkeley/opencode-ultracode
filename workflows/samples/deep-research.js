// deep-research: fan out one researcher per angle, verify every claim with an
// independent verifier, overturn weak verdicts with a skeptic pass, synthesize.
// Tool input: { workflow: "deep-research", args: { topic: "...", angles?: ["technical", "market", "criticism"] } }
// Agents (stock): explore for research, general for verify, skeptic, synthesize.

const input = args && typeof args === "object" ? args : {}
const topic = typeof input.topic === "string" ? input.topic.trim() : ""
if (!topic) throw new Error("args.topic is needed: a short research question to investigate")
const angles = (Array.isArray(input.angles) ? input.angles : ["technical", "market", "criticism"])
  .map((a) => String(a).trim())
  .filter(Boolean)
  .slice(0, 6)
if (angles.length === 0) throw new Error("args.angles must be a non-empty array of angle names")

const findingsSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "source_hint", "confidence"],
        properties: {
          claim: { type: "string" },
          source_hint: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
}
const verdictSchema = {
  type: "object",
  required: ["claim", "verdict"],
  properties: {
    claim: { type: "string" },
    verdict: { type: "string", enum: ["supported", "refuted", "unverifiable"] },
    evidence: { type: "string" },
  },
}
const overturnedSchema = {
  type: "object",
  required: ["overturned"],
  properties: {
    overturned: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "reason"],
        properties: { claim: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
}

phase("research")
progress("researching " + angles.length + " angles on: " + topic)
const angleRuns = await parallel(
  angles.map((angle) => () =>
    agent(
      "Research ONE angle of a topic and report raw claims.\n" +
        "Topic: " + topic + "\nAngle: " + angle + "\n" +
        "Return 3 to 6 distinct, checkable factual claims. For each claim give a source_hint " +
        "(where a verifier should look: doc name, paper, dataset, spec section) and a confidence " +
        "from 0.0 to 1.0. Nothing outside the JSON.",
      { agent: "explore", label: "research:" + angle, phase: "research", schema: findingsSchema },
    ),
  ),
)

// merge + dedupe (case-insensitive first-80-chars key), keep the most confident copy
const byKey = new Map()
for (const run of angleRuns) {
  for (const f of (run && run.data && run.data.findings) || []) {
    const claim = String(f.claim || "").trim()
    if (!claim) continue
    const key = claim.toLowerCase().slice(0, 80)
    const conf = Math.max(0, Math.min(1, Number(f.confidence) || 0))
    const prev = byKey.get(key)
    if (!prev || conf > prev.confidence) {
      byKey.set(key, { claim: claim, source_hint: String(f.source_hint || "").trim(), confidence: conf })
    }
  }
}
const claims = [...byKey.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 20)
if (claims.length === 0) throw new Error("every research angle failed or returned no claims")

phase("verify")
progress("verifying " + claims.length + " claims")
const verdictRuns = await parallel(
  claims.map((c, i) => () =>
    agent(
      "Verify ONE research claim. Try to refute it before accepting it.\n" +
        "Claim: " + c.claim + "\nWhere to look: " + (c.source_hint || "primary sources") + "\n" +
        "Return the claim, a verdict (supported, refuted, or unverifiable), and one line of evidence.",
      { agent: "general", label: "verify:" + (i + 1), phase: "verify", schema: verdictSchema },
    ),
  ),
)
const checked = []
verdictRuns.forEach((run, i) => {
  if (run && run.data && run.data.verdict) {
    checked.push({
      claim: claims[i].claim,
      source_hint: claims[i].source_hint,
      verdict: String(run.data.verdict),
      evidence: String(run.data.evidence || "").trim(),
    })
  }
})
const supported = checked.filter((c) => c.verdict === "supported")

phase("skeptic")
let overturned = []
if (supported.length > 0) {
  const skeptic = await agent(
    "A batch of claims just passed verification. Re-examine ALL of them as a harsh skeptic: " +
      "which rest on weak, circular, or outdated evidence?\nClaims JSON:\n" + JSON.stringify(supported) + "\n" +
      "Return ONLY the claims you would overturn, each with a one-line reason.",
    { agent: "general", label: "skeptic", phase: "skeptic", schema: overturnedSchema },
  )
  overturned = (skeptic && skeptic.data && skeptic.data.overturned) || []
}
const badKeys = new Set(overturned.map((o) => String(o.claim || "").toLowerCase().slice(0, 80)))
const finalClaims = supported.filter((c) => !badKeys.has(c.claim.toLowerCase().slice(0, 80)))

phase("synthesize")
const report = await agent(
  "Write a cited research briefing (300-500 words) answering: " + topic + "\n" +
    "Use ONLY these verified claims, citing each source_hint inline. End with one section of open " +
    "questions listing the claims below that failed verification.\nVerified claims JSON:\n" +
    JSON.stringify(finalClaims) + "\nNot supported (open questions):\n" +
    JSON.stringify(checked.filter((c) => c.verdict !== "supported").map((c) => c.claim)),
  { agent: "general", label: "synthesize", phase: "synthesize" },
)

return {
  report: report ? report.text : "",
  stats: {
    topic: topic,
    angles: angles,
    claimsFound: claims.length,
    supported: supported.length,
    overturned: overturned.length,
    kept: finalClaims.length,
    notSupported: checked.length - supported.length,
  },
}
