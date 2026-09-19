/**
 * Provider-failure classifier — the single place that decides WHY a child
 * session died at the provider level, so retry/failover policy can branch on a
 * typed result instead of re-parsing error strings at every call site.
 *
 * WHY pure and standalone: the decision is a function of the structured error
 * object the server attaches to the last assistant message (`message.error`)
 * plus free-text failure detail. Keeping it out of sessions.ts makes the rules
 * unit-testable against the real production messages without a session fake.
 *
 * Two classes matter for policy:
 * - "burst": per-minute/concurrent caps (rate-limit type / 429 / "rate limit
 *   reached for requests", no hours-away reset). Clears in seconds — a
 *   same-model retry with backoff is viable.
 * - "quota": plan quota ("usage limit", "quota", "1-week", "5 hour", or a
 *   parseable reset clearly >2 min away). Account-level and hours long —
 *   same-model AND same-provider retries are guaranteed to fail instantly.
 * - "other": no provider-shaped signal — callers keep their existing behavior.
 *
 * Reset timestamps are advisory: returned only when parseable AND clearly in
 * the future. An unparseable or ambiguous timestamp yields no resetAt — never
 * guess, because a wrong reset time would quarantine a healthy provider for
 * hours.
 */
import type { ContextMessageError } from "./types.ts"

export type FailureClass = "quota" | "burst" | "other"

export interface FailureClassification {
  class: FailureClass
  /** Structured error message (verbatim), when the server attached one. */
  message?: string
  /** HTTP-ish status from the structured error, when present. */
  status?: number
  /** Epoch ms reset time — only when parseable and clearly >2 min in the future. */
  resetAt?: number
  /** Why this class was chosen (human-readable; policy must never parse it). */
  reason: string
}

/**
 * Reset timestamps closer than this are treated as "no reset": burst caps clear
 * in seconds, so a sub-2-minute timestamp must not read as an hours-long quota.
 */
const RESET_MIN_HORIZON_MS = 120_000

/**
 * Year-less timestamps more than this far in the past roll to next year
 * (covers the Dec -> Jan reset window; the message is generated at failure
 * time, so anything older than a day cannot be the intended year).
 */
const YEAR_ROLLOVER_GRACE_MS = 86_400_000

/** Reset-shaped wording within this many chars BEFORE a timestamp scopes it. */
const RESET_CONTEXT_CHARS = 64

interface Marker {
  re: RegExp
  label: string
}

/**
 * Quota markers are checked BEFORE rate-limit markers: "rate limit reached
 * … 1-week quota has been exhausted" is a quota problem, and treating it as a
 * burst would burn an instant-death retry.
 */
const QUOTA_MARKERS: ReadonlyArray<Marker> = [
  { re: /usage\s+limit/, label: "usage limit" },
  { re: /\bquota\b/, label: "quota" },
  { re: /1[\s_-]?week/, label: "1-week" },
  { re: /5[\s_-]?hour/, label: "5 hour" },
]

const BURST_MARKERS: ReadonlyArray<Marker> = [
  { re: /rate[\s_-]?limit/, label: "rate limit" },
  { re: /\b429\b/, label: "429" },
  { re: /too many requests/, label: "too many requests" },
]

/** Wording that scopes a nearby timestamp as a reset time. */
const RESET_KEYWORD = /\b(?:reset(?:s)?|renew(?:s)?|retry\s+after|available\s+(?:at|after)|until|till)\b/i

/** `2026-09-19 22:56:08` (zoneless provider wall clock; parsed as UTC). */
const ISO_TIMESTAMP_SOURCE = String.raw`(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?`

/** `09-19 13:10:00 UTC` (year inferred; zone marker optional and always UTC). */
const SHORT_TIMESTAMP_SOURCE = String.raw`(?<![\d-])(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*(?:UTC|GMT|Z))?`

interface TimestampHit {
  ms: number
  index: number
}

/**
 * Classify a failed turn. `error` is the structured error off the last
 * assistant message; `text` is any human-readable failure detail (server error
 * text, error content parts, assistant text). Never throws.
 */
export function classifyFailure(error?: ContextMessageError, text?: string): FailureClassification {
  const now = Date.now()
  const structuredMessage = typeof error?.message === "string" ? error.message.trim() : ""
  const type = typeof error?.type === "string" ? error.type.trim() : ""
  const status = readFailureStatus(error)
  const freeText = typeof text === "string" ? text : ""
  const haystack = [structuredMessage, freeText].filter((s) => s.length > 0).join("\n")
  const lowered = haystack.toLowerCase()

  const quotaMarker = firstMarker(QUOTA_MARKERS, lowered)
  const burstMarker = firstMarker(BURST_MARKERS, lowered)
  const typeIsRateLimit = /rate[\s_-]?limit/.test(type.toLowerCase())
  const statusIs429 = status === 429

  // Reset parsing is deliberately scoped: assistant prose can contain
  // unrelated dates (a workflow about dates, for example), so a timestamp is
  // trusted only when reset-shaped wording precedes it, when the text is
  // otherwise quota-shaped, or when the structured provider error names it.
  // A stray date must never quarantine a healthy provider.
  let parsedReset = findContextualReset(freeText, now)
  if (parsedReset === undefined && (quotaMarker !== undefined || RESET_KEYWORD.test(freeText))) {
    parsedReset = firstTimestamp(freeText, now)
  }
  if (parsedReset === undefined && structuredMessage.length > 0) {
    parsedReset = firstTimestamp(structuredMessage, now)
  }

  let resetAt: number | undefined
  let resetIgnored = false
  if (parsedReset !== undefined) {
    if (parsedReset - now > RESET_MIN_HORIZON_MS) resetAt = parsedReset
    else resetIgnored = true
  }

  const base: Pick<FailureClassification, "message" | "status"> = {}
  if (structuredMessage.length > 0) base.message = structuredMessage
  if (status !== undefined) base.status = status

  if (resetAt !== undefined) {
    const minutes = Math.round((resetAt - now) / 60_000)
    return { class: "quota", ...base, resetAt, reason: `quota: reset in ~${minutes}m` }
  }
  if (quotaMarker !== undefined) {
    const suffix = resetIgnored ? "; reset timestamp not clearly in the future" : ""
    return { class: "quota", ...base, reason: `quota marker "${quotaMarker.label}"${suffix}` }
  }

  const burstBits: string[] = []
  if (typeIsRateLimit) burstBits.push(`type "${type}"`)
  if (statusIs429) burstBits.push("status 429")
  if (burstMarker !== undefined) burstBits.push(`marker "${burstMarker.label}"`)
  if (burstBits.length > 0) {
    return { class: "burst", ...base, reason: `rate-limit: ${burstBits.join(", ")}` }
  }

  const otherSuffix = resetIgnored ? "; saw a reset timestamp not clearly in the future" : ""
  return { class: "other", ...base, reason: `no quota or rate-limit markers${otherSuffix}` }
}

/**
 * Status off an untrusted structured error, tolerating numeric strings — the
 * shape is a server JSON passthrough, so the static type is a claim, not a
 * guarantee.
 */
export function readFailureStatus(error: ContextMessageError | undefined): number | undefined {
  const raw = (error as { status?: unknown } | undefined)?.status
  if (typeof raw === "number" && Number.isFinite(raw)) return raw
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Parse the first reset timestamp a failure message names, or undefined when
 * none is parseable. Exported for tests and for callers that need the reset
 * time without a full classification (quarantine expiry).
 *
 * Formats handled (the two observed in production):
 * - `2026-09-19 22:56:08` — zoneless provider wall clock, parsed as UTC.
 * - `09-19 13:10:00 UTC` — year inferred as the nearest occurrence.
 * Anything else (missing components, impossible calendar values) => undefined.
 */
export function parseResetTimestamp(text: string, now = Date.now()): number | undefined {
  if (typeof text !== "string" || text.length === 0) return undefined
  const contextual = findContextualReset(text, now)
  if (contextual !== undefined) return contextual
  return firstTimestamp(text, now)
}

function firstMarker(markers: ReadonlyArray<Marker>, lowered: string): Marker | undefined {
  for (const marker of markers) {
    if (marker.re.test(lowered)) return marker
  }
  return undefined
}

/** First timestamp preceded by reset-shaped wording within the context window. */
function findContextualReset(text: string, now: number): number | undefined {
  for (const hit of scanTimestamps(text, now)) {
    const before = text.slice(Math.max(0, hit.index - RESET_CONTEXT_CHARS), hit.index)
    if (RESET_KEYWORD.test(before)) return hit.ms
  }
  return undefined
}

/** Earliest parseable timestamp in the text (index order). */
function firstTimestamp(text: string, now: number): number | undefined {
  const hits = scanTimestamps(text, now)
  return hits.length > 0 ? hits[0]!.ms : undefined
}

function scanTimestamps(text: string, now: number): TimestampHit[] {
  if (typeof text !== "string" || text.length === 0) return []
  const hits: TimestampHit[] = []
  scanWith(text, ISO_TIMESTAMP_SOURCE, (m) => parseIsoParts(m), hits)
  scanWith(text, SHORT_TIMESTAMP_SOURCE, (m) => parseShortParts(m, now), hits)
  return hits.sort((a, b) => a.index - b.index)
}

function scanWith(
  text: string,
  source: string,
  parse: (match: RegExpExecArray) => number | undefined,
  into: TimestampHit[],
): void {
  const re = new RegExp(source, "g")
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const ms = parse(match)
    if (ms !== undefined) into.push({ ms, index: match.index })
    if (match.index === re.lastIndex) re.lastIndex++ // zero-length guard
  }
}

function parseIsoParts(match: RegExpExecArray): number | undefined {
  return utcMs(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6] ?? 0),
  )
}

function parseShortParts(match: RegExpExecArray, now: number): number | undefined {
  const month = Number(match[1])
  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  const second = Number(match[5] ?? 0)
  const currentYear = new Date(now).getUTCFullYear()
  let ms = utcMs(currentYear, month, day, hour, minute, second)
  if (ms === undefined) return undefined
  if (ms < now - YEAR_ROLLOVER_GRACE_MS) {
    const rolled = utcMs(currentYear + 1, month, day, hour, minute, second)
    if (rolled !== undefined) ms = rolled
  }
  return ms
}

/**
 * Strict UTC construction: impossible calendar values (month 13, day 32,
 * Feb 30, hour 99) return undefined instead of silently rolling over — a
 * rolled-over date would be a fabricated reset time.
 */
function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined
  if (year < 1970 || year > 3000) return undefined
  if (month < 1 || month > 12) return undefined
  if (day < 1 || day > daysInMonth(year, month)) return undefined
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return undefined
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}