import { marked } from "marked"

/**
 * Shared by the panel and the card editor. Lives apart from both so neither imports the other:
 * a module cycle between a 2,300-line tab and the dialog it opens is the kind of thing that
 * works until a test imports one of them first.
 */

/**
 * The commands that act on ONE Atlas item, by id.
 *
 * Kept as data rather than markup so the set is one list to extend, and so the strings can be
 * asserted: an id pasted into the wrong verb is a command that runs and does the wrong thing,
 * which is worse than one that fails.
 */
export function itemCommands(id: number): { label: string; cmd: string }[] {
  return [
    { label: "use", cmd: `iris atlas use ${id}` },
    { label: "show", cmd: `iris bloqs get-item ${id}` },
    { label: "edit", cmd: `iris bloqs update-item ${id} --content "…"` },
    { label: "assign", cmd: `iris agents assign <agent-id> --item ${id}` },
    { label: "share", cmd: `iris bloqs make-public ${id}` },
  ]
}

/**
 * Markdown -> HTML, synchronously.
 *
 * `marked` is already an app dependency. The MarkedProvider in @opencode-ai/ui is not mounted
 * anywhere in this app, so useMarked() would throw — that provider adds shiki highlighting and
 * katex, which this panel does not need to read a board item.
 */
export function renderMarkdown(md: string): string {
  try {
    return marked.parse(md, { async: false }) as string
  } catch {
    return ""
  }
}
