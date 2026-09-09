/**
 * The Ultracode authoring skill (Builder C).
 *
 * Consumed by src/index.ts (skill transform) and mirrored to
 * .opencode/workflows/ultracode-skill.md at plugin setup. The content teaches
 * the host model how to AUTHOR workflow scripts; it is deliberately token-lean.
 */

export const SKILL_NAME: string = "Ultracode"

export const SKILL_DESCRIPTION: string =
  "Trigger when the user says ultracode or asks for a workflow, or when a task outgrows one context window, needs many parallel subagents, or needs enforced structural verification: author a JavaScript workflow script, call the workflow tool, and let the isolated runtime spawn real subagent sessions, fan out with parallel and pipeline, verify with independent verifier and skeptic passes, and return a small JSON result."

export const SKILL_CONTENT: string = `# Ultracode workflows

You are about to author a workflow: a plain JavaScript async-body script that runs in an isolated
worker. Every \`agent(...)\` call spawns a REAL subagent session with its own context window and its
own model. The script returns a small JSON value; only that value plus a compact run envelope
re-enters your session. Child transcripts never touch your context.

Invoke the \`ultracode_run\` tool with \`{ script, name?, meta?, args? }\` for an inline run, or
\`{ workflow: "name", args? }\` to run a saved workflow. \`meta\` and \`args\` are injected into the
script as globals.

Never paste a workflow script into a generic JS/execute sandbox — \`agent\`, \`parallel\`, \`pipeline\`, \`phase\`, \`progress\`, \`workflow\`, \`sleep\`, \`args\`, and \`meta\` exist only inside \`ultracode_run\`; anywhere else they are undefined.

This skill auto-attaches when \`ultracode\` appears as a standalone keyword anywhere in the prompt
— for example \`ultracode: audit the auth module\`, \`please ultracode this\`, or \`ultracode do X\`.
Paths like \`opencode-ultracode\` do not match. Plain "use a workflow" does not auto-attach; the
host may still select this skill from its description.

## Coexistence with other skills

Other attached skills carry the domain: methodology, evidence standards, consent rules, reporting
format. Ultracode carries only the execution mechanism: orchestrating many agents from one script.
Two rules keep the layers from fighting:

1. Use ONE orchestration mechanism per task. Do not fan out through native subagents AND a
   workflow in the same task; if a workflow is running, it owns all delegation.
2. Child sessions do NOT inherit skills attached to your session: a child sees only its prompt.
   When domain skills impose requirements (consent, provider rules, output format), restate them
   inside the workflow prompts for that domain work — e.g. the bailian consent and provider rules
   when the user relies on them.

## Decide: answer, delegate, or workflow

| Situation | Do |
| --- | --- |
| One reply answers it | Answer directly. Spawn nothing. |
| One focused subtask (explore one corner, review one file) | Delegate to a single subagent. |
| Task outgrows one context window: many files, many sources, broad research | Workflow: fan out, merge. |
| Verification must be structural: independent verifiers, skeptics, judges | Workflow with a verify phase. |
| You will rerun, share, or compose the orchestration | Workflow, saved under a name. |

Rule of thumb: a workflow earns its cost when you can name BOTH the fan-out AND the verifier.
Name neither? Answer or delegate instead.

## Script API (exact)

The script is an async function body: top-level \`await\` and \`return\` are legal, module syntax is
rejected. Injected globals, nothing else:

| Global | Call | Semantics |
| --- | --- | --- |
| \`agent\` | \`agent(prompt, opts?)\` | Spawns one subagent and waits. Resolves \`{ text, sessionID, agent, model, tokens, data? }\`. \`opts\`: \`agent\` (agent id), \`label\`, \`phase\`, \`schema\`. With \`opts.schema\`, extracted JSON lands in \`.data\`, validated and repaired once. |
| \`parallel\` | \`parallel(thunks)\` | Barrier over thunks. A thunk that throws resolves as \`null\`; siblings still run. |
| \`pipeline\` | \`pipeline(items, ...stages)\` | Runs every item through the stages in order. A failing item becomes \`null\`; other items are unaffected. |
| \`phase\` | \`phase(name)\` | Sets the ambient phase label for progress grouping. |
| \`progress\` | \`progress(text)\` | Emits a progress line into the run log. |
| \`workflow\` | \`workflow(name, args?)\` | Runs a SAVED workflow, resolves its JSON return. Depth 1 only: it may not compose another. |
| \`sleep\` | \`sleep(ms)\` | Pause, capped at 60000 ms per call. |
| \`console\` | \`console.log(x)\` | Buffered into the run log. |
| \`args\` | \`args\` | Your tool-input arguments, a JSON value. |
| \`meta\` | \`meta\` | Your tool-input metadata: name, description, phases, requires. |

Caps: 8 concurrent agents (default), 200 agent calls per run, 60 minutes wall clock, 512 KB max
script size, results truncated after 64 KB by default.

## Hard rules

1. **Async function body ONLY.** \`import\`, \`export\`, and \`require\` are rejected before the run
   starts. There are no file, network, or process APIs in the worker; all real work goes through
   \`agent\`.
2. **Return small JSON.** A few keys: a report string, counts, verdicts. Bigger values come back
   as a truncated preview.
3. **Route by agent, never by model.** No provider or model ids anywhere. Pass an agent id in
   \`opts.agent\`; the user's own agent config decides which model runs.
4. **Prompts are the entire world.** A child agent sees ONLY its prompt string, zero conversation
   context. Make every prompt self-contained: paths, pasted snippets, criteria, output format.
5. **Serialize write agents.** A clean context is NOT filesystem isolation: two write agents
   racing in one worktree corrupt it. One write agent at a time; parallelize read-only agents.
6. **Prefer explicit \`opts.phase\`.** The ambient \`phase()\` label races across parallel branches;
   an explicit \`opts.phase\` on every \`agent\` call always wins.
7. **Use \`opts.schema\` for anything you merge or branch on.** \`.data\` is validated JSON; \`.text\`
   is unvalidated prose.
8. **\`parallel\` swallows failures as \`null\`.** Null-check every result before merging, then
   decide: skip, retry, or abort.
9. **Bound everything.** Cap items, claims, and retry iterations. A runaway fan-out hits the
   200-agent cap and fails the whole run.
10. **\`meta\` and \`args\` come from tool input**, never from inside the script. Declare every
    non-stock agent in \`meta.requires\` so the preflight fails fast with the available-agents list.
11. **Verify before you trust.** Generators fan out, independent verifiers check, a skeptic pass
    overturns weak survivals. If the verifier shares the generator's failure modes, the workflow
    is theater.

## Patterns

Skeletons assume SCHEMA constants are JSON Schema objects you define inline (see the complete
example below).

### Fan-out and synthesize (read-only, parallel-safe)

\`\`\`
phase("research")
const parts = await parallel(["api", "storage", "ui"].map((area) => () =>
  agent("Summarize the " + area + " layer of this repo. Read the code; be concrete.",
    { agent: "explore", phase: "research", schema: SUMMARY })))
const good = parts.filter(Boolean)
const report = await agent("Merge these summaries into one report:\\n" +
  JSON.stringify(good.map((p) => p.data)), { agent: "general", phase: "synthesize" })
return { report: report.text, sections: good.length }
\`\`\`

### Adversarial verification (verifier, then skeptic)

\`\`\`
phase("verify")
const verdicts = await parallel(claims.map((c) => () =>
  agent("Verify this claim. Try to refute it before accepting it.\\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT })))
const supported = verdicts.flatMap((v, i) =>
  v && v.data && v.data.verdict === "supported" ? [claims[i]] : [])
phase("skeptic")
const skeptic = await agent("Overturn any of these resting on weak evidence:\\n" +
  JSON.stringify(supported), { agent: "general", phase: "skeptic", schema: OVERTURNED })
\`\`\`

### Pipeline per item (a stage failure isolates to one item)

\`\`\`
const rated = await pipeline(files,
  (f) => agent("Skim this file and list risks.\\nFile: " + f,
    { agent: "explore", phase: "skim", schema: RISKS }),
  (r, i) => agent("Rate the severity of these risks:\\n" + JSON.stringify(r.data) +
    "\\nFile: " + files[i], { agent: "general", phase: "rate", schema: SEVERITY }))
\`\`\`

### Generate and filter

\`\`\`
phase("draft")
const drafts = await parallel(Array.from({ length: 6 }, (_, i) => () =>
  agent("Propose solution " + (i + 1) + " for this task. One paragraph each.\\nTask: " + task,
    { agent: "general", phase: "draft" })))
phase("filter")
const best = await agent("Rank these drafts. Keep the top 2 with reasons.\\n" +
  drafts.filter(Boolean).map((d) => d.text).join("\\n---\\n"),
  { agent: "general", phase: "filter", schema: TOP2 })
\`\`\`

### Tournament (pairwise judges, bounded rounds)

\`\`\`
let pool = options.slice()
for (let round = 0; round < 3 && pool.length > 1; round++) {
  const pairs = []
  for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]])
  const picks = await parallel(pairs.map((pair) => () =>
    agent("Judge this pair; pick exactly one winner.\\nA: " + pair[0] + "\\nB: " + pair[1],
      { agent: "general", phase: "judge", schema: PICK })))
  pool = picks.flatMap((p, i) =>
    p && p.data && p.data.winner === "B" ? [pairs[i][1]] : [pairs[i][0]])
}
return { winner: pool[0] }
\`\`\`

### Loop until done (bounded; the write agent stays sequential)

\`\`\`
let open = issues
for (let pass = 1; pass <= 5 && open.length > 0; pass++) {
  progress("pass " + pass + ": " + open.length + " open")
  await agent("Fix exactly these issues. Change no unrelated code.\\n" + JSON.stringify(open),
    { agent: "general", phase: "fix", label: "fix" + pass })   // write agent: one at a time
  const recheck = await agent("Check whether these issues still exist. List survivors only.\\n" +
    JSON.stringify(open), { agent: "explore", phase: "recheck", schema: ISSUES })
  open = (recheck && recheck.data && recheck.data.issues) || []
}
return { fixed: issues.length - open.length, open }
\`\`\`

### Compose a saved workflow (depth 1)

\`\`\`
const research = await workflow("deep-research", { topic: topic })
const audit = await workflow("code-audit", { modules: ["auth", "db"] })
return { research: research.stats, audit: audit.stats }
\`\`\`

Saved workflows (samples included) run only after the user approves them once via
\`/ultracode trust <name>\`; editing the script later invalidates that approval. An unapproved
call fails fast with that instruction — relay it to the user instead of retrying.

## Complete example

Research fan-out with structural verification. Runs as-is:

\`\`\`
const topic = String(args.topic)
const CLAIMS = { type: "object", required: ["claims"], properties: { claims: { type: "array",
  items: { type: "object", required: ["claim", "hint"], properties: { claim: { type: "string" },
  hint: { type: "string" } } } } } }
const VERDICT = { type: "object", required: ["verdict"], properties: { verdict: { type: "string",
  enum: ["supported", "refuted", "unverifiable"] }, evidence: { type: "string" } } }
phase("research")
const found = await parallel(["how it works", "who relies on it", "known failures"].map((a) => () =>
  agent("Collect 3 to 5 checkable factual claims about: " + topic + "\\nAngle: " + a +
    "\\nOne source hint per claim.", { agent: "explore", phase: "research", schema: CLAIMS })))
const claims = []
for (const part of found) for (const c of (part && part.data && part.data.claims) || []) claims.push(c.claim)
phase("verify")
const verdicts = await parallel(claims.slice(0, 12).map((c) => () =>
  agent("Verify against primary sources; refute it if you can.\\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT })))
const kept = []
verdicts.forEach((v, i) => { if (v && v.data && v.data.verdict === "supported")
  kept.push({ claim: claims[i], evidence: v.data.evidence || "" }) })
phase("report")
const report = await agent("Write a 300-word briefing on: " + topic +
  "\\nUse ONLY these verified claims:\\n" + JSON.stringify(kept, null, 1),
  { agent: "general", phase: "report" })
return { brief: report.text, verified: kept.length, examined: claims.length }
\`\`\`

## Agent routing

- Every install has \`general\` (general-purpose subagent) and \`explore\` (fast codebase
  exploration). Omitting \`opts.agent\` means \`general\`.
- If this user has specialists (reviewer, deep-researcher, critic, planner), prefer them: pass the
  id via \`opts.agent\` AND declare it in \`meta.requires\`. The preflight then fails fast with the
  list of available agents instead of the run dying midway.
- Cost shape: extraction and search go to the cheap agent; judgment and synthesis go to the strong
  one. The user pins which model each agent runs. You never name models, ever.
- \`model\` on results is informational (what actually ran). Do not branch on it.

Before writing the script, answer two questions: what is the fan-out? who verifies? If both
answers exist, write the script: self-contained prompts, explicit phases, bounded loops, a schema
for everything you merge on, and a small JSON return.
`

/** Live agent + saved-workflow catalog injected into the in-memory skill (D1). */
export interface SkillCatalogAgent {
  id: string
  description?: string
}

export interface SkillCatalogWorkflow {
  name: string
  description?: string
  phases?: string[]
  trusted: boolean
}

export interface SkillCatalog {
  agents: ReadonlyArray<SkillCatalogAgent>
  workflows: ReadonlyArray<SkillCatalogWorkflow>
}

export const EMPTY_CATALOG: SkillCatalog = { agents: [], workflows: [] }

/**
 * Authoring skill markdown plus, when the catalog is non-empty, a live
 * agents/workflows appendix. Empty catalog returns SKILL_CONTENT byte-identical
 * so `skills/ultracode.md === SKILL_CONTENT` stays locked.
 */
export function buildSkillContent(catalog: SkillCatalog): string {
  if (catalog.agents.length === 0 && catalog.workflows.length === 0) return SKILL_CONTENT
  const lines: string[] = ["", "## Live catalogs in this install", "", "### Agents", ""]
  if (catalog.agents.length === 0) {
    lines.push("(none)")
  } else {
    for (const a of catalog.agents) {
      lines.push(a.description ? `- \`${a.id}\` — ${a.description}` : `- \`${a.id}\``)
    }
  }
  lines.push("", "### Saved workflows", "")
  if (catalog.workflows.length === 0) {
    lines.push("(none)")
  } else {
    for (const w of catalog.workflows) {
      const bits: string[] = []
      if (w.phases && w.phases.length > 0) bits.push(`phases: ${w.phases.join(", ")}`)
      bits.push(`trusted: ${w.trusted ? "yes" : "no"}`)
      const extra = bits.join("; ")
      const desc = w.description ? ` — ${w.description}` : ""
      lines.push(`- \`${w.name}\`${desc} (${extra})`)
    }
  }
  lines.push("")
  return SKILL_CONTENT + lines.join("\n")
}
