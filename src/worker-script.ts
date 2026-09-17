/**
 * Worker-side runtime (as a plain-JS string) + host-side script validation.
 *
 * The worker source is a literal string so spawning needs no file resolution:
 *   new Worker(WORKER_SOURCE, { eval: true })
 * followed by an init message {type:"init", script, args, meta}.
 *
 * Worker isolation is an AVAILABILITY boundary (runaway scripts terminate),
 * not a security sandbox — user scripts are trusted code (see README).
 *
 * Builder B module.
 */

/**
 * Loop-engine + queue runtime, spliced into WORKER_SOURCE. Plain JS only —
 * no backticks, no template literals, no escapes (this file embeds it in a
 * TS template literal). Engine-owned disciplines: budget ledger shared across
 * nested loops, per-iteration agent limits, auto-keys, wall/deadline/token
 * stops, stall detection, per-iteration checkpoints, verdict + asymmetric
 * skeptic for terminating claims, stop-reason accounting.
 */
const LOOP_RUNTIME = `
// ---- loop engine + queue library -----------------------------------------
var loopCaps = { maxAgents: 0, maxLoopDepth: 2, artifactsDir: null, runDir: null };
var activeLoops = [];
var scriptDepth = 0;

function applyLoopCaps(caps) {
  if (caps === null || typeof caps !== "object") return;
  loopCaps.maxAgents = Number(caps.maxAgents) > 0 ? Math.floor(Number(caps.maxAgents)) : 0;
  loopCaps.maxLoopDepth = Number(caps.maxLoopDepth) > 0 ? Math.floor(Number(caps.maxLoopDepth)) : 2;
  loopCaps.artifactsDir = typeof caps.artifactsDir === "string" && caps.artifactsDir ? caps.artifactsDir : null;
  loopCaps.runDir = typeof caps.runDir === "string" && caps.runDir ? caps.runDir : null;
}

function fnv1a(str) {
  var h = 0x811c9dc5;
  for (var fi = 0; fi < str.length; fi++) {
    h = h ^ str.charCodeAt(fi);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

function hashValue(v) {
  var s;
  try {
    s = JSON.stringify(v === undefined ? null : v);
  } catch (e) {
    s = "[unserializable]";
  }
  return fnv1a(String(s));
}

function postCheckpoint(name, value) {
  post({ type: "event", kind: "checkpoint", data: { name: String(name), value: value === undefined ? null : value } });
}

// ---- queue: pure serializable worklist (pop/push/done/block) --------------
function createQueue(initial, opts) {
  var items = [];
  var index = Object.create(null);
  var idField = opts !== null && typeof opts === "object" && typeof opts.id === "string" && opts.id ? opts.id : null;
  var source = Array.isArray(initial) ? initial : [];

  function normalize(raw) {
    var o = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    var text = typeof o.text === "string" ? o.text : (typeof o.title === "string" ? o.title : "");
    var deps = [];
    if (Array.isArray(o.deps)) {
      for (var di = 0; di < o.deps.length; di++) if (typeof o.deps[di] === "string") deps.push(o.deps[di]);
    }
    var tags = [];
    if (Array.isArray(o.tags)) {
      for (var ti = 0; ti < o.tags.length; ti++) if (typeof o.tags[ti] === "string") tags.push(o.tags[ti]);
    }
    var meta = o.meta === undefined ? null : o.meta;
    var id = "";
    if (typeof o.id === "string" && o.id) id = o.id;
    else if (idField && typeof o[idField] === "string" && o[idField]) id = String(o[idField]);
    if (!id) id = "q" + fnv1a(JSON.stringify([text, deps, tags, meta]));
    return { id: id, text: text, deps: deps, tags: tags, meta: meta, status: "open", note: null };
  }

  function add(raw) {
    var it = normalize(raw);
    if (index[it.id]) return index[it.id].id;
    items.push(it);
    index[it.id] = it;
    return it.id;
  }

  for (var si = 0; si < source.length; si++) add(source[si]);

  function doneMap() {
    var m = Object.create(null);
    for (var i = 0; i < items.length; i++) if (items[i].status === "done") m[items[i].id] = true;
    return m;
  }

  function ready(it, done) {
    if (it.status !== "open") return false;
    for (var i = 0; i < it.deps.length; i++) if (!done[it.deps[i]]) return false;
    return true;
  }

  function popOne() {
    var done = doneMap();
    for (var i = 0; i < items.length; i++) {
      if (ready(items[i], done)) {
        items[i].status = "active";
        return out(items[i]);
      }
    }
    return null;
  }

  function out(it) {
    return { id: it.id, text: it.text, deps: it.deps, tags: it.tags, meta: it.meta, status: it.status, note: it.note };
  }

  return {
    push: function (raw) {
      var list = Array.isArray(raw) ? raw : [raw];
      var ids = [];
      for (var i = 0; i < list.length; i++) ids.push(add(list[i]));
      return ids;
    },
    pop: function () {
      return popOne();
    },
    popMany: function (n) {
      var out2 = [];
      var k = Math.max(0, Math.floor(Number(n) || 0));
      for (var i = 0; i < k; i++) {
        var it = popOne();
        if (!it) break;
        out2.push(it);
      }
      return out2;
    },
    done: function (id, note) {
      var it = index[id];
      if (!it) throw new Error("queue.done: unknown id " + String(id));
      it.status = "done";
      if (note !== undefined) it.note = note;
      return true;
    },
    block: function (id, reason) {
      var it = index[id];
      if (!it) throw new Error("queue.block: unknown id " + String(id));
      it.status = "blocked";
      if (reason !== undefined) it.note = reason;
      return true;
    },
    unblock: function (id) {
      var it = index[id];
      if (!it) throw new Error("queue.unblock: unknown id " + String(id));
      if (it.status === "blocked") it.status = "open";
      return true;
    },
    sizes: function () {
      var done = doneMap();
      var n = { total: items.length, open: 0, active: 0, blocked: 0, done: 0, ready: 0 };
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.status === "open") {
          n.open += 1;
          if (ready(it, done)) n.ready += 1;
        } else if (it.status === "active") n.active += 1;
        else if (it.status === "blocked") n.blocked += 1;
        else if (it.status === "done") n.done += 1;
      }
      return n;
    },
    items: function () {
      var out3 = [];
      for (var i = 0; i < items.length; i++) out3.push(out(items[i]));
      return out3;
    },
  };
}

// ---- agent() wrapper: shared ledger + auto-keys ----------------------------
function loopAgentCall(prompt, opts, engineCall) {
  if (activeLoops.length === 0) {
    return callHost("agent", [prompt, opts === undefined || opts === null ? {} : opts]);
  }  var o = opts !== null && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  var top = activeLoops[activeLoops.length - 1];
  for (var li = 0; li < activeLoops.length; li++) {
    var ctx = activeLoops[li];
    ctx.iterAgents += 1;
    ctx.totalAgents += 1;
    var limit = engineCall === true ? ctx.perIteration : ctx.perIteration - ctx.reserved;
    if (limit < 1) limit = 1;
    if (ctx.iterAgents > limit) {
      throw new Error(
        "loop " + ctx.key + ": iteration " + ctx.iteration + " exceeded its agent budget (" +
          (engineCall === true ? ctx.perIteration : ctx.perIteration - ctx.reserved) +
          " calls" + (ctx.reserved > 0 && engineCall !== true ? " after verdict reservation" : "") +
          "; agentsPerIteration " + ctx.perIteration + ")"
      );
    }
  }
  var call = {};
  for (var k in o) {
    if (Object.prototype.hasOwnProperty.call(o, k)) call[k] = o[k];
  }
  if (call.key === undefined || call.key === null || call.key === "") {
    top.iterCalls += 1;
    call.key = top.key + ":i" + top.iteration + ":a" + top.iterCalls;
  }
  return callHost("agent", [prompt, call]).then(function (res) {
    if (res !== null && typeof res === "object" && res.tokens !== null && typeof res.tokens === "object") {
      var t = (Number(res.tokens.input) || 0) + (Number(res.tokens.output) || 0) + (Number(res.tokens.reasoning) || 0);
      if (t > 0) {
        for (var li2 = 0; li2 < activeLoops.length; li2++) activeLoops[li2].tokens += t;
      }
    }
    return res;
  });
}

// ---- loop engine ----------------------------------------------------------
function normalizeLoopBudget(raw) {
  var b = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  var iterations = Number.isFinite(Number(b.iterations)) ? Math.floor(Number(b.iterations)) : 10;
  iterations = Math.min(200, Math.max(1, iterations));
  var per = Number.isFinite(Number(b.agentsPerIteration)) ? Math.floor(Number(b.agentsPerIteration)) : 12;
  per = Math.min(64, Math.max(1, per));
  var wallMs = Number.isFinite(Number(b.wallMs)) && Number(b.wallMs) > 0 ? Math.floor(Number(b.wallMs)) : 0;
  var tokens = Number.isFinite(Number(b.tokens)) && Number(b.tokens) > 0 ? Math.floor(Number(b.tokens)) : 0;
  var deadlineAt = 0;
  if (b.deadline !== undefined && b.deadline !== null) {
    var d = typeof b.deadline === "number" ? b.deadline : Date.parse(String(b.deadline));
    if (!Number.isFinite(d)) {
      throw new Error("loop: budget.deadline must be epoch-ms or a Date-parseable string");
    }
    deadlineAt = d;
  }
  return { iterations: iterations, agentsPerIteration: per, wallMs: wallMs, tokens: tokens, deadlineAt: deadlineAt };
}

async function runLoop(spec, iterate) {
  var s = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? spec : {};
  var key = "";
  var goal = "";
  var state = {};
  var iterateFn = null;
  var unit = null;
  var unitName = "";
  var budget = null;
  var stopSpec = {};
  var predicate = null;
  var stallK = 3;
  var verdictSpec = null;
  var skepticOn = false;
  var onError = "retry";
  // Preflight region: structural failures (bad spec, depth cap, budget
  // arithmetic, unit trust) are marked so an ENCLOSING loop's
  // onIterationError policy rethrows them instead of retrying/absorbing.
  try {
    key = typeof s.key === "string" ? s.key.trim() : "";
    if (!key || key.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
      throw new Error("loop: key must be 1-64 chars of [A-Za-z0-9._:-]");
    }
    goal = typeof s.goal === "string" ? s.goal : "";
    state = s.state === undefined ? {} : s.state;
    iterateFn = typeof iterate === "function" ? iterate : null;
    unit = s.unit !== null && typeof s.unit === "object" && !Array.isArray(s.unit) ? s.unit : null;
    unitName = unit && typeof unit.name === "string" && unit.name ? unit.name : "";
    if (iterateFn && unitName) throw new Error("loop: pass iterate(ctx) or unit { name, args }, not both");
    if (!iterateFn && !unitName) throw new Error("loop: pass iterate(ctx) or unit { name, args(state) }");
    budget = normalizeLoopBudget(s.budget);
    stopSpec = s.stop !== null && typeof s.stop === "object" && !Array.isArray(s.stop) ? s.stop : {};
    predicate = typeof stopSpec.predicate === "function" ? stopSpec.predicate : null;
    stallK = Number.isFinite(Number(stopSpec.stallK)) ? Math.min(10, Math.max(1, Math.floor(Number(stopSpec.stallK)))) : 3;
    verdictSpec = s.verdict !== null && typeof s.verdict === "object" && !Array.isArray(s.verdict) ? s.verdict : null;
    skepticOn = verdictSpec ? verdictSpec.skeptic !== false : false;
    onError = s.onIterationError === "record" || s.onIterationError === "abort" ? s.onIterationError : "retry";

    var depthNow = activeLoops.length;
    var maxDepth = loopCaps.maxLoopDepth > 0 ? loopCaps.maxLoopDepth : 2;
    if (depthNow + 1 > maxDepth) {
      throw new Error("loop: nesting depth " + (depthNow + 1) + " exceeds maxLoopDepth " + maxDepth + " — flatten the loops or raise the plugin option");
    }
    var maxAgents = loopCaps.maxAgents > 0 ? loopCaps.maxAgents : 0;
    var estimated = budget.iterations * budget.agentsPerIteration;
    if (maxAgents > 0 && estimated > maxAgents) {
      throw new Error(
        "loop: budget worst case " + estimated + " agent calls (iterations x agentsPerIteration) exceeds the run cap maxAgents=" +
          maxAgents + " — lower iterations/agentsPerIteration"
      );
    }
    if (unitName) {
      await callHost("workflow-check", [unitName, null, scriptDepth]);
    }
  } catch (preflightErr) {
    if (preflightErr !== null && typeof preflightErr === "object" && preflightErr.__ucStructural !== true) {
      preflightErr.__ucStructural = true;
    }
    throw preflightErr;
  }

  var reserved = verdictSpec ? 1 + (skepticOn ? 1 : 0) : 0;
  var perIteration = budget.agentsPerIteration;
  if (reserved >= perIteration) {
    var reserveErr = new Error("loop: agentsPerIteration " + perIteration + " leaves no room for the verdict/skeptic calls (" + reserved + ")");
    reserveErr.__ucStructural = true;
    throw reserveErr;
  }

  var startedAt = Date.now();
  var endAt = budget.wallMs > 0 ? startedAt + budget.wallMs : 0;
  if (budget.deadlineAt > 0 && (endAt === 0 || budget.deadlineAt < endAt)) endAt = budget.deadlineAt;

  var ledger = {
    key: key,
    iteration: 0,
    perIteration: perIteration,
    reserved: reserved,
    iterAgents: 0,
    totalAgents: 0,
    iterCalls: 0,
    tokens: 0,
  };
  activeLoops.push(ledger);
  var history = [];
  var lastVerdict = null;
  var lastResult = null;
  var stopReason = "budget";
  var stall = 0;
  var lastDigest = null;
  var completed = 0;
  var errors = 0;

  function postHistoryRow(row) {
    history.push(row);
    if (history.length > 12) history.shift();
  }

  try {
    for (var i = 0; i < budget.iterations; i++) {
      if (endAt > 0 && Date.now() >= endAt) {
        stopReason = "budget";
        break;
      }
      if (budget.tokens > 0 && ledger.tokens >= budget.tokens) {
        stopReason = "budget";
        break;
      }
      ledger.iteration = i;
      ledger.iterAgents = 0;
      post({ type: "event", kind: "phase", data: key });
      post({ type: "event", kind: "progress", data: "loop " + key + ": iteration " + (i + 1) + "/" + budget.iterations });

      var ctx = {
        i: i,
        key: key,
        goal: goal,
        state: state,
        budgetLeft: {
          iterations: budget.iterations - i,
          agentsPerIteration: perIteration - reserved,
          wallMs: endAt > 0 ? Math.max(0, endAt - Date.now()) : 0,
          tokens: budget.tokens > 0 ? Math.max(0, budget.tokens - ledger.tokens) : 0,
        },
        artifactsDir: loopCaps.artifactsDir ? String(loopCaps.artifactsDir) + "/it-" + i : null,
        runDir: loopCaps.runDir ? String(loopCaps.runDir) : null,
        history: history.slice(),
        lastVerdict: lastVerdict,
        lastResult: lastResult,
      };

      var attempts = onError === "retry" ? 2 : 1;
      var outcome = null;
      var iterError = null;
      var status = "improve";
      var stopped = false;
      for (var attempt = 0; attempt < attempts; attempt++) {
        iterError = null;
        outcome = null;
        ledger.iterCalls = 0;
        try {
          var res = iterateFn
            ? await iterateFn(ctx)
            : await runUnit(unitName, unit, ctx);
          if (res === null || typeof res !== "object" || Array.isArray(res) || res.state === undefined) {
            throw new Error("loop: iterate must return an object with { state } (got " + fmt(res) + ")");
          }
          outcome = { state: res.state, result: res.result === undefined ? null : res.result };
          if (verdictSpec) {
            var vPrompt = verdictSpec.prompt;
            if (typeof vPrompt === "function") vPrompt = vPrompt({ i: i, state: outcome.state, result: outcome.result, goal: goal });
            if (vPrompt === null || vPrompt === undefined) vPrompt = "";
            var vres = await loopAgentCall(String(vPrompt), {
              agent: typeof verdictSpec.agent === "string" ? verdictSpec.agent : undefined,
              schema: verdictSpec.schema,
              key: key + ":i" + i + ":verdict",
              label: key + ":verdict",
              phase: key,
            }, true);
            lastVerdict = vres !== null && typeof vres === "object" && vres.data !== undefined ? vres.data : null;
            if (lastVerdict !== null && typeof lastVerdict === "object" && typeof lastVerdict.status === "string") {
              status = lastVerdict.status;
            }
          } else {
            lastVerdict = null;
          }
          var terminating = status === "done" || status === "target";
          if (terminating && skepticOn) {
            var claim = JSON.stringify(lastVerdict === null ? { status: status } : lastVerdict);
            var verified = false;
            try {
              var sk = await loopAgentCall(
                "Act as an independent skeptic. Attempt to REFUTE this termination claim by re-deriving it from the workspace and its evidence; verify the quoted evidence and the claimed metric. If you cannot reproduce it, refute it. Claim: " + claim,
                {
                  agent: typeof verdictSpec.agent === "string" ? verdictSpec.agent : undefined,
                  schema: { type: "object", required: ["verified"], properties: { verified: { type: "boolean" }, reason: { type: "string" } } },
                  key: key + ":i" + i + ":skeptic",
                  label: key + ":skeptic",
                  phase: key,
                },
                true
              );
              verified = sk !== null && typeof sk === "object" && sk.data !== undefined && sk.data !== null && sk.data.verified === true;
            } catch (skErr) {
              verified = false;
              postHistoryRow({ i: i, status: "skeptic-error", error: errMsg(skErr).slice(0, 160) });
            }
            if (!verified) status = "improve";
          }
          if (status === "blocked") {
            stopReason = "blocked";
            stopped = true;
          } else if ((status === "done" || status === "target") && !(terminating && skepticOn && status === "improve")) {
            stopReason = "target";
            stopped = true;
          }
          if (!stopped && predicate) {
            var pv = predicate({ i: i, state: outcome.state, result: outcome.result, verdict: lastVerdict, goal: goal });
            if (pv) {
              stopReason = typeof pv === "string" && pv ? pv.slice(0, 40) : "target";
              stopped = true;
            }
          }
        } catch (e) {
          // Structural failures (bad nested spec, depth cap, budget arithmetic,
          // unit trust) bypass the iteration policy and fail loud — retrying a
          // broken spec can only burn budget.
          if (e !== null && typeof e === "object" && e.__ucStructural === true) throw e;
          iterError = e;
          outcome = null;
          stopped = false;
          if (attempt + 1 < attempts) continue;
        }
        break;
      }

      if (iterError !== null) {
        errors += 1;
        postHistoryRow({ i: i, status: "error", error: errMsg(iterError).slice(0, 160) });
        postCheckpoint("loop:" + key.slice(0, 24) + ":i" + i, { status: "error" });
        if (onError === "abort") {
          stopReason = "error";
          break;
        }
        stall += 1;
        if (stall >= stallK) {
          stopReason = "stall";
          break;
        }
        continue;
      }

      state = outcome.state;
      lastResult = outcome.result;
      completed = i + 1;
      var digest = hashValue(state);
      if (!stopped) {
        if (digest === lastDigest && status !== "done" && status !== "target") {
          stall += 1;
          if (stall >= stallK) {
            stopReason = "stall";
            stopped = true;
          }
        } else {
          stall = 0;
        }
      }
      lastDigest = digest;
      postHistoryRow({ i: i, status: status, digest: digest.slice(0, 12) });
      postCheckpoint("loop:" + key.slice(0, 24) + ":i" + i, {
        status: status,
        digest: digest.slice(0, 12),
        agents: ledger.iterAgents,
        tokens: ledger.tokens,
      });
      if (stopped) break;
    }
  } finally {
    activeLoops.pop();
  }

  return {
    key: key,
    goal: goal,
    iterations: completed,
    stopReason: stopReason,
    state: state,
    lastVerdict: lastVerdict,
    lastResult: lastResult,
    history: history,
    spent: { agents: ledger.totalAgents, tokens: ledger.tokens, wallMs: Date.now() - startedAt, errors: errors },
  };
}

async function runUnit(name, unit, ctx) {
  var ua = typeof unit.args === "function" ? unit.args(ctx) : (unit.args === undefined ? null : unit.args);
  if (ua !== null && typeof ua === "object" && typeof ua.then === "function") ua = await ua;
  var composed = await callHost("workflow", [name, ua === undefined ? null : ua, scriptDepth]);
  if (!composed || typeof composed.script !== "string") {
    throw new Error("workflow bridge returned no script");
  }
  return await runScript(composed.script, composed.meta || {}, ua, scriptDepth + 1);
}
`

/**
 * The complete worker-side runtime. Plain JS (no backticks / template
 * literals inside — this file embeds it as a TS template string).
 *
 * Semantics:
 *  - {type:"init", script, args, meta, caps} -> runs script as `(async () => { ... })()`
 *    with injected globals (agent/parallel/pipeline/phase/progress/checkpoint/
 *    workflow/loop/queue/sleep/console/args/meta); posts {type:"done", ok, value|error}.
 *  - agent()/workflow()/workflow-check() post {type:"call", id, fn, args} and
 *    resolve on {type:"result", id, ok, value|error}.
 *  - parallel: Promise.all with per-thunk catch -> null + console.log.
 *  - pipeline: per-item async chains; stage throw -> item null + console.log.
 *  - workflow(name, args) executes the composed script at depth+1; the depth
 *    is passed to the host which enforces the cap (depth > 0 rejected).
 *  - loop(spec, iterate): engine-owned loop disciplines (caps from init:
 *    maxAgents / maxLoopDepth / artifact dirs); queue(): pure worklist.
 *  - sleep bounded to 60s per call; console forwarded as log events.
 *  - done values are sanitized (functions/symbols/undefined stripped,
 *    bigint -> string, cycles -> "[circular]") so structured clone cannot throw.
 *  - unhandledRejection/uncaughtException -> done ok:false (single-shot).
 */
export const WORKER_SOURCE = `
"use strict";
// ultracode worker runtime (generated by src/worker-script.ts)
var wt = null;
try { wt = require("node:worker_threads"); } catch (e) { wt = null; }
var port = wt ? wt.parentPort : null;
if (!port) throw new Error("worker runtime: no parentPort");

var started = false;
var settled = false;
var callSeq = 0;
var pending = new Map();

function post(msg) {
  try { port.postMessage(msg); } catch (e) { /* host gone */ }
}

function errMsg(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

function fmt(v) {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}

function sanitize(v, seen) {
  if (v === null) return null;
  var t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v;
  if (t === "bigint") return String(v);
  if (t === "undefined" || t === "function" || t === "symbol") return null;
  if (t === "object") {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    var out;
    if (Array.isArray(v)) {
      out = new Array(v.length);
      for (var ai = 0; ai < v.length; ai++) out[ai] = sanitize(v[ai], seen);
    } else {
      out = {};
      var keys = Object.keys(v);
      for (var ki = 0; ki < keys.length; ki++) {
        var k = keys[ki];
        var val = v[k];
        var vt = typeof val;
        if (vt === "undefined" || vt === "function" || vt === "symbol") continue;
        out[k] = sanitize(val, seen);
      }
    }
    seen.delete(v); // ancestor tracking: shared refs are NOT cycles
    return out;
  }
  return null;
}

function callHost(fn, args) {
  return new Promise(function (resolve, reject) {
    callSeq += 1;
    var id = callSeq;
    var entry = { resolve: resolve, reject: reject };
    pending.set(id, entry);
    try {
      port.postMessage({ type: "call", id: id, fn: fn, args: args });
    } catch (e) {
      // Structured-clone failure (uncloneable arg): drop the pending entry and
      // reject so agent()/workflow() fail promptly instead of hanging forever.
      pending.delete(id);
      reject(new Error("ultracode: bridge call could not be delivered: " + errMsg(e)));
    }
  });
}

var scriptConsole = {
  log: function () {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
    post({ type: "event", kind: "log", data: parts.join(" ") });
  },
};

function runBody(script, globals) {
  var keys = Object.keys(globals);
  var values = keys.map(function (k) { return globals[k]; });
  var body = '"use strict"; return (async () => {\\n' + script + '\\n})();';
  var fn = new Function(...keys, body);
  return fn(...values);
}

function makeStep(stage, index) {
  return function (value) { return stage(value, index); };
}

// Network/DOM escape hatches are shadowed by throwing stubs (defense in depth
// on top of host-side script validation, which bans these identifiers).
function unavailableStub(name) {
  return function () {
    throw new Error("ultracode: " + name + " is not available in workflow scripts");
  };
}

${LOOP_RUNTIME}

function makeGlobals(depth, args, meta) {
  scriptDepth = depth;
  return {
    agent: function (prompt, opts) {
      return loopAgentCall(prompt, opts);
    },
    fetch: unavailableStub("fetch"),
    WebSocket: unavailableStub("WebSocket"),
    XMLHttpRequest: unavailableStub("XMLHttpRequest"),
    navigator: unavailableStub("navigator"),
    importScripts: unavailableStub("importScripts"),
    parallel: function (thunks) {
      return Promise.all(thunks.map(function (thunk) {
        return Promise.resolve().then(thunk).catch(function (e) {
          scriptConsole.log("parallel thunk failed: " + errMsg(e));
          return null;
        });
      }));
    },
    pipeline: function (items) {
      var stages = Array.prototype.slice.call(arguments, 1);
      return Promise.all(items.map(function (item, index) {
        var chain = Promise.resolve(item);
        for (var si = 0; si < stages.length; si++) chain = chain.then(makeStep(stages[si], index));
        return chain.catch(function (e) {
          scriptConsole.log("pipeline item " + index + " failed: " + errMsg(e));
          return null;
        });
      }));
    },
    phase: function (name) {
      post({ type: "event", kind: "phase", data: String(name) });
    },
    progress: function (text) {
      post({ type: "event", kind: "progress", data: String(text) });
    },
    checkpoint: function (name, value) {
      post({ type: "event", kind: "checkpoint", data: {
        name: String(name),
        value: sanitize(value === undefined ? null : value, new WeakSet()),
      } });
    },
    workflow: function (name, wfArgs) {
      return callHost("workflow", [name, wfArgs === undefined ? null : wfArgs, depth]).then(function (composed) {
        if (!composed || typeof composed.script !== "string") {
          throw new Error("workflow bridge returned no script");
        }
        return runScript(composed.script, composed.meta || {}, wfArgs, depth + 1);
      });
    },
    loop: function (spec, iterate) {
      return runLoop(spec, iterate);
    },
    queue: function (initial, opts) {
      return createQueue(initial, opts);
    },
    sleep: function (ms) {
      var n = Math.max(0, Math.min(Number(ms) || 0, 60000));
      return new Promise(function (resolve) { setTimeout(resolve, n); });
    },
    console: scriptConsole,
    args: args,
    meta: meta || {},
  };
}

async function runScript(script, meta, args, depth) {
  var globals = makeGlobals(depth, args, meta);
  return await runBody(script, globals);
}

function finish(ok, value, error) {
  if (settled) return;
  // Build the completion payload FIRST (a throwing getter in the return value
  // must become a failure payload, not a lost done message + watchdog wait).
  var payload;
  try {
    if (ok) payload = { type: "done", ok: true, value: sanitize(value, new WeakSet()) };
    else payload = { type: "done", ok: false, error: error };
  } catch (e) {
    payload = { type: "done", ok: false, error: "completion payload could not be built: " + errMsg(e) };
  }
  settled = true;
  post(payload);
}

port.on("message", function (msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "init" && !started) {
    started = true;
    applyLoopCaps(msg.caps);
    Promise.resolve()
      .then(function () { return runScript(msg.script, msg.meta, msg.args, 0); })
      .then(function (value) { finish(true, value, undefined); })
      .catch(function (e) { finish(false, undefined, errMsg(e)); });
    return;
  }
  if (msg.type === "result") {
    var entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.value);
    else entry.reject(new Error(msg.error));
  }
});

process.on("unhandledRejection", function (e) {
  finish(false, undefined, "unhandled rejection: " + errMsg(e));
});
process.on("uncaughtException", function (e) {
  finish(false, undefined, "uncaught exception: " + errMsg(e));
});
`

// ---------------------------------------------------------------------------
// Host-side validation (runs BEFORE spawn)
// ---------------------------------------------------------------------------

export type ScriptCheck = { ok: true } | { ok: false; error: string }

export const MAX_SCRIPT_CHARS = 512 * 1024

/** Identifiers that must not be referenced anywhere in a user script. */
const BANNED_IDENTIFIERS = new Set([
  "process",
  "require",
  "globalThis",
  "Function",
  "WebAssembly",
  // network/DOM escape hatches (shadowed by throwing stubs in the worker too)
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "navigator",
  "importScripts",
])

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$"
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= "0" && c <= "9")
}

/** Keywords after which a `/` starts a regex literal, not division. */
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "case",
  "typeof",
  "instanceof",
  "void",
  "delete",
  "in",
  "of",
  "new",
  "throw",
  "do",
  "else",
  "yield",
  "await",
])

function skipJsString(src: string, start: number, quote: string): { end: number; closed: boolean } {
  let i = start + 1
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return { end: i + 1, closed: true }
    // ' and " literals cannot span lines — a newline (or EOF) means the
    // string is unterminated (template literals may; quote !== "`" here).
    if (quote !== "`" && c === "\n") return { end: i, closed: false }
    i++
  }
  return { end: i, closed: false }
}

function lineOf(src: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === "\n") line++
  }
  return line
}

/**
 * Skip a regex literal starting at src[start] === "/" (caller has already
 * decided it is a regex, not division). Respects escapes and character
 * classes; a newline before the closing "/" ends the skip (let the real
 * parser diagnose it). Returns the index after the literal + flags.
 */
function skipRegexLiteral(src: string, start: number): number {
  let i = start + 1
  let inClass = false
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === "[") inClass = true
    else if (c === "]") inClass = false
    else if (c === "/" && !inClass) {
      i++
      while (i < src.length && isIdentPart(src[i]!)) i++ // flags: /re/gi
      return i
    } else if (c === "\n") {
      return i
    }
    i++
  }
  return i
}

function skipWsAndComments(src: string, start: number): number {
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      i += 2
      while (i < src.length && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i = Math.min(src.length, i + 2)
      continue
    }
    break
  }
  return i
}

function nextMeaningfulChar(src: string, start: number): string {
  const i = skipWsAndComments(src, start)
  return i < src.length ? src[i] : ""
}

/**
 * Validate a user script before spawning a worker.
 *
 * Rejects: ESM `export` / `import` at statement starts (and dynamic `import(`),
 * references to `process` / `require` / `globalThis` / `Function` /
 * `WebAssembly` / `fetch` / `WebSocket` / `XMLHttpRequest` / `navigator` /
 * `importScripts`, and scripts over 512 KB. `while (true) {}` and friends are
 * ALLOWED — worker termination handles runaway scripts (availability boundary).
 *
 * The tokenizer is deliberately simple (strings / template literals / comments
 * are skipped; regex literals are not distinguished) — it must not false-positive
 * on words like "import" inside strings, and it does not need to be perfect.
 */
export function validateScriptSource(src: string): ScriptCheck {
  if (typeof src !== "string") return { ok: false, error: "script must be a string" }
  if (src.trim() === "") return { ok: false, error: "script is empty" }
  if (src.length > MAX_SCRIPT_CHARS) {
    return { ok: false, error: `script too large: ${src.length} chars (max ${MAX_SCRIPT_CHARS})` }
  }

  let i = 0
  const n = src.length
  // "" = start of script, ";" / "}" = statement-terminating token, else "x"
  let prev = ""
  // True when the previous token is a VALUE (identifier, literal, `)`/`]`) —
  // a following `/` is division, not a regex start.
  let prevValue = false

  while (i < n) {
    const c = src[i]
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      i = skipWsAndComments(src, i)
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      i = skipWsAndComments(src, i)
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const str = skipJsString(src, i, c)
      if (!str.closed && c !== "`") {
        return {
          ok: false,
          error:
            `unterminated string literal starting at line ${lineOf(src, i)} — ` +
            `single- and double-quoted strings cannot span lines in a workflow script ` +
            `(use \\n escapes or a template literal)`,
        }
      }
      i = str.end
      prev = "x"
      prevValue = true
      continue
    }
    if (c >= "0" && c <= "9") {
      // Number literal: digits, separators, hex/binary prefixes, exponents.
      while (i < n && (isIdentPart(src[i]!) || src[i] === ".")) i++
      prev = "x"
      prevValue = true
      continue
    }
    if (c === "/" && !prevValue) {
      // Regex-literal position: skip it so a quote inside /[...]/ cannot be
      // mistaken for a string start.
      i = skipRegexLiteral(src, i)
      prev = "x"
      prevValue = true
      continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < n && isIdentPart(src[j])) j++
      const word = src.slice(i, j)
      if (BANNED_IDENTIFIERS.has(word)) {
        return { ok: false, error: `forbidden reference: "${word}" is not allowed in workflow scripts` }
      }
      const atStatementStart = prev === "" || prev === ";" || prev === "}"
      if (word === "import" && (atStatementStart || nextMeaningfulChar(src, j) === "(")) {
        return { ok: false, error: "import/export statements are not allowed — a workflow script is an async function body (plain JS, no ESM)" }
      }
      if (word === "export" && atStatementStart) {
        return { ok: false, error: "import/export statements are not allowed — a workflow script is an async function body (plain JS, no ESM)" }
      }
      prev = "x"
      prevValue = !KEYWORDS_BEFORE_REGEX.has(word)
      i = j
      continue
    }
    prev = c === ";" || c === "}" ? c : "x"
    prevValue = c === ")" || c === "]"
    i++
  }
  return { ok: true }
}
