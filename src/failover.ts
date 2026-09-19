/**
 * Provider failover policy (failover-core) — the single place that decides
 * WHERE a child may continue after a provider-level failure.
 *
 * WHY standalone and pure: the ladder (per-call opts.fallbacks > plugin option
 * modelFallbacks > agent-config pin pool > catalog inference) and the tier gate
 * are policy, not session mechanics. Keeping resolveFallbacks out of the runner
 * makes the whole matrix unit-testable without a session or a host catalog; the
 * runner supplies already-resolved inputs and this module never reads files or
 * the host.
 *
 * Rules implemented (see README "Provider failover"):
 *  - Never the same providerID+id as the dead model (any failure class): the
 *    failed turn already proved that model is unavailable.
 *  - Never the dead provider AT ALL for quota (account-level, hours long):
 *    same-provider retry is guaranteed suicide. A burst cap is per-minute and
 *    may allow another model on the same provider.
 *  - Never a provider the caller marked disabled (`disabled_providers`).
 *  - Context-fit: when both the dead session's token total and a catalog
 *    entry's contextLimit are known, a candidate whose window cannot hold the
 *    existing history is skipped.
 *  - Catalog inference only for read-only children (run mode noEditTools, or
 *    the `explore` agent) and only for enabled, tool-capable models on a
 *    DIFFERENT provider — an agent child needs tools, and inference must not
 *    pick a chat-only model.
 *  - Tier gate: read-only children may fail over ANY direction (cheaper is
 *    fine for exploration/review). Edit-capable children may not fail over
 *    DOWN: when the catalog gives price tiers for both sides, the candidate
 *    tier must be >= the dead tier; without that metadata only explicit
 *    (per-call / plugin-option) and pin-pool candidates are eligible — never
 *    catalog inference. "When in doubt, fail the child" is the intended
 *    failure mode, so every unknown resolves to a smaller candidate list.
 */
import type { ModelRef, PermissionMode } from "./types.ts"
import type { FailureClass } from "./failure-classify.ts"
import { normalizeModelRef } from "./agent-pins.ts"

/** Where a fallback candidate came from (precedence order = this order). */
export type FallbackSource = "call" | "option" | "pin" | "catalog"

/** One eligible fallback in ladder order (the runner tries them in order). */
export interface FallbackCandidate {
  model: ModelRef
  source: FallbackSource
  /** Agent id whose config pin supplied this candidate (source "pin" only). */
  agentID?: string
  /** Raw pin string this candidate was parsed from, when it came from one. */
  pin?: string
  /** Price-tier proxy from the catalog, when known. */
  priceTier?: number
}

/** A resolved agent-config pin, tagged with the agent id it belongs to. */
export interface PinPoolEntry {
  agentID: string
  pin: string
}

/**
 * One host-catalog model row. All fields beyond identity are optional: the
 * catalog may know prices but not context windows (or vice versa), and this
 * policy must keep working when nothing is known.
 */
export interface ModelCatalogEntry {
  providerID: string
  id: string
  variant?: string
  /** false = provider/model offline (excluded); absent = treat as enabled. */
  enabled?: boolean
  /** true = usable for tool-using agent children (required for inference). */
  toolCapable?: boolean
  /** Context window in tokens, when known. */
  contextLimit?: number
  /** Relative price tier; larger = more expensive. Used by the tier gate. */
  priceTier?: number
}

export interface ResolveFallbacksInput {
  /** The model the failed session was running on (intended spawn model). */
  dead: ModelRef
  failureClass: FailureClass
  /**
   * Per-call fallback pins (agent(prompt, { fallbacks })): highest precedence.
   * Invalid entries are dropped — the CALLER owns admission-time validation.
   */
  callFallbacks?: ReadonlyArray<string>
  /**
   * Plugin option modelFallbacks: keyed by the dead model's "provider/id" pin
   * string (no variant), value = ordered pin strings.
   */
  modelFallbacks?: Readonly<Record<string, ReadonlyArray<string>>>
  /** Agent-config pins across the run's agent ids (agent-pins.collectAgentPins). */
  pinPool?: ReadonlyArray<PinPoolEntry>
  /** Provider ids the user took offline — never a candidate. */
  disabledProviders?: ReadonlySet<string>
  /** True for read-only children (isReadOnlyChild): unlocks inference + down-tier. */
  readOnly: boolean
  /** Total tokens already in the dead session; enables the context-fit check. */
  sessionTokens?: number
  /** Host model catalog, when available (prices/context limits/enabled). */
  catalog?: ReadonlyArray<ModelCatalogEntry>
}

/**
 * Read-only child = the run may not edit, or the requested agent is the
 * built-in read-only explorer. Only such children may fail over to a cheaper
 * model or use catalog inference; edit-capable children stay conservative.
 */
export function isReadOnlyChild(permissions: PermissionMode | undefined, requestedAgent: string): boolean {
  return permissions === "noEditTools" || requestedAgent === "explore"
}

/** "provider/id" identity of a model (variant deliberately not part of it). */
function modelKey(model: { providerID: string; id: string }): string {
  return `${model.providerID}/${model.id}`
}

/** Parse one pin string through the ONE shared parser (agent-pins). */
function parsePin(pin: unknown): ModelRef | undefined {
  if (typeof pin !== "string") return undefined
  const normalized = normalizeModelRef(pin)
  return normalized.ok ? normalized.model : undefined
}

/**
 * Resolve the ordered fallback ladder for a dead model, already filtered by
 * the exclusion + context-fit + tier rules. Pure; never throws. An empty
 * result means "no eligible candidate" — the caller fails the child with its
 * typed error (fail-closed).
 */
export function resolveFallbacks(input: ResolveFallbacksInput): FallbackCandidate[] {
  const deadKey = modelKey(input.dead)
  // Catalog index: first row per model wins (identity key ignores variant).
  const catalog = new Map<string, ModelCatalogEntry>()
  for (const entry of input.catalog ?? []) {
    if (typeof entry?.providerID !== "string" || typeof entry?.id !== "string") continue
    const key = modelKey(entry)
    if (!catalog.has(key)) catalog.set(key, entry)
  }
  const deadTier = catalog.get(deadKey)?.priceTier

  const candidates: FallbackCandidate[] = []
  // The dead model itself is never a candidate (same providerID+id), and
  // duplicates keep their highest-precedence occurrence.
  const seen = new Set<string>([deadKey])
  const push = (
    model: ModelRef,
    source: FallbackSource,
    extra?: { agentID?: string; pin?: string; priceTier?: number },
  ): void => {
    const key = modelKey(model)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ model: { ...model }, source, ...extra })
  }

  // 1. Per-call opts.fallbacks (explicit, caller-validated at admission).
  for (const pin of input.callFallbacks ?? []) {
    const model = parsePin(pin)
    if (model !== undefined) push(model, "call", { pin })
  }
  // 2. Plugin option modelFallbacks[<dead provider>/<dead id>].
  for (const pin of input.modelFallbacks?.[deadKey] ?? []) {
    const model = parsePin(pin)
    if (model !== undefined) push(model, "option", { pin })
  }
  // 3. The user's agent-config pins on OTHER agents/providers. Disabled agents
  //    never reach the pool (collectAgentPins skips them).
  for (const entry of input.pinPool ?? []) {
    const model = parsePin(entry.pin)
    if (model !== undefined) push(model, "pin", { agentID: entry.agentID, pin: entry.pin })
  }
  // 4. Catalog inference — read-only children only, enabled + tool-capable,
  //    different provider, context window large enough for the history.
  if (input.readOnly) {
    for (const entry of input.catalog ?? []) {
      if (entry.enabled === false) continue
      if (entry.toolCapable !== true) continue
      if (entry.providerID === input.dead.providerID) continue
      if (input.sessionTokens !== undefined && (entry.contextLimit === undefined || entry.contextLimit < input.sessionTokens)) {
        continue
      }
      const model: ModelRef = { providerID: entry.providerID, id: entry.id }
      if (entry.variant !== undefined) model.variant = entry.variant
      push(model, "catalog", entry.priceTier !== undefined ? { priceTier: entry.priceTier } : undefined)
    }
  }

  // Filters — apply to every source: exclusions are model-level, so a model
  // dropped here cannot sneak back in through a lower-precedence occurrence.
  const eligible: FallbackCandidate[] = []
  for (const candidate of candidates) {
    const providerID = candidate.model.providerID
    if (input.disabledProviders?.has(providerID)) continue
    if (input.failureClass === "quota" && providerID === input.dead.providerID) continue
    const meta = catalog.get(modelKey(candidate.model))
    if (meta?.enabled === false) continue
    // Context-fit only when the limit AND the session's token total are known
    // (an unknown limit must not manufacture a veto).
    if (input.sessionTokens !== undefined && meta?.contextLimit !== undefined && meta.contextLimit < input.sessionTokens) {
      continue
    }
    // Tier gate: edit-capable children may not fail over DOWN. Without tier
    // metadata only explicit/per-call/pin candidates pass — catalog inference
    // is excluded by construction (read-only only), and a known-too-cheap
    // candidate is dropped even when it came from a pin.
    if (!input.readOnly) {
      const candidateTier = meta?.priceTier ?? candidate.priceTier
      if (deadTier !== undefined && candidateTier !== undefined && candidateTier < deadTier) continue
    }
    eligible.push(candidate)
  }
  return eligible
}