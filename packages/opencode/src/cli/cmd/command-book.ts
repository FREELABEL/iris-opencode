import book from "../../../command-book.json"
import capabilities from "../../../capabilities.json"

/**
 * The book (#193064): every IRIS CLI command and what it does — read · own_write · shared_write ·
 * shared_overwrite · egress · payment, or unclassified. It lives in fl-iris-api (config/cli-commands.yaml);
 * command-book.json is a generated copy (script/sync-command-book.ts), embedded at build time like
 * capabilities.json so the shipped binary carries it. Never edit the copy: edit the book, then sync.
 */
export type Effect = "read" | "own_write" | "shared_write" | "shared_overwrite" | "egress" | "payment" | "unclassified"
const COMMANDS = (book as { commands: Record<string, Effect> }).commands
const ACTIONS = ((book as { actions?: Record<string, Record<string, Effect>> }).actions ?? {}) as Record<string, Record<string, Effect>>

// Aliases, from the CLI's own declarations: "bloqs" names `atlas`, "bug submit" names `bug report`.
// Keyed by the typed path (parent already canonical) → the canonical last word.
const ALIASES = new Map<string, string>()
for (const e of (capabilities as any).entries as Array<{ kind: string; run: string; aliases?: string[] }>) {
  if (e.kind !== "command" || !e.aliases?.length) continue
  const name = commandName(e.run).split(" ")
  const parent = name.slice(0, -1)
  for (const a of e.aliases) ALIASES.set([...parent, a].join(" "), name[name.length - 1])
}

/** A command line with every alias replaced by the command it names, word by word. */
export function canonical(command: string): string {
  const out: string[] = []
  for (const w of command.replace(/^iris\s+/, "").split(/\s+/).filter(Boolean)) {
    if (w.startsWith("-")) {
      out.push(w)
      continue
    }
    out.push(ALIASES.get([...out.filter((x) => !x.startsWith("-")), w].join(" ")) ?? w)
  }
  return out.join(" ")
}

/** "iris hive schedule pause <id>" → "hive schedule pause" — the same rule as fl-iris-api's sync script. */
export function commandName(run: string): string {
  return run
    .replace(/^iris\s+/, "")
    .split(/\s+/)
    .filter((w) => w && !/^[<[]/.test(w) && !w.includes(".."))
    .join(" ")
}

/** The effect of a command line, by its longest prefix the book knows. Unknown is unclassified, never read. */
export function effectOf(command: string): Effect {
  const words = canonical(command).split(/\s+/).filter((w) => w && !w.startsWith("-"))
  for (let n = Math.min(words.length, 6); n > 0; n--) {
    const name = words.slice(0, n).join(" ")
    const hit = COMMANDS[name]
    if (!hit) continue
    // `hive tasks create …`: an action taken as an argument decides; anything else (an id, nothing) is the default.
    const action = ACTIONS[name]?.[words[n] ?? ""]
    return action ?? hit
  }
  return "unclassified"
}

/** The words after the book's matched prefix: what a dry run must still look at (`heartbeats pause 3`). */
export function argsAfterMatch(command: string): string[] {
  const words = canonical(command).split(/\s+/).filter((w) => w && !w.startsWith("-"))
  for (let n = Math.min(words.length, 6); n > 0; n--) if (COMMANDS[words.slice(0, n).join(" ")]) return words.slice(n)
  return words
}
