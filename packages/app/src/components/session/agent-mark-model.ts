/**
 * Which mark an agent session wears (#192985). Pure: the provider the daemon reports in, a mark out.
 * A tool we have no mark for gets a neutral tile with its initial — never someone else's logo.
 */
export type AgentMarkKind = "claude" | "codex" | "gemini" | "iris" | "ollama" | "other"

const MARKS: Record<string, AgentMarkKind> = {
  claude_code: "claude",
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  gemini_cli: "gemini",
  opencode: "iris",
  iris: "iris",
  ollama: "ollama",
}

export const markOf = (provider: string): AgentMarkKind => MARKS[provider.toLowerCase()] ?? "other"
