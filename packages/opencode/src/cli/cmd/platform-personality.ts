import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, dim, bold, success } from "./iris-api"

// Personality presets — list available preset library and apply to an agent.
// Backed by config/personalities.php (fl-api).
//
// Usage:
//   iris personality                       # list presets
//   iris personality show concise           # show full preset traits
//   iris personality apply <agent_id> concise

const PersonalityListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list available personality presets",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Personality Presets")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/personalities`)
    const ok = await handleApiError(res, "List personalities"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const presets: any[] = data?.data ?? []
    if (args.json) { console.log(JSON.stringify(presets, null, 2)); prompts.outro("Done"); return }
    printDivider()
    for (const p of presets) {
      console.log(`  ${bold(p.key.padEnd(12))} ${p.name}`)
      console.log(`  ${dim("".padEnd(12))} ${dim(p.description)}`)
      console.log()
    }
    printDivider()
    prompts.outro(`${presets.length} preset(s) — apply with: iris personality apply <agent_id> <key>`)
  },
})

const PersonalityShowCommand = cmd({
  command: "show <key>",
  describe: "show full traits text for a preset",
  builder: (yargs) =>
    yargs
      .positional("key", { type: "string", demandOption: true, describe: "preset key (e.g. concise, formal)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Preset: ${bold(args.key as string)}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/personalities/${encodeURIComponent(String(args.key))}`)
    const ok = await handleApiError(res, "Show personality"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const preset = data?.data
    if (!preset) { prompts.outro("Not found"); return }
    if (args.json) { console.log(JSON.stringify(preset, null, 2)); prompts.outro("Done"); return }
    printDivider()
    console.log(`  ${bold("Name:")}        ${preset.name}`)
    console.log(`  ${bold("Description:")} ${preset.description}`)
    console.log()
    console.log(`  ${bold("Traits:")}`)
    console.log(`  ${preset.traits}`)
    printDivider()
    prompts.outro("Done")
  },
})

const PersonalityApplyCommand = cmd({
  command: "apply <agentId> [key]",
  describe: "apply a preset (or raw traits via --traits) to an agent",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "string", demandOption: true, describe: "target bloq_agent ID" })
      .positional("key", { type: "string", describe: "preset key (omit when using --traits)" })
      .option("traits", { type: "string", describe: "raw personality_traits text (alternative to a preset key)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.key && !args.traits) {
      console.error("personality apply: provide either a preset key or --traits \"...\"")
      process.exit(1)
    }
    UI.empty()
    prompts.intro(`◈  Apply Personality → agent ${bold(String(args.agentId))}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    const body: Record<string, string> = {}
    if (args.key) body.preset = String(args.key)
    if (args.traits) body.traits = String(args.traits)

    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.agentId}/apply-personality`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    const ok = await handleApiError(res, "Apply personality"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    console.log(`  ${success("✓")} ${data?.message ?? "Applied"}`)
    if (data?.data?.applied_from) console.log(`  ${dim("From:")} ${data.data.applied_from}`)
    printDivider()
    prompts.outro("Done")
  },
})

export const PlatformPersonalityCommand = cmd({
  command: "personality <command>",
  aliases: ["personalities"],
  describe: "manage agent personality presets — list, show, apply",
  builder: (yargs) =>
    yargs
      .command(PersonalityListCommand)
      .command(PersonalityShowCommand)
      .command(PersonalityApplyCommand)
      .demandCommand(1, "specify a subcommand: list | show | apply"),
  handler: () => {},
})
