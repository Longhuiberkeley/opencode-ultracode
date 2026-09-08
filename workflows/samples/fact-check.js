// fact-check: extract checkable claims from a draft, verify each against the
// given sources, overturn weak verdicts with a skeptic pass, compile a table.
// Tool input: { workflow: "fact-check", args: { draft: "<text>", sources: ["<text, path, or URL>"] } }
// Agents (stock): general for extract, verify, skeptic, report.

const input = args && typeof args === "object" ? args : {}
const draft = typeof input.draft === "string" ? input.draft : ""
if (!draft.trim()) throw new Error("args.draft is needed: the text to fact-check")
const sources = (Array.isArray(input.sources) ? input.sources : [])
  .map((s) => String(s).trim())
  .filter(Boolean)
  .slice(0, 8)
if (sources.length === 0) throw new Error("args.sources is needed: an array of reference texts, file paths, or URLs")

const sourceBlock = sources
  .map((s, i) => "[" + (i + 1) + "] " + (s.length > 400 ? s.slice(0, 400) + " ...(truncated)" : s))
  .join("\n")
const extractSchema = {
  type: "object",
  required: ["claims"],
  properties: { claims: { type: "array", items: { type: "string" } } },
}
const verdictSchema = {
  type: "object",
  required: ["claim", "verdict"],
  properties: {
    claim: { type: "string" },
    verdict: { type: "string", enum: ["supported", "refuted", "unverifiable"] },
    quote: { type: "string" },
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

phase("extract")
const extract = await agent(
  "Extract every checkable factual claim from the draft below. Skip opinions, forecasts, and " +
    "wording choices. One claim per item, phrased as a standalone sentence.\nDraft:\n" + draft,
  { agent: "general", label: "extract", phase: "extract", schema: extractSchema },
)
const seenClaims = new Set()
const claims = []
for (const c of ((extract && extract.data && extract.data.claims) || []).map((c) => String(c).trim())) {
  if (!c) continue
  const key = c.toLowerCase().slice(0, 80)
  if (seenClaims.has(key)) continue
  seenClaims.add(key)
  claims.push(c)
}
const boundedClaims = claims.slice(0, 20)
if (boundedClaims.length === 0) {
  return {
    report: "No checkable factual claims were found in the draft.",
    verdicts: [],
    stats: { claims: 0, supported: 0, refuted: 0, unverifiable: 0, overturned: 0 },
  }
}

phase("verify")
progress("verifying " + boundedClaims.length + " claims against " + sources.length + " sources")
const verdictRuns = await parallel(
  boundedClaims.map((c, i) => () =>
    agent(
      "Verify ONE claim strictly against the sources. If the sources do not address it, return " +
        "unverifiable instead of guessing.\nClaim: " + c + "\nSources:\n" + sourceBlock + "\n" +
        "Return the claim, the verdict, and (when found) a short supporting or refuting quote.",
      { agent: "general", label: "verify:" + (i + 1), phase: "verify", schema: verdictSchema },
    ),
  ),
)
const VERDICTS = ["supported", "refuted", "unverifiable"]
const verdicts = verdictRuns.map((run, i) => {
  if (!run || !run.data) return { claim: boundedClaims[i], verdict: "unverifiable", quote: "" }
  const v = String(run.data.verdict || "")
  return {
    claim: boundedClaims[i],
    verdict: VERDICTS.indexOf(v) >= 0 ? v : "unverifiable",
    quote: String(run.data.quote || "").trim(),
  }
})
const supported = verdicts.filter((v) => v.verdict === "supported")

phase("skeptic")
let overturned = []
if (supported.length > 0) {
  const skeptic = await agent(
    "These claims were marked supported against the sources below. As a harsh skeptic, overturn " +
      "any where the quote does not actually entail the claim, the source is weak, or the reading " +
      "is cherry-picked.\nClaims JSON:\n" + JSON.stringify(supported) + "\nSources:\n" + sourceBlock + "\n" +
      "Return ONLY overturned claims, each with a one-line reason.",
    { agent: "general", label: "skeptic", phase: "skeptic", schema: overturnedSchema },
  )
  overturned = (skeptic && skeptic.data && skeptic.data.overturned) || []
}
const badKeys = new Set(overturned.map((o) => String(o.claim || "").toLowerCase().slice(0, 80)))
const final = verdicts.map((v) =>
  badKeys.has(v.claim.toLowerCase().slice(0, 80))
    ? { claim: v.claim, verdict: "unverifiable", quote: v.quote, overturned: true }
    : { claim: v.claim, verdict: v.verdict, quote: v.quote, overturned: false },
)

phase("report")
const counts = { supported: 0, refuted: 0, unverifiable: 0 }
for (const v of final) counts[v.verdict]++
const reporter = await agent(
  "Compile a fact-check report in markdown. First a table with columns Claim, Verdict, Evidence " +
    "(the quote; for overturned claims, the skeptic reason). Then a one-line count summary, then a " +
    "short list of suggested fixes for every refuted claim.\nVerdicts JSON:\n" + JSON.stringify(final) +
    "\nSkeptic reasons:\n" + JSON.stringify(overturned) + "\nCounts: " + JSON.stringify(counts),
  { agent: "general", label: "report", phase: "report" },
)

return {
  report: reporter ? reporter.text : "",
  verdicts: final,
  stats: {
    claims: boundedClaims.length,
    supported: counts.supported,
    refuted: counts.refuted,
    unverifiable: counts.unverifiable,
    overturned: overturned.length,
  },
}
