/** Opt-in, deterministic routing for Ultracode children. No OpenCode agent pins are changed. */
import { parseModelPin } from "./agent-pins.ts"

export interface RouteCandidate {
  model: string
  /** Named quota/capacity pool. Independent of the model's provider. */
  capacityPool?: string
  /** Local hours in `timezone` below. The end is exclusive and may wrap midnight. */
  hours?: [number, number]
  /** Conservative weekday exclusion windows in profile timezone (e.g. DeepSeek peak). */
  blockedWeekdayHours?: Array<[number, number]>
  /** Reserve this much of the provider's quota for other uses (0..100). */
  reservePercent?: number
  /** Weighted selection: draw weight inside this candidate's own pool (default 1). */
  weight?: number
  /** Weighted selection: PAYG-only draw weight for the MAIN pool shared with eligible plans. */
  mainWeight?: number
}

export interface RouteTier {
  /** Each inner group rotates eligible candidates; groups themselves have strict priority. */
  plans: RouteCandidate[][]
  payg: RouteCandidate[][]
  /**
   * "weighted" flattens the groups and draws by weight (deterministic smooth weighted
   * round-robin); the default "ordered" keeps group priority and least-use rotation.
   */
  selection?: "ordered" | "weighted"
  /** Tier to try with the same eligibility rules when this tier has no eligible candidate. */
  fallback?: string
}

export interface ModelRouting {
  /** IANA timezone; for example Asia/Hong_Kong. */
  timezone: string
  /** Agent id -> default tier. Explicit per-call tier takes precedence. */
  roles: Record<string, string>
  tiers: Record<string, RouteTier>
  /** Provider -> quota feed id. An absent feed never pretends to have headroom. */
  quotaIDs?: Record<string, string>
  /** When quota is unknown, skip candidates with a reserve unless explicitly allowed. */
  allowUnknownQuota?: boolean
}

export interface RouteObservation {
  /** Percentage remaining across ALL relevant windows (lowest wins). */
  remainingPercent?: number
}

/** One eligible candidate in the weighted pool the pick came from. */
export interface RoutePoolEntry {
  /** The configured model pin. */
  model: string
  /** Draw weight inside this pool. */
  weight: number
  /** Share of the pool's eligible weight, 0..100. */
  percent: number
}

export interface RouteDecision {
  model?: { providerID: string; id: string; variant?: string }
  reason: string
  skipped: string[]
  /** Weighted selection: the eligible pool the pick came from (main or PAYG fallback). */
  pool?: RoutePoolEntry[]
  /** Tiers walked, starting with the requested tier, when a `fallback` chain fired. */
  fallbackChain?: string[]
}

/** Select() inputs, shared by every tier in a fallback chain. */
interface SelectInput {
  role: string
  tier?: string
  now?: Date
  disabled?: ReadonlySet<string>
  /** Machine/quarantine knowledge in addition to `disabled` (distinct skip reason). */
  quarantined?: ReadonlySet<string>
  available?: ReadonlySet<string>
  quota?: (id: string) => Promise<RouteObservation | undefined>
}

/** An eligible candidate normalized for ordered rotation / weighted drawing. */
interface EligibleCandidate {
  model: NonNullable<RouteDecision["model"]>
  pin: string
  weight: number
}

function hourAt(now: Date, timezone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now))
}

function within(hour: number, hours: [number, number] | undefined): boolean {
  if (!hours) return true
  const [start, end] = hours
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

function validHours(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((h) => Number.isInteger(h) && h >= 0 && h <= 23) && value[0] !== value[1]
}

/** Weighted draws need a bounded positive finite number so a typo cannot starve or dominate. */
function validWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 10000
}

/** Stateless validation: reject bad routing at startup rather than silently using a wrong provider. */
export function parseModelRouting(value: unknown): ModelRouting {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("routing must be an object")
  const r = value as Record<string, unknown>
  const timezone = r.timezone
  if (typeof timezone !== "string") throw new Error("routing.timezone must be an IANA timezone")
  try { new Intl.DateTimeFormat("en-GB", { timeZone: timezone }) } catch { throw new Error(`invalid routing timezone: ${timezone}`) }
  if (!r.tiers || typeof r.tiers !== "object" || Array.isArray(r.tiers)) throw new Error("routing.tiers must be an object")
  const tiers: Record<string, RouteTier> = {}
  for (const [name, raw] of Object.entries(r.tiers)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`routing tier ${name} must be an object`)
    const input = raw as Record<string, unknown>
    // The format is new and the CLI never writes unknown keys, so a typo (e.g.
    // "selections") is rejected rather than silently disabling the feature.
    const tierKeys = new Set(["plans", "payg", "selection", "fallback"])
    for (const key of Object.keys(input)) if (!tierKeys.has(key)) throw new Error(`unknown routing tier ${name} key ${key}`)
    const selection = input.selection
    if (selection !== undefined && selection !== "ordered" && selection !== "weighted") {
      throw new Error(`routing tier ${name}.selection must be "ordered" or "weighted"`)
    }
    const fallback = input.fallback
    if (fallback !== undefined && (typeof fallback !== "string" || !fallback.trim())) {
      throw new Error(`routing tier ${name}.fallback must name a defined tier`)
    }
    const weighted = selection === "weighted"
    const candidateKeys = new Set(["model", "capacityPool", "hours", "blockedWeekdayHours", "reservePercent", "weight", "mainWeight"])
    const groups = (kind: "plans" | "payg"): RouteCandidate[][] => {
      if (!Array.isArray(input[kind])) throw new Error(`routing tier ${name}.${kind} must be an array of rotation groups`)
      return (input[kind] as unknown[]).map((group, i) => {
        if (!Array.isArray(group) || !group.length) throw new Error(`routing tier ${name}.${kind}[${i}] must be a nonempty group`)
        return group.map((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("routing candidate must be an object")
          const candidate = entry as RouteCandidate
          if (typeof candidate.model !== "string" || !parseModelPin(candidate.model)) throw new Error(`invalid routing model: ${String(candidate.model)}`)
          for (const key of Object.keys(candidate)) if (!candidateKeys.has(key)) throw new Error(`unknown routing candidate ${candidate.model} key ${key}`)
          if (candidate.capacityPool !== undefined && (typeof candidate.capacityPool !== "string" || !candidate.capacityPool.trim())) throw new Error(`invalid capacityPool for ${candidate.model}`)
          if (candidate.hours !== undefined && !validHours(candidate.hours)) {
            throw new Error(`invalid routing hours for ${candidate.model}`)
          }
          if (candidate.blockedWeekdayHours !== undefined && (!Array.isArray(candidate.blockedWeekdayHours) ||
            candidate.blockedWeekdayHours.some((hours) => !validHours(hours)))) throw new Error(`invalid routing blockedWeekdayHours for ${candidate.model}`)
          if (candidate.reservePercent !== undefined && (!Number.isFinite(candidate.reservePercent) || candidate.reservePercent < 0 || candidate.reservePercent > 100)) {
            throw new Error(`invalid routing reserve for ${candidate.model}`)
          }
          if (candidate.weight !== undefined && !validWeight(candidate.weight)) throw new Error(`invalid routing weight for ${candidate.model}`)
          if (candidate.mainWeight !== undefined) {
            // mainWeight only means something in the PAYG main pool; on a plan it is a typo.
            if (kind === "plans") throw new Error(`routing mainWeight is only valid on payg candidates: ${candidate.model}`)
            if (!validWeight(candidate.mainWeight)) throw new Error(`invalid routing mainWeight for ${candidate.model}`)
          }
          return { model: candidate.model, ...(candidate.hours ? { hours: candidate.hours } : {}),
            ...(candidate.capacityPool ? { capacityPool: candidate.capacityPool } : {}),
            ...(candidate.blockedWeekdayHours ? { blockedWeekdayHours: candidate.blockedWeekdayHours } : {}),
            ...(candidate.reservePercent !== undefined ? { reservePercent: candidate.reservePercent } : {}),
            ...(candidate.weight !== undefined ? { weight: candidate.weight } : {}),
            ...(candidate.mainWeight !== undefined ? { mainWeight: candidate.mainWeight } : {}) }
        })
      })
    }
    const plans = groups("plans")
    const payg = groups("payg")
    if (weighted) {
      // SWRR credits are keyed by pool, so a duplicate pin inside ONE pool would
      // double-count its weight. The pools are what actually draw: MAIN is `plans`
      // plus PAYG carrying mainWeight; FALLBACK is every PAYG. Ordered tiers use a
      // per-candidate `uses` count and per-group findIndex, both duplicate-safe, so
      // they stay permissive (a pin may appear in two groups with different windows).
      const pools = [
        [...plans.flat(), ...payg.flat().filter((candidate) => candidate.mainWeight !== undefined)],
        payg.flat(),
      ]
      for (const candidates of pools) {
        const seen = new Set<string>()
        for (const candidate of candidates) {
          if (seen.has(candidate.model)) throw new Error(`routing tier ${name} lists ${candidate.model} twice`)
          seen.add(candidate.model)
        }
      }
    }
    tiers[name] = { plans, payg,
      ...(selection !== undefined ? { selection: selection as "ordered" | "weighted" } : {}),
      ...(fallback !== undefined ? { fallback: fallback as string } : {}) }
  }
  // Fallback targets may be declared after their referrer, so resolve the whole map first.
  for (const [name, tier] of Object.entries(tiers)) {
    if (tier.fallback !== undefined && !tiers[tier.fallback]) {
      throw new Error(`routing tier ${name}.fallback references unknown tier ${tier.fallback}`)
    }
  }
  for (const name of Object.keys(tiers)) {
    const seen = new Set<string>()
    let current: string | undefined = name
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`routing fallback cycle: ${[...seen, current].join(" -> ")}`)
      seen.add(current)
      current = tiers[current]?.fallback
    }
  }
  const roles = r.roles
  if (!roles || typeof roles !== "object" || Array.isArray(roles) ||
    Object.values(roles).some((tier) => typeof tier !== "string" || !tiers[tier])) throw new Error("routing.roles must map agent ids to defined tiers")
  const quotaIDs = r.quotaIDs
  if (quotaIDs !== undefined && (!quotaIDs || typeof quotaIDs !== "object" || Array.isArray(quotaIDs) ||
    Object.values(quotaIDs).some((id) => typeof id !== "string" || !id))) throw new Error("routing.quotaIDs must map providers to quota feed ids")
  // Omitted allowUnknownQuota now means ALLOW (2026-09-25): an unknown feed is
  // not evidence of exhaustion, and the old default silently locked reserved
  // plans out whenever the feed command was missing — concentrating load on
  // unreserved plans that then died on the very quota the feed would have
  // shown. An explicit false keeps the fail-closed behavior for users who
  // want a missing feed to never spend a paid plan.
  if (r.allowUnknownQuota !== undefined && typeof r.allowUnknownQuota !== "boolean") {
    throw new Error("routing.allowUnknownQuota must be a boolean when present")
  }
  return { timezone, roles: roles as Record<string, string>, tiers,
    ...(quotaIDs ? { quotaIDs: quotaIDs as Record<string, string> } : {}),
    allowUnknownQuota: r.allowUnknownQuota === undefined ? true : r.allowUnknownQuota === true }
}

/** Counter shared by a supervisor, so parallel children do not all pick the first plan. */
export class ModelRouter {
  private readonly uses = new Map<string, number>()
  /**
   * Weighted-selection credits keyed `${tier}|${pool}|${modelPin}`. The tier is part of
   * the key so the same pin in two tiers never shares SWRR state.
   */
  private readonly credits = new Map<string, number>()
  private readonly config: ModelRouting
  constructor(config: ModelRouting) { this.config = config }

  async select(input: {
    role: string
    tier?: string
    now?: Date
    disabled?: ReadonlySet<string>
    quarantined?: ReadonlySet<string>
    available?: ReadonlySet<string>
    quota?: (id: string) => Promise<RouteObservation | undefined>
  }): Promise<RouteDecision> {
    const tier = input.tier ?? this.config.roles[input.role]
    if (!tier) return { reason: "no tier configured; use agent pin", skipped: [] }
    const tierConfig = this.config.tiers[tier]
    if (!tierConfig) throw new Error(`unknown routing tier ${tier}`)
    return this.selectTier(tier, tierConfig, input, [tier])
  }

  /** Walk one tier, recursing through `fallback` links; `chain` carries the tiers walked. */
  private async selectTier(tier: string, tierConfig: RouteTier, input: SelectInput, chain: string[]): Promise<RouteDecision> {
    // Defence in depth: a directly-constructed router over a hand-edited policy must
    // never recurse forever on a fallback cycle (parse-time validation is the first net).
    if (chain.length > Object.keys(this.config.tiers).length) {
      throw new Error(`routing fallback cycle: ${chain.join(" -> ")}`)
    }
    // A tier nobody has configured is a no-op, not an error: the agent keeps its pin.
    if (!tierConfig.plans.length && !tierConfig.payg.length) {
      // An empty tier still honours its own fallback, so `tier fallback` is never inert.
      if (tierConfig.fallback) {
        const target = this.config.tiers[tierConfig.fallback]
        if (!target) throw new Error(`unknown routing tier ${tierConfig.fallback}`)
        let inner: RouteDecision
        try {
          inner = await this.selectTier(tierConfig.fallback, target, input, [...chain, tierConfig.fallback])
        } catch (error) {
          // Keep the chain context so the requested tier is named, not the deepest hop.
          throw new Error(`${tier} empty -> ${tierConfig.fallback}: ${error instanceof Error ? error.message : String(error)}`)
        }
        // A walk that never found a model means the whole chain was empty: the
        // requested tier has no model choices, so degrade to the agent pin (spec 4).
        // The inner decision already names the requested tier; do not re-wrap it.
        if (inner.model === undefined) return inner
        return { ...inner, reason: `${tier} empty -> ${tierConfig.fallback}: ${inner.reason}` }
      }
      // Degrade to the agent pin ONLY when EVERY tier walked is empty. A chain that
      // passed through a populated-but-gated tier must fail loud instead of spending
      // the pin — the pin is often the very PAYG model the gates were protecting.
      const allEmpty = chain.every((name) => {
        const walked = this.config.tiers[name]
        return walked !== undefined && !walked.plans.length && !walked.payg.length
      })
      if (allEmpty) {
        if (chain.length > 1) return { reason: `tier ${chain[0]} is empty; use agent pin`, skipped: [] }
        return this.finish({ reason: `tier ${tier} is empty; use agent pin`, skipped: [] }, chain)
      }
      throw new Error(`no eligible ${chain[0]} model for ${input.role}: ${tier} has no candidates`)
    }
    const now = input.now ?? new Date()
    const hour = hourAt(now, this.config.timezone)
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: this.config.timezone, weekday: "short" }).format(now)
    const skipped: string[] = []
    const observed = new Map<string, RouteObservation | undefined>()
    const check = async (entry: RouteCandidate, pool: "plans" | "payg"): Promise<EligibleCandidate | undefined> => {
      const model = parseModelPin(entry.model)!
      if (input.available && !input.available.has(`${model.providerID}/${model.id}`)) { skipped.push(`${entry.model}: not in live catalog`); return }
      if (input.disabled?.has(model.providerID)) { skipped.push(`${entry.model}: provider offline`); return }
      if (input.quarantined?.has(model.providerID)) { skipped.push(`${entry.model}: provider quarantined`); return }
      if (!within(hour, entry.hours)) { skipped.push(`${entry.model}: outside allowed hours`); return }
      if (weekday !== "Sat" && weekday !== "Sun" && entry.blockedWeekdayHours?.some((range) => within(hour, range))) {
        skipped.push(`${entry.model}: weekday peak hours`); return
      }
      // Quota layering (plans are subscription-backed; PAYG only honors an
      // explicit reserve): the feed is consulted for every plans entry, not
      // only reserved ones. KNOWN-zero is a hard stop — a plan the feed
      // reports exhausted is never tried, not even once (observed 2026-09-24:
      // children kept spawning onto a dead provider and burned whole turns).
      // A reserve still skips when KNOWN-low (1-2% left keeps trying unless a
      // reservePercent says otherwise); UNKNOWN never blocks on its own.
      if (pool === "plans" || entry.reservePercent !== undefined) {
        const feed = entry.capacityPool ?? this.config.quotaIDs?.[model.providerID] ?? model.providerID
        if (!observed.has(feed)) {
          let value: RouteObservation | undefined
          try { value = await input.quota?.(feed) } catch { /* unknown, never unlimited */ }
          observed.set(feed, value)
        }
        const remaining = observed.get(feed)?.remainingPercent
        if (pool === "plans" && remaining === 0) { skipped.push(`${entry.model}: quota exhausted`); return }
        if (remaining !== undefined && entry.reservePercent !== undefined && remaining <= entry.reservePercent) { skipped.push(`${entry.model}: quota reserve`); return }
        if (remaining === undefined && entry.reservePercent !== undefined && !this.config.allowUnknownQuota) { skipped.push(`${entry.model}: quota unknown`); return }
      }
      return { model, pin: entry.model, weight: entry.weight ?? 1 }
    }

    if (tierConfig.selection !== "weighted") {
      for (const [kind, groups] of [["plan", tierConfig.plans], ["payg", tierConfig.payg]] as const) {
        for (const group of groups) {
          const eligible: EligibleCandidate[] = []
          for (const entry of group) {
            const candidate = await check(entry, kind === "plan" ? "plans" : "payg")
            if (candidate) eligible.push(candidate)
          }
          if (!eligible.length) continue
          eligible.sort((a, b) => (this.uses.get(a.pin) ?? 0) - (this.uses.get(b.pin) ?? 0) || group.findIndex((e) => e.model === a.pin) - group.findIndex((e) => e.model === b.pin))
          const chosen = eligible[0]!
          this.uses.set(chosen.pin, (this.uses.get(chosen.pin) ?? 0) + 1)
          return this.finish({ model: chosen.model, reason: `${kind} ${tier}: ${chosen.pin}`, skipped }, chain)
        }
      }
      return this.exhausted(tier, tierConfig, input, chain, skipped)
    }

    const planEligible: EligibleCandidate[] = []
    for (const group of tierConfig.plans) for (const entry of group) {
      const candidate = await check(entry, "plans")
      if (candidate) planEligible.push(candidate)
    }
    const paygEligible: Array<EligibleCandidate & { mainWeight?: number }> = []
    for (const group of tierConfig.payg) for (const entry of group) {
      const candidate = await check(entry, "payg")
      if (candidate) paygEligible.push({ ...candidate, ...(entry.mainWeight !== undefined ? { mainWeight: entry.mainWeight } : {}) })
    }

    // MAIN pool: eligible plans (weight) plus eligible PAYG carrying a mainWeight.
    const mainEligible: EligibleCandidate[] = [
      ...planEligible,
      ...paygEligible.filter((e) => e.mainWeight !== undefined).map((e) => ({ model: e.model, pin: e.pin, weight: e.mainWeight! })),
    ]
    if (mainEligible.length) {
      const members = [
        ...tierConfig.plans.flat().map((e) => ({ pin: e.model, weight: e.weight ?? 1 })),
        ...tierConfig.payg.flat().filter((e) => e.mainWeight !== undefined).map((e) => ({ pin: e.model, weight: e.mainWeight! })),
      ]
      return this.finish(this.weighted(tier, "main", members, mainEligible, skipped), chain)
    }
    // FALLBACK pool: every eligible PAYG candidate, drawn with `weight`.
    if (paygEligible.length) {
      const members = tierConfig.payg.flat().map((e) => ({ pin: e.model, weight: e.weight ?? 1 }))
      const eligible = paygEligible.map((e) => ({ model: e.model, pin: e.pin, weight: e.weight }))
      return this.finish(this.weighted(tier, "fallback", members, eligible, skipped), chain)
    }
    return this.exhausted(tier, tierConfig, input, chain, skipped)
  }

  /** No candidate is eligible: follow the tier's fallback chain, or throw with every skip reason. */
  private async exhausted(tier: string, tierConfig: RouteTier, input: SelectInput, chain: string[], skipped: string[]): Promise<RouteDecision> {
    if (tierConfig.fallback) {
      const target = this.config.tiers[tierConfig.fallback]
      if (!target) throw new Error(`unknown routing tier ${tierConfig.fallback}`)
      let inner: RouteDecision
      try {
        inner = await this.selectTier(tierConfig.fallback, target, input, [...chain, tierConfig.fallback])
      } catch (error) {
        // The fallback hop failed too: keep the chain context AND this tier's skip
        // reasons, so the operator sees WHY the chain fired (dead feed, hours, catalog).
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${tier} exhausted -> ${tierConfig.fallback}: ${message}${skipped.length ? `; skipped ${skipped.join("; ")}` : ""}`)
      }
      // Skip reasons from every hop are kept so operators can see why the chain fired.
      return { ...inner, reason: `${tier} exhausted -> ${tierConfig.fallback}: ${inner.reason}`, skipped: [...skipped, ...inner.skipped] }
    }
    throw new Error(`no eligible ${tier} model for ${input.role}: ${skipped.join("; ") || "tier has no candidates"}`)
  }

  /**
   * Deterministic smooth weighted round-robin (no Math.random). Ineligible members of the
   * pool are rebased to zero first, so a grounded candidate accumulates no credit and gains
   * no delayed burst on re-entry. Proportions converge to the configured weights over any
   * window with a stable eligible set, and are exact at cycle multiples.
   */
  private draw(tier: string, pool: "main" | "fallback", members: Array<{ pin: string; weight: number }>, eligible: EligibleCandidate[]): { pick: EligibleCandidate; total: number } {
    if (eligible.length === 1) return { pick: eligible[0]!, total: eligible[0]!.weight }
    const present = new Set(eligible.map((e) => e.pin))
    for (const member of members) if (!present.has(member.pin)) this.credits.set(this.creditKey(tier, pool, member.pin), 0)
    let total = 0
    for (const candidate of eligible) {
      total += candidate.weight
      const key = this.creditKey(tier, pool, candidate.pin)
      this.credits.set(key, (this.credits.get(key) ?? 0) + candidate.weight)
    }
    let pick = eligible[0]!
    for (const candidate of eligible.slice(1)) {
      const credit = this.credits.get(this.creditKey(tier, pool, candidate.pin)) ?? 0
      if (credit > (this.credits.get(this.creditKey(tier, pool, pick.pin)) ?? 0)) pick = candidate
    }
    const winner = this.creditKey(tier, pool, pick.pin)
    this.credits.set(winner, (this.credits.get(winner) ?? 0) - total)
    return { pick, total }
  }

  private weighted(tier: string, pool: "main" | "fallback", members: Array<{ pin: string; weight: number }>, eligible: EligibleCandidate[], skipped: string[]): RouteDecision {
    const { pick, total } = this.draw(tier, pool, members, eligible)
    const entries: RoutePoolEntry[] = eligible.map((e) => ({ model: e.pin, weight: e.weight, percent: (e.weight / total) * 100 }))
    return { model: pick.model, reason: `weighted ${tier}: ${pick.pin} (w${pick.weight} of ${total})`, skipped, pool: entries }
  }

  private creditKey(tier: string, pool: "main" | "fallback", pin: string): string {
    // JSON encoding is injective regardless of `|` or other characters in tier
    // names and model ids, so distinct (tier, pool, pin) triples never collide.
    return JSON.stringify([tier, pool, pin])
  }

  private finish(decision: RouteDecision, chain: string[]): RouteDecision {
    return chain.length > 1 ? { ...decision, fallbackChain: chain } : decision
  }
}