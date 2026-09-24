import assert from "node:assert/strict"
import { test } from "node:test"
import { ModelRouter, parseModelRouting } from "../src/model-routing.ts"

const profile = parseModelRouting({
  timezone: "Asia/Hong_Kong",
  roles: { reviewer: "strong" },
  quotaIDs: { openai: "openai", xai: "xai", "alibaba-token-plan": "alibaba-token-plan" },
  tiers: {
    strong: {
      plans: [
        [{ model: "alibaba-token-plan/qwen3.8-max", hours: [22, 8], reservePercent: 20 }],
        [{ model: "xai/grok-4.7#high", reservePercent: 5 }, { model: "openai/gpt-6-sol#high", reservePercent: 15 }],
      ],
      payg: [[{ model: "xiaomi/mimo-v2.6-pro" }]],
    },
  },
})

test("night plan takes priority, daytime plans rotate, PAYG last", async () => {
  const router = new ModelRouter(profile)
  const quota = async () => ({ remainingPercent: 50 })
  const daytime = new Date("2026-09-23T06:00:00Z") // 14:00 HKT
  assert.equal((await router.select({ role: "reviewer", now: daytime, quota })).model?.providerID, "xai")
  assert.equal((await router.select({ role: "reviewer", now: daytime, quota })).model?.providerID, "openai")
  const night = new Date("2026-09-23T16:00:00Z") // midnight HKT
  assert.equal((await router.select({ role: "reviewer", now: night, quota })).model?.providerID, "alibaba-token-plan")
  const exhausted = async () => ({ remainingPercent: 2 })
  assert.equal((await router.select({ role: "reviewer", now: daytime, quota: exhausted })).model?.providerID, "xiaomi")
})

test("unknown quotas allow reserved plans by default; explicit false fails closed; exhausted plans never run", async () => {
  const router = new ModelRouter(profile)
  const night = new Date("2026-09-23T16:00:00Z") // midnight HKT
  // Omitted allowUnknownQuota (default since 2026-09-25): a missing feed is
  // not evidence of exhaustion — reserved plans stay eligible.
  assert.equal((await router.select({ role: "reviewer", now: night })).model?.providerID, "alibaba-token-plan")
  // Explicit false keeps the old fail-closed contract for missing feeds.
  const strict = new ModelRouter(parseModelRouting({
    timezone: "Asia/Hong_Kong",
    roles: { reviewer: "strong" },
    quotaIDs: { openai: "openai", xai: "xai", "alibaba-token-plan": "alibaba-token-plan" },
    allowUnknownQuota: false,
    tiers: {
      strong: {
        plans: [
          [{ model: "alibaba-token-plan/qwen3.8-max", hours: [22, 8], reservePercent: 20 }],
          [{ model: "xai/grok-4.7#high", reservePercent: 5 }, { model: "openai/gpt-6-sol#high", reservePercent: 15 }],
        ],
        payg: [[{ model: "xiaomi/mimo-v2.6-pro" }]],
      },
    },
  }))
  assert.equal((await strict.select({ role: "reviewer", now: night })).model?.providerID, "xiaomi")
  await assert.rejects(strict.select({ role: "reviewer", disabled: new Set(["xiaomi"]) }), /no eligible strong model/)
  // Hard stop: a feed reporting zero remaining skips even an UNRESERVED plan
  // — "100% gone" is never tried — while an unreserved PAYG model is blind
  // to quota and stays eligible.
  const unreserved = new ModelRouter(parseModelRouting({
    timezone: "Asia/Hong_Kong",
    roles: { reviewer: "strong" },
    quotaIDs: { xai: "xai" },
    tiers: {
      strong: {
        plans: [[{ model: "xai/grok-4.7#high" }]],
        payg: [[{ model: "xiaomi/mimo-v2.6-pro" }]],
      },
    },
  }))
  const dead = async () => ({ remainingPercent: 0 })
  const decision = await unreserved.select({ role: "reviewer", now: night, quota: dead })
  assert.equal(decision.model?.providerID, "xiaomi")
  assert.ok(decision.skipped.some((s) => s.includes("quota exhausted")), decision.skipped.join("; "))
})

test("routing validation rejects unsafe hours and unknown role tiers", () => {
  assert.throws(() => parseModelRouting({ timezone: "Asia/Hong_Kong", roles: { reviewer: "missing" }, tiers: {} }), /routing.roles/)
  assert.throws(() => parseModelRouting({ timezone: "Asia/Hong_Kong", roles: {}, tiers: {
    strong: { plans: [[{ model: "xiaomi/mimo-v2.6-pro", hours: [22, 27] }]], payg: [] },
  } }), /invalid routing hours/)
})

test("DeepSeek weekday peak windows are blocked, weekends are eligible", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "Asia/Hong_Kong", roles: { explore: "fast" }, tiers: {
    fast: { plans: [], payg: [[{ model: "deepseek/deepseek-flash", blockedWeekdayHours: [[9, 12], [14, 18]] }], [{ model: "xiaomi/mimo-v2.6-flash" }]] },
  } }))
  assert.equal((await router.select({ role: "explore", now: new Date("2026-09-23T02:00:00Z") })).model?.providerID, "xiaomi")
  assert.equal((await router.select({ role: "explore", now: new Date("2026-09-26T02:00:00Z") })).model?.providerID, "deepseek")
})

test("a plan candidate can draw from a named pool independent of provider", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "standard" }, tiers: {
    standard: { plans: [[{ model: "provider/model", capacityPool: "shared-monthly", reservePercent: 15 }]], payg: [[{ model: "provider/paid" }]] },
  } }))
  assert.equal((await router.select({ role: "general", quota: async (id) => {
    assert.equal(id, "shared-monthly")
    return { remainingPercent: 14 }
  } })).model?.id, "paid")
})

// ---------------------------------------------------------------------------
// Weighted selection (selection: "weighted")
// ---------------------------------------------------------------------------

const weighted = (tier: unknown, roles: Record<string, string> = { general: "strong" }) =>
  parseModelRouting({ timezone: "UTC", roles, tiers: { strong: tier } })

test("weighted selection matches configured proportions exactly over a cycle", async () => {
  const router = new ModelRouter(weighted({ selection: "weighted", plans: [[
    { model: "p/a", weight: 15 }, { model: "p/b", weight: 6 }, { model: "p/c", weight: 2 },
  ]], payg: [] }))
  const counts: Record<string, number> = { a: 0, b: 0, c: 0 }
  for (let i = 0; i < 23; i++) counts[(await router.select({ role: "general" })).model!.id]++
  assert.deepEqual({ ...counts }, { a: 15, b: 6, c: 2 })
  // Long-run proportions stay exact at cycle multiples.
  for (let i = 0; i < 46; i++) counts[(await router.select({ role: "general" })).model!.id]++
  assert.deepEqual({ ...counts }, { a: 45, b: 18, c: 6 })
})

test("weighted decision exposes reason, pool and percentages", async () => {
  const router = new ModelRouter(weighted({ selection: "weighted", plans: [[
    { model: "p/a", weight: 4 }, { model: "p/b", weight: 2 },
  ]], payg: [] }))
  const decision = await router.select({ role: "general" })
  assert.equal(decision.model!.id, "a")
  assert.equal(decision.reason, "weighted strong: p/a (w4 of 6)")
  assert.deepEqual(decision.pool, [
    { model: "p/a", weight: 4, percent: (4 / 6) * 100 },
    { model: "p/b", weight: 2, percent: (2 / 6) * 100 },
  ])
})

test("weighted main pool joins PAYG with mainWeight; mainWeight-less PAYG waits for fallback", async () => {
  const router = new ModelRouter(weighted({ selection: "weighted",
    plans: [[{ model: "plan/a", hours: [22, 8], weight: 5 }]],
    payg: [[{ model: "payg/pm", hours: [22, 8], mainWeight: 1 }], [{ model: "payg/pf", weight: 1 }]] }))
  const night = new Date("2026-09-23T02:00:00Z") // 02:00 UTC, inside [22, 8)
  const day = new Date("2026-09-23T12:00:00Z")   // 12:00 UTC, outside
  const counts: Record<string, number> = {}
  for (let i = 0; i < 60; i++) { const id = (await router.select({ role: "general", now: night })).model!.id; counts[id] = (counts[id] ?? 0) + 1 }
  assert.equal(counts["pf"], undefined) // never while any plan candidate is eligible
  assert.equal(counts["a"], 50) // mainWeight PAYG joins the MAIN draw at 5:1, exactly
  assert.equal(counts["pm"], 10)
  const fallback = await router.select({ role: "general", now: day })
  assert.equal(fallback.model!.id, "pf") // plans gated -> PAYG-only fallback pool
  assert.equal(fallback.reason, "weighted strong: payg/pf (w1 of 1)")
})

test("grounded candidates accrue no credit and produce no burst on re-entry", async () => {
  const router = new ModelRouter(weighted({ selection: "weighted", plans: [[
    { model: "p/a", weight: 2 }, { model: "p/b", weight: 2 }, { model: "p/c", hours: [22, 8], weight: 3 },
  ]], payg: [] }))
  const night = new Date("2026-09-23T02:00:00Z")
  const day = new Date("2026-09-23T12:00:00Z")
  // Let the heavy night candidate build credit while all three are eligible.
  for (let i = 0; i < 3; i++) await router.select({ role: "general", now: night })
  // Ground it during the day; the rebase must zero its stale credit.
  await router.select({ role: "general", now: day })
  const sequence: string[] = []
  for (let i = 0; i < 4; i++) sequence.push((await router.select({ role: "general", now: night })).model!.id)
  // Without the rebase its stale credit would have won the first draw back (no delayed burst).
  assert.deepEqual(sequence, ["b", "c", "a", "c"])
})

test("fallback chains resolve and report the chain in the reason", async () => {
  const profile = parseModelRouting({ timezone: "UTC", roles: { general: "frontier" }, tiers: {
    frontier: { selection: "weighted", plans: [[{ model: "plan/x", hours: [22, 8], weight: 3 }]], payg: [], fallback: "strong" },
    strong: { plans: [[{ model: "strong/a" }]], payg: [] },
  } })
  const router = new ModelRouter(profile)
  const decision = await router.select({ role: "general", now: new Date("2026-09-23T12:00:00Z") })
  assert.equal(decision.model!.providerID, "strong")
  assert.equal(decision.reason, "frontier exhausted -> strong: plan strong: strong/a")
  assert.deepEqual(decision.fallbackChain, ["frontier", "strong"])
  // The gated tier's skip reasons survive the successful hop.
  assert.deepEqual(decision.skipped, ["plan/x: outside allowed hours"])
})

test("a fallback chain can span more than one hop", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "frontier" }, tiers: {
    frontier: { selection: "weighted", plans: [[{ model: "plan/x", hours: [22, 8] }]], payg: [], fallback: "strong" },
    strong: { selection: "weighted", plans: [[{ model: "plan/y", hours: [22, 8] }]], payg: [], fallback: "standard" },
    standard: { selection: "weighted", plans: [[{ model: "plan/z" }]], payg: [] },
  } }))
  const decision = await router.select({ role: "general", now: new Date("2026-09-23T12:00:00Z") })
  assert.equal(decision.model!.id, "z")
  assert.match(decision.reason, /^frontier exhausted -> strong: strong exhausted -> standard: weighted standard: plan\/z/)
  assert.deepEqual(decision.fallbackChain, ["frontier", "strong", "standard"])
})

test("a fallback hop keeps the originating tier's skip reasons", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "frontier" }, tiers: {
    frontier: { selection: "weighted", fallback: "strong", plans: [
      [{ model: "plan/night", hours: [22, 8] }],
      [{ model: "plan/reserved", reservePercent: 50 }],
    ], payg: [[{ model: "payg/p", reservePercent: 90 }]] },
    strong: { plans: [[{ model: "strong/a" }]], payg: [] },
  } }))
  const decision = await router.select({ role: "general", now: new Date("2026-09-23T12:00:00Z"), quota: async () => ({ remainingPercent: 10 }) })
  assert.equal(decision.model!.id, "a")
  assert.equal(decision.reason, "frontier exhausted -> strong: plan strong: strong/a")
  // Hours and quota-reserve causes are all preserved across the successful hop.
  assert.deepEqual(decision.skipped, [
    "plan/night: outside allowed hours",
    "plan/reserved: quota reserve",
    "payg/p: quota reserve",
  ])
})

test("a gated tier whose fallback is empty rejects instead of degrading to the pin", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "frontier" }, tiers: {
    frontier: { selection: "weighted", plans: [[{ model: "plan/x", hours: [22, 8] }]], payg: [], fallback: "lite" },
    lite: { plans: [], payg: [] },
  } }))
  const noon = new Date("2026-09-23T12:00:00Z")
  await assert.rejects(router.select({ role: "general", now: noon }), /no eligible frontier model/)
  // An explicit hint surfaces the gated tier, not "routing tier frontier is empty".
  await assert.rejects(router.select({ role: "general", tier: "frontier", now: noon }),
    /frontier exhausted -> lite: no eligible frontier model/)
})

test("an empty tier honours its own fallback instead of degrading to the pin", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "frontier" }, tiers: {
    frontier: { plans: [], payg: [], fallback: "strong" },
    strong: { plans: [[{ model: "strong/a" }]], payg: [] },
  } }))
  const decision = await router.select({ role: "general" })
  assert.equal(decision.model!.id, "a")
  assert.equal(decision.reason, "frontier empty -> strong: plan strong: strong/a")
  assert.deepEqual(decision.fallbackChain, ["frontier", "strong"])
})

test("a directly-constructed router stops an unvalidated fallback cycle", async () => {
  // Bypasses parseModelRouting (which rejects this) to exercise the router's own guard.
  const router = new ModelRouter({ timezone: "UTC", roles: { general: "a" }, tiers: {
    a: { plans: [[{ model: "p/a", hours: [22, 8] }]], payg: [], fallback: "b" },
    b: { plans: [], payg: [], fallback: "a" },
  } })
  await assert.rejects(router.select({ role: "general", now: new Date("2026-09-23T12:00:00Z") }),
    /routing fallback cycle: a -> b -> a/)
})

test("the same pin in two tiers keeps independent SWRR state", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "a", reviewer: "b" }, tiers: {
    a: { selection: "weighted", plans: [[{ model: "p/shared" }, { model: "p/a" }]], payg: [] },
    b: { selection: "weighted", plans: [[{ model: "p/shared" }, { model: "p/b" }]], payg: [] },
  } }))
  assert.equal((await router.select({ role: "general" })).model!.id, "shared")
  // A shared credit map would have pushed "shared" negative and selected "p/b" here.
  assert.equal((await router.select({ role: "reviewer" })).model!.id, "shared")
})

test("ordered mode keeps its behavior and adds no decision fields", async () => {
  const router = new ModelRouter(weighted({ plans: [[{ model: "p/a", weight: 99 }]], payg: [[{ model: "p/b" }]] }))
  const decision = await router.select({ role: "general" })
  assert.deepEqual(Object.keys(decision).sort(), ["model", "reason", "skipped"])
  assert.equal(decision.reason, "plan strong: p/a") // weight is ignored in ordered mode
  assert.equal(decision.model!.id, "a")
})

test("an empty tier yields a no-model decision; a gated non-empty tier still throws", async () => {
  const empty = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "frontier" }, tiers: {
    frontier: { plans: [], payg: [] },
  } }))
  assert.deepEqual(await empty.select({ role: "general" }), { reason: "tier frontier is empty; use agent pin", skipped: [] })
  const gated = new ModelRouter(weighted({ selection: "weighted",
    plans: [[{ model: "p/a", hours: [22, 8] }]], payg: [[{ model: "p/b", hours: [22, 8] }]] }))
  await assert.rejects(gated.select({ role: "general", now: new Date("2026-09-23T12:00:00Z") }), /no eligible strong model/)
})

test("an empty requested tier falling back to another empty tier degrades to the pin", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "a" }, tiers: {
    a: { plans: [], payg: [], fallback: "b" },
    b: { plans: [], payg: [] },
  } }))
  assert.deepEqual(await router.select({ role: "general" }),
    { reason: "tier a is empty; use agent pin", skipped: [] })
})

test("an empty walk that ends in a gated tier throws with the whole chain named", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "a" }, allowUnknownQuota: false, tiers: {
    a: { plans: [], payg: [], fallback: "b" },
    b: { plans: [], payg: [], fallback: "c" },
    c: { plans: [[{ model: "p/z", reservePercent: 50 }]], payg: [] },
  } }))
  await assert.rejects(router.select({ role: "general" }),
    /a empty -> b: b empty -> c: no eligible c model for general: p\/z: quota unknown/)
})

test("an empty head never degrades to the pin past a gated middle tier", async () => {
  // Regression: the degrade-to-pin check once looked only at the head tier, so
  // lite(empty) -> standard(populated but gated) -> frontier(empty) silently
  // spawned the agent pin — the exact PAYG spend the gates were protecting.
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { explore: "lite" }, allowUnknownQuota: false, tiers: {
    lite: { plans: [], payg: [], fallback: "standard" },
    standard: { selection: "weighted", plans: [[{ model: "anthropic/claude-x", reservePercent: 20 }]], payg: [], fallback: "frontier" },
    frontier: { plans: [], payg: [] },
  } }))
  await assert.rejects(router.select({ role: "explore" }), /no eligible lite model for explore/)
  await assert.rejects(router.select({ role: "explore", tier: "lite" }), /no eligible lite model for explore/)
})

test("a throwing fallback hop keeps the originating tier's skip reasons", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "a" }, allowUnknownQuota: false, tiers: {
    a: { plans: [[{ model: "p/gated", hours: [22, 8] }], [{ model: "p/res", reservePercent: 40 }]], payg: [], fallback: "b" },
    b: { plans: [], payg: [] },
  } }))
  await assert.rejects(router.select({ role: "general", now: new Date("2026-09-23T12:00:00Z") }),
    /a exhausted -> b: no eligible a model for general: b has no candidates; skipped p\/gated: outside allowed hours/)
})

test("an empty head preserves the full fallback chain of a deeper successful walk", async () => {
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "a" }, tiers: {
    a: { plans: [], payg: [], fallback: "b" },
    b: { plans: [[{ model: "p/y", hours: [22, 8] }]], payg: [], fallback: "c" },
    c: { plans: [[{ model: "p/z" }]], payg: [] },
  } }))
  const decision = await router.select({ role: "general", now: new Date("2026-09-23T12:00:00Z") })
  assert.equal(decision.model!.id, "z")
  assert.equal(decision.reason, "a empty -> b: b exhausted -> c: plan c: p/z")
  assert.deepEqual(decision.fallbackChain, ["a", "b", "c"])
})

test("the exactly-one-eligible short-circuit skips the rebase (bounded stale credit)", async () => {
  // One weighted pool. a w3 hours [14,7), b w1 hours [5,17), c w2 hours [23,7).
  // The rebase is skipped whenever exactly one candidate is eligible, so a grounded
  // member can keep at most the one draw's worth of credit it held when it grounded.
  // Here that stale credit makes the 5th draw pick c instead of the rebased a —
  // pinning the documented (skipped-rebase) behavior. See docs/MODEL-ROUTING.md.
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "strong" }, tiers: {
    strong: { selection: "weighted", plans: [[
      { model: "p/a", weight: 3, hours: [14, 7] },
      { model: "p/b", weight: 1, hours: [5, 17] },
      { model: "p/c", weight: 2, hours: [23, 7] },
    ]], payg: [] },
  } }))
  const at = (hour: number) => new Date(`2026-09-23T${String(hour).padStart(2, "0")}:00:00Z`)
  const picks: string[] = []
  for (const hour of [9, 5, 7, 11, 0]) picks.push((await router.select({ role: "general", now: at(hour) })).model!.id)
  assert.deepEqual(picks, ["b", "a", "b", "b", "c"])
})

test("routing validation rejects bad weights and mainWeight on a plan", () => {
  const tier = (candidate: Record<string, unknown>, kind: "plans" | "payg" = "payg") =>
    ({ timezone: "UTC", roles: {}, tiers: { a: { plans: kind === "plans" ? [[candidate]] : [], payg: kind === "payg" ? [[candidate]] : [] } } })
  assert.throws(() => parseModelRouting(tier({ model: "p/a", weight: 0 })), /invalid routing weight/)
  assert.throws(() => parseModelRouting(tier({ model: "p/a", weight: 10001 })), /invalid routing weight/)
  assert.throws(() => parseModelRouting(tier({ model: "p/a", weight: Number.POSITIVE_INFINITY })), /invalid routing weight/)
  assert.throws(() => parseModelRouting(tier({ model: "p/a", mainWeight: -1 })), /invalid routing mainWeight/)
  assert.throws(() => parseModelRouting(tier({ model: "p/a", mainWeight: 2 }, "plans")), /mainWeight is only valid on payg/)
})

test("routing validation rejects bad fallback references and cycles", () => {
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { plans: [[{ model: "p/a" }]], payg: [], fallback: "missing" },
  } }), /unknown tier/)
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { plans: [[{ model: "p/a" }]], payg: [], fallback: "a" },
  } }), /fallback cycle/)
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { plans: [[{ model: "p/a" }]], payg: [], fallback: "b" },
    b: { plans: [[{ model: "p/b" }]], payg: [], fallback: "a" },
  } }), /fallback cycle/)
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { plans: [[{ model: "p/a" }]], payg: [], selection: "random" },
  } }), /selection/)
})

test("routing validation rejects duplicate pins in a weighted pool and unknown tier/candidate keys", () => {
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { selection: "weighted", plans: [[{ model: "p/dup" }]], payg: [[{ model: "p/dup", mainWeight: 1 }]] },
  } }), /routing tier a lists p\/dup twice/)
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { plans: [[{ model: "p/a" }]], payg: [], selections: "weighted" },
  } }), /unknown routing tier a key selections/)
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { plans: [[{ model: "p/a", weightS: 5 }]], payg: [] },
  } }), /unknown routing candidate p\/a key weightS/)
})

test("ordered tiers stay permissive about a pin repeated across groups and rotate by least use", async () => {
  // Ordered selection uses a per-candidate `uses` count and per-group findIndex,
  // both duplicate-safe, so a pin may appear in two groups with different windows.
  const router = new ModelRouter(parseModelRouting({ timezone: "UTC", roles: { general: "a" }, tiers: {
    a: { plans: [
      [{ model: "p/shared", hours: [22, 8] }],
      [{ model: "p/shared", hours: [8, 22] }],
    ], payg: [] },
  } }))
  const noon = new Date("2026-09-23T12:00:00Z")
  const night = new Date("2026-09-23T23:00:00Z")
  assert.equal((await router.select({ role: "general", now: noon })).model!.id, "shared")
  assert.equal((await router.select({ role: "general", now: night })).model!.id, "shared")
  // A weighted tier still rejects the same pin twice inside one pool.
  assert.throws(() => parseModelRouting({ timezone: "UTC", roles: {}, tiers: {
    a: { selection: "weighted", plans: [[{ model: "p/dup" }, { model: "p/dup" }]], payg: [] },
  } }), /routing tier a lists p\/dup twice/)
})
