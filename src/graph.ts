/**
 * Graph-authored workflows (workstream B): a JSON DAG spec that compiles to a
 * plain async-body script for the existing worker runtime. The model (or a
 * human) describes STRUCTURE — nodes and data-flow edges — and the compiler
 * emits the plumbing: null-checking, batching, lane partitioning, phase and
 * label bookkeeping, idempotency keys, and gate branching.
 *
 * Why compile instead of a second runtime: one execution path means caps, the
 * inspector, steering, settle notices, checkpoints, and keyed warm replay all
 * keep working unchanged, and every compiled script is inspectable as the JS
 * the rest of the system already understands.
 *
 * Pure module: no plugin imports, no I/O, deterministic output (stable node
 * order). The emitted script must pass validateScriptSource and use only the
 * injected worker globals.
 */
import type { Json } from "./types.ts"

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

/** Node kinds the compiler understands. */
export type GraphNodeKind =
  | "agent" // one child
  | "fanout" // one child per item of `over`
  | "partition" // split an inventory into token-budgeted lanes (no agent)
  | "merge" // batched merge children over `from` (joined text)
  | "gate" // one QC reviewer; aborts the run on a failed verdict
  | "checkpoint" // persist a named snapshot (no agent)
  | "workflow" // compose a saved workflow (depth 1)

const GRAPH_NODE_KINDS: ReadonlySet<string> = new Set<GraphNodeKind>([
  "agent",
  "fanout",
  "partition",
  "merge",
  "gate",
  "checkpoint",
  "workflow",
])

export type GraphNode = {
  id: string
  kind: GraphNodeKind
  /** agent/fanout/merge/gate: agent id (default: plugin option). */
  agent?: string
  /** agent/fanout/merge: prompt template. {{item}}/{{index}} valid in fanout+merge. */
  prompt?: string
  /** agent/fanout/merge: JSON Schema for structured output. */
  schema?: Json
  /** agent/fanout: short label (default: node id). */
  label?: string
  /** fanout: hard cap on items (default 64). */
  max?: number
  /** partition/merge/gate/checkpoint: source ref, e.g. "$scout.files". */
  from?: string
  /** fanout: source ref yielding the item array, e.g. "$lanes". */
  over?: string
  /** partition: estimated tokens per lane (default 35000). */
  budgetTokens?: number
  /** partition: estimated tokens per input line (default 10). */
  tokensPerLine?: number
  /** merge: batch size (default 8). */
  batches?: number
  /** gate: default prompt template when `prompt` is omitted. */
  onFail?: "abort" | "continue"
  /** checkpoint: value ref, e.g. "$review.length" (optional). */
  value?: string
  /** workflow: saved workflow name. */
  name?: string
  /** workflow: args ref, e.g. "$args.topic" (optional). */
  argsFrom?: string
}

export type GraphSpec = {
  name?: string
  description?: string
  nodes: GraphNode[]
  /** Return-value assembly: output key -> ref ("$report.text"). Default: { result: <last node> }. */
  returns?: Record<string, string>
}

export type GraphCheck = { ok: true; warnings: string[] } | { ok: false; errors: string[]; warnings: string[] }

export type CompiledGraph = {
  script: string
  /** Synthesized run meta (name, phases in execution order, agent preflight). */
  meta: { name?: string; description?: string; phases: string[]; requires: string[] }
}

/**
 * Spec + compiler generation. Stamped into the compiled header comment and
 * into saved graph manifests. Bumping it changes every compiled script, which
 * deliberately invalidates saved-graph trust (fail closed on a compiler change).
 * NOT a required input field: `{ nodes: [...] }` stays valid.
 */
export const GRAPH_SPEC_VERSION = 1

export const MAX_GRAPH_NODES = 64
export const DEFAULT_FANOUT_MAX = 64
export const DEFAULT_LANE_BUDGET_TOKENS = 35000
export const DEFAULT_TOKENS_PER_LINE = 10
export const DEFAULT_MERGE_BATCH = 8

const ID_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/
const RESERVED_IDS = new Set(["args", "item", "index"])
const ALLOWED_NODE_KEYS: Record<GraphNodeKind, ReadonlySet<string>> = {
  agent: new Set(["id", "kind", "agent", "prompt", "schema", "label"]),
  fanout: new Set(["id", "kind", "agent", "prompt", "schema", "label", "max", "over"]),
  partition: new Set(["id", "kind", "from", "budgetTokens", "tokensPerLine"]),
  merge: new Set(["id", "kind", "agent", "prompt", "schema", "from", "batches"]),
  gate: new Set(["id", "kind", "agent", "prompt", "schema", "from", "onFail"]),
  checkpoint: new Set(["id", "kind", "from", "value"]),
  workflow: new Set(["id", "kind", "name", "argsFrom"]),
}

/** Default gate prompt: QC over the merged batch; only concrete defects fail. */
export const DEFAULT_GATE_PROMPT =
  "QC these results as a harsh but fair reviewer. pass=false ONLY for concrete defects: " +
  "empty or unusable output, duplicated items, or off-scope content. Do not fail style opinions.\n" +
  "{{items}}\n" +
  "issues: one line each, only for real defects."

// ---------------------------------------------------------------------------
// Template + ref resolution
// ---------------------------------------------------------------------------

const TEMPLATE_VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

type VarContext = "node" | "item" // item => {{item}}/{{index}} legal

type ResolvedExpr = string // a JS expression over G_args / v_<id> / item / index

/**
 * Resolve one template variable path to a JS expression. Paths:
 *   args[.seg...] | item | index | <nodeId>[.seg...]
 */
function resolveVarPath(
  path: string,
  definedNodes: ReadonlySet<string>,
  context: VarContext,
): ResolvedExpr | undefined {
  const segs = path.split(".").map((s) => s.trim()).filter(Boolean)
  if (segs.length === 0) return undefined
  const head = segs[0]!
  let base: string | undefined
  if (head === "args") base = "G_args"
  else if (head === "item" && context === "item") base = "item"
  else if (head === "index" && context === "item") base = "index"
  else if (head === "items") return undefined // reserved for the gate default prompt
  else if (definedNodes.has(head)) base = `v_${head}`
  if (base === undefined) return undefined
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!
    if (!ID_RE.test(seg)) return undefined
    base += `.${seg}`
  }
  return base
}

/** Compile a prompt template into a JS string expression (JSON-stringifies vars). */
function compileTemplate(
  prompt: string,
  definedNodes: ReadonlySet<string>,
  context: VarContext,
  nodeId: string,
): { expr: string; unresolved: string[] } {
  const unresolved: string[] = []
  const parts: string[] = []
  let last = 0
  TEMPLATE_VAR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TEMPLATE_VAR_RE.exec(prompt)) !== null) {
    const lit = prompt.slice(last, m.index)
    if (lit !== "") parts.push(JSON.stringify(lit))
    const expr = resolveVarPath(m[1]!, definedNodes, context)
    if (expr === undefined) {
      unresolved.push(m[1]!)
      parts.push(JSON.stringify(`{{${m[1]}}}`))
    } else {
      parts.push(`G_str(${expr})`)
    }
    last = m.index + m[0].length
  }
  const tail = prompt.slice(last)
  if (tail !== "") parts.push(JSON.stringify(tail))
  void nodeId
  return { expr: parts.length > 0 ? parts.join(" + ") : '""', unresolved }
}

/** Resolve a ref ("$scout.files", "$args.angles") to a JS expression. */
function resolveRef(
  ref: string,
  definedNodes: ReadonlySet<string>,
): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith("$")) return undefined
  const path = ref.slice(1)
  return resolveVarPath(path, definedNodes, "node")
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function nodeDeps(node: GraphNode): string[] {
  const deps: string[] = []
  for (const ref of [node.from, node.over, node.value, node.argsFrom]) {
    if (typeof ref !== "string" || !ref.startsWith("$")) continue
    const head = ref.slice(1).split(".")[0]!
    if (head === "args") continue
    deps.push(head)
  }
  return deps
}

/** Validate structure, refs, templates, and rough budget. Never throws. */
export function validateGraphSpec(spec: unknown): GraphCheck {
  const errors: string[] = []
  const warnings: string[] = []
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
    return { ok: false, errors: ["graph spec must be a JSON object"], warnings }
  }
  const g = spec as { name?: unknown; description?: unknown; nodes?: unknown; returns?: unknown }
  if (g.name !== undefined && typeof g.name !== "string") errors.push("name must be a string")
  if (g.description !== undefined && typeof g.description !== "string") {
    errors.push("description must be a string")
  }
  if (!Array.isArray(g.nodes)) {
    return { ok: false, errors: [...errors, "nodes must be an array"], warnings }
  }
  if (g.nodes.length === 0) errors.push("nodes must contain at least one node")
  if (g.nodes.length > MAX_GRAPH_NODES) {
    errors.push(`too many nodes: ${g.nodes.length} (max ${MAX_GRAPH_NODES})`)
  }

  const ids = new Set<string>()
  const defined = new Set<string>()
  const depEdges = new Map<string, string[]>()
  let agentCalls = 0

  g.nodes.forEach((raw, i) => {
    const where = `nodes[${i}]`
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`${where}: must be an object`)
      return
    }
    const n = raw as Record<string, unknown>
    const kind = typeof n["kind"] === "string" ? (n["kind"] as GraphNodeKind) : undefined
    if (kind === undefined || !GRAPH_NODE_KINDS.has(kind)) {
      errors.push(`${where}: unknown kind ${JSON.stringify(n["kind"])}`)
      return
    }
    const allowed = ALLOWED_NODE_KEYS[kind]!
    for (const key of Object.keys(n)) {
      if (!allowed.has(key)) errors.push(`${where}: unexpected key "${key}" for kind ${kind}`)
    }
    const id = typeof n["id"] === "string" ? n["id"] : ""
    if (!ID_RE.test(id)) {
      errors.push(`${where}: id must match ${ID_RE.source} (got ${JSON.stringify(id)})`)
      return
    }
    if (RESERVED_IDS.has(id)) errors.push(`${where}: id "${id}" is reserved`)
    if (ids.has(id)) errors.push(`${where}: duplicate id "${id}"`)
    ids.add(id)

    // per-kind required fields
    if (kind === "agent" || kind === "fanout" || kind === "merge") {
      if (typeof n["prompt"] !== "string" || (n["prompt"] as string).trim() === "") {
        errors.push(`${where} (${id}): prompt is required for kind ${kind}`)
      }
    }
    if (kind === "fanout" && typeof n["over"] !== "string") {
      errors.push(`${where} (${id}): over is required (a ref like "$lanes")`)
    }
    if (kind === "partition" && typeof n["from"] !== "string") {
      errors.push(`${where} (${id}): from is required (a ref like "$scout.files")`)
    }
    if (kind === "merge" && typeof n["from"] !== "string") {
      errors.push(`${where} (${id}): from is required (a ref like "$review")`)
    }
    if (kind === "workflow") {
      if (typeof n["name"] !== "string" || (n["name"] as string).trim() === "") {
        errors.push(`${where} (${id}): name is required for kind workflow`)
      }
    }
    if (kind === "checkpoint" && typeof n["from"] !== "string" && typeof n["value"] !== "string") {
      errors.push(`${where} (${id}): checkpoint needs from or value`)
    }

    // refs must point at nodes defined EARLIER (spec order is topo order)
    const deps = nodeDeps(n as unknown as GraphNode)
    for (const dep of deps) {
      if (!defined.has(dep)) {
        errors.push(
          `${where} (${id}): ref "$${dep}" does not match any node defined earlier — edges must flow forward in spec order`,
        )
      }
    }
    depEdges.set(id, deps)

    // templates resolve
    const prompt = typeof n["prompt"] === "string" ? (n["prompt"] as string) : undefined
    if (prompt !== undefined) {
      const context: VarContext = kind === "fanout" || kind === "merge" ? "item" : "node"
      const { unresolved } = compileTemplate(prompt, defined, context, id)
      for (const u of unresolved) {
        errors.push(`${where} (${id}): template {{${u}}} does not resolve (defined so far: args${[...defined].map((d) => ", " + d).join("")})`)
      }
    }
    if (kind === "gate") {
      const from = n["from"]
      if (typeof from !== "string") errors.push(`${where} (${id}): gate needs from (a ref like "$review")`)
    }
    if (kind === "fanout") {
      const max = n["max"]
      if (max !== undefined && (typeof max !== "number" || max < 1 || max > 500)) {
        errors.push(`${where} (${id}): max must be a number between 1 and 500`)
      }
      if (max === undefined) {
        warnings.push(`fanout ${id}: no max set — compiled with the default cap ${DEFAULT_FANOUT_MAX}`)
      }
      agentCalls += typeof max === "number" ? max : DEFAULT_FANOUT_MAX
    }
    if (kind === "agent" || kind === "merge" || kind === "gate") agentCalls += 1
    defined.add(id)
  })

  // returns refs resolve against all nodes
  if (g.returns !== undefined) {
    if (g.returns === null || typeof g.returns !== "object" || Array.isArray(g.returns)) {
      errors.push("returns must be an object of { outputKey: ref }")
    } else {
      for (const [key, ref] of Object.entries(g.returns as Record<string, unknown>)) {
        if (!ID_RE.test(key)) errors.push(`returns key ${JSON.stringify(key)} must match ${ID_RE.source}`)
        if (typeof ref !== "string" || resolveRef(ref, ids) === undefined) {
          errors.push(`returns.${key}: ref ${JSON.stringify(ref)} does not resolve`)
        }
      }
    }
  }

  // budget warnings (wall clock is the binding constraint)
  if (agentCalls > 100) {
    warnings.push(`estimated agent calls ≈ ${agentCalls} — waves × ~5-10 min per child must fit the run timeout`)
  }

  return errors.length > 0 ? { ok: false, errors, warnings } : { ok: true, warnings }
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

/**
 * Spec order IS the topological order (validated forward-only). Levels group
 * nodes whose dependencies are all satisfied by the previous levels; a level
 * with >1 agent-ish node compiles to one parallel() wave.
 */
export function graphLevels(spec: GraphSpec): GraphNode[][] {
  const defined = new Set<string>()
  const levels: GraphNode[][] = []
  let remaining = [...spec.nodes]
  while (remaining.length > 0) {
    const wave = remaining.filter((n) => nodeDeps(n).every((d) => defined.has(d)))
    if (wave.length === 0) break // unreachable after validation; defensive
    for (const n of wave) defined.add(n.id)
    levels.push(wave)
    remaining = remaining.filter((n) => !wave.includes(n))
  }
  if (remaining.length > 0) levels.push(remaining)
  return levels
}

const AGENTISH: ReadonlySet<string> = new Set(["agent", "fanout", "merge", "gate", "workflow"])

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

const GATE_SCHEMA: Json = {
  type: "object",
  required: ["pass", "action"],
  properties: {
    pass: { type: "boolean" },
    action: { type: "string", enum: ["continue", "abort"] },
    issues: { type: "array", items: { type: "string" } },
  },
}

function jsonLiteral(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function promptExpr(node: GraphNode, defined: ReadonlySet<string>, context: VarContext): string {
  let prompt = node.prompt
  if (prompt === undefined && node.kind === "gate") {
    const fromPath = (node.from ?? "$args").slice(1)
    prompt = DEFAULT_GATE_PROMPT.replace("{{items}}", `{{${fromPath}}}`)
  }
  return compileTemplate(prompt ?? "", defined, context, node.id).expr
}

/** The `agent(...)` call expression for a single-child node (no assignment). */
function singleCallExpr(node: GraphNode, defined: ReadonlySet<string>): string {
  const parts: string[] = []
  if (node.agent !== undefined) parts.push(`agent: ${jsonLiteral(node.agent)}`)
  parts.push(`phase: ${jsonLiteral(node.id)}`)
  parts.push(`label: ${jsonLiteral(node.label ?? node.id)}`)
  parts.push(`key: ${jsonLiteral(node.id)}`)
  if (node.kind === "gate") {
    parts.push(`schema: ${JSON.stringify(GATE_SCHEMA)}`)
  } else if (node.schema !== undefined) {
    parts.push(`schema: ${JSON.stringify(node.schema)}`)
  }
  return `agent(${promptExpr(node, defined, "node")}, { ${parts.join(", ")} })`
}

/** The full `parallel(...)` expression for a fanout or batched merge. */
function parallelCallExpr(node: GraphNode, defined: ReadonlySet<string>, refExpr: string, batched: boolean): string {
  const perItem = (): string => {
    const parts: string[] = []
    if (node.agent !== undefined) parts.push(`agent: ${jsonLiteral(node.agent)}`)
    parts.push(`phase: ${jsonLiteral(node.id)}`)
    const base = node.label ?? node.id
    parts.push(`label: ${jsonLiteral(base + ":")} + index`)
    parts.push(`key: ${jsonLiteral(node.id + (batched ? ":b" : ":"))} + index`)
    if (node.schema !== undefined) parts.push(`schema: ${JSON.stringify(node.schema)}`)
    return `agent(${promptExpr(node, defined, "item")}, { ${parts.join(", ")} })`
  }
  if (batched) {
    // refExpr is already the batched list (G_batches_<id>) — no re-batching
    return `parallel(${refExpr}.map((item, index) => () => ${perItem()}))`
  }
  const max = node.max ?? DEFAULT_FANOUT_MAX
  return `parallel(G_list(${refExpr}).slice(0, ${max}).map((item, index) => () => ${perItem()}))`
}

/**
 * Compile a validated spec into an async-body script. Deterministic; built
 * from the fixed vocabulary + validated identifiers only. Throws only on
 * internal invariant violations (call validateGraphSpec first).
 */
export function compileGraphSpec(spec: GraphSpec): CompiledGraph {
  const defined = new Set<string>()
  const lines: string[] = []
  lines.push(
    // Stable on purpose: the compiled script is the TRUST digest basis for saved
    // graph workflows, so nothing that does not change execution (a rename, for
    // example) may appear here. Spec identity lives in the manifest, not the header.
    `// compiled from a graph spec (opencode-ultracode graph v${GRAPH_SPEC_VERSION}) — regenerate from the spec, do not hand-edit`,
  )
  lines.push(`const G_args = args && typeof args === "object" && !Array.isArray(args) ? args : {}`)
  lines.push(`const G_str = (x) => JSON.stringify(x === undefined ? null : x)`)
  lines.push(`const G_list = (x) => Array.isArray(x) ? x : (x === null || x === undefined ? [] : [x])`)
  lines.push(`const G_batch_map = (x, n) => { const src = G_list(x); const out = []; for (let i = 0; i < src.length; i += Math.max(1, n)) out.push(src.slice(i, i + Math.max(1, n))); return out }`)

  const phases: string[] = []
  const requires = new Set<string>()

  /** Prelude lines (before the call site — e.g. merge's batch list const). */
  const emitPrelude = (node: GraphNode): void => {
    if (node.kind === "merge") {
      const refExpr = resolveRef(node.from ?? "$args", defined) ?? "[]"
      lines.push(`const G_batches_${node.id} = G_batch_map(${refExpr}, ${node.batches ?? DEFAULT_MERGE_BATCH})`)
    }
  }

  /** The call line only — `mode: "thunk"` emits a bare arrow for a parallel wave. */
  const emitNode = (node: GraphNode, mode: "await" | "thunk"): void => {
    if (node.agent !== undefined) requires.add(node.agent)

    if (node.kind === "workflow") {
      const argsExpr = node.argsFrom !== undefined ? resolveRef(node.argsFrom, defined) : undefined
      const call = `workflow(${jsonLiteral(node.name ?? "")}${argsExpr !== undefined ? `, ${argsExpr}` : ""})`
      lines.push(mode === "thunk" ? `  () => ${call},` : `const r_${node.id} = await ${call}`)
      if (mode === "await") lines.push(`const v_${node.id} = r_${node.id} ?? null`)
      return
    }

    if (node.kind === "fanout") {
      const refExpr = resolveRef(node.over ?? "$args", defined) ?? "[]"
      const call = parallelCallExpr(node, defined, refExpr, false)
      lines.push(mode === "thunk" ? `  () => ${call},` : `const r_${node.id} = await ${call}`)
      if (mode === "await") emitParallelPost(node)
      return
    }

    if (node.kind === "merge") {
      const call = parallelCallExpr(node, defined, `G_batches_${node.id}`, true)
      lines.push(mode === "thunk" ? `  () => ${call},` : `const r_${node.id} = await ${call}`)
      if (mode === "await") emitParallelPost(node)
      return
    }

    // agent / gate
    const call = singleCallExpr(node, defined)
    lines.push(mode === "thunk" ? `  () => ${call},` : `const r_${node.id} = await ${call}`)
    if (mode === "await") {
      if (node.kind === "gate") emitGatePost(node)
      else emitPrimary(node)
    }
  }

  const emitPrimary = (node: GraphNode): void => {
    if (node.schema !== undefined) {
      lines.push(`const v_${node.id} = r_${node.id} && r_${node.id}.data !== undefined ? r_${node.id}.data : (r_${node.id} ? r_${node.id}.text : null)`)
    } else {
      lines.push(`const v_${node.id} = r_${node.id} ? r_${node.id}.text : null`)
    }
  }

  const emitParallelPost = (node: GraphNode): void => {
    if (node.kind === "fanout") {
      lines.push(`const v_${node.id} = (r_${node.id} || []).filter(Boolean).map((r) => r.data !== undefined ? r.data : r.text)`)
      lines.push(`if ((r_${node.id} || []).length > 0 && v_${node.id}.length === 0) throw new Error("fanout ${node.id}: every child failed — check the prompt or agent availability")`)
      return
    }
    // merge
    lines.push(`const G_ok_${node.id} = (r_${node.id} || []).filter(Boolean)`)
    lines.push(`if (G_batches_${node.id}.length > 0 && G_ok_${node.id}.length === 0) throw new Error("merge ${node.id}: every batch failed")`)
    if (node.schema !== undefined) {
      lines.push(`const v_${node.id} = G_ok_${node.id}.map((r) => r.data).filter((d) => d !== undefined)`)
    } else {
      lines.push(`const v_${node.id} = G_ok_${node.id}.map((r) => r.text).join("\\n---\\n")`)
    }
  }

  const emitGatePost = (node: GraphNode): void => {
    lines.push(`if (r_${node.id} && r_${node.id}.data) checkpoint(${jsonLiteral(node.id)}, { pass: r_${node.id}.data.pass, issues: r_${node.id}.data.issues || [] })`)
    if ((node.onFail ?? "abort") === "abort") {
      lines.push(`if (r_${node.id} && r_${node.id}.data && r_${node.id}.data.pass === false && r_${node.id}.data.action === "abort") throw new Error("gate ${node.id} rejected the batch: " + JSON.stringify(r_${node.id}.data.issues || []))`)
    }
    lines.push(`const v_${node.id} = r_${node.id} && r_${node.id}.data ? r_${node.id}.data : null`)
  }

  const emitSyncNode = (node: GraphNode): void => {
    if (node.kind === "partition") {
      const budget = node.budgetTokens ?? DEFAULT_LANE_BUDGET_TOKENS
      const perLine = node.tokensPerLine ?? DEFAULT_TOKENS_PER_LINE
      const input = resolveRef(node.from ?? "$args", defined) ?? "[]"
      lines.push(`// partition ${node.id}: lanes under ~${budget} tokens (${perLine} tokens/line)`)
      lines.push(`const G_src_${node.id} = G_list(${input})`)
      lines.push(`const G_est_${node.id} = (it) => Math.max(1, Math.round((Number(it && it.lines) || 1) * ${perLine}))`)
      lines.push(`const v_${node.id} = []`)
      lines.push(`let G_cur_${node.id} = { items: [], tokens: 0 }`)
      lines.push(`for (const G_it of G_src_${node.id}) {`)
      lines.push(`  if (G_cur_${node.id}.items.length > 0 && G_cur_${node.id}.tokens + G_est_${node.id}(G_it) > ${budget}) { v_${node.id}.push(G_cur_${node.id}); G_cur_${node.id} = { items: [], tokens: 0 } }`)
      lines.push(`  G_cur_${node.id}.items.push(G_it); G_cur_${node.id}.tokens += G_est_${node.id}(G_it)`)
      lines.push(`}`)
      lines.push(`if (G_cur_${node.id}.items.length > 0) v_${node.id}.push(G_cur_${node.id})`)
      lines.push(`progress("partition ${node.id}: " + v_${node.id}.length + " lanes from " + G_src_${node.id}.length + " items")`)
      return
    }
    if (node.kind === "checkpoint") {
      const valueExpr =
        node.value !== undefined ? resolveRef(node.value, defined) : node.from !== undefined ? resolveRef(node.from, defined) : undefined
      lines.push(`checkpoint(${jsonLiteral(node.id)}, ${valueExpr ?? "null"})`)
    }
  }

  const levels = graphLevels(spec)
  levels.forEach((wave, li) => {
    // synchronous nodes (partition / checkpoint) run first, in spec order
    for (const node of wave) {
      if (!AGENTISH.has(node.kind)) emitSyncNode(node)
    }
    const agentish = wave.filter((n) => AGENTISH.has(n.kind))
    if (agentish.length === 0) {
      for (const n of wave) defined.add(n.id)
      return
    }
    if (agentish.length === 1) {
      const node = agentish[0]!
      lines.push(`phase(${jsonLiteral(node.id)})`)
      phases.push(node.id)
      emitPrelude(node)
      emitNode(node, "await")
      defined.add(node.id)
      return
    }
    lines.push(`phase(${jsonLiteral("wave" + (li + 1))})`)
    lines.push(`progress("wave ${li + 1}: ${agentish.length} parallel nodes")`)
    for (const node of agentish) emitPrelude(node)
    lines.push(`const [${agentish.map((n) => `r_${n.id}`).join(", ")}] = await parallel([`)
    for (const node of agentish) emitNode(node, "thunk")
    lines.push(`])`)
    for (const node of agentish) {
      defined.add(node.id)
      if (node.kind === "fanout" || node.kind === "merge") emitParallelPost(node)
      else if (node.kind === "gate") emitGatePost(node)
      else if (node.kind === "workflow") lines.push(`const v_${node.id} = r_${node.id} ?? null`)
      else emitPrimary(node)
      phases.push(node.id)
    }
  })

  // Return assembly
  const allIds = new Set(spec.nodes.map((n) => n.id))
  const lastNode = spec.nodes[spec.nodes.length - 1]
  const returns = spec.returns ?? (lastNode ? { result: `$${lastNode.id}` } : {})
  const entries = Object.entries(returns).map(
    ([key, ref]) => `${JSON.stringify(key)}: ${resolveRef(ref, allIds) ?? "null"}`,
  )
  lines.push(`return {`)
  for (const e of entries) lines.push(`  ${e},`)
  lines.push(`}`)

  const meta: { name?: string; description?: string; phases: string[]; requires: string[] } = {
    phases,
    requires: [...requires].sort(),
  }
  if (spec.name !== undefined) meta.name = spec.name
  if (spec.description !== undefined) meta.description = spec.description
  return { script: lines.join("\n"), meta }
}

// ---------------------------------------------------------------------------
// Rendering (pure; `/ultracode graph` in command.ts consumes both)
// ---------------------------------------------------------------------------

/** Mermaid flowchart of the DAG (data-flow edges only). */
export function graphToMermaid(spec: GraphSpec): string {
  const rows: string[] = ["graph TD"]
  for (const n of spec.nodes) {
    const label = `${n.id} · ${n.kind}`
    rows.push(`  ${n.id}["${label.replace(/"/g, "'")}"]`)
  }
  for (const n of spec.nodes) {
    for (const dep of nodeDeps(n)) {
      rows.push(`  ${dep} --> ${n.id}`)
    }
  }
  return rows.join("\n")
}

/** ASCII wave listing: execution order with parallel groups marked. */
export function graphToAscii(spec: GraphSpec): string {
  const levels = graphLevels(spec)
  const rows: string[] = []
  levels.forEach((wave, i) => {
    const items = wave.map((n) => `${n.id}(${n.kind})`).join("  +  ")
    rows.push(`wave ${i + 1}${wave.length > 1 ? " [parallel]" : ""}: ${items}`)
  })
  return rows.join("\n")
}

// ---------------------------------------------------------------------------
// Persistence helpers (saved graph workflows, run-record provenance)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const next = canonicalize(source[key])
      if (next !== undefined) out[key] = next
    }
    return out
  }
  return value
}

/**
 * Canonical JSON of a spec: object keys sorted recursively, no whitespace.
 * Two semantically identical specs written with different key order produce the
 * same string, so this is safe as a comparison basis (saved-graph rerun checks,
 * dedup). It is NOT the trust digest basis — that is the compiled script, the
 * thing that actually executes.
 */
export function canonicalGraphSpec(spec: unknown): string {
  return JSON.stringify(canonicalize(spec)) ?? "null"
}

/** Node count of a persisted spec (unknown/invalid shapes count 0). */
export function graphNodeCount(spec: unknown): number {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return 0
  const nodes = (spec as { nodes?: unknown }).nodes
  return Array.isArray(nodes) ? nodes.length : 0
}

/** Node ids in spec order (execution order) — used by the catalog and `/ultracode graph`. */
export function graphNodeIds(spec: unknown): string[] {
  if (spec === null || typeof spec !== "object" || Array.isArray(spec)) return []
  const nodes = (spec as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return []
  const ids: string[] = []
  for (const n of nodes) {
    if (n !== null && typeof n === "object" && !Array.isArray(n)) {
      const id = (n as { id?: unknown }).id
      if (typeof id === "string") ids.push(id)
    }
  }
  return ids
}
