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

You are about to author a workflow that orchestrates REAL subagent sessions from an isolated
worker. Every \`agent(...)\` call spawns a child with its own context window and its own model.
The run returns a small JSON value; only that value plus a compact envelope re-enters your
session. Child transcripts never touch your context.

Two ways to author, and the order matters:

1. **Graph** — a JSON DAG. The runtime validates it (refs, forward edges, prompts, budget),
   schedules the parallel waves and compiles the plumbing. Preferred: an invalid graph costs
   zero tokens, every call is auto-keyed for warm replay, and the structure stays reviewable.
2. **Script** — a plain-JS async function body. The escape hatch for what nodes cannot express:
   bounded loops, retries, conditional re-planning, arithmetic over intermediates.

Invoke \`ultracode_run\` with \`{ graph, args? }\`, \`{ script, name?, meta?, args? }\`, \`{ path, args? }\`
(a project-root-relative workflow file you write with your file tool — preferred for anything over
~30 lines), \`{ template: "name", args? }\` (served script template), or \`{ workflow: "name", args? }\`
(saved). Every form also takes \`background\` and \`resumeFrom\` — a
prior runID that warm-starts the run so keyed succeeded agents replay from cache and an
interrupted long run costs only its unfinished tail. \`meta\` and \`args\` are injected as globals.

**Never embed a long script as a string in tool input.** Author it as
\`.opencode/workflows/<name>.js\` with your file-write tool, then run
\`{ path: ".opencode/workflows/<name>.js", args }\` (no \`/ultracode save\` or trust
needed). Escaping a large script through a generic
execute/JS sandbox mangles it (workflow globals only exist inside \`ultracode_run\`).

## Discovery first: ultracode_catalog

\`ultracode_catalog\` is read-only, cheap, and fresher than anything in this skill. Call it before
choosing a saved workflow or authoring a graph from a blank page. With no input it returns the
agent roster, every saved workflow (kind, description, **params (names always; JSON types only when declared —
explicit params, a // Tool input: header, or a saved run's real args; graph-derived params are names only)**, phases,
required agents, trust state, last-run stats), the graph template summaries and the script template summaries, and
the live \`caps\`. Drill in with \`{ workflow: "name" }\` for one workflow's full spec (graph) or script head,
\`{ template: "name" }\` for one ready-made graph spec, \`{ templates: true }\` for all of them, or
\`{ scriptTemplate: "name" }\` for a ready-to-adapt script body (staged-delivery, verify-fix).

Two things it tells you that guessing cannot: what \`args\` a saved workflow actually takes, and
whether the user has trusted it. Trust gates SAVED workflows only: running by name requires the user's
one-time \`/ultracode trust <name>\` — relay that and wait. An inline \`{ script }\` you author now runs
without saving or trusting (there is no digest check against saved files); save when you will rerun or
share the orchestration. Never dodge an untrusted saved workflow by inlining its content — that bypasses
the user's pending approval; ask them to trust it.

## Decide: answer, delegate, or workflow

| Situation | Do |
| --- | --- |
| One reply answers it | Answer directly. Spawn nothing. |
| One focused subtask (explore one corner, review one file) | Delegate to a single subagent. |
| Task outgrows one context window: many files, many sources, broad research | Workflow: fan out, merge. |
| The shape is standard: scout → partition → fan out → gate → merge | Workflow as a **graph**, from a template. |
| Verification must be structural: independent verifiers, skeptics, judges | Workflow with a verify phase and a gate. |
| You will rerun, share, or compose the orchestration | Workflow, saved under a name. |
| You need loops, retries or conditional re-planning | Workflow as a **script** — start from \`staged-delivery\` if it is sequential write stages with verification. |

Rule of thumb: a workflow earns its cost when you can name BOTH the fan-out AND the verifier.
Name neither? Answer or delegate instead.

## Graph mode (author structure, not plumbing)

A graph is \`{ nodes: [...], returns?: { key: "$node.path" } }\`. Node ids are the phases; refs
like \`"$scout.items"\` are the edges and must flow forward, so cycles are impossible by
construction. Prompt templates interpolate \`{{args.x}}\`, \`{{nodeId.path}}\` and, inside a fanout
or merge, \`{{item}}\` and \`{{index}}\` — each JSON-stringified. A template that names another node
IS a dependency: the scheduler orders it, so a reader never runs beside its producer.

| Kind | What it does | Key fields |
| --- | --- | --- |
| \`agent\` | one child | \`prompt\`, \`agent?\`, \`schema?\`, \`label?\` |
| \`fanout\` | one child per item of \`over\` | \`over\`, \`prompt\` with \`{{item}}\`, \`max\` (always set it) |
| \`partition\` | split an inventory into token-budgeted lanes, no agent | \`from\`, \`budgetTokens\`, \`tokensPerLine\` |
| \`merge\` | batched merge children over \`from\`, joined text | \`from\`, \`prompt\`, \`batches\` |
| \`gate\` | ONE QC reviewer; auto-checkpoints, aborts the run on a failed verdict | \`from\`, \`onFail\` |
| \`checkpoint\` | persist a named snapshot, no agent | \`from\` or \`value\` |
| \`workflow\` | compose a saved workflow, depth 1 | \`name\`, \`argsFrom?\` |

What the compiler does for you: null-checking and a total-failure abort per fanout or merge,
batching, lane partitioning with coverage by construction, \`phase\` and \`label\` bookkeeping,
independent nodes grouped into \`parallel()\` waves, and an auto \`key\` on every call (\`scout\`,
\`review:3\`, \`report:b1\`) so a warm rerun replays finished children instead of paying twice.

Start from a template (\`ultracode_catalog { template: "partitioned-review" }\`) and edit prompts,
caps and schemas — that is cheaper and safer than inventing structure. Templates ship for
partitioned review, research with independent verification, and draft fact-checking.

## Complete graph example (runs as-is)

Material-budgeted review of a repo area: scout → partition → one reviewer per lane → QC gate →
batched merge of reports only.

\`\`\`
{
  "graph": {
    "name": "partitioned-review",
    "nodes": [
      { "id": "scout", "kind": "agent", "agent": "explore",
        "prompt": "Inventory {{args.area}} for review. Use glob, grep and line counts only — do NOT read file contents. Return every file with path and line count.",
        "schema": { "type": "object", "required": ["files"], "properties": { "files": { "type": "array",
          "items": { "type": "object", "required": ["path", "lines"],
            "properties": { "path": { "type": "string" }, "lines": { "type": "number" } } } } } } },
      { "id": "lanes", "kind": "partition", "from": "$scout.files", "budgetTokens": 35000 },
      { "id": "review", "kind": "fanout", "over": "$lanes", "agent": "explore", "max": 12,
        "prompt": "Review exactly the files in this lane: {{item}}\\nRead-discipline: grep and ranged reads only, never whole-read a file over ~500 lines, never echo contents back.\\nReport concrete defects with file and line; list what you covered and put anything unread in overflow.",
        "schema": { "type": "object", "required": ["summary", "covered", "overflow"], "properties": {
          "summary": { "type": "string" }, "covered": { "type": "array", "items": { "type": "string" } },
          "overflow": { "type": "array", "items": { "type": "string" } } } } },
      { "id": "qc", "kind": "gate", "from": "$review" },
      { "id": "report", "kind": "merge", "from": "$review", "agent": "general", "batches": 8,
        "prompt": "Merge these lane reports into one review ordered by severity. Reports only — do NOT read source files.\\n{{item}}" }
    ],
    "returns": { "report": "$report", "lanes": "$lanes.length", "qc": "$qc" }
  },
  "args": { "area": "the directory to review" }
}
\`\`\`

## Plan → Build (named workflow, no prior run)

Author in Plan mode; run by name from Build mode. Do not call \`ultracode_run\` inline from Plan.

1. Write ONE artifact into the project workflows directory: \`<name>.graph.json\` (a graph — pure
   JSON, no escaping hazards) or \`<name>.js\` (a script, async-function body, no module syntax).
   Name: lowercase alphanumerics, \`-\` or \`_\`, max 64 chars.
2. \`/ultracode save <name>\` (one-token file save). After a run, \`/ultracode save <runID> <name>\`
   still works — a graph run saves its spec, not the compiled script.
3. Review a graph with \`/ultracode graph <name>\` (waves, node table, mermaid — works before
   trust, which is the point), then \`/ultracode trust <name>\` (digest-bound; editing the artifact
   invalidates trust until it is re-approved).
4. Build: \`ultracode_run\` with \`{ workflow: "name", args? }\`. Do not mix native subagent fan-out
   with a workflow in the same task.

## Script mode (the escape hatch)

The script is an async function body: top-level \`await\` and \`return\` are legal, module syntax is
rejected. Served templates cover the recurring shapes — \`staged-delivery\` (write stages with
verify-fix gates), \`verify-fix\` (bounded fix loop), and the loop-mode recipes \`kanban\` and
\`kaggle-ml\` (below). Get one with \`ultracode_catalog { scriptTemplate: "staged-delivery" }\`, edit
prompts and args, then run it inline or save it. Injected globals, nothing else:

| Global | Call | Semantics |
| --- | --- | --- |
| \`agent\` | \`agent(prompt, opts?)\` | Spawns one subagent and waits. Resolves \`{ text, sessionID, agent, model, tokens, data?, cachedFrom?, failover? }\`. \`opts\`: \`agent\` (agent id), \`model\` (EXPLICIT override in the pin-string shape — only when the user asked for a model; beats pins and the run-level model), \`label\`, \`phase\`, \`schema\`, \`key\`. With \`opts.schema\`, extracted JSON lands in \`.data\`, validated and repaired once. \`opts.key\` (stable id, e.g. \`"lane:3"\`) marks the call replayable: on a warm rerun (\`resumeFrom\`, or \`/ultracode rerun <runID> --warm\`) a succeeded call with the same key AND the same prompt+schema+agent+model digest returns from cache — no session, no cap hit. Key every deterministic call in a long run. Plan-quota children fail over automatically (same session, different provider) unless the user set failover off; \`.failover\` is present when the child finished on a different model than it was spawned on. |
| \`parallel\` | \`parallel(thunks)\` | Barrier over thunks. A thunk that throws resolves as \`null\`; siblings still run. |
| \`pipeline\` | \`pipeline(items, ...stages)\` | Runs every item through the stages in order. A failing item becomes \`null\`; other items are unaffected. |
| \`phase\` | \`phase(name)\` | Sets the ambient phase label for progress grouping. |
| \`progress\` | \`progress(text)\` | Emits a progress line into the run log. |
| \`checkpoint\` | \`checkpoint(name, value?)\` | Persists a named phase-boundary snapshot (small JSON) onto the run record — visible in \`/ultracode show\` and \`ultracode_status\`. Call it after each expensive phase; it survives interruption and marks where a warm rerun resumes from. |
| \`workflow\` | \`workflow(name, args?)\` | Runs a SAVED workflow, resolves its JSON return. Depth 1 only: it may not compose another. |
| \`loop\` | \`loop(spec, iterate)\` | Engine-owned iteration (budgets, verdicts, stall, checkpoints). Use it instead of hand-rolled \`while\` loops — see Loop mode below. |
| \`queue\` | \`queue(items, opts?)\` | Pure serializable worklist: push, pop, popMany, done, block, unblock, sizes, items — content-hash ids (dedupe), \`deps\` gate readiness. Statuses survive \`items()\` round-trips, so a queue persists inside loop state. |
| \`sleep\` | \`sleep(ms)\` | Pause, capped at 60000 ms per call. |
| \`console\` | \`console.log(x)\` | Buffered into the run log. |
| \`args\` | \`args\` | Your tool-input arguments, a JSON value. |
| \`meta\` | \`meta\` | Your tool-input metadata: name, description, phases, requires. |

Caps are project settings, not constants: \`ultracode_catalog\` reports the live concurrency, agent
cap and timeout under \`caps\` (defaults: 8 concurrent agents, 200 agent calls per run, 60 minutes
wall clock; separately, scripts are hard-capped at 512 KB and results truncate after 64 KB by
default). Budget the wall clock before anything else — waves × dependent stages × ~5-10 min per child
must fit; prefer wide-not-deep. When a run legitimately needs longer, pass \`timeoutMs\` in the run
call (10 s to 24 h; this run only, recorded on the run; ask the user to \`/ultracode set timeoutMs\`
when it should stick). Loop caps are per-run inputs on the same pattern: \`maxLoopDepth\` (1..16,
when a design legitimately nests deeper) and \`maxLoopIterations\` (1..200, TIGHTEN-ONLY —
effective = min(loop budget, input); cap a template, never raise a budget).

## Loop mode (engine-owned iteration)

Hand-rolled \`while\` loops re-derive budget math, stall detection, verdict validation and resume
keys every time — \`loop(spec, iterate)\` makes the engine own them:

\`\`\`js
const summary = await loop({
  key: "green-suite",                    // auto-keys <key>:i<n>:a<m>; checkpoints loop:<key>:i<n>
  goal: "tests green, no regressions",
  state: { open: issues },               // yours; iterate is the ONLY writer; keep it small
  budget: { iterations: 8, agentsPerIteration: 6, wallMs: 30*60_000 },  // deadline: "8am-shaped" too
  stop: { predicate: (v) => v.state.open.length === 0 && "queue-empty", stallK: 3 },
  verdict: { agent: "general", schema: EVIDENCE, prompt: (c) => "Judge round " + c.i + ": " + JSON.stringify(c.result) },
}, async (c) => {
  const q = queue(c.state.open)          // statuses round-trip through state
  const item = q.pop()
  if (!item) return { state: c.state }
  // agent() calls here get auto-keys and count against the iteration budget
  return { state: { open: q.items() }, result: {} }
})
\`\`\`

- \`iterate(ctx)\` must return \`{ state, result? }\`; \`result\` feeds prompts and the verdict.
- Budgets are engine-owned: iterations / agentsPerIteration / wallMs / tokens / deadline checked
  every iteration; preflight rejects the worst case (iterations × agentsPerIteration, after any
  per-run \`maxLoopIterations\` ceiling is applied) beyond the run caps; \`ctx.budgetLeft\` shows what
  remains (agentsPerIteration already excludes the verdict+skeptic reservation).
- \`verdict\`: an independent judge (different agent than the workers) with a schema; a terminating
  \`done\` must survive ONE skeptic re-derivation before the loop stops (\`skeptic: false\` opts out);
  a refuted termination continues the loop. Evidence-shaped schemas (command / exitCode / outputQuote
  / metrics) keep "done" falsifiable.
- Stop reasons (returned + checkpointed): \`target | queue-empty | stall | budget | blocked | error\`.
  The summary's \`budget: { requested, effective }\` makes a stop at a per-run ceiling visible.
- \`ctx.artifactsDir\` (\`<run artifacts>/it-<i>\`) and \`ctx.runDir\` are where iterations put files;
  checkpoints store refs, not contents. \`ctx.history\` / \`ctx.lastVerdict\` / \`ctx.lastResult\` feed
  the next iteration without bloating state.
- \`unit: { name, args(state) }\` runs a TRUSTED saved workflow per iteration instead of a local
  iterate (preflighted before iteration 1); nesting is capped (\`maxLoopDepth\`, default 2 — but a
  unit whose workflow contains loops legitimately needs depth 3+: pass the per-run \`maxLoopDepth\`
  input). The budget ledger is shared across nested loops; a per-run \`maxLoopIterations\` ceiling
  binds unit loops too. A unit cannot run inside a composed workflow (depth 1) and its script must
  return \`{ state, result? }\` like any iterate.
- Structural failures (bad spec, depth cap, unit trust) fail loud; per-iteration failures follow
  \`onIterationError: retry | record | abort\`.
- Served loop templates: \`kanban\` (ticket worklist) and \`kaggle-ml\` (metric-targeted refinement).
  Inspect with \`ultracode_catalog { scriptTemplate: "kanban" }\`.
- Leftover work is a result shape, not a mechanism: loop templates return \`remaining\` — continue
  it in a follow-up run in the SAME conversation by passing it as the next run's \`tickets\`/\`open\`
  args. Cross-conversation campaign memory is deliberately unbuilt (docs/DESIGN-NOTES/reduce.md).

## Hard rules

1. **Graph first, script when you must.** If nodes express the shape, use them: validation is
   free, keys are automatic, and the structure stays reviewable. Write JS for loops and retries.
2. **Async function body ONLY** in a script. \`import\`, \`export\` and \`require\` are rejected before
   the run starts. There are no file, network or process APIs in the worker; all real work goes
   through \`agent\`.
3. **Return small JSON.** A few keys: a report string, counts, verdicts. Bigger values come back
   as a truncated preview — recover the full value with \`ultracode_result\` (offset paging), never
   by guessing past the cut.
4. **Route by agent, not by model — \`opts.model\` is the exception.** The user's pins decide each
   agent's model; use \`opts.model\` (or run input \`model\`) ONLY when the user asked for one — an
   override beats pins, but a provider the user disabled stays locked unless the run unlocks it.
5. **Prompts are the entire world.** A child agent sees ONLY its prompt string, zero conversation
   context. Make every prompt self-contained: paths, pasted snippets, criteria, output format.
6. **Serialize write agents.** A clean context is NOT filesystem isolation: two write agents
   racing in one worktree corrupt it. One write agent at a time; parallelize read-only agents.
   In a graph, a write node's prompt must reference its predecessor's output (even just a
   baseline count): a prompt naming no node compiles as a root and schedules beside it.
7. **Prefer explicit \`opts.phase\`.** The ambient \`phase()\` label races across parallel branches;
   an explicit \`opts.phase\` on every \`agent\` call always wins. (Graph nodes set it for you.)
8. **Use \`opts.schema\` for anything you merge or branch on.** \`.data\` is validated JSON; \`.text\`
   is unvalidated prose. (A graph node's \`schema\` does the same.)
9. **\`parallel\` swallows failures as \`null\`.** Null-check every result before merging, then
   decide: skip, retry, or abort. Compiled graphs null-check and abort on total failure for you.
10. **Bound everything.** Cap items, claims and retry iterations. A runaway fan-out hits the
    200-agent cap and fails the whole run; a wide one dies on the 60-minute wall clock. Set \`max\`
    on every fanout node and \`slice(0, n)\` in every script loop.
11. **\`meta\` and \`args\` come from tool input**, never from inside the script. Declare every
    non-stock agent in \`meta.requires\` so the preflight fails fast with the available-agents list.
12. **Verify before you trust.** Generators fan out, independent verifiers check, a skeptic pass
    overturns weak survivals. If the verifier shares the generator's failure modes, the workflow
    is theater. A \`gate\` node between an expensive phase and the next one is this, pre-built.
13. **Iterate through \`loop()\`, not a hand-rolled \`while\`.** The engine owns budgets, auto-keys,
    checkpoints, stall detection and the skeptics behind terminating verdicts; a raw wait-loop
    forfeits all of it (and its un-keyed children cannot warm-replay). Graph first, \`loop()\` for
    refinement until a condition, raw scripts for bounded one-shot shapes (tournaments, fan-out).

## Sizing: partition, budget, merge (read this before any wide fan-out)

A 300k-token child is a lane that was too wide, not a model problem. Budget **input material**
(files, line counts), not context tokens — reasoning models inflate their own numbers, so material
is the only unit comparable across the user's model rotation.

1. **Scout before you fan out** — one cheap \`explore\` child returns an inventory (paths + line
   counts). The orchestration, not the children, partitions it into lanes. A \`partition\` node
   does this at ~35000 estimated tokens per lane (≈3-4k lines at ~10 tokens per line).
2. **Arithmetic coverage assertion** — every inventoried file lands in ≥1 lane. Coverage comes
   from the map, not from each child reading everything.
3. **Every lane schema carries \`overflow\`** (paths not read within budget) so the next pass can
   subdivide them instead of silently under-covering.
4. **Merge reads REPORTS only, in batches of ~8** (hierarchical for more). One mega-merge child
   recreates the exact blowup fan-out exists to avoid.
5. **One cross-cutting lane** greps the cross-file question's symbols repo-wide, so
   partition-by-file seams have an owner.
6. **Read-discipline in every child prompt**: grep + ranged reads, no whole-file reads of large
   files, never echo file contents back; output = the schema JSON only.

## Script-only patterns

Skeletons assume SCHEMA constants are JSON Schema objects you define inline.

### Adversarial verification (verifier, then skeptic)

\`\`\`
phase("verify")
const verdicts = await parallel(claims.map((c) => () =>
  agent("Verify this claim. Try to refute it before accepting it.\\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT, key: "verify:" + c.slice(0, 24) })))
const supported = verdicts.flatMap((v, i) =>
  v && v.data && v.data.verdict === "supported" ? [claims[i]] : [])
phase("skeptic")
const skeptic = await agent("Overturn any of these resting on weak evidence:\\n" +
  JSON.stringify(supported), { agent: "general", phase: "skeptic", key: "skeptic:v1" })
\`\`\`

### Pipeline per item (a stage failure isolates to one item)

\`\`\`
const rated = await pipeline(files,
  (f) => agent("Skim this file and list risks.\\nFile: " + f,
    { agent: "explore", phase: "skim", schema: RISKS, key: "skim:" + f }),
  (r, i) => agent("Rate the severity of these risks:\\n" + JSON.stringify(r.data) +
    "\\nFile: " + files[i], { agent: "general", phase: "rate", schema: SEVERITY, key: "rate:" + files[i] }))
\`\`\`

### Loop until done (engine-owned; the write agent stays sequential per iteration)

\`\`\`
const summary = await loop({
  key: "fix", goal: "issues resolved", state: { open: issues },
  budget: { iterations: 5, agentsPerIteration: 4 }, stop: { predicate: (v) => v.state.open.length === 0 && "queue-empty", stallK: 2 },
}, async (c) => {
  await agent("Fix exactly these issues. Change no unrelated code.\\n" + JSON.stringify(c.state.open),
    { agent: "general", phase: "fix", label: "fix" + c.i, key: "fix:" + c.i })
  const recheck = await agent("Check whether these issues still exist. List survivors only.\\n" +
    JSON.stringify(c.state.open), { agent: "explore", phase: "recheck", schema: ISSUES, key: "recheck:" + c.i })
  return { state: { open: (recheck && recheck.data && recheck.data.issues) || [] } }
})
return { fixed: issues.length - summary.state.open.length, open: summary.state.open }
\`\`\`

### Tournament (pairwise judges, bounded rounds)

\`\`\`
let pool = options.slice()
for (let round = 0; round < 3 && pool.length > 1; round++) {
  const pairs = []
  for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]])
  const picks = await parallel(pairs.map((pair, i) => () =>
    agent("Judge this pair; pick exactly one winner.\\nA: " + pair[0] + "\\nB: " + pair[1],
      { agent: "general", phase: "judge", schema: PICK, key: "judge:" + round + ":" + i })))
  pool = picks.flatMap((p, i) =>
    p && p.data && p.data.winner === "B" ? [pairs[i][1]] : [pairs[i][0]])
}
return { winner: pool[0] }
\`\`\`

### Compose a saved workflow (depth 1)

\`\`\`
const research = await workflow("deep-research", { topic: topic })
const audit = await workflow("code-audit", { modules: ["auth", "db"] })
return { research: research.stats, audit: audit.stats }
\`\`\`

Saved workflows (samples included) run only after the user approves them once via
\`/ultracode trust <name>\`; editing the artifact later invalidates that approval. An unapproved
call fails fast with that instruction — relay it to the user instead of retrying. Plan-authored
files use the same gate after \`/ultracode save <name>\`.

## Complete script example

Research fan-out with structural verification. Runs as-is:

\`\`\`
const topic = String(args.topic)
const CLAIMS = { type: "object", required: ["claims"], properties: { claims: { type: "array",
  items: { type: "object", required: ["claim", "hint"], properties: { claim: { type: "string" },
  hint: { type: "string" } } } } } }
const VERDICT = { type: "object", required: ["verdict"], properties: { verdict: { type: "string",
  enum: ["supported", "refuted", "unverifiable"] }, evidence: { type: "string" } } }
phase("research")
const found = await parallel(["how it works", "who relies on it", "known failures"].map((a, i) => () =>
  agent("Collect 3 to 5 checkable factual claims about: " + topic + "\\nAngle: " + a +
    "\\nOne source hint per claim.", { agent: "explore", phase: "research", schema: CLAIMS, key: "angle:" + i })))
const claims = []
for (const part of found) for (const c of (part && part.data && part.data.claims) || []) claims.push(c.claim)
phase("verify")
const verdicts = await parallel(claims.slice(0, 12).map((c, i) => () =>
  agent("Verify against primary sources; refute it if you can.\\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT, key: "verify:" + i })))
const kept = []
verdicts.forEach((v, i) => { if (v && v.data && v.data.verdict === "supported")
  kept.push({ claim: claims[i], evidence: v.data.evidence || "" }) })
checkpoint("verified", { kept: kept.length, examined: claims.length })
phase("report")
const report = await agent("Write a 300-word briefing on: " + topic +
  "\\nUse ONLY these verified claims:\\n" + JSON.stringify(kept, null, 1),
  { agent: "general", phase: "report", key: "report:v1" })
return { brief: report.text, verified: kept.length, examined: claims.length }
\`\`\`

## Running, steering and stopping a run

Runs are background by default so the user can keep chatting. When the run settles, a one-line
notice lands in the parent session and wakes the calling agent (status, agents, result brief,
stop reason). If the result exceeds the size cap, the notice and \`ultracode_status\` carry a
preview and the total size — fetch the full value with \`ultracode_result { runID, offset,
maxLength }\`; chunks are substrings of the compact JSON, so concatenate from offset 0 following
\`nextOffset\`, then parse once.

- \`ultracode_status { runID? }\` — per-child detail (id, session, label, phase, status, tokens,
  tool calls, permission waits) and, once settled, the result itself or a bounded preview.
- \`ultracode_control { action: "stop" | "pause" | "resume", runID?, model?, remember? }\` — your own runs only. Stop
  is graceful (no new agent calls, in-flight children interrupted) and is recorded as the run's
  stop reason; pause closes admission of new \`agent()\` calls. Ask-mode resume: optional \`model\` (pin) is this run's fallback override; \`remember: true\` persists it for future runs.
- \`ultracode_steer { runID, agentID?, text }\` — deliver a user adjustment to ONE running child
  without stopping the workflow. If several children are active, pick the relevant agentID from
  status; do not broadcast edits blindly. It does not restart completed children.

Status includes active child ids and permission waits. In Ctrl+G, review permissions with y or n;
never treat a blocked child as completed work.

Never paste a workflow script into a generic JS or execute sandbox — \`agent\`, \`parallel\`,
\`pipeline\`, \`phase\`, \`progress\`, \`checkpoint\`, \`workflow\`, \`sleep\`, \`args\` and \`meta\` exist only
inside \`ultracode_run\`; anywhere else they are undefined.

This skill auto-attaches when \`ultracode\` appears as a standalone keyword anywhere in the prompt
(\`ultracode: audit the auth module\`, \`please ultracode this\`). Paths like \`opencode-ultracode\` do
not match; plain "use a workflow" does not auto-attach — the host may still select this skill.

## Coexistence with other skills

Other attached skills carry the domain: methodology, evidence standards, consent rules, reporting
format. Ultracode carries only the execution mechanism: orchestrating many agents from one run.
Two rules keep the layers from fighting:

1. Use ONE orchestration mechanism per task. Do not fan out through native subagents AND a
   workflow in the same task; if a workflow is running, it owns all delegation.
2. Child sessions do NOT inherit skills attached to your session: a child sees only its prompt.
   When domain skills impose requirements (consent, provider rules, output format), restate them
   inside the workflow prompts for that domain work.

## Agent routing

- Every install has \`general\` (general-purpose subagent) and \`explore\` (fast codebase
  exploration). Omitting \`opts.agent\` means \`general\`. \`ultracode_catalog\` lists the real roster.
- If this user has specialists (reviewer, deep-researcher, critic, planner), prefer them: pass the
  id via \`opts.agent\` AND declare it in \`meta.requires\` (a graph node's \`agent\` is collected into
  \`requires\` for you). The preflight then fails fast with the list of available agents instead of
  the run dying midway.
- Cost shape: extraction and search go to the cheap agent; judgment and synthesis go to the strong
  one. The user pins which model each agent runs. Name a model (\`opts.model\` / run-input \`model\`)
  ONLY when the user explicitly asked for one — see hard rule 4.
- \`model\` on results is informational (what actually ran). Do not branch on it.

Before authoring, answer two questions: what is the fan-out? who verifies? If both answers exist,
build it — graph first, script when the shape needs loops — with self-contained prompts, explicit
phases, bounded fan-out, a schema for everything you merge on, and a small JSON return.
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
