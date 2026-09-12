# Authoring workflow scripts

The complete reference for writing scripts for the `ultracode_run` tool — for the model that authors
them and for humans curating saved workflows. The condensed version the model sees at runtime is
the `Ultracode` skill; this document is the long form.

- [The ultracode_run tool](#the-ultracode_run-tool)
- [The script model](#the-script-model)
- [Globals reference](#globals-reference)
- [meta fields](#meta-fields)
- [Structured output with opts.schema](#structured-output-with-optsschema)
- [Patterns](#patterns)
- [A complete annotated example](#a-complete-annotated-example)
- [The return contract](#the-return-contract)
- [Run envelope fields](#run-envelope-fields)
- [Caps](#caps)
- [Testing your workflows](#testing-your-workflows)
- [Samples and manifests](#samples-and-manifests)

---

## The ultracode_run tool

The model invokes the `ultracode_run` tool (it is received as a normal tool despite the
namespaced registration name). The skill auto-attaches when `ultracode` appears as a standalone
keyword anywhere in the prompt (e.g. `ultracode: audit X`, `please ultracode this`);
plain-language workflow requests reach the same tool by the model's own judgment.

Two input shapes (a union — anything else is rejected, extra keys included):

### Inline run

```json
{
  "script": "<plain JS async function body>",
  "name": "optional display name",
  "meta": { "name": "...", "description": "...", "phases": ["..."], "requires": ["..."] },
  "args": { "any": "JSON value" },
  "background": true,
  "resumeFrom": "run_ab12cd34ef56"
}
```

- `script` (required): max **512 KB**. Validated before anything spawns: module tokens
  (`import` / `export` / `require`) are rejected up front.
- `meta` / `args` (optional): JSON. `args` is capped at **64 KB** serialized. Both are injected
  into the script as the globals `meta` and `args` — they never appear in the script source.
- `name` (optional): display name for the run record and `/ultracode` output.

### Saved run

```json
{ "workflow": "deep-research", "args": { "topic": "..." }, "resumeFrom": "run_ab12cd34ef56" }
```

- Loads the saved pair `<name>.js` + `<name>.json` (project dir beats personal dir; names match
  `^[a-z0-9][a-z0-9-_]{0,63}$`).
- **Trust gate:** saved workflows (samples included) run only after a one-time user approval via
  `/ultracode trust <name>`, which stores an approved digest of the script's current content.
  Editing the script afterwards invalidates trust — the run is refused until re-approved. There
  is no `confirm` flag; approval is an explicit user action, not a model decision.
- Agents listed in the manifest's `requires` are preflighted: a missing agent fails the call
  *before any session spawns*, with the list of agents that do exist.

The tool call returns immediately after admission (`background` defaults to true) with
`{ runID, status: "running", hint }`. On completion the plugin appends a one-line settle
notice to the parent session — status, agents, bounded result brief, stop reason, and for
truncated results the `ultracode_result` recovery pointer — which
**wakes the parent agent** (live-verified); `ultracode_status` remains the authoritative poll
(carrying the settled result inline when it fits the cap, else a bounded preview with the total
size). Runs cannot
nest: an `ultracode_run` call from a session owned by a
running workflow is rejected. Pass `background: false` to block until the run finishes
(success, failure, stop, or timeout) — never while agents are live.

### Graph-authored runs (preferred for standard shapes)

Instead of hand-writing JS, describe the workflow as a **DAG** and let the compiler emit the
script — cheaper to author, validated before any token is spent, and every call is auto-keyed
for warm reruns:

```json
{
  "graph": {
    "name": "partitioned-review",
    "nodes": [
      { "id": "scout", "kind": "agent", "agent": "explore",
        "prompt": "Inventory {{args.area}}. Per file: name + line count. Do not read contents.",
        "schema": { "...": "items: [{name, lines}]" } },
      { "id": "lanes", "kind": "partition", "from": "$scout.items", "budgetTokens": 35000 },
      { "id": "review", "kind": "fanout", "over": "$lanes", "agent": "explore", "max": 16,
        "prompt": "Review exactly these files (ranged reads only):\n{{item}}\nReturn a summary." },
      { "id": "qc", "kind": "gate", "from": "$review" },
      { "id": "report", "kind": "merge", "from": "$review", "batches": 8,
        "prompt": "Merge these lane reports. Reports only:\n{{item}}" }
    ],
    "returns": { "report": "$report", "laneCount": "$lanes.length" }
  },
  "args": { "area": "src/api" }
}
```

- **Node kinds:** `agent` (one child), `fanout` (`over` a ref — one child per item, `{{item}}` /
  `{{index}}` in the prompt, hard `max` cap default 64), `partition` (token-budgeted lanes from an
  inventory, no agent), `merge` (batched join of a list, `batches` default 8), `gate` (one QC
  reviewer with the `{pass, action, issues}` verdict schema; auto-checkpoints and aborts on fail —
  `onFail: "continue"` to tolerate), `checkpoint` (persist a ref), `workflow` (compose a saved
  workflow, `argsFrom` ref).
- **Refs:** `"$scout.items"`, `"$args.angles"`, `"$lanes.length"` — a node's *primary value* is
  its `.data` when a schema was given, else its `.text`; fanout/merge primaries are arrays / joined
  text. Refs must flow forward (spec order is the topological order); back-references are
  validation errors, so cycles are impossible by construction.
- **Templates:** prompt strings interpolate `{{args.x}}`, `{{nodeId.path}}`, and (fanout/merge)
  `{{item}}` / `{{index}}`, JSON-stringified.
- **What the compiler does for you:** null-checking and total-failure aborts per fanout/merge,
  batching, lane partitioning with coverage by construction, `phase`/`label` bookkeeping (node ids
  are phases), auto `key` on every call (`scout`, `review:3`, `report:b1`) so warm reruns replay
  finished children, and independent nodes grouped into `parallel()` waves automatically.
- **Validation before spawn:** unknown kinds/keys, duplicate or reserved ids, missing prompts,
  unresolvable refs and templates, fanouts without `max` (warning), budget warnings — an invalid
  graph costs zero tokens.
- JS scripts remain the escape hatch for anything the node kinds don't cover; both run through the
  same runtime, caps, inspector, and resume machinery.

### Saved graph workflows (v0.9.0)

A graph can be a named, trusted, shareable artifact exactly like a script:

- **Artifact:** `<project>/.opencode/workflows/<name>.graph.json` (the spec) + `<name>.json`
  (manifest v1 with `kind: "graph"`). The script is **compiled fresh on every load** — the spec is
  the only stored truth, so there is never a stale generated file to drift.
- **Saving:** `/ultracode save <name>` picks up a hand-authored `<name>.graph.json` (it writes only
  the manifest and never reformats your spec), and `/ultracode save <runID> <name>` saves the spec
  a graph run was launched from — not the compiled JS.
- **Trust:** `/ultracode trust <name>` records the digest of the **compiled script**, i.e. you
  approve what will actually execute. Editing the spec invalidates trust; so does upgrading the
  plugin when the compiler's output changes. That is deliberate (fail closed): a graph is trusted
  code, and "the spec looks the same" is not proof "the code is the same". A spec that fails to
  parse, validate or compile can never be trusted or run — it stays listed with the validator's
  own errors so you can see why.
- **One artifact kind per name:** saving a graph while `<name>.js` exists (or vice versa) is
  refused rather than silently shadowed. If both files exist on disk, `<name>.js` wins.
- **Review:** `/ultracode graph <name>` renders the DAG — execution waves, a node table (kind,
  agent, source ref, bounds), returns and a mermaid flowchart — and is *not* trust-gated, because
  seeing the structure is how you decide whether to approve it. `/ultracode graph <runID>` renders
  the spec of any graph-authored run.
- **Rerun:** `/ultracode rerun <runID>` replays the run's own recorded script and carries the spec
  forward (so re-saving the rerun stays a graph). For a named graph workflow the "has it changed?"
  check compares **canonical specs**, not compiled output — a compiler upgrade is not mistaken for
  an edit you never made. `--warm` still replays every finished child: the compiler keys each call
  by node id (`scout`, `review:3`, `report:b1`), and keys are stable across recompiles.
- **Composition:** a graph node of `kind: "workflow"` can compose a saved graph workflow (depth 1),
  because the loader compiles fresh on every call.

### Discovery: `ultracode_catalog` and declared params

The live catalog appended to the authoring skill is built once per plugin instance, from inside
the `ultracode_run` executor — so before the first run of a server session the attached skill
carries an empty catalog and the model cannot see which saved workflows exist. `ultracode_catalog`
is the fresh, read-only path:

```json
{}                                    // agents, saved workflows, template summaries, caps
{ "workflow": "code-audit" }          // one workflow: params as data, graph spec or script head
{ "template": "research-verify" }     // one complete graph template to adapt
{ "templates": true }                 // every template spec
```

- **Workflows** are listed with `kind`, description, `params`, `phases`, `requires`, `trusted`,
  `source`, node count for graphs, a `broken` reason when a spec will not load, and — from runs
  **owned by the calling conversation only** — a run count plus the latest run's status, duration,
  agent counts and tokens. Run history is per-session provenance, so the tool executor filters it
  before the builder ever sees it.
- **Params** (`manifest.params`) are derived at save time when not authored: a `// Tool input:`
  header (names, `?` optionality, example types) beats code references (`args.x`, `args?.x`,
  `args["x"]`, the `const input = args && …` alias, destructuring), a graph contributes its
  `{{args.x}}` templates and `$args.x` refs, and saving a run contributes that run's real `args`
  keys with their JSON types. Explicit params win field by field; derived names fill the gaps.
  Derivation is best-effort by design — a missed name costs a documentation gap, never a wrong
  run, because `args` are not enforced.
- **Templates** (`src/graph-templates.ts`) are the anti-blank-page answer: `partitioned-review`,
  `research-verify` and `draft-fact-check`, each test-asserted to validate, compile, route only
  through stock agents, cap every fan-out, and interpolate its item (a fan-out child that never
  reads `{{item}}` does identical work per lane — the classic wasted-budget bug).
- **Bounds:** 40 workflows per listing (overflow reported as `moreWorkflows`), descriptions sliced
  to 200 chars, a script detail view limited to a 1200-char head (where the args contract lives),
  templates only on request. A catalog is a menu, not a dump.

### Plan → Build (no prior run)

OpenCode plan/build is a host agent mode. Handoff is file + trust + named run:

1. **Plan:** write only `<project>/.opencode/workflows/<name>.js` (async-function body) — or, for a
   standard shape, `<name>.graph.json` (pure JSON, no escaping hazards). Do not call `ultracode_run` inline.
2. `/ultracode save <name>` (one-token; picks up either artifact, and preserves a hand-written
   `<name>.json` manifest's `description` / `phases` / `requires` / `params`). After a run,
   `/ultracode save <runID> <name>` still works.
3. Review a graph with `/ultracode graph <name>` (works before trust), then
   `/ultracode trust <name>` (digest-bound; a changed script or spec is refused until re-trusted).
4. **Build:** `{ workflow: "name", args? }`. Do not mix native subagent fan-out with a workflow in the same task.

The registered skill is `buildSkillContent` in `src/skill-content.ts`, not an on-disk markdown file.

## The script model

A script is the **body of an async function**. Concretely, the runtime executes:

```js
(async () => {
  /* your script, verbatim */
})()
```

Therefore:

- Top-level `await` and top-level `return <value>` are legal and expected.
- `const` / `let`, arrow functions, `Map` / `Set`, spread, template literals, `JSON`, `Math`,
  `RegExp` — all plain modern JS, fine.
- There is **no module system**: `import`, `export`, and `require` are rejected at validation
  (write `// Tool input:` comment headers instead of imports; everything else arrives via
  `args` / `meta` or is defined inline).
- There are **no host APIs**: no `fs`, no `net`, no `process`, no `fetch`. Available globals are
  the injected workflow API (below) plus a small allowlist of pure builtins (`JSON`, `Math`,
  `Array`, `Object`, `String`, `Number`, `Boolean`, `Map`, `Set`, `Promise`, `Error`,
  `TypeError`, `RegExp`, `structuredClone`, buffered `console`). This is enforced by omission —
  see the README security section before running untrusted scripts.
- An **unhandled rejection fails the whole run** (the envelope carries the error). Handle errors
  where you can degrade; rethrow where the result would be meaningless.
- The script runs in a worker thread the supervisor can terminate (stop, timeout). The worker is
  an *availability* boundary, not a sandbox.

Two golden invariants:

1. **Prompts are the entire world.** A child agent sees only its prompt string — none of your
   conversation, none of the workflow's other children. Every prompt must be self-contained:
   file paths in, snippets in, criteria in, output format in.
2. **Route by agent id, never by model id.** `opts.agent: "reviewer"` — the user's own agent
   config decides which model that is. Scripts that hard-code provider or model ids are wrong by
   construction (and the authoring skill forbids them).

## Globals reference

### `agent(prompt, opts?) -> Promise<AgentResult>`

Spawns one subagent session, sends `prompt`, waits for the reply, returns the final assistant
message.

```ts
agent(prompt: string, opts?: {
  agent?: string    // agent id; default: plugin options.agent ("general")
  label?: string    // short label for progress + run records, e.g. "verify:3"
  phase?: string    // phase grouping; explicit beats the ambient phase() label
  schema?: Json     // JSON Schema -> reply parsed+validated into .data
  key?: string      // stable idempotency key -> warm-rerun replay (see below)
}): Promise<{
  text: string      // concatenated text parts of the final assistant message
  sessionID: string
  agent?: string    // agent actually used
  model?: { providerID: string; id: string } | null  // informational
  tokens?: TokenUsage
  data?: Json       // present iff opts.schema was given and validation succeeded
  cachedFrom?: string  // source runID when this result was warm-replayed
}>
```

Semantics and failure modes:

- **Session naming:** child sessions are titled `[uc:xxxxxxxx] label` (short run tag + your
  `opts.label` or phase) so they group visibly in the session list. Pick meaningful labels.

- **Concurrency / queueing:** at most `concurrency` (default 8) child sessions run at once;
  further calls wait FIFO. Queued calls are rejected if the run stops while they wait.
- **Agent resolution:** explicit `opts.agent` missing from the server's agent list => the call
  fails with the available-agents list (the same list preflight shows for `meta.requires`).
  Omitted => plugin default; if that doesn't exist, fail-fast with guidance.
- **Child failure:** if the child session's outcome is not `succeeded`, the call rejects with a
  typed error carrying any partial text it produced.
- **Schema mode:** see [below](#structured-output-with-optsschema). Invalid output after one
  repair round rejects the call.
- One `agent()` call = one run-record entry ("a1", "a2", ...) with its own tokens and
  `effectiveModel` — visible in `/ultracode show`.

Design guidance: prompts should state the role, the exact input, and the exact output contract;
keep each under a few hundred words; put bulk data (JSON arrays) at the end after instructions.

### `parallel(thunks) -> Promise<Array<T | null>>`

Barrier over an array of zero-arg thunks. Starts all of them (subject to the global concurrency
cap), waits for every one.

- **A thunk that throws (or whose promise rejects) resolves as `null`** — it never rejects the
  `parallel()` call and never cancels its siblings.
- Therefore: **always null-check before merging.** `parts.filter(Boolean)` for
  tolerate-and-continue; count failures and abort if `(parts.filter(p => !p).length / parts.length)`
  exceeds a threshold you pick; wrap a thunk body in try/catch if you want per-item recovery.

```js
const runs = await parallel(items.map((item) => () => agent(promptFor(item), { phase: "scan" })))
const ok = runs.filter(Boolean)          // tolerate failures
if (ok.length === 0) throw new Error("every scan failed — likely a bad prompt or missing agent")
```

### `pipeline(items, ...stages) -> Promise<Array<unknown>>`

Chains **each item independently** through the stages, in order: `stage2(stage1(item, i), i)`.
Semantically `items.map(item => stages.reduce(...))` with per-item isolation:

- If any stage throws for item *i*, that item's final value is `null`; **other items are
  unaffected** and the call never rejects.
- The result array is positionally aligned with `items`.
- Stages may be sync or async; each receives `(valueSoFar, index)`.
- Use it when stage 2 needs stage 1's *per-item* output (e.g. skim file -> rate findings for that
  file), and you want one flaky item to drop out instead of poisoning the batch.

```js
const rated = await pipeline(files,
  (f) => agent("Skim and list risks.\nFile: " + f, { agent: "explore", phase: "skim", schema: RISKS }),
  (r, i) => agent("Rate these risks 1-5.\nFile: " + files[i] + "\nRisks: " + JSON.stringify(r.data),
    { agent: "general", phase: "rate", schema: RATING }))
// rated[i] === null  <=>  file i failed at some stage
```

### `phase(name)` / `progress(text)` / `checkpoint(name, value?)`

- `phase(name)`: sets the *ambient* phase label applied to subsequent `agent()` calls that omit
  `opts.phase`. Cheap, never throws. **Racy across concurrent branches** — when you `parallel()`,
  the last `phase()` call wins for whichever agents lacked an explicit `opts.phase`. Rule: in
  concurrent code, always pass `opts.phase` explicitly; use ambient `phase()` only in straight-line
  sections (it reads nicely there).
- `progress(text)`: emits a human-readable line into the run's progress log (throttled ~500 ms,
  surfaced through tool progress and `/ultracode show`). Use it at phase boundaries and inside
  bounded loops ("pass 3: 4 issues left").
- `checkpoint(name, value?)`: persists a named phase-boundary snapshot (a small JSON value) onto
  the run record. Checkpoints are visible in `/ultracode show` and `ultracode_status`
  (`checkpoints: [{name, at}]`; values only in `show`), capped at the newest 50. Call it after
  each expensive phase with the merged intermediate — `checkpoint("survey-done", { signals: 12 })`
  — so the boundary is inspectable and a warm rerun has a narrative of how far the first attempt
  got. Values are sanitized (functions/symbols stripped) before they cross the worker boundary.

### `workflow(name, args?) -> Promise<Json>`

Loads and runs a **saved** workflow inside the current run, resolves with its JSON return value.

- **Depth 1 only**: a composed workflow's script may not call `workflow()` again (throws).
- The composed workflow's agents run under the *same* run: same concurrency semaphore, same
  `maxAgents` budget, same wall-clock timeout, same stop/abort semantics.
- Its `meta.requires` is NOT re-preflighted at compose time (the outer run is already live) —
  a missing agent surfaces as an agent-resolution error from its first `agent()` call.
- Unknown name or unreadable files => the call rejects (inside the script, so catch it if
  degradation is acceptable). An untrusted workflow (never approved, or edited since approval)
  rejects the *outer* tool call before the run starts, with the instruction to run
  `/ultracode trust <name>` — relay that to the user rather than retrying.

```js
const research = await workflow("deep-research", { topic: args.topic })
return { report: research.report, researchStats: research.stats }
```

### `sleep(ms) -> Promise<void>`

Pause the script. Capped at **60000 ms per call** (larger values clamp); the run's wall-clock
watchdog still applies, so "sleep forever" is bounded by the run timeout. Use for politeness
back-off, never as a synchronization mechanism.

### `console.log(...)`

Buffered into the run log (not your terminal). Fine for a few dozen lines of debugging; do not
log large objects — worker memory is not bounded.

### `args` / `meta`

Injected from the tool input, JSON values. Idioms:

```js
const input = args && typeof args === "object" ? args : {}
const topic = typeof input.topic === "string" ? input.topic.trim() : ""
if (!topic) throw new Error("args.topic is needed: a short research question")
```

Validate at the top and **fail fast with a message that names the missing arg** — a run that
throws before its first `agent()` call costs zero tokens. `meta` is read-only metadata (see
[below](#meta-fields)); scripts mostly ignore it, but it is available (e.g. to name the run in
`progress()` output).

## meta fields

Provided in tool input (`meta`), surfaced in run records and `/ultracode`; saved into manifests.

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Display name for the run. |
| `description` | string | One-liner shown in summaries. |
| `phases` | string[] | Declared phase labels — documentation + progress grouping; also written to saved manifests. |
| `requires` | string[] | Agent ids that must exist **before the run starts**. Preflight fails fast listing available agents — declare every non-stock agent you use. |

Preflight applies to *inline* runs and *saved* runs (manifest `requires`). `general` and `explore`
exist on any bootstrapped install; only declare what you actually call.

## Structured output with opts.schema

Pass a JSON Schema in `opts.schema` and the runtime handles extraction + validation for you:

1. The final prompt sent to the child appends your schema and the instruction to respond with
   ONLY a JSON value (no prose, no markdown fences).
2. The reply is extracted tolerantly: whole trimmed response; else a single fenced `json` block;
   else the first balanced `{...}` / `[...]` scan. Ambiguous multiples are rejected. **No eval**,
   ever.
3. The value is validated against a small but sufficient validator: `type`, `required`,
   `properties`, `items`, `enum`, `minimum`, `maximum` (`additionalProperties` is ignored).
4. On invalid: **one repair round** — the child is re-prompted with the validation error and
   asked for corrected JSON only. Still invalid => the `agent()` call rejects.

Authoring tips:

- Keep schemas shallow (two levels is plenty) and arrays bounded by instruction ("up to 10").
- `enum` the values you will branch on (`["supported", "refuted", "unverifiable"]`) — it turns
  model drift into a repair round instead of a mystery string.
- Normalize defensively *after* `.data` anyway (clamp numbers, `String()` everything you index
  by) — the samples show the pattern.
- Use `.text` only for human-facing blobs (reports) that a later agent consumes verbatim.

## Patterns

Expanded from the skill; each names when to reach for it.

### 0. Sizing: partition, budget, merge (read before any wide fan-out)

*When:* always, before a fan-out over more than a handful of files or sources.

Production post-mortem (2026-09-12): unbounded `general` children reached 300-400k context on a
2M-window model and would have died on smaller ones; the biggest driver was full-file reads plus a
shared context file every child had to read in full. The cure is distribution discipline, not
context caps:

- **Scout before you fan out** — one cheap `explore` child inventories the material (paths + line
  counts); the script partitions it into lanes. The `partitioned-review` sample implements the
  whole pattern end to end.
- **~30-40k tokens of source per lane** (≈3-4k lines at ~10 tokens/line — convert
  the scout's line counts), keyed to the smallest context window in the user's model
  rotation (pins change between runs).
- **Arithmetic coverage assertion** — every inventoried file lands in ≥1 lane; assert it in the
  script so coverage is a checkable invariant, not vibes.
- **Lane schemas carry `overflow`** (paths not read within budget); the script subdivides overflow
  in a bounded gap-fill pass instead of silently under-covering.
- **Merge reads REPORTS only, in batches of ~8** (hierarchical for more) — one mega-merge child
  recreates the context blowup one level up.
- **One cross-cutting lane** greps the cross-file question's symbols repo-wide so
  partition-by-file seams have an owner.
- **Wall clock beats the agent cap** — waves × stages × ~5-10 min per child must fit `timeoutMs`
  (default 60 min). Prefer wide-not-deep; raise per project with `/ultracode set timeoutMs <ms>`.
- **Read-discipline in every child prompt**: grep + ranged reads, no whole-file reads of large
  files, never echo file contents back; the child's output is the schema JSON only.

### 1. Fan-out and synthesize

*When:* the task is read-only and embarrassingly parallel (many files, many sources, many
angles), and one merge step can consume the parts.

```js
phase("research")
const parts = await parallel(angles.map((a) => () =>
  agent("Research ONE angle...\nTopic: " + topic + "\nAngle: " + a + "\nReturn JSON findings.",
    { agent: "explore", phase: "research", schema: FINDINGS })))
// merge + dedupe in plain JS (the whole point: merging is code, not vibes)
const seen = new Map()
for (const part of parts) {
  for (const f of (part && part.data && part.data.findings) || []) {
    const key = String(f.claim || "").toLowerCase().slice(0, 80)
    if (key && !seen.has(key)) seen.set(key, f)
  }
}
const merged = [...seen.values()].slice(0, 20)          // bound the merge
phase("synthesize")
const out = await agent("Write the final report from these verified parts:\n" + JSON.stringify(merged),
  { agent: "general", phase: "synthesize" })
return { report: out.text, parts: merged.length }
```

*Notes:* dedupe before the expensive verification stage; slice() the merged list so a
hallucination-heavy fan-out can't blow the agent budget.

### 2. Adversarial verification (verifier + skeptic)

*When:* correctness matters more than latency. Two independent stages with different failure
modes: per-claim verifiers first, then one batch skeptic re-checking the survivors.

```js
phase("verify")
const verdicts = await parallel(claims.map((c) => () =>
  agent("Verify ONE claim; try to refute it first.\nClaim: " + c,
    { agent: "general", phase: "verify", schema: VERDICT })))
const supported = claims.filter((c, i) => verdicts[i] && verdicts[i].data
  && verdicts[i].data.verdict === "supported")
phase("skeptic")
const skeptic = await agent("Re-examine ALL of these as a harsh skeptic; overturn the weak ones.\n"
  + JSON.stringify(supported), { agent: "general", phase: "skeptic", schema: OVERTURNED })
const bad = new Set(((skeptic && skeptic.data && skeptic.data.overturned) || [])
  .map((o) => String(o.claim || "").toLowerCase().slice(0, 80)))
const kept = supported.filter((c) => !bad.has(c.toLowerCase().slice(0, 80)))
```

*Why the skeptic:* verifiers share failure modes (same model family, same prompt shape, same
economy of attention). A single adversarial pass over the *batch* catches groupthink the
individual checks missed. Keep the skeptic's schema small (`{overturned: [{claim, reason}]}`).

### 3. Pipeline per item

*When:* each item needs staged transformation and one bad item must not poison the batch. See
[pipeline](#pipelineitems-stages--promisearrayunknown) above; the canonical shape is
skim (cheap agent) -> judge (strong agent) per item, with `null` dropping out at the end.

### 4. Generate and filter

*When:* quantity is cheap and quality needs a judge — brainstorming, candidate solutions,
name/label generation.

```js
phase("generate")
const drafts = await parallel(Array.from({ length: 6 }, (_, i) => () =>
  agent("Propose approach " + (i + 1) + " ...\nTask: " + task, { agent: "general", phase: "generate" })))
phase("filter")
const best = await agent("Rank these drafts; keep the top 2 with one-line reasons.\n"
  + drafts.filter(Boolean).map((d, i) => "--- draft " + (i + 1) + " ---\n" + d.text).join("\n"),
  { agent: "general", phase: "filter", schema: TOP2 })
```

*Notes:* vary the generation prompts (index, angle) or you pay six times for one idea; the filter
step is a single strong-agent call, not another fan-out.

### 5. Tournament (pairwise judges)

*When:* you have candidates and a rubric too fuzzy to score absolutely but easy to compare
pairwise. Bounded rounds; odd one out gets a bye.

```js
let pool = options.slice()
for (let round = 0; round < 3 && pool.length > 1; round++) {
  const pairs = []
  for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]])
  const picks = await parallel(pairs.map((pair) => () =>
    agent("Judge this pair; pick exactly one winner.\nA: " + JSON.stringify(pair[0])
      + "\nB: " + JSON.stringify(pair[1]),
      { agent: "general", phase: "round" + (round + 1), schema: PICK })))
  pool = picks.flatMap((p, i) =>
    p && p.data && p.data.winner === "B" ? [pairs[i][1]] : [pairs[i][0]])  // failed judge -> A survives
}
return { winner: pool[0] }
```

### 6. Loop until done (bounded)

*When:* iterative fixing/converging. The write agent is strictly sequential; the recheck is
read-only.

```js
let open = issues
let prevOpen = open.length
for (let pass = 1; pass <= 5 && open.length > 0; pass++) {
  progress("pass " + pass + ": " + open.length + " open")
  await agent("Fix exactly these issues. Change no unrelated code.\n" + JSON.stringify(open),
    { agent: "general", phase: "fix", label: "fix" + pass })            // ONE write agent at a time
  const recheck = await agent("Check which of these still exist; list survivors only.\n"
    + JSON.stringify(open), { agent: "explore", phase: "recheck", schema: ISSUES })
  open = (recheck && recheck.data && recheck.data.issues) || []
  if (open.length === prevOpen) break                                  // no progress -> stop early
  prevOpen = open.length
}
return { fixed: issues.length - open.length, open }
```

*Notes:* always bound the loop AND break on no-progress; recheck with a *different* agent than
the fixer (structural verification again).

### 7. Gate + checkpoint between phases (cheap QC)

*When:* an expensive phase consumes a cheap phase's output. One small reviewer guards the merge;
the checkpoint marks the boundary. Never gate with a fan-out — the wall clock is the binding
constraint, and the gate is one agent with a tiny schema.

```js
const GATE = {
  type: "object", required: ["pass", "action"],
  properties: {
    pass: { type: "boolean" },
    action: { type: "string", enum: ["continue", "retry", "abort"] },
    issues: { type: "array", items: { type: "string" } },
  },
}
phase("gate")
const gate = await agent(
  "QC this merged batch. pass=false only for concrete defects (empty, duplicated, off-scope).\n" +
  JSON.stringify(merged.slice(0, 10)),
  { agent: "explore", phase: "gate", schema: GATE })
const g = gate && gate.data
if (g && g.pass === false && g.action === "abort") {
  throw new Error("gate rejected the merge: " + JSON.stringify(g.issues || []))
}
checkpoint("merge-done", { count: merged.length })
```

### 8. Warm reruns: keyed replay (`opts.key` + `resumeFrom`)

*When:* a long run dies mid-flight (timeout, restart, stop) and rerunning from zero would re-pay
for children that already succeeded. Pending-write semantics: a warm rerun never redoes
successful children.

- Give deterministic calls a stable `opts.key` (e.g. `"scout"`, `"lane:" + i`, `"verify:" + i`).
  Keyed successes persist their replay identity (a digest over prompt + schema + resolved agent)
  and their final text on the run record.
- Warm-start the rerun: tool input `{ workflow, args, resumeFrom: "<prior runID>" }` (or inline
  `{ script, args, resumeFrom }`), or `/ultracode rerun <runID> --warm`. A keyed call whose key
  AND digest match a succeeded agent in the source run returns from cache — no session spawned,
  no concurrency slot, no `maxAgents` consumption; the new run records it as `cached: true` and
  the envelope carries `resumedFrom`.
- Digest mismatch (you changed the prompt, schema, or agent id) falls through to a real spawn —
  stale results are never silently reused. Unkeyed calls always spawn.
- The replayed `AgentResult` keeps the original `sessionID` (provenance) and sets `cachedFrom` to
  the source run id. Replayed children contribute **zero** tokens to the new run's totals.

```js
// in a long partitioned review, every deterministic child is keyed:
const scout = await agent("Inventory " + area + "…", { agent: "explore", phase: "scout", key: "scout" })
const reports = await parallel(lanes.map((lane, i) => () =>
  agent("Review exactly these files…\n" + JSON.stringify(lane.files),
    { agent: "explore", phase: "lanes", label: "lane" + (i + 1), key: "lane:" + i, schema: REPORT })))
// interrupted at lane 5/8? rerun warm: scout + lanes 0-4 replay, 5-7 spawn.
```

### 9. Compose via workflow()

*When:* the orchestration already exists as a saved workflow. See
[`workflow()`](#workflowname-args--promisejson). Depth 1, shared budget — compose for reuse, not
for depth.

### 10. Write-safe serialization (the meta-pattern)

A clean context is **not** filesystem isolation. Parallel read-only agents are safe; parallel
*write* agents race on the same worktree. All workflow children share ONE checkout: two write
agents touching overlapping files (or even the same directory) will conflict, and a lost update
is indistinguishable from success. Either **serialize** write agents (below) or **split
ownership** so each concurrent writer owns disjoint files/directories and the prompts say so
explicitly. The pattern every writing workflow follows:

```js
// reads: fan out freely
const notes = await parallel(files.map((f) => () =>
  agent("Read " + f + " and propose edits. Do NOT edit files; output a patch plan.",
    { agent: "explore", phase: "plan", schema: PLAN })))
// writes: strictly sequential, one agent
for (const plan of notes.filter(Boolean)) {
  await agent("Apply exactly this plan to the files it names. Nothing else.\n" + JSON.stringify(plan.data),
    { agent: "general", phase: "apply", label: "apply:" + plan.data.file })
}
```

Note also: a child that spawns helpers through opencode's *native* subagent tool escapes this
run's caps and permission scoping (see README known limitations) — keep modifying agents
serialized regardless. Until worktree isolation lands (roadmap), serialization or explicit
ownership splits are the only safe ways to write.

## A complete annotated example

A repo-survey workflow: fan out per area, extract structured signals, adversarially verify the
risky ones, then synthesize. Every rule from this document applied inline. Save as
`.opencode/workflows/repo-survey.js` with a manifest to run it by name, or paste as
`{ script: "...", args: { areas: ["src/api", "src/db"] } }`.

```js
// repo-survey: map the state of a codebase area-by-area, verify the risk
// signals, and produce a prioritized report.
// Tool input: { workflow: "repo-survey", args: { areas: ["src/api", "src/db"],
//                minConfidence?: 0.5 } }
// Agents (stock): explore for survey, general for verify + synthesize.

// --- 1. Validate args before spending a single token -------------------------
const input = args && typeof args === "object" ? args : {}
const areas = (Array.isArray(input.areas) ? input.areas : [])
  .map((a) => String(a).trim()).filter(Boolean).slice(0, 8)
if (areas.length === 0) throw new Error("args.areas is needed: an array of directories to survey")
const minConfidence = Math.max(0, Math.min(1, Number(input.minConfidence) || 0.5))

// --- 2. Schemas: everything merged on later is structured --------------------
const SURVEY = {
  type: "object", required: ["summary", "signals"],
  properties: {
    summary: { type: "string" },                      // <= 100 words
    signals: { type: "array", items: {
      type: "object", required: ["kind", "detail", "file", "confidence"],
      properties: {
        kind: { type: "string", enum: ["risk", "debt", "smell"] },
        detail: { type: "string" },
        file: { type: "string" },
        confidence: { type: "number" },
      } } },
  },
}
const VERDICT = {
  type: "object", required: ["keep", "reason"],
  properties: { keep: { type: "boolean" }, reason: { type: "string" } },
}

// --- 3. Fan-out (read-only agents: safe to parallelize) ----------------------
phase("survey")
progress("surveying " + areas.length + " areas")
const surveys = await parallel(areas.map((area) => () =>
  agent(
    "Survey ONE area of a repo. Read the code; do not modify anything.\n" +
    "Area: " + area + "\n" +
    "Return a summary (max 100 words) plus up to 8 signals. Each signal needs kind " +
    "(risk, debt, or smell), a one-sentence detail, the file it lives in, and confidence " +
    "0.0-1.0 that it is real and worth reporting.",
    { agent: "explore", label: "survey:" + area, phase: "survey", schema: SURVEY })))

// --- 4. Plain-JS merge: dedupe, clamp, bound ---------------------------------
const seen = new Set()
const signals = []
for (const s of surveys) {
  for (const sig of (s && s.data && s.data.signals) || []) {
    const file = String(sig.file || "").trim()
    const detail = String(sig.detail || "").trim()
    const kind = ["risk", "debt", "smell"].indexOf(String(sig.kind)) >= 0
      ? String(sig.kind) : "smell"
    if (!file || !detail) continue
    const key = file + "|" + detail.toLowerCase().slice(0, 50)
    if (seen.has(key)) continue
    seen.add(key)
    signals.push({ kind, detail, file,
      confidence: Math.max(0, Math.min(1, Number(sig.confidence) || 0)) })
  }
}
const summaries = surveys.filter(Boolean).map((s) => s.data.summary)
if (signals.length === 0) {
  return { report: "No signals found.", stats: { areas, signals: 0, verified: 0 } }
}
const shortlist = signals
  .filter((s) => s.confidence >= minConfidence)
  .sort((a, b) => b.confidence - a.confidence)
  .slice(0, 15)                                     // bound the expensive stage

// --- 5. Adversarial verification: independent verifier per signal -------------
phase("verify")
const checks = await parallel(shortlist.map((sig, i) => () =>
  agent(
    "Verify ONE codebase signal by reading the actual file. Is it real, present in the code " +
    "as written, and worth reporting? Be skeptical.\nSignal: " + JSON.stringify(sig),
    { agent: "general", label: "verify:" + (i + 1), phase: "verify", schema: VERDICT })))
const verified = shortlist.filter((sig, i) =>
  checks[i] && checks[i].data && checks[i].data.keep === true)

// --- 6. Synthesis: one strong agent, all context handed to it explicitly ------
phase("synthesize")
const report = await agent(
  "Write a prioritized repo-survey report in markdown.\n" +
  "Area summaries:\n" + summaries.join("\n") + "\n" +
  "Verified signals (highest confidence first):\n" + JSON.stringify(verified) + "\n" +
  "Rejected during verification (mention count only). Lead with the top 3 risks.",
  { agent: "general", label: "synthesize", phase: "synthesize" })

// --- 7. Small JSON return ------------------------------------------------------
return {
  report: report ? report.text : "",
  stats: {
    areas: areas,
    signalsFound: signals.length,
    shortlisted: shortlist.length,
    verified: verified.length,
    verifyFailureRate: checks.filter((c) => !c).length / Math.max(1, checks.length),
  },
}
```

Annotation map: (1) fail-fast validation — rule 10 and zero-cost errors; (2) schemas for
everything merged on; (3) read-only fan-out with explicit `opts.phase`; (4) dedupe + clamp +
bound in plain JS; (5) independent verifiers, null-safe; (6) one synthesis agent with ALL context
in the prompt (prompts are the entire world); (7) small return with counts.

## The return contract

The script's return value is the workflow's product:

- It must be **JSON-safe**. The runtime sanitizes the done value before it crosses the worker
  boundary (bigint → string, cycles → `"[circular]"`, functions/symbols/undefined stripped;
  non-plain objects like `Date`/`Map`/`Set` degrade to `{}`). Return plain data, not class
  instances.
- It should be **small**: if the compact serialization exceeds `maxResultChars` (default 65536
  chars), the envelope carries a `preview` (the first `maxResultChars` characters of the COMPACT
  JSON) plus `truncated: true`, `resultChars` (total compact length) and, when the artifact write
  succeeded, a `resultArtifactKey`. The full value is persisted in plugin storage; the parent
  agent pages it back with the `ultracode_result` tool (`{ runID, offset, maxLength }` — chunks
  concatenate from offset 0 following `nextOffset`, then parse once), and a human can print it
  with `/ultracode result <runID>`. Return summaries + pointers, not dumps.
- Shape is yours, but convention: `{ report: string, stats: { ...counts } }` or
  `{ findings: [...bounded], stats: {...} }`. Keep arrays bounded (`slice`) before returning.

## Run envelope fields

What the `ultracode_run` tool returns to the parent session (always valid JSON):

| Field | Type | Present | Meaning |
| --- | --- | --- | --- |
| `runID` | string | always | `run_` + 12 random base32 chars; use with `/ultracode` commands. |
| `name` | string | if set | Run display name (tool `name` or saved workflow name). |
| `status` | string | always | `succeeded` \| `failed` \| `stopped` \| `interrupted` (final states only — the tool returns after finalization). |
| `durationMs` | number | always | Wall-clock duration. |
| `agents` | object | always | `{ total, succeeded, failed, interrupted }` across the whole run (composed workflows included). |
| `tokens` | object | on success paths | Summed `TokenUsage` over all child sessions: `{ input, output, reasoning, cache: { read, write } }`. |
| `result` | JSON | when it fit | The script's return value (see the return contract). |
| `preview` | string | when truncated | First `maxResultChars` chars of the COMPACT-JSON result (surrogate-pair safe). |
| `truncated` | boolean | always | Whether `result` was replaced by `preview`. |
| `resultChars` | number | when a result exists | Total compact-JSON length of the result — how much `ultracode_result` paging would fetch. |
| `resultArtifactKey` | string | when truncated + persisted | Storage key of the persisted full result; page it with `ultracode_result` or print via `/ultracode result <runID>` (falls back to the run-record copy when the artifact is missing). |
| `scriptPath` | string | when persisted | Absolute path of the run's script artifact. |
| `workflowName` | string | when saved-run | The saved workflow that was executed. |
| `resumedFrom` | string | when warm-started | Source run id this run replayed keyed results from (`resumeFrom` / `rerun --warm`). |
| `error` | string | on failure | The failing error (script throw, validation, preflight, timeout, untrusted workflow). |
| `stopReason` | string | when stopped/interrupted | e.g. `"server restart"` for reconciled orphans. |

## Caps

| Cap | Default | Where configured |
| --- | --- | --- |
| Concurrent child sessions | 8 | plugin option `concurrency` |
| Total `agent()` calls per run | 200 | plugin option `maxAgents` |
| Run wall clock | 60 min | plugin option `timeoutMs` |
| `sleep()` per call | 60 s | hard clamp |
| Script size | 512 KB | tool-input validation |
| `args` JSON size | 64 KB | tool-input validation |
| Returned result before truncation | 65536 chars | plugin option `maxResultChars` |
| Composition depth | 1 | hard cap |

Budget arithmetic is part of authoring: a script that fans out 30 claims x (1 verify + 1 repair
round) + merges + synthesizes should keep `items x stages + overhead` comfortably inside
`maxAgents`, with `slice()` as the seatbelt.

The wall clock is usually the binding constraint before `maxAgents` is: `waves
(ceil(agents / concurrency)) x dependent stages x ~5-10 min per child` must fit `timeoutMs`.
A production run died at 63 min with 7/8 agents done and the fix loop never reached (2026-09-12) —
budget time before you write the first `agent()` call, prefer wide-not-deep, and raise
`timeoutMs` per project when a wide run legitimately needs it.

## Testing your workflows

1. **Shrink the caps first.** In your plugin options for a scratch install:
   `"concurrency": 2, "maxAgents": 5, "timeoutMs": 120000`. A broken fan-out then costs seconds
   and pennies, not an hour.
2. **One-directory slices.** Point `args` at a single small directory (`modules: ["src/util"]`)
   before the whole repo; the schemas and prompts behave the same, the blast radius doesn't.
3. **Dry-run the plumbing.** Replace judgment prompts with trivially-satisfiable ones
   ("Return one signal: kind smell, detail test, file x, confidence 1") to verify merge/dedupe
   logic before paying for real analysis.
4. **Read `/ultracode show <runID>`.** Per-agent status, requested vs effective agent, model,
   tokens — this is where silent agent-resolution failures and pin drift show up.
5. **Watch the envelope.** `agents.failed > 0` with `status: "succeeded"` means your script
   tolerated failures (parallel-null) — decide whether that was right.
6. **Assert on stats.** Saved workflows return `stats` precisely so you (and tests) can check
   counts without parsing prose. The repo's own test suite executes the samples against fake
   agents this way (`test/skill-content.test.ts`).
7. **Rehearse the abort path.** `/ultracode stop` mid-run should leave the envelope coherent
   (`stopped`, interrupted children counted). If your merge logic assumes no nulls, it will show
   here.
8. **Trust before first saved run.** After copying or editing a saved workflow (samples
   included), the first `{ workflow: "name" }` call is refused until the user runs
   `/ultracode trust <name>`. Budget that step into manual test passes.

## Samples and manifests

`workflows/samples/` ships four ready pairs (copy both files into
`<project>/.opencode/workflows/`, review them, then `/ultracode trust <name>` — samples go
through the same one-time approval as any saved workflow):

| Name | args | Phases | Agents |
| --- | --- | --- | --- |
| `deep-research` | `{ topic, angles? }` (default angles: technical, market, criticism) | research, verify, skeptic, synthesize | explore + general |
| `code-audit` | `{ modules, focus? }` — returns reviewed `findings` plus reviewer-failed batches separately as `unverified` | scan, review | explore + general |
| `fact-check` | `{ draft, sources }` | extract, verify, skeptic, report | general |
| `dev-loop` | `{ task, repo?, scope?, fixPasses? }` (fixPasses max 3) | explore, implement, verify, review, fix | explore + general (reviewer via `args.reviewer`) |

Manifest = `SavedWorkflowManifest` (v1): `version`, `name`, `description`, `phases`, `requires`,
`hash` (sha256 of the script), `source` (`project` \| `personal`), `savedAt`, optional
`savedFromRunID` (omitted for one-token file saves). Create them with `/ultracode save <name>`
from a `.js` file or `/ultracode save <runID> <name>` from a run — both compute the hash.

Sample manifests ship with `"hash": ""` — the loader tolerates the **empty** hash specifically
for these reviewed, in-repo samples. Trust, not the hash, is what gates execution: approval is
bound to the script's content digest, and editing the script invalidates it until re-approved
(`/ultracode trust <name>`). That gate is the point: saved workflows are executable content, and
a changed script should never run silently.
