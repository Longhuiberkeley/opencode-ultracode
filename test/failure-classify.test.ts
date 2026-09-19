/**
 * Builder classify tests — src/failure-classify.ts: the three production
 * failure shapes (burst 429, 5-hour usage limit, 1-week token quota) plus
 * reset-timestamp parsing edge cases (never guess).
 */
import test from "node:test"
import assert from "node:assert/strict"
import { classifyFailure, parseResetTimestamp } from "../src/failure-classify.ts"

const MIN = 60_000
const HOUR = 60 * MIN

/** `2026-09-19 22:56:08` — the zoneless production format. */
function utcIso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ")
}

/** `09-19 13:10:00 UTC` — the year-less production format. */
function utcShort(ms: number): string {
  return `${new Date(ms).toISOString().slice(5, 19).replace("T", " ")} UTC`
}

// ---------------------------------------------------------------------------
// Production messages
// ---------------------------------------------------------------------------

test("classify: production burst — provider.rate-limit / 429, no reset", () => {
  const c = classifyFailure(
    { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
    "finish: error",
  )
  assert.equal(c.class, "burst")
  assert.equal(c.status, 429)
  assert.equal(c.message, "Rate limit reached for requests")
  assert.equal(c.resetAt, undefined)
  assert.match(c.reason, /rate-limit/)
})

test("classify: production quota — 'Usage limit reached for 5 hour' with ISO reset", () => {
  const reset = Date.now() + 5 * HOUR
  const c = classifyFailure({
    type: "provider.rate-limit",
    message: `Usage limit reached for 5 hour. Your limit will reset at ${utcIso(reset)}`,
    status: 429,
  })
  assert.equal(c.class, "quota")
  assert.ok(c.resetAt !== undefined)
  assert.ok(Math.abs(c.resetAt - reset) < 2_000, `resetAt ${c.resetAt} vs ${reset}`)
  assert.match(c.reason, /quota/)
})

test("classify: production quota — '1-week quota has been exhausted' with short UTC reset", () => {
  const reset = Date.now() + 3 * 24 * HOUR
  const c = classifyFailure({
    type: "provider.rate-limit",
    message: `Your token-plan 1-week quota has been exhausted. The quota will reset at ${utcShort(reset)}`,
    status: 429,
  })
  assert.equal(c.class, "quota")
  assert.ok(c.resetAt !== undefined && c.resetAt > Date.now() + MIN, `resetAt ${c.resetAt}`)
})

// ---------------------------------------------------------------------------
// Classification edges
// ---------------------------------------------------------------------------

test("classify: 429 without any markers => burst", () => {
  const c = classifyFailure({ status: 429 })
  assert.equal(c.class, "burst")
  assert.equal(c.resetAt, undefined)
})

test("classify: 429 with a future reset => quota", () => {
  const reset = Date.now() + 30 * MIN
  const c = classifyFailure(
    { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
    `Retry after ${utcIso(reset)}`,
  )
  assert.equal(c.class, "quota")
  assert.ok(c.resetAt !== undefined && c.resetAt > Date.now() + MIN)
})

test("classify: reset timestamp in the past => burst / no resetAt", () => {
  const c = classifyFailure({
    type: "provider.rate-limit",
    message: "Rate limit reached for requests. Retry after 2020-01-02 03:04:05",
    status: 429,
  })
  assert.equal(c.class, "burst")
  assert.equal(c.resetAt, undefined)
})

test("classify: no error object and no markers => other", () => {
  const c = classifyFailure(undefined, "something went wrong")
  assert.equal(c.class, "other")
  assert.equal(c.status, undefined)
  assert.equal(c.resetAt, undefined)
  assert.match(c.reason, /no quota or rate-limit/)
})

test("classify: quota markers beat rate-limit markers (quota wins)", () => {
  const c = classifyFailure({
    type: "provider.rate-limit",
    message: "Rate limit reached for requests — your 1-week quota has been exhausted",
    status: 429,
  })
  assert.equal(c.class, "quota")
})

test("classify: quota marker without a reset timestamp => quota, no resetAt", () => {
  const c = classifyFailure(undefined, "Usage limit reached for 5 hour")
  assert.equal(c.class, "quota")
  assert.equal(c.resetAt, undefined)
})

test("classify: bare 'rate limit' text without structured error => burst", () => {
  const c = classifyFailure(undefined, "provider said: rate limit reached for requests")
  assert.equal(c.class, "burst")
})

test("classify: a stray future date without reset wording does not quarantine", () => {
  const c = classifyFailure(undefined, `here are the dates: ${utcIso(Date.now() + 10 * MIN)}`)
  assert.equal(c.class, "other")
  assert.equal(c.resetAt, undefined)
})

test("classify: quota marker + unrelated future date in prose => quota, no resetAt", () => {
  const c = classifyFailure(
    undefined,
    `Usage limit reached for 5 hour. See you on ${utcIso(Date.now() + 10 * HOUR)} at the standup.`,
  )
  assert.equal(c.class, "quota")
  assert.equal(c.resetAt, undefined)
})

test("classify: quota marker with a contextual reset date still parses resetAt", () => {
  const reset = Date.now() + 5 * HOUR
  const c = classifyFailure(undefined, `Usage limit reached. Your limit will reset at ${utcIso(reset)}`)
  assert.equal(c.class, "quota")
  assert.ok(c.resetAt !== undefined)
  assert.ok(Math.abs(c.resetAt! - reset) < 2_000, `resetAt ${c.resetAt} vs ${reset}`)
})

test("classify: tolerates a numeric-string status from untrusted JSON", () => {
  const c = classifyFailure({ status: "429" as unknown as number })
  assert.equal(c.class, "burst")
  assert.equal(c.status, 429)
})

test("classify: reset already imminent (<2 min) is not treated as a quota reset", () => {
  const reset = Date.now() + 30_000
  const c = classifyFailure(
    { type: "provider.rate-limit", message: "Rate limit reached for requests", status: 429 },
    `Retry after ${utcIso(reset)}`,
  )
  assert.equal(c.class, "burst")
  assert.equal(c.resetAt, undefined)
})

// ---------------------------------------------------------------------------
// parseResetTimestamp
// ---------------------------------------------------------------------------

test("parseResetTimestamp: zoneless ISO is parsed as UTC", () => {
  const nowMs = Date.UTC(2026, 8, 19, 20, 0, 0)
  assert.equal(
    parseResetTimestamp("Your limit will reset at 2026-09-19 22:56:08", nowMs),
    Date.UTC(2026, 8, 19, 22, 56, 8),
  )
})

test("parseResetTimestamp: year-less UTC stamp uses the nearest year", () => {
  const nowMs = Date.UTC(2026, 8, 18, 12, 0, 0)
  assert.equal(
    parseResetTimestamp("The quota will reset at 09-19 13:10:00 UTC", nowMs),
    Date.UTC(2026, 8, 19, 13, 10, 0),
  )
})

test("parseResetTimestamp: year rollover across Dec -> Jan", () => {
  const nowMs = Date.UTC(2026, 11, 31, 1, 0, 0)
  assert.equal(parseResetTimestamp("reset at 01-02 03:04:05 UTC", nowMs), Date.UTC(2027, 0, 2, 3, 4, 5))
})

test("parseResetTimestamp: impossible/ambiguous timestamps => undefined (never guess)", () => {
  const nowMs = Date.UTC(2026, 8, 19, 20, 0, 0)
  assert.equal(parseResetTimestamp("will reset at 2026-02-30 10:00:00", nowMs), undefined)
  assert.equal(parseResetTimestamp("will reset at 2026-09-19 25:00:00", nowMs), undefined)
  assert.equal(parseResetTimestamp("resets soon", nowMs), undefined)
  assert.equal(parseResetTimestamp("", nowMs), undefined)
})