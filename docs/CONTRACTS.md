# Contracts — module ownership and seams

Three builders work in parallel. `src/types.ts` (already written, do not modify without noting it
in your final report) is the single source of truth. Import shared types from `../types.ts`
(extend locally if you need module-private types). Everything must typecheck with
`tsc --noEmit` and run under `node --experimental-strip-types --test test/`.

## Hard rules (from verified spike findings — see docs/SPIKE-FINDINGS.md)

1. **Never await `ctx.session.prompt/create/get` inside plugin `setup()`** — admission deadlocks.
   Session driving happens only inside tool executors and command executors.
2. **Every `ctx.*.transform(...)` call wrapped in try/catch** — a throwing transform disables the
   entire plugin.
3. `ctx.agent.list()` returns `{ location, data: AgentInfo[] }` — unwrap `.data`.
4. Context messages: extract text from the last `type === "assistant"` message,
   `content` parts where `part.type === "text"`.
5. Tool executor 2nd arg: `{ sessionID, agent, messageID, id, progress }`.
6. Code style: erasable TS only (no enums/namespaces/parameter properties); imports use explicit
   `.ts` extensions; no imports of `@opencode/plugin` outside `src/index.ts` (keeps the rest
   testable under node) — other modules receive capabilities via plain interfaces/arguments.

## Module ownership

### Builder A — registration & state (`src/index.ts`, `src/config.ts`, `src/tool-input.ts`, `src/registry.ts`, `src/storage.ts`)

- `src/config.ts`: parse/validate `UltracodeOptions` from `ctx.options` (unknown keys ignored,
  bad values fall back to defaults + collect warnings). Export `loadOptions(raw: unknown): { options: Required<UltracodeOptions>, warnings: string[] }`.
- `src/tool-input.ts`: `validateToolInput(raw: unknown): { ok: true; input: WorkflowToolInput } | { ok: false; error: string }`.
  Discriminate: `workflow` (string) => SavedRunInput; `script` (string) => InlineRunInput (max script
  size 512 KB, max args JSON size 64 KB). Reject extras.
- `src/registry.ts`: implement `Registry` (types.ts). In-memory `Map` + owned-session maps.
  Persistence via injected `Storage.saveRun` (throttled ~1s per run, flush on finalize).
  `reconcileOrphans()` flips persisted `running|stopping` -> `interrupted` with
  `stopReason: "server restart"`. Thread-safety: single-threaded JS, no locks needed.
- `src/storage.ts`: implement `Storage` (types.ts). Two backends:
  - plugin KV via injected `kv: { get(key): Promise<Json|undefined>, set(key, v: Json): Promise<void>, scan(prefix): ... }`
    (from `ctx.storage`) — used for run snapshots + result artifacts (`runs/<id>`, `results/<id>`).
  - filesystem (via injected `fs` helpers, see `test/fakes.ts` `FsLike`) — script artifacts under
    `<projectRoot>/.opencode/workflows/runs/<runID>.js`; saved workflows as `<name>.js` +
    `<name>.json` manifest (sha256 via `node:crypto`), project dir `<projectRoot>/.opencode/workflows/`
    beats personal `~/.config/opencode/workflows/`. Name validation: `/^[a-z0-9][a-z0-9-_]{0,63}$/`,
    path containment (no `..`, no absolute, resolve + startsWith check).
- `src/index.ts`: `Plugin.define({ id: "ultracode", setup })`:
  - load options; build `storage` (ctx.storage + ctx.location.project.directory), `registry`,
    `supervisor` (import from `../supervisor.ts` — Builder B; **code against the `Supervisor` interface**,
    and if B's module is missing, guard the import failure by disabling the tool with an error message —
    keeps A testable standalone).
  - register tool `workflow` (name `workflow`, no namespace): input JSON schema for the union;
    executor: **first statement** nested-run rejection via `supervisor.isOwnedSession(tool.sessionID)`;
    then validate input; resolve saved workflow via storage (hash mismatch after save => require
    `confirmHash` field... simpler: saved-workflow manifest hash mismatch => return error telling the
    user to re-save or confirm via `{ workflow, args, confirm: true }` — add optional `confirm?: boolean`
    to SavedRunInput validation in tool-input.ts); preflight `meta.requires` agents against
    `ctx.agent.list()` (fail fast listing available agents); then `supervisor.start(...)` and return
    `{ content: JSON.stringify(envelope, null, 1) }`.
  - register commands via `ctx.command.transform`: **only** `ultracode` (no `/workflow` /
    `/workflows` aliases — those names are left free to avoid colliding with a future OpenCode
    command). Parse `prompt.text` after the `/ultracode` token: no args => summary of active +
    recent runs + saved workflows (deliver via `ctx.session.synthetic({ sessionID, text })`);
    `stop <runID>` => `supervisor.stop` + synthetic ack; `show <runID>` => script + agent table
    via synthetic; `save <runID> <name>` => storage.saveWorkflow (default source "project") +
    synthetic ack; `help` => usage text. Unknown args point at authoring-via-keyword (no slash).
  - prompt hook: if `/(?:^|\s)ultracode(?=\s|:|$)/i` matches `event.prompt.text` (standalone
    keyword anywhere; not path substrings like `opencode-ultracode`) AND the session is not
    registry-owned (defensive `event.sessionID` read) => `(event.prompt.skills ??= []).push({ id: "ultracode" })`.
  - skill transform (try/catch!): register skill id `ultracode` with content imported from
    `../skill-content.ts` (Builder C) and `location` pointing at `<projectRoot>/.opencode/workflows/ultracode-skill.md`
    — **also write that file at setup** (storage fs helper) so the path exists; guard all failures.
  - permission hook ALWAYS registered (ask delegates to the host): `ctx.permission.hook("evaluate", ...)`,
    logic in `src/settings.ts` `evaluateOwnedPermission` (pure, tested). Owned-active child only.
    `ask`/missing mode => untouched (delegate). `autoEditsWorkflow`: action in `["edit", "write"]`
    and every resource path inside the project root (symlink-aware, fail-closed) =>
    `event.effect = "allow"`. `noEditTools`: edit-class actions => `effect: "deny"`;
    shell actions (`shell`/`bash`) with any write-shaped resource (`isShellWriteCommand`:
    redirects, `sed -i`, `tee`, mutating git, `sh -c`, …) => `deny` with the shell-write
    message. Otherwise untouched.
  - permission stall watchdog (same event subscription as tool-call counting): on
    `permission.asked` for an owned-active child, `noEditTools` rejects immediately via
    `ctx.permission.reply({ reply: "reject" })`; other modes reject after
    `effective.permissionStallMs` (0 disables). `permission.replied` clears the timer;
    dispose clears all timers. A hidden prompt never hangs a run until `timeoutMs`.
  - question tool: `action: "question"` on an owned-active child => `effect: "deny"` in every
    mode (dialog only renders inside the child session — invisible hang). Children must
    decide autonomously; authors give decision rules instead.
  - cleanup return: `supervisor.dispose()`, abort event subscriptions.
- A also wires NO direct session calls inside setup (deadlock rule) — commands do session calls
  inside their executors (allowed).

### Builder B — execution runtime (`src/supervisor.ts`, `src/worker-host.ts`, `src/worker-script.ts`, `src/primitives.ts`, `src/sessions.ts`, `src/serialize.ts`)

- `src/sessions.ts`: `createSessionDriver(ctxLike: SessionCtx, opts)`. `SessionCtx` is a narrow
  interface (see test/fakes.ts) mirroring the verified plugin session methods:
  `create/get/prompt/wait/context/interrupt`. `runAgent({ prompt, agent, label, phase, schema, defaultAgent, availableAgents }, hooks: { onSessionID(sessionID), abort: AbortSignal })`:
  1. resolve agent: explicit `agent` (missing from available => throw with list) else `defaultAgent`
     (missing => throw with guidance) — callers pre-validated defaults;
  2. `session.create({ title: label || phase || "workflow agent", agent })` — register sessionID via
     `onSessionID` IMMEDIATELY; re-check abort after create;
  3. build final prompt text (schema => append structured-output instruction with the JSON schema +
     "Respond with ONLY a JSON value matching the schema. No prose, no markdown fences.");
  4. `session.prompt` → `session.wait` (both race an `AbortSignal`-driven rejector; on abort call
     `session.interrupt({ sessionID, continue: false })` best-effort);
  5. `session.get` for `outcome` + tokens; `session.context` for the last assistant message:
     text/model/agent/tokens; `outcome !== "succeeded"` => typed error carrying text if any;
  6. schema mode: tolerant JSON extraction (whole-trimmed response, else single fenced ```json
     block, else first `{...}`/`[...]` balanced scan; reject ambiguous multiples; NO eval);
     validate with a tiny validator (`src/serialize.ts` `validateJsonSchemaValue(schema, value): { ok, error }`
     supporting type/required/properties/items/enum/minimum/maximum/additionalProperties-ignored);
     on invalid => ONE repair round: `session.prompt` with the validation error asking to output
     corrected JSON only, re-extract+validate; still invalid => throw typed error;
  7. return `AgentResult`.
- `src/primitives.ts`: host-side bridge handlers. `AgentRunner` = wrapper around runAgent that
  enforces: registry bookkeeping (addAgent => pending; updateAgent running/succeeded/failed with
  tokens/model), semaphore (`acquire(abort)` — queue FIFO, abort rejects queued), run-wide agent
  counter (maxAgents => throw typed "agent cap reached"), phase label (ambient from last `phase()`
  event + explicit opts.phase wins), progress reporting callback (throttled ~500ms:
  `"phase X — running aN (M done, K failed) of cap"`).
  Also `loadWorkflowForComposition(name)` handler: storage.loadWorkflow, depth cap 1 (a composed
  workflow may not compose another), returns `{ script, meta }` to the worker.
- `src/worker-host.ts`: spawn `node:worker_threads` Worker from `src/worker-script.ts` **source**
  (inline `new Worker(code, { eval: true })` where `code = workerSource + "(" + entryFn + ")()"` —
  keep worker-script.ts a string-exporting module `export const WORKER_SOURCE: string` so no file
  path resolution at runtime; testable pure JS). Host side: pending-call map, admission gate
  (closed => reject new bridge calls with "run stopping"), event handler (progress/phase/log),
  watchdog `setTimeout(timeoutMs)` => `stop()`; `terminate()` after grace (children interrupted first).
- `src/worker-script.ts` (runs inside worker — plain JS string): sandbox globals allowlist
  (JSON/Math/Array/Object/String/Number/Boolean/Map/Set/Promise/Error/TypeError/RegExp/
  structuredClone/console-buffered), async function body wrapper `(async () => { ...user script... })`,
  NO `export` statements expected (validation rejects `export`/`import` tokens outside strings —
  simple tokenizer check, and module-meta comes from tool input not script source). Injected API
  per `WorkflowScriptGlobal`: `agent` posts bridge call; `parallel(thunks)` = `Promise.all(t.map(t =>
  Promise.resolve().then(t).catch(e => { log; return null })))`; `pipeline(items, ...stages)` =
  per-item async chains (fail-fast per item: item result becomes `null` on stage throw, logged);
  `phase(name)` posts event; `progress(text)` posts event; `workflow(name, args)` posts bridge call
  and then EXECUTES the returned `{ script, meta }` as a nested async body at depth 1 (depth 2 =>
  throw); `sleep(ms)` bounded to 60s per call. Script return value: must be JSON-safe
  (structured-clone attempt; failure => stringify with replacer; symbol/function values stripped
  with warning). Unhandled rejection in worker => run fails with the error.
- `src/supervisor.ts`: implement `Supervisor`. Owns: registry+storage+sessions driver injection,
  run state machine (`running -> stopping -> final`), abort controllers per run, child session set,
  settle-all-before-finalize (track every in-flight agent()/bridge call; on script return or throw:
  close admission, wait outstanding calls (grace 15s) interrupting children, then finalize),
  timeout watchdog, stop() (status stopping -> close gate -> interrupt children -> terminate worker
  after grace -> finalize `stopped`), dispose() (stopAll). Envelope assembly: `serialize.ts`
  `buildEnvelope(run, maxChars)`; if `JSON.stringify(result)` > maxChars => preview (first maxChars
  chars of pretty JSON) + `truncated: true` + persist full result artifact via storage; result must
  stay valid-JSON-envelope-shaped. Total tokens = sum of agent tokens.
- B does NOT import `@opencode/plugin`; everything arrives via narrow interfaces
  (`SessionCtx`, `Registry`, `Storage`, options) — constructible from fakes in tests.

### Builder C — authoring surface & tests (`src/skill-content.ts`, `src/graph-templates.ts`, `src/script-templates.ts`, `src/catalog.ts`, `workflows/samples/*`, `test/*.test.ts`, `README.md`, `docs/AUTHORING.md`)

- `src/script-templates.ts`: pure module, twin of `graph-templates.ts` for script-mode shapes —
  `SCRIPT_TEMPLATES: readonly ScriptTemplate[]` (`{ name, description, args, script }`), lookup and
  summary helpers. Every body must pass `validateScriptSource`, fail fast on degenerate args, keep
  write agents sequential, cap every loop/slice, and carry stable `opts.key`s (enforced by
  `test/script-templates.test.ts`, including end-to-end supervisor runs). Served read-only by
  `ultracode_catalog` via `{ scriptTemplate }` / `{ scriptTemplates }` — the catalog never executes.
- `src/skill-content.ts`: `export const SKILL_NAME = "Ultracode"`; `export const SKILL_DESCRIPTION`
  (one dense sentence, trigger conditions); `export const SKILL_CONTENT: string` — the authoring
  skill markdown (mirrors Claude Code's workflow docs, adapted):
  when to use (task outgrows one context window / structural verification / repeatable orchestration),
  when NOT (single subagent suffices), the script API reference (agent/parallel/pipeline/phase/
  progress/workflow/sleep/args/meta via tool input, NOT in-script), rules (plain JS async body only,
  no import/export, return small JSON values, route via agents not models, serialize file-modifying
  agents, prefer explicit opts.phase, schema for structured outputs), patterns (fan-out+synthesize,
  adversarial verification, pipeline, generate-and-filter, tournament, loop-until-done), model-routing
  guidance via agents (cheap agent for extraction, strong agent for judgment — users pin agents).
- `workflows/samples/deep-research.{js,json}`, `code-audit.{js,json}`, `fact-check.{js,json}`:
  saved-workflow pairs (js = async body WITHOUT meta; json = manifest v1 with name/description/
  phases/requires/hash placeholder "" — the loader tolerates missing hash for samples, note in
  AUTHORING). Samples use ONLY stock agents: `requires: ["general", "explore"]`. deep-research:
  fan out explore agents per angle -> extract claims -> general verifier per claim -> skeptic pass
  -> synthesize. code-audit: enumerate modules (passed via args), one explore agent per module ->
  findings -> general adversarial reviewer -> merged report. fact-check: extraction -> verify ->
  skeptic -> report table.
- `test/fakes.ts` — shared fake infra (I have written the baseline; EXTEND, don't rewrite):
  `FakeSessionCtx` (scriptable queue of assistant replies, records calls, `wait` resolves after
  queued replies drain), `FakeKv`, `FakeFs`, `makeFakeCtx()` aggregating + plugin-tool-context fake
  `{ sessionID, agent, messageID, id, progress: async (s) => {} }`.
- `test/*.test.ts` using `node:test` + `node:assert/strict`:
  - `tool-input.test.ts`: union validation, size caps, confirm flag.
  - `config.test.ts`: defaults, bad values, warnings.
  - `registry.test.ts`: lifecycle transitions, owned maps, reconcileOrphans, persistence calls.
  - `storage.test.ts`: path safety (traversal rejected), name validation, workflow precedence,
    manifest round-trip.
  - `serialize.test.ts`: envelope truncation, schema validator cases (types/required/enum/nested),
    balanced JSON extraction (incl. fences, ambiguity rejection).
  - `primitives.test.ts`: semaphore FIFO + abort rejection, cap enforcement, parallel-null semantics
    (via a fake AgentRunner — do NOT spawn real workers here), phase labeling.
  - `worker-script.test.ts`: run WORKER_SOURCE in a real worker via `worker_threads` from the test:
    parallel/pipeline semantics, no-`export` validation, JSON-only return enforcement, console
    buffering, infinite loop + terminate (availability), nested workflow depth cap (mock bridge).
  - `sessions.test.ts`: runAgent happy path, missing agent fail-fast, outcome != succeeded error,
    schema repair round, abort => interrupt called (FakeSessionCtx supports it).
  - `skill-content.test.ts`: content covers every primitive name; samples parse + mention only
    stock agents; manifests match sample scripts.
  Tests must pass with `npm test` (`node --experimental-strip-types --test test/`).
- `README.md`: what it is (honest: trusted-code execution, worker = availability boundary NOT
  sandbox), install (git clone, npm install, add to global opencode.json plugins with absolute
  path), options table, the `ultracode` keyword, `/ultracode` command reference, cost control via
  `opencode2 subagent-config` pins (hot-reload applies to next spawned agent), saved workflows +
  sharing, security notes, FAQ (works on stock installs: general/explore; empty-agent fresh servers
  fail fast with guidance).
- `docs/AUTHORING.md`: full script API reference + patterns + complete runnable example.

## Integration points (owned by me, the lead)

- `src/index.ts` imports `Supervisor` from B and `SKILL_*` from C — both must exist for the final
  build; A guards B's import, C's skill registration is already try/caught.
- package.json test script already set; add `devDependencies.typescript` (done).
- Final wiring: user's global `~/.config/opencode/opencode.json` + live test (separate step).

## Definition of done (per builder)

- `npx tsc --noEmit` passes (run from repo root; your files included).
- `npm test` passes for your tests.
- No `@opencode/plugin` import outside `src/index.ts`.
- Every transform/hook registration wrapped in try/catch where ctx is involved.
- Report: files created, deviations from contracts (with reasons), anything you could not verify.
