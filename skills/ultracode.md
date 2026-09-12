# Ultracode workflows

You are about to author a workflow: a plain JavaScript async-body script that runs in an isolated
worker. Every `agent(...)` call spawns a REAL subagent session with its own context window and its
own model. The script returns a small JSON value; only that value plus a compact run envelope
re-enters your session. Child transcripts never touch your context.

Invoke the `ultracode_run` tool with `{ script, name?, meta?, args?, background?, resumeFrom? }` for an inline
run, or `{ workflow: "name", args?, background?, resumeFrom? }` to run a saved workflow. `meta` and `args` are injected
into the script as globals. `resumeFrom` (a prior runID) warm-starts: keyed succeeded agents replay
from cache, so an interrupted long run costs only its unfinished tail. Runs are background by
default: the tool returns immediately after admission
so the parent chat stays available; pass `background: false` only when you need the envelope
in-call. Progress and status are scoped to that run
(`ultracode_status`, inspect, `/ultracode status`). When the run settles, a one-line notice lands
in the parent session and wakes the calling agent (status, agents, result brief, stop reason). If
the result exceeds the size cap, the notice and `ultracode_status` carry a preview and the total
size — fetch the full value with `ultracode_result { runID, offset, maxLength }`; chunks are
substrings of the compact JSON, so concatenate from offset 0 following `nextOffset`, then parse once.

For long interactive tasks, background is the default so the user can keep chatting.
When the user changes requirements, use `ultracode_steer` with `{ runID, agentID?, text }`
to deliver the adjustment to one running child without stopping the workflow. If several
children are active, choose the relevant agentID from status; do not broadcast edits blindly.
Status includes active child IDs and permission waits. In Ctrl+G, review permissions with y or n;
never treat a blocked child as completed work.

Control your own runs: `ultracode_status { runID? }` returns per-child detail (id, session, label,
phase, status) and, once the run settles, the result itself — inline when it fits the size cap,
else a bounded preview with the total size; `ultracode_result` `{ runID, offset?, maxLength? }`
pages the FULL settled result when it was truncated; `ultracode_control` with
`{ action: "stop" | "pause" | "resume", runID? }` stops, pauses, or resumes a run this
conversation owns (implicit target only when exactly one is active). Stop is graceful — no new
agent calls, in-flight children interrupted — and is recorded as the run's stop reason
(`/ultracode show` displays it). Pause and resume are not persisted log lines.

Never paste a workflow script into a generic JS/execute sandbox — `agent`, `parallel`, `pipeline`, `phase`, `progress`, `workflow`, `sleep`, `args`, and `meta` exist only inside `ultracode_run`; anywhere else they are undefined.

This skill auto-attaches when `ultracode` appears as a standalone keyword anywhere in the prompt
— for example `ultracode: audit the auth module`, `please ultracode this`, or `ultracode do X`.
Paths like `opencode-ultracode` do not match. Plain "use a workflow" does not auto-attach; the
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

## Plan → Build (named workflow, no prior run)

Author in Plan mode; run by name from Build mode. Do not call `ultracode_run` inline from Plan.

1. Write only `<name>.js` in the project workflows directory (async-function body, no module syntax).
   Name: lowercase alphanumerics, `-`/`_`, max 64 chars.
2. `/ultracode save <name>` (one-token file save). After a run, `/ultracode save <runID> <name>` still works.
3. `/ultracode trust <name>` (digest-bound; editing the script invalidates trust until re-approved).
4. Build: `ultracode_run` with `{ workflow: "name", args? }`. Do not mix native subagent fan-out
   with a workflow in the same task.

## Script API (exact)

The script is an async function body: top-level `await` and `return` are legal, module syntax is
rejected. Injected globals, nothing else:

| Global | Call | Semantics |
| --- | --- | --- |
| `agent` | `agent(prompt, opts?)` | Spawns one subagent and waits. Resolves `{ text, sessionID, agent, model, tokens, data?, cachedFrom? }`. `opts`: `agent` (agent id), `label`, `phase`, `schema`, `key`. With `opts.schema`, extracted JSON lands in `.data`, validated and repaired once. `opts.key` (stable id, e.g. `"lane:3"`) marks the call replayable: on a warm rerun (`resumeFrom` tool input, or `/ultracode rerun <runID> --warm`) a succeeded call with the same key AND the same prompt+schema+agent digest returns from cache — no session, no cap hit. Key every deterministic call in long runs. |
| `parallel` | `parallel(thunks)` | Barrier over thunks. A thunk that throws resolves as `null`; siblings still run. |
| `pipeline` | `pipeline(items, ...stages)` | Runs every item through the stages in order. A failing item becomes `null`; other items are unaffected. |
| `phase` | `phase(name)` | Sets the ambient phase label for progress grouping. |
| `progress` | `progress(text)` | Emits a progress line into the run log. |
| `checkpoint` | `checkpoint(name, value?)` | Persists a named phase-boundary snapshot (small JSON) onto the run record — visible in `/ultracode show` and `ultracode_status` (`checkpoints`). Call it after each expensive phase with the merged intermediate (`checkpoint("survey-done", { signals: merged.length })`); it survives interruption and marks where a warm rerun can resume from. |
| `workflow` | `workflow(name, args?)` | Runs a SAVED workflow, resolves its JSON return. Depth 1 only: it may not compose another. |
| `sleep` | `sleep(ms)` | Pause, capped at 60000 ms per call. |
| `console` | `console.log(x)` | Buffered into the run log. |
| `args` | `args` | Your tool-input arguments, a JSON value. |
| `meta` | `meta` | Your tool-input metadata: name, description, phases, requires. |

Caps: 8 concurrent agents (default), 200 agent calls per run, 60 minutes wall clock, 512 KB max
script size, results truncated after 64 KB by default. Budget the wall clock before anything else:
waves (ceil(agents / concurrency)) × dependent stages × ~5-10 minutes per child must fit — prefer
wide-not-deep, and raise the ceiling per project with `/ultracode set timeoutMs <ms>` when a wide
run legitimately needs it.

## Hard rules

1. **Async function body ONLY.** `import`, `export`, and `require` are rejected before the run
   starts. There are no file, network, or process APIs in the worker; all real work goes through
   `agent`.
2. **Return small JSON.** A few keys: a report string, counts, verdicts. Bigger values come back
   as a truncated preview — recover the full value with `ultracode_result` (offset paging), never
   by guessing past the cut.
3. **Route by agent, never by model.** No provider or model ids anywhere. Pass an agent id in
   `opts.agent`; the user's own agent config decides which model runs.
4. **Prompts are the entire world.** A child agent sees ONLY its prompt string, zero conversation
   context. Make every prompt self-contained: paths, pasted snippets, criteria, output format.
5. **Serialize write agents.** A clean context is NOT filesystem isolation: two write agents
   racing in one worktree corrupt it. One write agent at a time; parallelize read-only agents.
6. **Prefer explicit `opts.phase`.** The ambient `phase()` label races across parallel branches;
   an explicit `opts.phase` on every `agent` call always wins.
7. **Use `opts.schema` for anything you merge or branch on.** `.data` is validated JSON; `.text`
   is unvalidated prose.
8. **`parallel` swallows failures as `null`.** Null-check every result before merging, then
   decide: skip, retry, or abort.
9. **Bound everything.** Cap items, claims, and retry iterations. A runaway fan-out hits the
   200-agent cap and fails the whole run; a wide one dies on the 60-minute wall clock — budget
   waves × stages × ~5-10 min per child before you write the first `agent()` call.
10. **`meta` and `args` come from tool input**, never from inside the script. Declare every
    non-stock agent in `meta.requires` so the preflight fails fast with the available-agents list.
11. **Verify before you trust.** Generators fan out, independent verifiers check, a skeptic pass
    overturns weak survivals. If the verifier shares the generator's failure modes, the workflow
    is theater.
12. **Gate expensive phases; checkpoint the merge.** Between a cheap phase and an expensive one,
    run ONE small reviewer (`{ pass, issues, action }` schema) over the merged intermediate and
    abort or retry on failure — a bad merge must not fund a synthesis fan-out. Then
    `checkpoint(name, value)` so the boundary survives interruption. Key the calls you would not
    want to pay for twice.

## Patterns

Skeletons assume SCHEMA constants are JSON Schema objects you define inline (see the complete
example below).

### Sizing: partition, budget, merge (read this before any wide fan-out)

A 300k-token child is a lane that was too wide, not a model problem. Budget **input material**
(files, line counts), not context tokens — reasoning models inflate their own numbers, so material
is the only unit comparable across the user's model rotation.

1. **Scout before you fan out** — one cheap `explore` child returns an inventory (paths + line
   counts). The script, not the children, partitions it into lanes.
2. **~30-40k tokens of source per lane** (≈3-4k lines at ~10 tokens per line — the
   scout reports lines, the script converts), keyed to the smallest window that
   might run it.
3. **Arithmetic coverage assertion** — every inventoried file lands in ≥1 lane; assert it in the
   script. Coverage comes from the map, not from each child reading everything.
4. **Every lane schema carries `overflow`** (paths not read within budget); the script subdivides
   overflow into new lanes instead of silently under-covering.
5. **Merge reads REPORTS only, in batches of ~8** (hierarchical for more). One mega-merge child
   recreates the exact blowup fan-out exists to avoid.
6. **One cross-cutting lane** greps the cross-file question's symbols repo-wide, so
   partition-by-file seams have an owner.
7. **Wall clock beats the agent cap**: waves (ceil(agents / concurrency)) × stages × ~5-10 min per
   child must fit 60 min. Prefer wide-not-deep; raise per project via `/ultracode set timeoutMs`.
8. **Read-discipline in every child prompt**: grep + ranged reads, no whole-file reads of large
   files, never echo file contents back; output = the schema JSON only.

### Scout → partition → fan-out (material-budgeted, coverage-checked)

```
const LANE_BUDGET = 35000 // ESTIMATED TOKENS of source; scout reports lines
const TOKENS_PER_LINE = 10
const SCOUT = { type: "object", required: ["files"], properties: { files: { type: "array",
  items: { type: "object", required: ["path", "lines"], properties: { path: { type: "string" },
  lines: { type: "number" } } } } } }
const REPORT = { type: "object", required: ["summary", "covered", "overflow"], properties: {
  summary: { type: "string" }, covered: { type: "array", items: { type: "string" } },
  overflow: { type: "array", items: { type: "string" } } } }

phase("scout")
const scout = await agent("Inventory the repo area " + area + ". Per file: path, line count. " +
  "Use glob, grep, wc — do NOT read file contents.", { agent: "explore", phase: "scout", schema: SCOUT })
const files = (scout && scout.data && scout.data.files) || []

// Script-side partition under the token budget (lines × ~10), then assert coverage.
const est = (f) => Math.max(1, Math.round((f.lines || 0) * TOKENS_PER_LINE))
const lanes = []
let cur = { files: [], lines: 0 }
for (const f of files) {
  if (cur.files.length > 0 && cur.lines + est(f) > LANE_BUDGET) { lanes.push(cur); cur = { files: [], lines: 0 } }
  cur.files.push(f); cur.lines += est(f)
}
if (cur.files.length) lanes.push(cur)
const assigned = new Set(lanes.flatMap((l) => l.files.map((f) => f.path)))
const unassigned = files.filter((f) => !assigned.has(f.path)).map((f) => f.path)
if (unassigned.length) throw new Error("coverage assertion failed: " + unassigned.join(", "))

phase("lanes")
const reports = await parallel(lanes.map((lane, i) => () =>
  agent("Review exactly these files (grep + ranged reads only; never whole-read files over ~500 " +
    "lines; never echo contents back):\n" + JSON.stringify(lane.files) +
    "\nReturn summary, covered paths, overflow = paths you could not review within budget.",
    { agent: "explore", phase: "lanes", label: "lane" + (i + 1), schema: REPORT })))
// overflow paths → subdivide and re-run (bounded gap-fill, same partition helper)
```

### Fan-out and synthesize (batched merge; merge reads reports only)

```
phase("research")
const parts = await parallel(["api", "storage", "ui"].map((area) => () =>
  agent("Summarize the " + area + " layer of this repo. Read the code; be concrete.",
    { agent: "explore", phase: "research", schema: SUMMARY })))
const good = parts.filter(Boolean)
// Batched merge: reports only, ~8 per merge child (one mega-merge recreates
// the context blowup fan-out exists to avoid).
const batches = []
for (let i = 0; i < good.length; i += 8) batches.push(good.slice(i, i + 8))
const drafts = await parallel(batches.map((batch, bi) => () =>
  agent("Merge these lane reports into one section list. Reports only — do not read source files.\n" +
    JSON.stringify(batch.map((p) => p.data)), { agent: "general", phase: "synthesize", label: "merge" + (bi + 1) })))
const report = await agent("Combine these merged sections into one report:\n" +
  drafts.filter(Boolean).map((d) => d.text).join("\n---\n"), { agent: "general", phase: "synthesize" })
return { report: report.text, sections: good.length }
```

### Adversarial verification (verifier, then skeptic)

```
phase("verify")
const verdicts = await parallel(claims.map((c) => () =>
  agent("Verify this claim. Try to refute it before accepting it.\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT })))
const supported = verdicts.flatMap((v, i) =>
  v && v.data && v.data.verdict === "supported" ? [claims[i]] : [])
phase("skeptic")
const skeptic = await agent("Overturn any of these resting on weak evidence:\n" +
  JSON.stringify(supported), { agent: "general", phase: "skeptic", schema: OVERTURNED })
```

### Pipeline per item (a stage failure isolates to one item)

```
const rated = await pipeline(files,
  (f) => agent("Skim this file and list risks.\nFile: " + f,
    { agent: "explore", phase: "skim", schema: RISKS }),
  (r, i) => agent("Rate the severity of these risks:\n" + JSON.stringify(r.data) +
    "\nFile: " + files[i], { agent: "general", phase: "rate", schema: SEVERITY }))
```

### Generate and filter

```
phase("draft")
const drafts = await parallel(Array.from({ length: 6 }, (_, i) => () =>
  agent("Propose solution " + (i + 1) + " for this task. One paragraph each.\nTask: " + task,
    { agent: "general", phase: "draft" })))
phase("filter")
const best = await agent("Rank these drafts. Keep the top 2 with reasons.\n" +
  drafts.filter(Boolean).map((d) => d.text).join("\n---\n"),
  { agent: "general", phase: "filter", schema: TOP2 })
```

### Tournament (pairwise judges, bounded rounds)

```
let pool = options.slice()
for (let round = 0; round < 3 && pool.length > 1; round++) {
  const pairs = []
  for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]])
  const picks = await parallel(pairs.map((pair) => () =>
    agent("Judge this pair; pick exactly one winner.\nA: " + pair[0] + "\nB: " + pair[1],
      { agent: "general", phase: "judge", schema: PICK })))
  pool = picks.flatMap((p, i) =>
    p && p.data && p.data.winner === "B" ? [pairs[i][1]] : [pairs[i][0]])
}
return { winner: pool[0] }
```

### Loop until done (bounded; the write agent stays sequential)

```
let open = issues
for (let pass = 1; pass <= 5 && open.length > 0; pass++) {
  progress("pass " + pass + ": " + open.length + " open")
  await agent("Fix exactly these issues. Change no unrelated code.\n" + JSON.stringify(open),
    { agent: "general", phase: "fix", label: "fix" + pass })   // write agent: one at a time
  const recheck = await agent("Check whether these issues still exist. List survivors only.\n" +
    JSON.stringify(open), { agent: "explore", phase: "recheck", schema: ISSUES })
  open = (recheck && recheck.data && recheck.data.issues) || []
}
return { fixed: issues.length - open.length, open }
```

### Gate + checkpoint between phases (cheap QC; resumable boundaries)

```
// after an expensive phase produces the merged intermediate `merged`:
const GATE = { type: "object", required: ["pass", "action"], properties: {
  pass: { type: "boolean" }, action: { type: "string", enum: ["continue", "retry", "abort"] },
  issues: { type: "array", items: { type: "string" } } } }
const gate = await agent("QC this batch of findings. pass=false only for concrete defects " +
  "(empty, duplicated, off-scope).\n" + JSON.stringify(merged.slice(0, 10)),
  { agent: "explore", phase: "gate", schema: GATE })
if (gate && gate.data && gate.data.pass === false && gate.data.action === "abort") {
  throw new Error("gate rejected the merge: " + JSON.stringify(gate.data.issues || []))
}
checkpoint("merge-done", { count: merged.length })
// downstream agents get opts.key so a warm rerun never pays for them twice:
const out = await agent("Synthesize...", { agent: "general", phase: "synthesize", key: "synthesize:v1" })
```

One small reviewer per boundary — never a gate fan-out (wall clock is the binding constraint).
`checkpoint` values are capped (50 kept) and visible in `/ultracode show` + `ultracode_status`.

### Compose a saved workflow (depth 1)

```
const research = await workflow("deep-research", { topic: topic })
const audit = await workflow("code-audit", { modules: ["auth", "db"] })
return { research: research.stats, audit: audit.stats }
```

Saved workflows (samples included) run only after the user approves them once via
`/ultracode trust <name>`; editing the script later invalidates that approval. An unapproved
call fails fast with that instruction — relay it to the user instead of retrying. Plan-authored
`.js` files use the same gate after `/ultracode save <name>`.

## Complete example

Research fan-out with structural verification. Runs as-is:

```
const topic = String(args.topic)
const CLAIMS = { type: "object", required: ["claims"], properties: { claims: { type: "array",
  items: { type: "object", required: ["claim", "hint"], properties: { claim: { type: "string" },
  hint: { type: "string" } } } } } }
const VERDICT = { type: "object", required: ["verdict"], properties: { verdict: { type: "string",
  enum: ["supported", "refuted", "unverifiable"] }, evidence: { type: "string" } } }
phase("research")
const found = await parallel(["how it works", "who relies on it", "known failures"].map((a) => () =>
  agent("Collect 3 to 5 checkable factual claims about: " + topic + "\nAngle: " + a +
    "\nOne source hint per claim.", { agent: "explore", phase: "research", schema: CLAIMS })))
const claims = []
for (const part of found) for (const c of (part && part.data && part.data.claims) || []) claims.push(c.claim)
phase("verify")
const verdicts = await parallel(claims.slice(0, 12).map((c) => () =>
  agent("Verify against primary sources; refute it if you can.\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT })))
const kept = []
verdicts.forEach((v, i) => { if (v && v.data && v.data.verdict === "supported")
  kept.push({ claim: claims[i], evidence: v.data.evidence || "" }) })
phase("report")
const report = await agent("Write a 300-word briefing on: " + topic +
  "\nUse ONLY these verified claims:\n" + JSON.stringify(kept, null, 1),
  { agent: "general", phase: "report" })
return { brief: report.text, verified: kept.length, examined: claims.length }
```

## Agent routing

- Every install has `general` (general-purpose subagent) and `explore` (fast codebase
  exploration). Omitting `opts.agent` means `general`.
- If this user has specialists (reviewer, deep-researcher, critic, planner), prefer them: pass the
  id via `opts.agent` AND declare it in `meta.requires`. The preflight then fails fast with the
  list of available agents instead of the run dying midway.
- Cost shape: extraction and search go to the cheap agent; judgment and synthesis go to the strong
  one. The user pins which model each agent runs. You never name models, ever.
- `model` on results is informational (what actually ran). Do not branch on it.

Before writing the script, answer two questions: what is the fan-out? who verifies? If both
answers exist, write the script: self-contained prompts, explicit phases, bounded loops, a schema
for everything you merge on, and a small JSON return.
