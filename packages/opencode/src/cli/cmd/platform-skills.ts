import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// Endpoints (SkillsResource):
//   GET    /api/v6/bloqs/agents/{agentId}/skills
//   GET    /api/v6/bloqs/agents/{agentId}/skills/{skillId}
//   POST   /api/v6/bloqs/agents/{agentId}/skills            { name, description, instructions, tools, triggers }
//   PUT    /api/v6/bloqs/agents/{agentId}/skills/{skillId}
//   DELETE /api/v6/bloqs/agents/{agentId}/skills/{skillId}

const SkillsListCommand = cmd({
  command: "list <agentId>",
  aliases: ["ls"],
  describe: "list skills for an agent",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Skills — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills`)
    const ok = await handleApiError(res, "List skills")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const skills: any[] = data?.data ?? data?.skills ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(skills, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (skills.length === 0) console.log(`  ${dim("(no skills)")}`)
    else for (const s of skills) {
      console.log(`  ${bold(String(s.name ?? "Untitled"))}  ${dim(`#${s.id}`)}  ${s.is_active ? success("active") : dim("inactive")}`)
      if (s.description) console.log(`    ${dim(String(s.description).slice(0, 80))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const SkillsShowCommand = cmd({
  command: "show <agentId> <skillId>",
  describe: "show a skill's details",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("skillId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Skill #${args.skillId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills/${args.skillId}`)
    const ok = await handleApiError(res, "Show skill")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    printDivider()
    printKV("ID", data.id)
    printKV("Name", data.name)
    printKV("Description", data.description)
    printKV("Instructions", data.instructions)
    printKV("Tools", Array.isArray(data.tools) ? data.tools.join(", ") : data.tools)
    printKV("Triggers", Array.isArray(data.triggers) ? data.triggers.join(", ") : data.triggers)
    printKV("Active", data.is_active)
    printDivider()
    prompts.outro("Done")
  },
})

const SkillsCreateCommand = cmd({
  command: "create <agentId>",
  describe: "create a new skill",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("name", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("instructions", { type: "string" })
      .option("tools", { type: "string", describe: "comma-separated tool names" })
      .option("triggers", { type: "string", describe: "comma-separated trigger phrases" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Skill")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { name: args.name }
    if (args.description) payload.description = args.description
    if (args.instructions) payload.instructions = args.instructions
    if (args.tools) payload.tools = args.tools.split(",").map((s) => s.trim())
    if (args.triggers) payload.triggers = args.triggers.split(",").map((s) => s.trim())
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Create skill")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? {}
    prompts.outro(`${success("✓")} Created skill #${data.id ?? ""}`)
  },
})

const SkillsDeleteCommand = cmd({
  command: "delete <agentId> <skillId>",
  aliases: ["rm"],
  describe: "delete a skill",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("skillId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete skill #${args.skillId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills/${args.skillId}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Delete skill")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Deleted`)
  },
})

export const PlatformSkillsCommand = cmd({
  command: "skills",
  describe: "manage agent skills (V6)",
  builder: (yargs) =>
    yargs
      .command(SkillsListCommand)
      .command(SkillsShowCommand)
      .command(SkillsCreateCommand)
      .command(SkillsDeleteCommand)
      .demandCommand(),
  async handler() {},
})
