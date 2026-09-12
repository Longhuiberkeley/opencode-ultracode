/**
 * Graph templates (workstream C): ready-to-adapt DAG specs for the shapes that
 * cover most real orchestrations. Authoring a graph from a blank page is the
 * cost graph mode exists to remove, so `ultracode_catalog` serves these and the
 * model edits prompts, caps and schemas instead of inventing structure.
 *
 * Rules these obey (enforced by test/graph-templates.test.ts):
 *  - every template passes validateGraphSpec and compiles to a valid script;
 *  - stock agents only (`explore`, `general`) — routing is by agent id, and a
 *    user's specialists are a one-word edit in the template;
 *  - no provider or model ids anywhere;
 *  - every fanout carries an explicit `max` (a runaway fan-out is the classic
 *    way to die on the wall clock, not the agent cap);
 *  - prompts are self-contained: a child sees only its prompt string.
 *
 * Pure module: no plugin imports, no I/O.
 */
import type { GraphSpec } from "./graph.ts"

export interface GraphTemplate {
  /** Stable id used by `ultracode_catalog { template: "<name>" }`. */
  name: string
  /** One-line "use this when" — the catalog shows this without the full spec. */
  description: string
  /** The args the template reads (names only; see src/params.ts). */
  args: string[]
  graph: GraphSpec
}

const FILES_SCHEMA = {
  type: "object",
  required: ["files"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "lines"],
        properties: { path: { type: "string" }, lines: { type: "number" }, purpose: { type: "string" } },
      },
    },
  },
}

const LANE_REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "covered", "overflow"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "object", properties: { file: { type: "string" }, note: { type: "string" }, severity: { type: "string" } } } },
    covered: { type: "array", items: { type: "string" } },
    overflow: { type: "array", items: { type: "string" } },
  },
}

const CLAIMS_SCHEMA = {
  type: "object",
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["claim"],
        properties: { claim: { type: "string" }, hint: { type: "string" }, quote: { type: "string" } },
      },
    },
  },
}

const VERDICTS_SCHEMA = {
  type: "object",
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "verdict"],
        properties: {
          claim: { type: "string" },
          verdict: { type: "string", enum: ["supported", "refuted", "unverifiable"] },
          evidence: { type: "string" },
        },
      },
    },
  },
}

export const GRAPH_TEMPLATES: readonly GraphTemplate[] = [
  {
    name: "partitioned-review",
    description:
      "Review a large repo area without blowing one context: scout inventory, token-budgeted lanes, one reviewer per lane, a QC gate, then a batched merge of reports only.",
    args: ["area"],
    graph: {
      name: "partitioned-review",
      description: "scout, partition into lanes, review each lane, QC gate, batched merge",
      nodes: [
        {
          id: "scout",
          kind: "agent",
          agent: "explore",
          prompt:
            "Inventory {{args.area}} for a code review. Use glob, grep and line counts only — do NOT read file contents.\n" +
            "Return every file with its path and line count, plus a one-line purpose where the name is not self-evident.",
          schema: FILES_SCHEMA,
        },
        { id: "lanes", kind: "partition", from: "$scout.files", budgetTokens: 35000, tokensPerLine: 10 },
        {
          id: "review",
          kind: "fanout",
          over: "$lanes",
          agent: "explore",
          max: 12,
          label: "lane",
          prompt:
            "Review exactly the files in this lane: {{item}}\n" +
            "Read-discipline: grep and ranged reads only, never whole-read a file over ~500 lines, never echo file contents back.\n" +
            "Report concrete defects (correctness, error handling, contracts) with file and line. " +
            "List every path you covered, and put anything you could not review within budget in overflow.",
          schema: LANE_REPORT_SCHEMA,
        },
        { id: "qc", kind: "gate", from: "$review", agent: "general" },
        {
          id: "report",
          kind: "merge",
          from: "$review",
          agent: "general",
          batches: 8,
          prompt:
            "Merge these lane reports into one review, ordered by severity. Reports only — do NOT read source files.\n{{item}}",
        },
      ],
      returns: { report: "$report", lanes: "$lanes.length", qc: "$qc" },
    },
  },
  {
    name: "research-verify",
    description:
      "One researcher per angle, an independent verifier per research report, a skeptic pass over the survivors, then a cited synthesis. Claims rest on evidence, not on the generator's confidence.",
    args: ["topic", "angles"],
    graph: {
      name: "research-verify",
      description: "fan out research angles, verify independently, skeptic pass, cited synthesis",
      nodes: [
        {
          id: "research",
          kind: "fanout",
          over: "$args.angles",
          agent: "explore",
          max: 6,
          label: "angle",
          prompt:
            "Research this question: {{args.topic}}\nYour angle, and only your angle: {{item}}\n" +
            "Collect 3 to 5 falsifiable factual claims with one source hint each (publication, page, date). " +
            "Prefer primary sources; skip anything you cannot attribute.",
          schema: CLAIMS_SCHEMA,
        },
        {
          id: "verify",
          kind: "fanout",
          over: "$research",
          agent: "general",
          max: 8,
          label: "verify",
          prompt:
            "Verify each claim in this set against primary sources. Try to REFUTE each one before accepting it; " +
            "mark a claim unverifiable when the evidence is thin rather than guessing.\nClaims: {{item}}",
          schema: VERDICTS_SCHEMA,
        },
        {
          id: "skeptic",
          kind: "agent",
          agent: "general",
          prompt:
            "You are the skeptic. Overturn any verdict below that rests on weak, stale or self-referential evidence, " +
            "and say which claims survive and why.\nVerdicts: {{verify}}",
        },
        {
          id: "report",
          kind: "agent",
          agent: "general",
          prompt:
            "Write a cited briefing on {{args.topic}} using ONLY the claims that survived verification and the skeptic pass. " +
            "State confidence per claim and list what could not be verified.\n" +
            "Verdicts: {{verify}}\nSkeptic notes: {{skeptic}}",
        },
      ],
      returns: { report: "$report", verdicts: "$verify", skeptic: "$skeptic" },
    },
  },
  {
    name: "draft-fact-check",
    description:
      "Extract checkable claims from a draft, check each one against the supplied sources only, QC the batch, then compile a verdict table. No web access assumed.",
    args: ["draft", "sources"],
    graph: {
      name: "draft-fact-check",
      description: "extract claims, check each against supplied sources, QC, verdict table",
      nodes: [
        {
          id: "extract",
          kind: "agent",
          agent: "general",
          prompt:
            "Extract every checkable factual claim from this draft (numbers, dates, attributions, causal claims). " +
            "Quote the exact sentence each claim comes from. Skip opinions and hedged language.\nDraft:\n{{args.draft}}",
          schema: CLAIMS_SCHEMA,
        },
        {
          id: "check",
          kind: "fanout",
          over: "$extract.claims",
          agent: "general",
          max: 12,
          label: "claim",
          prompt:
            "Check this claim against ONLY the supplied sources. Verdict supported, refuted or unverifiable, with the " +
            "evidence quoted. Do not use outside knowledge.\nClaim: {{item}}\nSources:\n{{args.sources}}",
          schema: VERDICTS_SCHEMA,
        },
        { id: "qc", kind: "gate", from: "$check", agent: "general" },
        {
          id: "report",
          kind: "agent",
          agent: "general",
          prompt:
            "Compile a markdown table of every claim with its verdict and evidence, then a short list of the claims that " +
            "must be corrected or removed.\nVerdicts: {{check}}\nQC notes: {{qc}}",
        },
      ],
      returns: { report: "$report", verdicts: "$check" },
    },
  },
]

/** Template names in catalog order. */
export function graphTemplateNames(): string[] {
  return GRAPH_TEMPLATES.map((t) => t.name)
}

/** One template by name (undefined when unknown). */
export function graphTemplate(name: string): GraphTemplate | undefined {
  return GRAPH_TEMPLATES.find((t) => t.name === name)
}

/** Compact catalog listing: name, when-to-use, args — no spec bodies. */
export function graphTemplateSummaries(): Array<{ name: string; description: string; args: string[] }> {
  return GRAPH_TEMPLATES.map((t) => ({ name: t.name, description: t.description, args: [...t.args] }))
}
