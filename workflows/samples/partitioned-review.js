// partitioned-review: material-budgeted review of a large repo area.
// Demonstrates the sizing contract from the Ultracode skill:
//   scout → script-side partition (~LANE_BUDGET of source per lane) →
//   arithmetic coverage assertion → lanes report {covered, overflow} →
//   bounded gap-fill for overflow lanes → batched merge (reports only).
// Tool input: { workflow: "partitioned-review", args: { area: "src", budget?: 35000, maxLanes?: 12 } }
// Agents (stock): explore for the scout and lanes, general for merge.

const input = args && typeof args === "object" ? args : {}
const area = typeof input.area === "string" && input.area.trim() ? input.area.trim() : "src"
// Budget is in ESTIMATED TOKENS of source (~10 tokens per line); the scout
// reports line counts, so convert at partition time.
const TOKENS_PER_LINE = 10
const LANE_BUDGET = Math.max(5000, Math.trunc(Number(input.budget) || 35000))
const MAX_LANES = Math.min(24, Math.max(2, Math.trunc(Number(input.maxLanes) || 12)))

const SCOUT = {
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
const REPORT = {
  type: "object",
  required: ["summary", "covered", "overflow"],
  properties: {
    summary: { type: "string" },
    covered: { type: "array", items: { type: "string" } },
    overflow: { type: "array", items: { type: "string" } },
  },
}

function partition(files) {
  const est = (f) => Math.max(1, Math.round((f.lines || 0) * TOKENS_PER_LINE))
  const lanes = []
  let cur = { files: [], lines: 0 }
  for (const f of files) {
    if (cur.files.length > 0 && cur.lines + est(f) > LANE_BUDGET) {
      lanes.push(cur)
      cur = { files: [], lines: 0 }
    }
    cur.files.push(f)
    cur.lines += est(f)
  }
  if (cur.files.length > 0) lanes.push(cur)
  return lanes
}

function lanePrompt(laneFiles) {
  return (
    "Review exactly these files for defects and risks (grep + ranged reads only; never read a " +
    "file whole when it is over ~500 lines; never echo file contents back):\n" +
    JSON.stringify(laneFiles) +
    "\nReturn: summary (findings with file + line refs), covered (paths fully reviewed), and " +
    "overflow (paths you could NOT review within this budget). Output is the schema JSON only."
  )
}

phase("scout")
progress("scouting " + area + " (inventory only — no file contents)")
const scout = await agent(
  "Inventory the repo area " + area + ". For each file return path, line count, and a one-line " +
    "purpose. Use glob, grep, and wc-style listing — do NOT read file contents. Cap at 400 files.",
  { agent: "explore", phase: "scout", label: "scout", schema: SCOUT },
)
const inventory = (scout && scout.data && scout.data.files) || []
if (inventory.length === 0) throw new Error("scout returned no files for area " + area)

phase("lanes")
let lanes = partition(inventory)
if (lanes.length > MAX_LANES) {
  // Wide-not-deep guard: merge smallest adjacent lanes until within budget
  // (coarser lanes beat blowing the wall clock on wave count).
  while (lanes.length > MAX_LANES) {
    lanes.sort((a, b) => a.lines - b.lines)
    const a = lanes.shift()
    const b = lanes.shift()
    lanes.push({ files: [...a.files, ...b.files], lines: a.lines + b.lines })
  }
}
progress(lanes.length + " lanes · " + inventory.length + " files · budget ~" + LANE_BUDGET + " tokens (≈" + Math.round(LANE_BUDGET / TOKENS_PER_LINE) + " lines) per lane")

// Arithmetic coverage assertion: every inventoried file is assigned to >= 1 lane.
const assigned = new Set()
for (const lane of lanes) for (const f of lane.files) assigned.add(f.path)
const unassigned = inventory.filter((f) => !assigned.has(f.path)).map((f) => f.path)
if (unassigned.length > 0) {
  throw new Error("coverage assertion failed — unassigned: " + unassigned.slice(0, 10).join(", "))
}

phase("cross")
// Cross-cutting lane (read-only, runs alongside the lanes): owns the seams a
// file partition cannot see — shared symbols crossing lane boundaries.
const crossPromise = agent(
  "Cross-cutting pass over " + area + ": grep for seams a file-by-file review misses — symbols " +
    "imported across many files, call sites that span modules, name collisions. Grep only; do NOT " +
    "read whole files. Return summary, covered greps, overflow.",
  { agent: "explore", phase: "cross", label: "cross", schema: REPORT },
)

let open = lanes
const summaries = []
for (let pass = 1; pass <= 2 && open.length > 0; pass++) {
  const reports = await parallel(
    open.map((lane, i) => () =>
      agent(lanePrompt(lane.files), {
        agent: "explore",
        phase: "lanes" + (pass > 1 ? "-gap" + pass : ""),
        label: (pass > 1 ? "gap" + pass + "-" : "lane") + (i + 1),
        schema: REPORT,
      }),
    ),
  )
  const next = []
  reports.forEach((r, i) => {
    if (!r || !r.data) {
      // Failed lane: its files flow into the bounded gap-fill pass instead of
      // silently vanishing from coverage.
      for (const sub of partition(open[i].files)) next.push(sub)
      return
    }
    summaries.push({ lane: open[i].files.map((f) => f.path), summary: r.data.summary })
    const overflowFiles = inventory.filter((f) => (r.data.overflow || []).includes(f.path))
    if (overflowFiles.length > 0) {
      // Bounded gap-fill: subdivide ONLY what the lane could not cover.
      for (const sub of partition(overflowFiles)) next.push(sub)
    }
  })
  open = next
}

const cross = await crossPromise
if (cross && cross.data) summaries.push({ lane: ["(cross-cutting)"], summary: cross.data.summary })

phase("merge")
// Batched merge: reports only, ~8 per merge child — never source material.
const batches = []
for (let i = 0; i < summaries.length; i += 8) batches.push(summaries.slice(i, i + 8))
const drafts = await parallel(
  batches.map((batch, bi) => () =>
    agent(
      "Merge these lane review reports into one deduplicated section list, worst findings first. " +
        "Each report lists the files it covered — keep file references so findings stay actionable. " +
        "Reports only — do NOT read source files.\n" +
        JSON.stringify(batch.map((s) => ({ files: s.lane.slice(0, 10), summary: s.summary }))),
      { agent: "general", phase: "merge", label: "merge" + (bi + 1) },
    ),
  ),
)
const report = drafts.filter(Boolean).map((d) => d.text).join("\n---\n")

return {
  report: report || "(no lane reports survived)",
  stats: {
    area: area,
    files: inventory.length,
    lanes: lanes.length,
    laneBudget: LANE_BUDGET,
    reports: summaries.length,
    mergeBatches: batches.length,
  },
}
