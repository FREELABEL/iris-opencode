/**
 * IRIS agents as opencode agents (#189425).
 *
 * Each of the account's IRIS agents becomes an `agents/iris-<name>.md` file in the
 * opencode config dir, so it shows up in the Desktop app and the TUI agent picker.
 *
 * Two things here were learned by shipping them wrong on 2026-10-14:
 *
 * 1. FULL TOOLS BY DEFAULT. The first hand-written versions denied read/edit/shell and
 *    told the model it was "only a proxy". That made the agents useless for the job
 *    they exist for — clients process their own (often patient) data locally, on their
 *    own machine. Grounding comes from the PROMPT (IRIS facts come from the IRIS agent,
 *    never from training data), not from taking tools away. Only commands that cannot
 *    be undone ask first.
 *
 * 2. THE KEY IS `permission:` (singular) AND IT IS A MAP. `permissions:` is silently
 *    ignored — every deny in it resolved to allow, nothing said so. A list under
 *    `permission:` is a ConfigInvalidError that stops the Desktop app from opening at
 *    all. `desktop-agents.test.ts` pins the shape.
 */
import { isDiscoverable, type RawAgent } from "../cmd/platform-intent-agents"

/** Frontmatter comment that marks a file as ours. A file without it is hand-written and never touched. */
export const DESKTOP_AGENT_MARKER = "# generated-by: iris agents desktop-sync — edits are overwritten"

export const DESKTOP_AGENT_PREFIX = "iris-"

/** Irreversible commands confirm first. Everything else — including reading and editing local data — does not. */
export const ASK_FIRST = ["rm -rf *", "git push *", "git reset --hard*"] as const

export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")
}

/** Stable file stem per agent. Name collisions (and names that slug to nothing) get the id appended. */
export function fileStems(agents: RawAgent[]): Map<number, string> {
  const base = new Map(agents.map((a) => [a.id, slugify(a.name)]))
  const counts = new Map<string, number>()
  for (const s of base.values()) counts.set(s, (counts.get(s) ?? 0) + 1)
  const out = new Map<number, string>()
  for (const a of agents) {
    const s = base.get(a.id)!
    out.set(a.id, DESKTOP_AGENT_PREFIX + (!s ? `agent-${a.id}` : counts.get(s)! > 1 ? `${s}-${a.id}` : s))
  }
  return out
}

function oneLine(s: string | null | undefined, max = 160): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t
}

export function renderDesktopAgent(a: RawAgent): string {
  const name = a.name.trim()
  const what = oneLine(a.description)
  const description = `${name} (IRIS agent #${a.id})${what ? ` — ${what}` : ""}`
  return [
    "---",
    DESKTOP_AGENT_MARKER,
    `description: ${JSON.stringify(description)}`,
    "mode: all",
    "permission:",
    "  bash:",
    `    "*": allow`,
    ...ASK_FIRST.map((p) => `    ${JSON.stringify(p)}: ask`),
    "---",
    "",
    `You are **${name}**, IRIS agent #${a.id}, working on this machine with full tools —`,
    "read, edit and create files, run commands, search the web, and spawn subagents.",
    ...(what ? ["", `Your role: ${what}`] : []),
    "",
    "You have two sources of truth. Use the right one:",
    "",
    "- **Grounded IRIS knowledge** — anything about records, cases, clients, datasets,",
    "  knowledge bases or memory that live in IRIS. Never answer these from your own",
    "  training data. Get them from the IRIS agent: the IRIS OS MCP agent-chat tool with",
    `  agent id ${a.id}, or \`iris agents chat ${a.id} "<question>"\`. Quote what it returns;`,
    "  if it errors, say so rather than inventing a substitute.",
    "- **Local work** — files, code, documents, scripts, builds, and the data on this",
    "  machine. Do it directly with your own tools. You don't need to route this through IRIS.",
    "",
    "Most real tasks use both: pull the facts from IRIS, then do the work locally.",
    "",
  ].join("\n")
}

export function isGeneratedDesktopAgent(existing: string | null): boolean {
  return existing === null || existing.includes(DESKTOP_AGENT_MARKER)
}

export type SyncPlan = {
  write: { file: string; id: number; name: string; content: string }[]
  /** Generated files whose agent is gone (deleted, deactivated, turned into a test agent). */
  remove: string[]
  /** Files at a path we would write that a person wrote by hand. */
  handWritten: string[]
}

/**
 * Pure: given the account's agents and what is already in the dir, decide what to do.
 * `existing` maps file name → content for every `.md` file in the agents dir.
 */
export function planDesktopSync(agents: RawAgent[], existing: Map<string, string>, only?: Set<number>): SyncPlan {
  const pool = agents.filter(isDiscoverable).filter((a) => !only || only.has(a.id))
  const stems = fileStems(pool)
  const plan: SyncPlan = { write: [], remove: [], handWritten: [] }
  const wanted = new Set<string>()
  for (const a of pool) {
    const file = `${stems.get(a.id)}.md`
    wanted.add(file)
    const prev = existing.get(file) ?? null
    if (!isGeneratedDesktopAgent(prev)) {
      plan.handWritten.push(file)
      continue
    }
    const content = renderDesktopAgent(a)
    if (prev !== content) plan.write.push({ file, id: a.id, name: a.name, content })
  }
  // A filtered sync (--agent) must not delete everyone else's file.
  if (!only) {
    for (const [file, content] of existing) {
      if (!wanted.has(file) && content.includes(DESKTOP_AGENT_MARKER)) plan.remove.push(file)
    }
  }
  return plan
}
