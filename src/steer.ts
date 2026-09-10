import type { RunRecord } from "./types.ts"

/** Admit an adjustment to one owned, active child without restarting a finished loop. */
export async function steerRun(
  run: RunRecord | undefined,
  parentSessionID: string,
  input: { text: string; agentID?: string },
  prompt: (input: { sessionID: string; text: string; delivery: "steer"; resume: false }) => Promise<unknown>,
): Promise<{ sessionID: string; agentID: string }> {
  if (!run || run.parentSessionID !== parentSessionID) throw new Error("run does not belong to this conversation")
  if (run.status !== "running" && run.status !== "paused") throw new Error(`cannot steer a ${run.status} run`)
  if (!input.text.trim()) throw new Error("adjustment text is empty")
  const active = run.agents.filter((a) => a.status === "running" && a.sessionID)
  const selected = input.agentID ? active.filter((a) => a.id === input.agentID || a.sessionID === input.agentID) : active
  if (selected.length !== 1) throw new Error(`select exactly one running agent with agentID; active: ${active.map((a) => a.id).join(", ") || "none"}`)
  const target = selected[0]!
  await prompt({ sessionID: target.sessionID!, text: input.text, delivery: "steer", resume: false })
  return { sessionID: target.sessionID!, agentID: target.id }
}
