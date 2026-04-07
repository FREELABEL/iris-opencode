import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// Endpoints (PhoneResource):
//   GET    /api/v1/phone/list           ?agent_id=
//   GET    /api/v1/phone/list-all       ?user_id=
//   GET    /api/v1/phone/get            ?agent_id=
//   GET    /api/v1/phone/search         ?area_code=&country=
//   POST   /api/v1/phone/buy            { phone_number, agent_id }
//   DELETE /api/v1/phone/delete         { phone_number }
//   POST   /api/v1/phone/configure
//   GET    /api/v1/phone/providers

const PhoneListCommand = cmd({
  command: "list [agentId]",
  aliases: ["ls"],
  describe: "list phone numbers",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Phone Numbers")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams()
    if (args.agentId) params.set("agent_id", String(args.agentId))
    const res = await irisFetch(`/api/v1/phone/list?${params}`)
    const ok = await handleApiError(res, "List phones")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const phones: any[] = data?.data ?? data?.phones ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(phones, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (phones.length === 0) console.log(`  ${dim("(no phones)")}`)
    else for (const p of phones) {
      console.log(`  ${bold(String(p.phone_number ?? p.number ?? "?"))}  ${dim(String(p.provider ?? ""))}  ${dim(`agent #${p.agent_id ?? "-"}`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const PhoneGetCommand = cmd({
  command: "get <agentId>",
  describe: "get phone for an agent",
  builder: (yargs) => yargs.positional("agentId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Phone — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/phone/get?agent_id=${args.agentId}`)
    const ok = await handleApiError(res, "Get phone")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    printDivider()
    printKV("Phone", data.phone_number ?? data.number)
    printKV("Provider", data.provider)
    printKV("Agent", data.agent_id)
    printKV("Status", data.status)
    printDivider()
    prompts.outro("Done")
  },
})

const PhoneSearchCommand = cmd({
  command: "search",
  describe: "search available phone numbers",
  builder: (yargs) =>
    yargs
      .option("area-code", { type: "string", describe: "area code (e.g. 415)" })
      .option("country", { type: "string", default: "US" })
      .option("limit", { type: "number", default: 10 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Search Phone Numbers")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams({ country: args.country, limit: String(args.limit) })
    if (args["area-code"]) params.set("area_code", args["area-code"])
    const res = await irisFetch(`/api/v1/phone/search?${params}`)
    const ok = await handleApiError(res, "Search phones")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const phones: any[] = data?.data ?? data?.numbers ?? (Array.isArray(data) ? data : [])
    printDivider()
    for (const p of phones) console.log(`  ${bold(String(p.phone_number ?? p.number))}  ${dim(String(p.locality ?? ""))}`)
    printDivider()
    prompts.outro(`${phones.length} available`)
  },
})

const PhoneBuyCommand = cmd({
  command: "buy <phoneNumber>",
  describe: "buy a phone number for an agent",
  builder: (yargs) =>
    yargs
      .positional("phoneNumber", { type: "string", demandOption: true })
      .option("agent-id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Buy ${args.phoneNumber}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/phone/buy`, {
      method: "POST",
      body: JSON.stringify({ phone_number: args.phoneNumber, agent_id: args["agent-id"] }),
    })
    const ok = await handleApiError(res, "Buy phone")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Bought`)
  },
})

const PhoneProvidersCommand = cmd({
  command: "providers",
  describe: "list phone providers",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Phone Providers")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/phone/providers`)
    const ok = await handleApiError(res, "List providers")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    console.log(JSON.stringify(data?.data ?? data, null, 2))
    prompts.outro("Done")
  },
})

export const PlatformPhoneCommand = cmd({
  command: "phone",
  describe: "manage agent phone numbers",
  builder: (yargs) =>
    yargs
      .command(PhoneListCommand)
      .command(PhoneGetCommand)
      .command(PhoneSearchCommand)
      .command(PhoneBuyCommand)
      .command(PhoneProvidersCommand)
      .demandCommand(),
  async handler() {},
})
