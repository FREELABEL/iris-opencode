// [IRIS] Which engine answers a command line (§7.4 C1). Pure, so it is tested without a binary.
//
// v2 owns its own command names; everything else (210+ platform names, upgrades, `mcp`, `auth`,
// `help`, namespaced `x:y`, typos) routes to the vendored v1 layer.
export const V2_OWNED = new Set([
  "run", "serve", "acp", "api", "debug", "models", "mini", "session",
  "service", "plugin", "pair", "reload",
])

// The ACP CLIENT is ours and lives in the v1 layer (#191163): `iris acp run|agents|sessions`
// drives Claude Code, Codex, Gemini, opencode or IRIS over the Agent Client Protocol. Bare
// `iris acp` — the ACP SERVER editors launch — stays v2's.
export const V1_ACP_SUBCOMMANDS = new Set(["run", "agents", "sessions"])

export function routesToV2(argv: string[]): boolean {
  const first = argv[0]
  const help = first === "--help" || first === "-h" || first === "help"
  if (help || first === "uninstall") return false
  if (first === undefined) return true
  const head = first.split(":")[0]
  if (head === "acp" && V1_ACP_SUBCOMMANDS.has(argv[1] ?? "")) return false
  // v2's ROOT flags (-c/--continue, -s/--session, --prompt, --standalone, --server, --auto, …) and
  // its [directory] positional open the TUI too. A directory contains "/" or ".", so a plain word
  // is still read as a command.
  return V2_OWNED.has(head) || first.startsWith("-") || first.includes("/") || first.includes(".")
}
