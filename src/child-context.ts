/** Approximate active request size; used only for explicitly opted-in children. */
export interface ChildContextLimit { targetInput: number; hardInput: number }

export function parseChildLimits(raw: unknown): Record<string, ChildContextLimit> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("childLimits must be an object")
  const limits: Record<string, ChildContextLimit> = {}
  for (const [pin, value] of Object.entries(raw)) {
    if (!/^[^/#]+\/.+/.test(pin) || !value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid childLimits entry: ${pin}`)
    const item = value as Record<string, unknown>
    if (!Number.isInteger(item.targetInput) || !Number.isInteger(item.hardInput) ||
      (item.targetInput as number) < 1 || (item.hardInput as number) <= (item.targetInput as number)) {
      throw new Error(`childLimits ${pin}: require integer targetInput < hardInput`)
    }
    limits[pin] = { targetInput: item.targetInput as number, hardInput: item.hardInput as number }
  }
  return limits
}

/** Conservative text proxy, not a tokenizer: separate from cumulative session usage. */
export function estimateRequestInput(system: unknown, messages: unknown, tools: unknown): number {
  try {
    const text = JSON.stringify([system, messages, tools])
    return Math.ceil(Buffer.byteLength(text, "utf8") / 3)
  } catch { return Number.POSITIVE_INFINITY }
}

export function childLimitFor(model: { providerID: string; id: string; variant?: string }, limits: Record<string, ChildContextLimit>): ChildContextLimit | undefined {
  const pin = `${model.providerID}/${model.id}`
  return limits[`${pin}#${model.variant}`] ?? limits[pin]
}

// ---------------------------------------------------------------------------
// Self-calibrating bytes -> context ratio, per model pin.
//
// The guard estimates the statusline-style request context (what the provider
// re-received: input + cache.read + cache.write) BEFORE a call. The fixed /3
// divisor is only a proxy; measured samples (requestContext of a real request
// against the serialized byte count the context hook sized for that session)
// teach each pin its own ratio. Unmeasured pins keep the /3 default, and every
// stored mean is clamped to [1/6, 1/2] so one pathological sample or a
// provider-side quirk cannot collapse or explode the thresholds.
// ---------------------------------------------------------------------------

/** Today's fixed divisor, kept for pins without measurements. */
const DEFAULT_DIVISOR = 3
const MIN_RATIO = 1 / 6
const MAX_RATIO = 1 / 2
/** Bootstrap window: the running mean is fully re-weighted every 8 samples. */
const CALIBRATION_WINDOW = 8

interface Calibration { samples: number; mean: number }
const calibrations = new Map<string, Calibration>()

function clampRatio(ratio: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

function calibratedRatio(pin: string): number | undefined {
  const state = calibrations.get(pin)
  return state === undefined ? undefined : clampRatio(state.mean)
}

/**
 * Fold one measurement into the pin's bounded running mean. Sample ratios are
 * clamped to [1/6, 1/2] BEFORE folding, so the stored mean itself stays in
 * bounds; the first sample is the mean, and later samples move it by
 * 1/min(samples, CALIBRATION_WINDOW). Invalid or non-positive inputs are
 * ignored (no sample exists for a request that produced no usage).
 */
export function recordContextCalibration(pin: string, measuredContext: number, serializedBytes: number): void {
  if (pin === "" || !Number.isFinite(measuredContext) || !Number.isFinite(serializedBytes) ||
    measuredContext <= 0 || serializedBytes <= 0) return
  const sample = clampRatio(measuredContext / serializedBytes)
  const state = calibrations.get(pin)
  if (state === undefined) {
    calibrations.set(pin, { samples: 1, mean: sample })
    return
  }
  state.samples = Math.min(state.samples + 1, CALIBRATION_WINDOW)
  state.mean += (sample - state.mean) / state.samples
}

/** Serialized UTF-8 byte count of one assembled request; +Infinity when not serializable. */
function requestBytes(system: unknown, messages: unknown, tools: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify([system, messages, tools]), "utf8")
  } catch { return Number.POSITIVE_INFINITY }
}

/**
 * Same byte count as estimateRequestInput, but scaled by the pin's calibrated
 * ratio once a measurement exists — so childLimits thresholds land in the same
 * units as the statusline context number. Pins without samples keep the fixed
 * /3 default (byte-identical result to estimateRequestInput).
 */
export function estimateRequestInputFor(pin: string, system: unknown, messages: unknown, tools: unknown): number {
  return estimateFromBytes(requestBytes(system, messages, tools), pin)
}

function estimateFromBytes(bytes: number, pin: string): number {
  const ratio = calibratedRatio(pin)
  return ratio === undefined ? Math.ceil(bytes / DEFAULT_DIVISOR) : Math.ceil(bytes * ratio)
}

/**
 * Hook -> measurement bridge. The context hook's `messages` are the assembled
 * @opencode/ai request messages, which carry no usage fields, so the measured
 * context can only be paired with the request the hook sized earlier. The hook
 * stores the serialized byte count per session here; primitives.ts folds the
 * provider-measured requestContext back in via recordMeasuredContext once the
 * child result lands. Session-scoped so concurrent children never mix samples;
 * a pin mismatch (mid-call failover) drops the stale sample instead.
 */
const lastRequestBytes = new Map<string, { pin: string; bytes: number }>()
/** Bound on unconsumed sessions: entries are re-inserted per hook pass (true LRU) and evicted least-recently-used. */
const LAST_BYTES_CAP = 64

/** Context-hook entry point: sizes the request once, records its bytes for the later measurement, and returns the calibrated estimate. */
export function estimateAndRecordRequestInput(sessionID: string, pin: string, system: unknown, messages: unknown, tools: unknown): number {
  const bytes = requestBytes(system, messages, tools)
  if (sessionID !== "" && Number.isFinite(bytes) && bytes > 0) {
    // Delete-then-set is a true LRU touch: Map.set on an existing key keeps
    // its ORIGINAL insertion position, which would let the oldest-first trim
    // below evict a long-lived active session and silently drop its samples.
    lastRequestBytes.delete(sessionID)
    lastRequestBytes.set(sessionID, { pin, bytes })
    if (lastRequestBytes.size > LAST_BYTES_CAP) {
      const oldest = lastRequestBytes.keys().next().value
      if (oldest !== undefined) lastRequestBytes.delete(oldest)
    }
  }
  return estimateFromBytes(bytes, pin)
}

/**
 * Fold a measured request context into the pin's calibration using the bytes
 * the context hook stored for that session. A measurement always consumes the
 * pending bytes (the hook may already have sized a later request); the fold
 * itself only happens when the pins match — a mid-call failover's measurement
 * teaches the model it actually ran on, not the one the bytes were sized for.
 * `stale` marks a fallback measurement whose usage came from an EARLIER
 * request than those bytes describe: it consumes without folding, because
 * pairing it would bias the pin downward.
 */
export function recordMeasuredContext(sessionID: string, pin: string, measuredContext: number, stale = false): void {
  const pending = lastRequestBytes.get(sessionID)
  if (pending === undefined) return
  lastRequestBytes.delete(sessionID)
  if (stale || pending.pin !== pin) return
  recordContextCalibration(pin, measuredContext, pending.bytes)
}
