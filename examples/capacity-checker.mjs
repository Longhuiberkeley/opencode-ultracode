#!/usr/bin/env node
// Minimal capacity-v1 checker for ultracode `quotaSources`.
//
// It turns a small budget file you maintain (or a script that writes it) into the
// portable snapshot the router reads. Copy it, replace `readBudgets` with calls
// to your providers' usage APIs, and register it:
//
//   opencode2 ultracode-config capacity source team-monthly capacity-v1 node /path/to/capacity-checker.mjs
//   opencode2 ultracode-config capacity bind strong anthropic/claude-opus-5-5 team-monthly
//   opencode2 ultracode-config capacity status team-monthly
//
// Contract (docs/MODEL-ROUTING.md → "Capacity feeds"): print ONE JSON object on
// stdout and exit 0; anything else (non-zero exit, timeout, malformed JSON)
// reads as "unknown" for every pool this checker serves.
//
// Budget file format (default ~/.config/opencode/capacity-budgets.json):
//   { "team-monthly": { "limit": 300, "used": 118 },
//     "anthropic-weekly": { "windows": [{ "remainingPercent": 72 }, { "remainingPercent": 15 }] },
//     "openrouter-key": { "remainingPercent": 44, "expiresAt": "2026-10-22T00:00:00Z" } }
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const file = process.argv[2] ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"), "opencode", "capacity-budgets.json")

async function readBudgets() {
  return JSON.parse(await readFile(file, "utf8"))
}

function clamp(value) {
  return Math.max(0, Math.min(100, Number(value)))
}

function toPool(id, entry) {
  let windows
  if (Array.isArray(entry?.windows)) windows = entry.windows.map((w) => ({ remainingPercent: clamp(w.remainingPercent) }))
  else if (Number.isFinite(entry?.remainingPercent)) windows = [{ remainingPercent: clamp(entry.remainingPercent) }]
  else if (Number.isFinite(entry?.limit) && Number.isFinite(entry?.used) && entry.limit > 0) windows = [{ remainingPercent: clamp(100 * (1 - entry.used / entry.limit)) }]
  else return { id, status: "unknown", windows: [] } // malformed entry: unknown, never unlimited
  const pool = { id, status: "ok", windows }
  if (typeof entry.expiresAt === "string") pool.expiresAt = entry.expiresAt
  return pool
}

try {
  const budgets = await readBudgets()
  const pools = Object.entries(budgets).map(([id, entry]) => toPool(id, entry))
  process.stdout.write(JSON.stringify({ pools }) + "\n")
} catch (err) {
  // Fail loudly: the router treats a non-zero exit as unknown and logs the cause.
  process.stderr.write(`capacity-checker: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
