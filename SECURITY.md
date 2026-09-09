# Security policy

## Trust model — read this first

**Workflow scripts are trusted code.** `ultracode_run` executes JavaScript you (or the model,
on your behalf) authored. The worker thread is an **availability boundary, not a security
sandbox**:

- Scripts run via `new Function` inside a `node:worker_threads` worker with ordinary worker
  globals minus shadowed network/DOM entry points (`fetch`, `WebSocket`,
  `XMLHttpRequest`, `navigator`, `importScripts` are replaced with throwing stubs). Module
  tokens (`import` / `export` / `require`) are rejected before execution.
- Isolation is **enforced by omission**, not a hard capability boundary, and **memory is not
  bounded**. A malicious script is still your code executing with your privileges — the same
  as any tool/script you run. Do not run scripts you have not reviewed.
- **Saved workflows are executable content.** Every saved workflow requires a one-time
  `/ultracode trust <name>` bound to the script's content digest; editing the file invalidates
  trust. Review workflow diffs in code review like any other code.
- **Child sessions are real agents with your config** — including your agent pins, permissions,
  and providers. Runs record the `effectiveModel` each child actually used. The plugin itself
  names no model or provider anywhere.

## Agent-count and time caps are not cost caps

`concurrency`, `maxAgents`, and `timeoutMs` bound runaway orchestration. They are not monetary
limits: tokens spent before a cap trips are spent. Bound fan-out in the script itself.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability) rather
than a public issue. Include the commit you tested against and, if relevant, a minimal script
that demonstrates the problem.

## Data

Runs persist run records and (optionally) saved workflow scripts under your project's
`.opencode/workflows/` directory and OpenCode project KV. Child-session transcripts live in
your OpenCode session store, exactly like any other session. The `spike/` development harness
writes captures under `spike/out/` — git-ignored, local-only, never committed.
