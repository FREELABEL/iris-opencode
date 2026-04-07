import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// Endpoints (VoiceResource):
//   GET  /api/v1/voice/list             ?provider=
//   GET  /api/v1/voice/get              ?agent_id=
//   POST /api/v1/voice/set              { agent_id, voice_id, provider }
//   GET  /api/v1/voice/providers

const VoiceListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list available voices",
  builder: (yargs) =>
    yargs
      .option("provider", { type: "string", describe: "filter by provider (elevenlabs, vapi, etc)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Voices")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams()
    if (args.provider) params.set("provider", args.provider)
    const res = await irisFetch(`/api/v1/voice/list?${params}`)
    const ok = await handleApiError(res, "List voices")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const voices: any[] = data?.data ?? data?.voices ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(voices, null, 2)); prompts.outro("Done"); return }
    printDivider()
    for (const v of voices) console.log(`  ${bold(String(v.name ?? v.voice_id ?? "?"))}  ${dim(String(v.provider ?? ""))}  ${dim(String(v.voice_id ?? ""))}`)
    printDivider()
    prompts.outro(`${voices.length} voice(s)`)
  },
})

const VoiceGetCommand = cmd({
  command: "get <agentId>",
  describe: "get an agent's voice configuration",
  builder: (yargs) => yargs.positional("agentId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Voice — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/voice/get?agent_id=${args.agentId}`)
    const ok = await handleApiError(res, "Get voice")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    printDivider()
    printKV("Voice", data.voice_name ?? data.name)
    printKV("ID", data.voice_id)
    printKV("Provider", data.provider)
    printDivider()
    prompts.outro("Done")
  },
})

const VoiceSetCommand = cmd({
  command: "set <agentId> <voiceId>",
  describe: "set an agent's voice",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("voiceId", { type: "string", demandOption: true })
      .option("provider", { type: "string", describe: "voice provider" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set voice — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { agent_id: args.agentId, voice_id: args.voiceId }
    if (args.provider) payload.provider = args.provider
    const res = await irisFetch(`/api/v1/voice/set`, { method: "POST", body: JSON.stringify(payload) })
    const ok = await handleApiError(res, "Set voice")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Updated`)
  },
})

const VoiceProvidersCommand = cmd({
  command: "providers",
  describe: "list voice providers",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Voice Providers")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/voice/providers`)
    const ok = await handleApiError(res, "List providers")
    if (!ok) { prompts.outro("Done"); return }
    console.log(JSON.stringify(((await res.json()) as any)?.data ?? (await res.json().catch(() => ({}))), null, 2))
    prompts.outro("Done")
  },
})

export const PlatformVoiceCommand = cmd({
  command: "voice",
  describe: "manage agent voices",
  builder: (yargs) =>
    yargs
      .command(VoiceListCommand)
      .command(VoiceGetCommand)
      .command(VoiceSetCommand)
      .command(VoiceProvidersCommand)
      .demandCommand(),
  async handler() {},
})
