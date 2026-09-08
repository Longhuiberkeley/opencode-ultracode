/**
 * Slash-command parsing and keyword matching for /ultracode.
 *
 * Kept free of `@opencode/plugin` so unit tests can cover the matchers
 * without loading the plugin entry.
 */

/**
 * Standalone keyword anywhere in the prompt: whitespace-delimited, optionally
 * followed by a colon. Rejects path/id substrings (`opencode-ultracode`,
 * `ultracode_run`, `ultracode.js`, `/path/ultracode`).
 */
const KEYWORD = /(?:^|\s)ultracode(?=\s|:|$)/i

export function matchesUltracodeKeyword(text: string): boolean {
  return KEYWORD.test(text)
}

/** Strip a leading `/ultracode` token; remaining text is returned trimmed. */
export function commandArgs(promptText: string | undefined): string {
  const text = (promptText ?? "").trim()
  const token = /^\/ultracode\b/i.exec(text)
  return (token ? text.slice(token[0].length) : text).trim()
}

/** First token is the subcommand (lowercased); the rest is unparsed args. */
export function parseSubcommand(argsText: string): { sub: string; rest: string } {
  const trimmed = argsText.trim()
  if (trimmed === "") return { sub: "", rest: "" }
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  return { sub: (m?.[1] ?? "").toLowerCase(), rest: (m?.[2] ?? "").trim() }
}

export function helpText(): string {
  return [
    "Usage: /ultracode — inspect and manage workflow runs",
    "- `/ultracode` — active + recent runs and saved workflows",
    "- `/ultracode show <runID>` — full run report (agents, sessions, tokens, script)",
    "- `/ultracode stop <runID>` — stop an active run",
    "- `/ultracode save <runID> <name>` — save a run's script as a reusable workflow",
    "- `/ultracode trust <name>` — approve the current version of a saved workflow",
    "- `/ultracode result <runID>` — print a truncated run's full result",
    "- `/ultracode help` — this text",
    "",
    "To author a run, send a normal message containing the keyword `ultracode` (no leading slash), e.g. `please ultracode this` or `ultracode: audit src/auth`.",
  ].join("\n")
}
