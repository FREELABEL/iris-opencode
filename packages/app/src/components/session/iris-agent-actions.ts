/**
 * What an agent's IRIS write did, as a sentence (#194362).
 *
 * In chat the agent's writes read as `iris bloqs add-item 952 3405 "Ethan Okafor (Blue Mesa Yoga) —
 * \$40k" --t…`: board ids, list ids and shell quoting, cut off mid-line. This reads the same command
 * the way a person would say it — "Added Ethan Okafor — Blue Mesa Yoga ($40k)" to "Atlas › Call
 * today" — using names the panel has already read for the ids. Pure: no Solid, no DOM.
 */
import { irisCommandWrites } from "./iris-agent-writes"

export type AgentAction = {
  /** One glyph for the kind of change. */
  icon: "plus" | "move" | "edit" | "note" | "publish" | "remove" | "run"
  title: string
  /** Where it landed, e.g. "Atlas › Call today". */
  target?: string
  /** The command exactly as run, for the disclosure. */
  command: string
  /** Where "Open" goes in the side panel. */
  nav?: { surface: string; sub?: string; bloqId?: number; itemId?: number }
}

export type Names = {
  lead: (id: number) => string | undefined
  list: (id: number) => string | undefined
  board: (id: number) => string | undefined
}
const NO_NAMES: Names = { lead: () => undefined, list: () => undefined, board: () => undefined }

/**
 * Split a shell line into words the way sh would quote them: '…' is literal, "…" keeps `\"`,
 * `\$`, `\\` and `` \` `` as the character, a bare `\x` is x. Stops at the first `;`, `&&`, `||` or `|`
 * outside quotes — the first command is the one described.
 */
export function shellWords(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let has = false
  let i = 0
  const push = () => {
    if (has) out.push(cur)
    cur = ""
    has = false
  }
  while (i < line.length) {
    const c = line[i]!
    if (c === "'") {
      const end = line.indexOf("'", i + 1)
      cur += end < 0 ? line.slice(i + 1) : line.slice(i + 1, end)
      has = true
      i = end < 0 ? line.length : end + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < line.length && line[i] !== '"') {
        if (line[i] === "\\" && i + 1 < line.length && '"$`\\'.includes(line[i + 1]!)) {
          cur += line[i + 1]
          i += 2
          continue
        }
        cur += line[i]
        i++
      }
      has = true
      i++
      continue
    }
    if (c === "\\" && i + 1 < line.length) {
      cur += line[i + 1]
      has = true
      i += 2
      continue
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      push()
      break
    }
    if (/\s/.test(c)) {
      push()
      i++
      continue
    }
    cur += c
    has = true
    i++
  }
  push()
  return out
}

/** The `iris …` words of a command line: from the `iris` word (bare or a path to it), env and `cd x &&` skipped. */
export function irisWords(line: string): string[] | undefined {
  // Only the segment that runs iris: `cd ~/x && iris leads update 1` describes the second.
  const seg = line.split(/&&|\|\||;/).find((s) => /(^|[\s/])iris(\s|$)/.test(s.trim()))
  if (!seg) return undefined
  const words = shellWords(seg.trim())
  const at = words.findIndex((w) => w === "iris" || /\/iris$/.test(w))
  return at < 0 ? undefined : words.slice(at + 1)
}

/** `--status Contacted`, `--status=Contacted`. */
function flag(words: string[], name: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w === `--${name}`) return words[i + 1]
    if (w.startsWith(`--${name}=`)) return w.slice(name.length + 3)
  }
  return undefined
}
const positional = (words: string[]) => {
  const out: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (w.startsWith("--")) {
      if (!w.includes("=") && i + 1 < words.length && !words[i + 1]!.startsWith("--")) i++
      continue
    }
    if (w.startsWith("-") && w.length === 2) {
      i++
      continue
    }
    out.push(w)
  }
  return out
}
const num = (s: string | undefined) => (s && /^\d+$/.test(s) ? Number(s) : undefined)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Describe one `iris …` command line, or undefined when it does not write. */
export function describeIrisCommand(line: string, names: Names = NO_NAMES): AgentAction | undefined {
  if (!irisCommandWrites(line)) return undefined
  const words = irisWords(line)
  if (!words?.length) return undefined
  const command = line.trim()
  const [group = "", verb = "", ...rest] = words
  const args = positional(rest)
  const g = group.toLowerCase()
  const v = verb.toLowerCase()

  if (g === "bloqs" || g === "atlas" || g === "boards") {
    const bloq = num(args[0])
    if (v === "create-list" || v === "add-list") {
      const listName = args[1] ?? flag(rest, "name")
      const board = bloq ? names.board(bloq) : undefined
      return {
        icon: "plus",
        title: listName ? `Created the list ${listName}` : "Created a list",
        target: board ? `Atlas › ${board}` : "Atlas",
        command,
        nav: { surface: "atlas", sub: "lists", bloqId: bloq },
      }
    }
    if (v === "add-item" || v === "create-item" || v === "add-card") {
      const list = num(args[1])
      const title = args[2] ?? flag(rest, "title")
      const listName = list ? names.list(list) : undefined
      return {
        icon: "plus",
        title: title ? `Added ${title}` : "Added a card",
        target: listName ? `Atlas › ${listName}` : "Atlas",
        command,
        nav: { surface: "atlas", sub: "lists", bloqId: bloq },
      }
    }
    if (/move/.test(v)) {
      const list = num(flag(rest, "list") ?? args[1])
      const listName = list ? names.list(list) : undefined
      return { icon: "move", title: listName ? `Moved a card to ${listName}` : "Moved a card", target: "Atlas", command, nav: { surface: "atlas", sub: "lists" } }
    }
    if (/(delete|remove|archive)/.test(v)) return { icon: "remove", title: "Removed a card", target: "Atlas", command, nav: { surface: "atlas", sub: "lists" } }
    return { icon: "edit", title: "Updated a card", target: "Atlas", command, nav: { surface: "atlas", sub: "lists" } }
  }

  if (g === "leads" || g === "lead") {
    const id = num(args[0])
    const who = (id ? names.lead(id) : undefined) ?? (id ? `lead #${id}` : "a lead")
    const status = flag(rest, "status") ?? flag(rest, "stage")
    if ((v === "update" || v === "set" || v === "move") && status)
      return { icon: "move", title: `Moved ${who} to ${status}`, target: "Leads", command, nav: { surface: "leads", sub: "all" } }
    if (/note|comment/.test(v)) return { icon: "note", title: `Added a note to ${who}`, target: "Leads", command, nav: { surface: "leads", sub: "all" } }
    if (v === "create" || v === "add" || v === "new" || v === "import") {
      const name = flag(rest, "name") ?? (id ? undefined : args[0])
      return { icon: "plus", title: name ? `Added the lead ${name}` : "Added leads", target: "Leads", command, nav: { surface: "leads", sub: "all" } }
    }
    if (/(delete|remove|archive)/.test(v)) return { icon: "remove", title: `Removed ${who}`, target: "Leads", command, nav: { surface: "leads", sub: "all" } }
    return { icon: "edit", title: `Updated ${who}`, target: "Leads", command, nav: { surface: "leads", sub: "all" } }
  }

  if (g === "pages" || g === "genesis") {
    const page = args[0]
    if (/^publish/.test(v)) return { icon: "publish", title: page ? `Published ${page}` : "Published a page", target: "Genesis", command, nav: { surface: "pages" } }
    return { icon: "edit", title: page ? `Updated the page ${page}` : "Updated a page", target: "Genesis", command, nav: { surface: "pages" } }
  }

  if (g === "playbook" || g === "playbooks") {
    if (v === "run") return { icon: "run", title: args[0] ? `Ran the playbook ${args[0]}` : "Ran a playbook", target: "Playbooks", command, nav: { surface: "playbooks" } }
    if (v === "install") return { icon: "plus", title: args[0] ? `Installed ${args[0]}` : "Installed a playbook", target: "Playbooks", command, nav: { surface: "playbooks" } }
  }

  return { icon: "edit", title: `${cap(verb.replace(/-/g, " "))} in ${cap(group)}`, command }
}

interface PartLike {
  type?: string
  tool?: string
  state?: { status?: string; input?: any }
}

/** A chat tool call, described — shell `iris …` and the IRIS MCP `iris_run`. Reads stay undescribed. */
export function describeAgentAction(part: PartLike, names: Names = NO_NAMES): AgentAction | undefined {
  if (part?.type !== "tool" || !part.tool) return undefined
  const input = part.state?.input ?? {}
  if (part.tool === "bash" || part.tool === "shell") return typeof input.command === "string" ? describeIrisCommand(input.command, names) : undefined
  if (/(^|_)iris_run$/i.test(part.tool)) {
    const cmd = typeof input.command === "string" ? input.command : Array.isArray(input.args) ? input.args.join(" ") : ""
    return cmd ? describeIrisCommand(`iris ${cmd.replace(/^\s*iris\s+/, "")}`, names) : undefined
  }
  return undefined
}
