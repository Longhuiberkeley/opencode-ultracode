/**
 * Agent model-pin resolution (v0.2.0 hotfix).
 *
 * Why this exists: sessions created through `ctx.session.create({ agent })` do
 * NOT apply global agent model pins — the client's task tool does, but the
 * server's session-create path falls back to the location default model
 * (observed live 2026-09-09: `agent: "explore"` ran on a free OpenRouter
 * default while the native task-tool subagent ran on the pinned model).
 *
 * Fix: read the SAME documented, public config the client reads —
 *   <project>/.opencode/agents/<id>.md  (project override)
 *   ~/.config/opencode/agents/<id>.md   (global)
 * — and pass the frontmatter `model:` value as `model` at create time
 * (verified accepted by session.create; see docs/SPIKE-FINDINGS.md).
 *
 * Lookups are per-call, so re-pinning an agent applies to the NEXT spawned
 * child (hot reload, matching the documented cost-control behavior).
 */

import type { FsLike } from "./types.ts"

/** Agent ids are file names; keep them boring. */
const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,63}$/

/**
 * Parse the `model:` key from a leading YAML frontmatter block.
 * Returns the raw value (e.g. `xai/grok-4.6#medium`) or undefined.
 */
export function parseAgentFrontmatterModel(content: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return undefined
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^model:\s*(\S+)\s*$/.exec(line)
    if (kv) return kv[1]
  }
  return undefined
}

/**
 * Parse a config pin string ("provider/id" or "provider/id#variant") into the
 * object `session.create` expects (verified against the @opencode/plugin SDK
 * types: model is { providerID, id, variant? }). Returns undefined on shapes
 * that do not look like provider/id pins.
 */
export function parseModelPin(pin: string): { providerID: string; id: string; variant?: string } | undefined {
  const m = /^([A-Za-z0-9._-]+)\/([^#/\s]+)(?:#([^#\s]+))?$/.exec(pin.trim())
  if (!m) return undefined
  const out: { providerID: string; id: string; variant?: string } = { providerID: m[1]!, id: m[2]! }
  if (m[3] !== undefined) out.variant = m[3]
  return out
}

async function readPin(fs: FsLike, path: string): Promise<string | undefined> {
  try {
    if (!(await fs.exists(path))) return undefined
    const content = await fs.readFile(path)
    return parseAgentFrontmatterModel(content)
  } catch {
    return undefined // unreadable pin file — fall through to defaults
  }
}

/**
 * Resolve the pinned model for an agent id: project `.opencode/agents/`
 * beats `~/.config/opencode/agents/`. Returns undefined when unpinned.
 */
export async function lookupAgentPin(
  fs: FsLike,
  projectRoot: string,
  homeDir: string,
  agentId: string,
): Promise<string | undefined> {
  if (!AGENT_ID_RE.test(agentId)) return undefined
  const project = await readPin(fs, `${projectRoot}/.opencode/agents/${agentId}.md`)
  if (project !== undefined) return project
  return readPin(fs, `${homeDir}/.config/opencode/agents/${agentId}.md`)
}
