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
 *
 * v0.12: `disabled: true` frontmatter (subagent-config disable) and
 * `disabled_providers` (subagent-config provider off) are respected —
 * disabled agents are never usable, pins on offline providers are skipped.
 */

import type { FsLike } from "./types.ts"
import type { PinPoolEntry } from "./failover.ts"

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
 * True when the frontmatter carries `disabled: true` (unquoted or quoted,
 * case-insensitive) — what `opencode2 subagent-config` writes when an agent
 * is turned off. The file still exists, so existence alone is NOT usability.
 */
export function parseAgentFrontmatterDisabled(content: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!m) return false
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^disabled:\s*(\S+)\s*$/.exec(line)
    if (kv) {
      const value = kv[1]!.replace(/^["']|["']$/g, "").toLowerCase()
      return value === "true" || value === "yes"
    }
  }
  return false
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

/**
 * Normalize an explicit model override (call-site `opts.model` or the run tool
 * input `model`): accepts the pin string shape ("provider/id#variant") or the
 * expanded object { providerID, id, variant? }. Unlike config pins (which SKIP
 * unreadable/offline values), an override the caller spelled wrong is an ERROR
 * — fail the call fast instead of silently spawning on a default.
 */
export function normalizeModelRef(
  raw: unknown,
): { ok: true; model: { providerID: string; id: string; variant?: string } } | { ok: false; error: string } {
  if (typeof raw === "string") {
    const parsed = parseModelPin(raw)
    if (parsed === undefined) {
      return {
        ok: false,
        error: `model must be "provider/id" or "provider/id#variant", got ${JSON.stringify(raw)}`,
      }
    }
    return { ok: true, model: parsed }
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as { providerID?: unknown; id?: unknown; variant?: unknown }
    if (typeof o.providerID === "string" && typeof o.id === "string" && o.providerID !== "" && o.id !== "") {
      if (!/^[A-Za-z0-9._-]+$/.test(o.providerID)) {
        return { ok: false, error: `model.providerID must match the provider id charset [A-Za-z0-9._-], got ${JSON.stringify(o.providerID)}` }
      }
      if (/[#/\s]/.test(o.id)) {
        return { ok: false, error: `model.id must be the bare model id (no provider/ or #variant), got ${JSON.stringify(o.id)}` }
      }
      const model: { providerID: string; id: string; variant?: string } = { providerID: o.providerID, id: o.id }
      if (typeof o.variant === "string" && o.variant !== "") {
        if (/[#\s]/.test(o.variant)) {
          return { ok: false, error: `model.variant must not contain "#" or whitespace, got ${JSON.stringify(o.variant)}` }
        }
        model.variant = o.variant
      }
      return { ok: true, model }
    }
    return { ok: false, error: `model object must be { providerID, id, variant? }, got ${JSON.stringify(raw)}` }
  }
  return { ok: false, error: `model must be "provider/id" or { providerID, id, variant? }, got ${JSON.stringify(raw)}` }
}

/**
 * Model strings referenced by a workflow body/spec (trust surfacing): scan for
 * pin-shaped literals in `model:` option position and return the deduped list.
 * Deliberately conservative — a false negative only hides a hint from the
 * trust listing (the digest still covers the executable body); a false
 * positive would require a pin-shaped string literal after `model:`.
 */
export function scanModelRefs(text: string): string[] {
  const out = new Set<string>()
  const re = /model\s*:\s*["'`]([^"'`\n]+)["'`]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const parsed = parseModelPin(m[1]!)
    if (parsed !== undefined) out.add(m[1]!.trim())
    if (out.size >= 16) break // bounded — 16 distinct model ids is far past any real workflow
  }
  return [...out].sort()
}

async function readPin(fs: FsLike, path: string): Promise<string | undefined> {
  try {
    if (!(await fs.exists(path))) return undefined
    const content = await fs.readFile(path)
    if (parseAgentFrontmatterDisabled(content)) return undefined // disabled file — not usable
    return parseAgentFrontmatterModel(content)
  } catch {
    return undefined // unreadable pin file — fall through to defaults
  }
}

/**
 * Resolve the pinned model for an agent id: project `.opencode/agents/`
 * beats `~/.config/opencode/agents/`. Returns undefined when unpinned.
 * A project file that exists but is `disabled: true` WINS over the global
 * file (project precedence) — a disabled project definition does not fall
 * through to a stale global pin.
 */
export async function lookupAgentPin(
  fs: FsLike,
  projectRoot: string,
  homeDir: string,
  agentId: string,
): Promise<string | undefined> {
  if (!AGENT_ID_RE.test(agentId)) return undefined
  const projectPath = `${projectRoot}/.opencode/agents/${agentId}.md`
  const globalPath = `${homeDir}/.config/opencode/agents/${agentId}.md`
  try {
    if (await fs.exists(projectPath)) {
      const content = await fs.readFile(projectPath)
      if (parseAgentFrontmatterDisabled(content)) return undefined
      return parseAgentFrontmatterModel(content)
    }
  } catch {
    // unreadable project file — fall through to the global lookup
  }
  return readPin(fs, globalPath)
}

/**
 * True when the agent has a definition file (project or global agents dir)
 * that is NOT `disabled: true` — the usable set `opencode2 subagent-config`
 * manages (enable/disable/add). Backs the `agentScope: "configured"` option:
 * shipped agents (e.g. `build`) count only once the user creates their file,
 * and disabled agents (file still on disk) do not count at all.
 */
export async function agentConfigured(
  fs: FsLike,
  projectRoot: string,
  homeDir: string,
  agentId: string,
): Promise<boolean> {
  if (!AGENT_ID_RE.test(agentId)) return false
  // Per-file try/catch: an UNREADABLE project file falls through to the
  // global check (mirrors lookupAgentPin) instead of failing closed.
  for (const path of [`${projectRoot}/.opencode/agents/${agentId}.md`, `${homeDir}/.config/opencode/agents/${agentId}.md`]) {
    try {
      if (!(await fs.exists(path))) continue
      if (parseAgentFrontmatterDisabled(await fs.readFile(path))) return false
      return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * Provider ids the user took offline (`disabled_providers` in the global or
 * project opencode.json — what `opencode2 subagent-config provider off`
 * writes). Best-effort disk read of the SAME documented config the client
 * reads: malformed or missing files contribute nothing (fail open).
 */
export async function readDisabledProviders(
  fs: FsLike,
  projectRoot: string,
  homeDir: string,
): Promise<ReadonlySet<string>> {
  const paths = [
    `${homeDir}/.config/opencode/opencode.json`,
    `${projectRoot}/opencode.json`,
    `${projectRoot}/.opencode/opencode.json`,
  ]
  const out = new Set<string>()
  for (const path of paths) {
    try {
      if (!(await fs.exists(path))) continue
      const raw = JSON.parse(await fs.readFile(path)) as unknown
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue
      const list = (raw as { disabled_providers?: unknown }).disabled_providers
      if (!Array.isArray(list)) continue
      for (const p of list) if (typeof p === "string" && p.length > 0) out.add(p)
    } catch {
      // unreadable/invalid config — contributes nothing
    }
  }
  return out
}

/**
 * Resolve the failover pin pool: every usable agent-config pin across the
 * given agent ids, tagged with its agent id. Disabled agents (`disabled:
 * true`) contribute nothing (project-disabled blocks a stale global file via
 * lookupAgentPin) and pins on providers in `disabled_providers` are skipped —
 * the failover ladder must never route onto a provider the user took offline
 * or reuse a model choice from an agent they turned off. Lookups are the SAME
 * project-beats-global resolution the spawn path uses, so re-pinning applies
 * to the next failover exactly as it applies to the next spawn. Never throws;
 * unreadable files just contribute nothing.
 */
export async function collectAgentPins(
  fs: FsLike,
  projectRoot: string,
  homeDir: string,
  agentIds: readonly string[],
): Promise<PinPoolEntry[]> {
  let disabledProviders: ReadonlySet<string> = new Set()
  try {
    disabledProviders = await readDisabledProviders(fs, projectRoot, homeDir)
  } catch {
    // best-effort — fail open (mirrors the spawn-path pin resolution)
  }
  const out: PinPoolEntry[] = []
  const seenAgents = new Set<string>()
  for (const agentID of agentIds) {
    if (typeof agentID !== "string" || agentID.length === 0 || seenAgents.has(agentID)) continue
    seenAgents.add(agentID)
    const pin = await lookupAgentPin(fs, projectRoot, homeDir, agentID)
    if (pin === undefined) continue
    const parsed = parseModelPin(pin)
    if (parsed === undefined) continue
    if (disabledProviders.has(parsed.providerID)) continue
    out.push({ agentID, pin })
  }
  return out
}

/**
 * Usability gate for `agentScope: "configured"`: the agent must be configured
 * AND not disabled, and if it carries a model pin, that pin's provider must
 * not be offline. Unpinned agents pass (no provider to check — fail open);
 * the offline check also guards the default-agent pin inheritance path.
 */
export async function agentUsable(
  fs: FsLike,
  projectRoot: string,
  homeDir: string,
  agentId: string,
  disabledProviders: ReadonlySet<string>,
): Promise<boolean> {
  if (!(await agentConfigured(fs, projectRoot, homeDir, agentId))) return false
  const pin = await lookupAgentPin(fs, projectRoot, homeDir, agentId)
  if (pin === undefined) return true
  const parsed = parseModelPin(pin)
  if (parsed === undefined) return true
  return !disabledProviders.has(parsed.providerID)
}
