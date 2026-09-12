/**
 * Builder B tests — worker-script: runs WORKER_SOURCE in REAL
 * node:worker_threads workers with a mock host bridge.
 */
import test from "node:test"
import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"
import { WORKER_SOURCE, validateScriptSource, MAX_SCRIPT_CHARS } from "../src/worker-script.ts"
import type { Json } from "../src/types.ts"

// ---------------------------------------------------------------------------
// Mock host bridge harness
// ---------------------------------------------------------------------------

interface WorkerEvent {
  kind: "progress" | "phase" | "log" | "checkpoint"
  data: Json
}

interface WorkerCall {
  fn: string
  args: Json[]
}

interface RunResult {
  ok: boolean
  value?: Json
  error?: string
  events: WorkerEvent[]
  calls: WorkerCall[]
}

type MockCallHandler = (fn: string, args: Json[]) => Promise<Json>

function runInWorker(
  script: string,
  opts: { args?: Json; meta?: Json; onCall?: MockCallHandler } = {},
): Promise<RunResult> {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  const events: WorkerEvent[] = []
  const calls: WorkerCall[] = []
  return new Promise<RunResult>((resolve, reject) => {
    worker.on("message", (msg: unknown) => {
      const m = msg as { type?: string; [k: string]: unknown }
      if (m.type === "call") {
        const args = (Array.isArray(m.args) ? m.args : []) as Json[]
        calls.push({ fn: String(m.fn), args })
        const handler = opts.onCall
        if (!handler) {
          worker.postMessage({ type: "result", id: Number(m.id), ok: false, error: `no mock handler for ${String(m.fn)}` })
          return
        }
        void Promise.resolve()
          .then(() => handler(String(m.fn), args))
          .then(
            (value) => worker.postMessage({ type: "result", id: Number(m.id), ok: true, value: value ?? null }),
            (err: unknown) =>
              worker.postMessage({ type: "result", id: Number(m.id), ok: false, error: String((err as Error)?.message ?? err) }),
          )
        return
      }
      if (m.type === "event") {
        events.push({ kind: String(m.kind) as WorkerEvent["kind"], data: (m.data ?? null) as Json })
        return
      }
      if (m.type === "done") {
        const result: RunResult = {
          ok: m.ok === true,
          value: (m.value ?? undefined) as Json | undefined,
          error: typeof m.error === "string" ? m.error : undefined,
          events,
          calls,
        }
        void worker.terminate()
        resolve(result)
      }
    })
    worker.on("error", (err: Error) => {
      void worker.terminate()
      reject(err)
    })
    worker.postMessage({ type: "init", script, args: opts.args, meta: opts.meta ?? {} })
  })
}

// ---------------------------------------------------------------------------
// validateScriptSource
// ---------------------------------------------------------------------------

test("validation: 'import'/'export' inside strings are fine", () => {
  assert.deepEqual(validateScriptSource(`const s = "import x from 'y'"; return s;`), { ok: true })
  assert.deepEqual(validateScriptSource(`const s = 'export default thing'; return s;`), { ok: true })
  assert.deepEqual(validateScriptSource("const s = `we may import and export stuff`; return s;"), { ok: true })
  assert.deepEqual(validateScriptSource("// import foo from 'bar'\nreturn 1;"), { ok: true })
  assert.deepEqual(validateScriptSource("/* require('fs') */ return 1;"), { ok: true })
})

test("validation: real ESM statements rejected", () => {
  assert.equal(validateScriptSource("export default 1").ok, false)
  assert.equal(validateScriptSource("const x = 1; export { x };").ok, false)
  assert.equal(validateScriptSource("import fs from 'node:fs';\nreturn 1;").ok, false)
  assert.equal(validateScriptSource("return 1;\nexport function f() {}").ok, false)
})

test("validation: banned references rejected", () => {
  assert.equal(validateScriptSource("return process.env.HOME;").ok, false)
  assert.equal(validateScriptSource("const fs = require('node:fs'); return 1;").ok, false)
  assert.equal(validateScriptSource("globalThis.x = 1; return 1;").ok, false)
  assert.equal(validateScriptSource("return new Function('return 1')();").ok, false)
  assert.equal(validateScriptSource("return typeof WebAssembly;").ok, false)
  assert.equal(validateScriptSource("const m = import('node:fs'); return m;").ok, false) // dynamic import(
})

test("validation: network/DOM identifiers banned (sandbox hardening)", () => {
  assert.equal(validateScriptSource('return fetch("http://x");').ok, false)
  assert.equal(validateScriptSource("return new WebSocket('w://x');").ok, false)
  assert.equal(validateScriptSource("return new XMLHttpRequest();").ok, false)
  assert.equal(validateScriptSource("const ua = navigator.userAgent; return ua;").ok, false)
  assert.equal(validateScriptSource("importScripts('a.js'); return 1;").ok, false)
  // ...but as strings they are fine:
  assert.deepEqual(validateScriptSource('const doc = "see the fetch docs"; return doc;'), { ok: true })
})

test("validation: while(true) allowed, size cap enforced, empty rejected", () => {
  assert.deepEqual(validateScriptSource("await sleep(10); while (true) {}"), { ok: true })
  const fits = `return "${"a".repeat(MAX_SCRIPT_CHARS - 20)}";`
  assert.ok(fits.length <= MAX_SCRIPT_CHARS)
  assert.equal(validateScriptSource(fits).ok, true)
  const tooBig = `return "${"a".repeat(MAX_SCRIPT_CHARS + 1)}";`
  assert.ok(tooBig.length > MAX_SCRIPT_CHARS)
  assert.equal(validateScriptSource(tooBig).ok, false)
  assert.equal(validateScriptSource("   \n ").ok, false)
})

test("validation: identifier-prefix words do not trip the tokenizer", () => {
  assert.deepEqual(validateScriptSource("const imports = 1; const exports2 = 2; return imports + exports2;"), { ok: true })
  assert.deepEqual(validateScriptSource("const p = { imported: 'noun', required: true }; return p;"), { ok: true })
  // Banned words as *strings* are fine; as identifiers they are not:
  assert.deepEqual(validateScriptSource('const s = "we need to require stuff"; return s;'), { ok: true })
  assert.equal(validateScriptSource("const s = 'we need to require stuff'; return s;").ok, true)
})

// ---------------------------------------------------------------------------
// Worker runtime semantics (real workers)
// ---------------------------------------------------------------------------

test("worker: agent bridge call round-trip + phase/progress events", async () => {
  const result = await runInWorker(
    `
    phase("research");
    const a = await agent("find the answer", { label: "seeker", agent: "explore" });
    progress("one done");
    return { text: a.text, sessionID: a.sessionID };
  `,
    {
      onCall: async (fn, args) => {
        assert.equal(fn, "agent")
        assert.equal(args[0], "find the answer")
        assert.deepEqual(args[1], { label: "seeker", agent: "explore" })
        return { text: "42", sessionID: "ses_w1" }
      },
    },
  )
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { text: "42", sessionID: "ses_w1" })
  assert.deepEqual(result.events, [
    { kind: "phase", data: "research" },
    { kind: "progress", data: "one done" },
  ])
})

test("worker: parallel thunk failure becomes null + log event", async () => {
  const result = await runInWorker(`
    const r = await parallel([
      () => Promise.reject(new Error("thunk blew up")),
      () => 7,
      async () => "three",
    ]);
    return r;
  `)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, [null, 7, "three"])
  const logs = result.events.filter((e) => e.kind === "log")
  assert.equal(logs.length, 1)
  assert.match(String(logs[0].data), /parallel thunk failed: thunk blew up/)
})

test("worker: pipeline stage failure nulls only that item + log event", async () => {
  const result = await runInWorker(`
    return await pipeline([1, 2, 3],
      (x) => x * 2,
      async (x) => { if (x === 4) throw new Error("no fours"); return x + 1; },
    );
  `)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, [3, null, 7])
  const logs = result.events.filter((e) => e.kind === "log")
  assert.equal(logs.length, 1)
  assert.match(String(logs[0].data), /pipeline item 1 failed: no fours/)
})

test("worker: console.log forwarded as buffered log events", async () => {
  const result = await runInWorker(`
    console.log("hello", { a: 1 });
    console.log("multi", "part");
    return 1;
  `)
  assert.equal(result.ok, true)
  const logs = result.events.filter((e) => e.kind === "log")
  assert.equal(logs.length, 2)
  assert.equal(logs[0].data, 'hello {"a":1}')
  assert.equal(logs[1].data, "multi part")
})

test("worker: args and meta injected", async () => {
  const result = await runInWorker(`return { gotArgs: args, gotMeta: meta };`, {
    args: { q: "search" },
    meta: { name: "named-flow" },
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    gotArgs: { q: "search" },
    gotMeta: { name: "named-flow" },
  })
})

test("worker: sleep is available and bounded", async () => {
  const started = Date.now()
  const result = await runInWorker(`await sleep(30); return "awake";`)
  assert.equal(result.ok, true)
  assert.equal(result.value, "awake")
  assert.ok(Date.now() - started >= 25)
})

test("worker: return value sanitized (functions stripped, bigint -> string, undefined omitted)", async () => {
  const result = await runInWorker(`
    return {
      keep: 1,
      fn: function () {},
      big: 10n,
      u: undefined,
      arr: [1, () => {}, undefined],
    };
  `)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, { keep: 1, big: "10", arr: [1, null, null] })
})

test("worker: cycles become [circular], shared refs stay intact", async () => {
  const result = await runInWorker(`
    const a = { n: 1 };
    a.self = a;
    const shared = { v: 9 };
    return { cyclic: a, dag: { x: shared, y: shared } };
  `)
  assert.equal(result.ok, true)
  assert.deepEqual(result.value, {
    cyclic: { n: 1, self: "[circular]" },
    dag: { x: { v: 9 }, y: { v: 9 } },
  })
})

test("worker: thrown error -> done ok:false with message", async () => {
  const result = await runInWorker(`throw new Error("script kaboom");`)
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /script kaboom/)
})

test("worker: syntax error in script -> done ok:false", async () => {
  const result = await runInWorker(`return (((;`)
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === "string" && result.error.length > 0)
})

test("worker: unhandled rejection -> done ok:false", async () => {
  const result = await runInWorker(`
    Promise.reject(new Error("dangling"));
    await sleep(80);
    return "never";
  `)
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /unhandled rejection: dangling/)
})

test("worker: composed workflow executes at depth 1 and returns its value", async () => {
  const result = await runInWorker(`return await workflow("helper", { n: 2 });`, {
    onCall: async (fn, args) => {
      assert.equal(fn, "workflow")
      assert.equal(args[0], "helper")
      assert.equal(args[2], 0) // depth from the top-level script
      return { script: "return args.n * 20 + 1;", meta: { name: "helper" } }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.value, 41)
})

test("worker: depth cap — nested workflow call arrives with depth 1 and host-side rejection propagates", async () => {
  const result = await runInWorker(`return await workflow("outer", null);`, {
    onCall: async (fn, args) => {
      assert.equal(fn, "workflow")
      if (Number(args[2]) === 0) {
        return { script: "return await workflow('inner', null);", meta: {} }
      }
      // Host-side composer behavior (src/primitives.ts getWorkflowComposer):
      throw new Error("nested composition beyond depth 1")
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /nested composition beyond depth 1/)
})

test("worker: infinite loop after an await — host terminate kills it (availability proof)", async () => {
  const worker = new Worker(WORKER_SOURCE, { eval: true })
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("worker did not terminate")), 5000)
    worker.on("exit", () => {
      clearTimeout(deadline)
      resolve()
    })
    worker.on("error", (err: Error) => {
      clearTimeout(deadline)
      reject(err)
    })
    worker.postMessage({
      type: "init",
      script: "await sleep(20);\nwhile (true) { /* spin */ }",
      args: undefined,
      meta: {},
    })
    setTimeout(() => {
      void worker.terminate()
    }, 150)
  })
  // Reaching this point proves the main thread was never blocked.
  assert.ok(true)
})

test("worker: gate-closed bridge call rejects inside the worker", async () => {
  // Simulates the host rejecting calls after closeGate(): the in-worker
  // agent() promise must reject (and surface as a script error).
  const result = await runInWorker(
    `
    const a = agent("hello");
    return await a;
  `,
    {
      onCall: async () => {
        throw new Error("run stopping")
      },
    },
  )
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /run stopping/)
})

test("worker: network/DOM stubs throw clean errors (no real network attempt)", async () => {
  const result = await runInWorker(`
    try {
      await fetch("http://127.0.0.1:9/never-reached");
      return "networked?!";
    } catch (e) {
      return String(e);
    }
  `)
  assert.equal(result.ok, true)
  assert.match(String(result.value), /ultracode: fetch is not available in workflow scripts/)
})

test("worker: return value with throwing getter fails fast (completion payload guarded)", async () => {
  const started = Date.now()
  const result = await runInWorker(`
    const o = {};
    Object.defineProperty(o, "boom", { get: function () { throw new Error("getter kaboom"); }, enumerable: true });
    return { nested: o };
  `)
  assert.equal(result.ok, false)
  assert.match(result.error ?? "", /completion payload could not be built/)
  assert.match(result.error ?? "", /getter kaboom/)
  assert.ok(Date.now() - started < 2000, "fails fast — no watchdog wait")
})

test("worker: uncloneable bridge arg rejects agent() promptly (no hang)", async () => {
  const started = Date.now()
  const result = await runInWorker(`
    try {
      await agent("hi", { weird: function () {} });
      return "delivered?!";
    } catch (e) {
      return "caught: " + e.message;
    }
  `)
  assert.equal(result.ok, true)
  assert.match(String(result.value), /ultracode: bridge call could not be delivered/)
  assert.ok(Date.now() - started < 2000, "rejected promptly — no hang")
})

// ---------------------------------------------------------------------------
// checkpoint() global
// ---------------------------------------------------------------------------

test("worker: checkpoint(name, value) posts a checkpoint event with sanitized value", async () => {
  const result = await runInWorker(`
    checkpoint("after-scout", { files: 3, nested: { ok: true } })
    checkpoint("empty")
    checkpoint("bad-value", function () {})
    return "done"
  `)
  assert.equal(result.ok, true)
  const checkpoints = result.events.filter((e) => e.kind === "checkpoint")
  assert.equal(checkpoints.length, 3)
  assert.deepEqual(checkpoints[0]!.data, { name: "after-scout", value: { files: 3, nested: { ok: true } } })
  assert.deepEqual(checkpoints[1]!.data, { name: "empty", value: null })
  // functions sanitize to null payloads, not a crash
  assert.deepEqual(checkpoints[2]!.data, { name: "bad-value", value: null })
})

// ---------------------------------------------------------------------------
// validateScriptSource: unterminated strings + regex literals
// ---------------------------------------------------------------------------

test("validation: unterminated single/double-quoted string is rejected with a line number", () => {
  const bad = 'const a = "starts here\nconst b = 2\nreturn b'
  const check = validateScriptSource(bad)
  assert.equal(check.ok, false)
  if (!check.ok) {
    assert.match(check.error, /unterminated string literal starting at line 1/)
    assert.match(check.error, /cannot span lines/)
  }
  const badLate = 'const ok = "fine"\nconst broken = \'oops\nreturn ok'
  const check2 = validateScriptSource(badLate)
  assert.equal(check2.ok, false)
  if (!check2.ok) assert.match(check2.error, /line 2/)
})

test("validation: template literals may span lines", () => {
  assert.equal(validateScriptSource("const s = `line one\nline two`; return s").ok, true)
})

test("validation: regex literals with quotes inside are fine (regex vs division heuristic)", () => {
  // quote inside a char class — must NOT be read as a string start
  assert.equal(validateScriptSource('const clean = s.replace(/["\']/g, ""); return clean').ok, true)
  // division after values stays division; regex after = stays regex
  assert.equal(validateScriptSource("const half = total / 2; return half / count;").ok, true)
  assert.equal(validateScriptSource('const hit = /a[b/ ]c/g.test("x"); return hit').ok, true)
  // regex after return keyword
  assert.equal(validateScriptSource("function f(x) { return /re/.test(x) }\nreturn f").ok, true)
  // number-adjacent division
  assert.equal(validateScriptSource("const m = 10 / 5 / 2; return m").ok, true)
})

test("validation: quote right after value position still diagnosed as unterminated when it spans lines", () => {
  // `dont` identifier then an apostrophe opening a "string" that hits EOL
  const check = validateScriptSource("const dont = 1\nconst s = dont't\n")
  assert.equal(check.ok, false)
})
