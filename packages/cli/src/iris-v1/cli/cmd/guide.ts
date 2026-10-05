import { cmd } from "./cmd"
import { CATEGORIES } from "./command-groups"
import { renderGroupedHelp, renderTopicHelp } from "../help-renderer"
import { UI } from "../ui"
import { EOL } from "os"

export const GuideCommand = cmd({
  command: "guide [topic]",
  aliases: ["topics"],
  describe: "show categorized help — list topics or deep-dive into one",
  builder: (y) =>
    y.positional("topic", {
      type: "string",
      describe: "category to show (e.g. crm, agents, pages, atlas)",
    }),
  async handler(args) {
    if (!args.topic) {
      const S = UI.Style
      const lines: string[] = []
      lines.push("")
      lines.push(
        `  ${S.TEXT_HIGHLIGHT_BOLD}IRIS CLI — Command Guide${S.TEXT_NORMAL}`,
      )
      lines.push("")

      const sortedCats = Object.entries(CATEGORIES).sort(
        ([, a], [, b]) => a.order - b.order,
      )
      for (const [key, cat] of sortedCats) {
        const keyCol = key.padEnd(16)
        lines.push(
          `    ${S.TEXT_NORMAL_BOLD}${keyCol}${S.TEXT_NORMAL}${cat.name} ${S.TEXT_DIM}— ${cat.description}${S.TEXT_NORMAL}`,
        )
      }

      lines.push("")
      lines.push(
        `  ${S.TEXT_DIM}Run ${S.TEXT_HIGHLIGHT}iris guide <topic>${S.TEXT_DIM} to see all commands in a category${S.TEXT_NORMAL}`,
      )
      lines.push("")

      process.stdout.write(lines.join(EOL) + EOL)
    } else {
      process.stdout.write(renderTopicHelp(String(args.topic)) + EOL)
    }
    process.exit(0)
  },
})
