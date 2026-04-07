import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, dim, bold } from "./iris-api"

// ============================================================================
// platform-sdk-call — generic SDK proxy
//
// Usage:
//   iris sdk:call leads.list search=acme
//   iris sdk:call agents.create name="Bot" prompt="..."
//   iris sdk:call bloqs.get 42
//   iris sdk:call leads.notes.create lead_id=525 message="hi"
//
// The PHP version uses runtime reflection over SDK classes. Since TS has no
// equivalent, we route via a registry mapping `resource.method` (or
// `resource.subresource.method`) → REST endpoint descriptor.
// Unmapped routes fall through to a generic guess: GET /api/v1/{resource}
// for "list", GET .../{id} for "get", POST .../ for "create", etc.
// ============================================================================

type Method = "GET" | "POST" | "PUT" | "DELETE" | "PATCH"

interface RouteDescriptor {
  method: Method
  // path may contain {param} placeholders that pull from params
  path: string
  // params consumed by URL placeholders are removed; remaining go to body (POST/PUT/PATCH) or query (GET/DELETE)
  needsUserId?: boolean
}

// Endpoints sourced directly from PHP SDK Resources/* (grepped April 2026)
const ROUTES: Record<string, RouteDescriptor> = {
  // Leads
  "leads.list": { method: "GET", path: "/api/v1/leads" },
  "leads.search": { method: "GET", path: "/api/v1/leads" },
  "leads.get": { method: "GET", path: "/api/v1/leads/{id}" },
  "leads.create": { method: "POST", path: "/api/v1/leads" },
  "leads.update": { method: "PUT", path: "/api/v1/leads/{id}" },
  "leads.delete": { method: "DELETE", path: "/api/v1/leads/{id}" },
  "leads.notes.all": { method: "GET", path: "/api/v1/leads/{lead_id}/notes" },
  "leads.notes.create": { method: "POST", path: "/api/v1/leads/{lead_id}/notes" },
  "leads.tasks.all": { method: "GET", path: "/api/v1/leads/{lead_id}/tasks" },
  "leads.tasks.create": { method: "POST", path: "/api/v1/leads/{lead_id}/tasks" },
  "leads.outreach.all": { method: "GET", path: "/api/v1/leads/{lead_id}/outreach-steps" },
  "leads.invoices.list": { method: "GET", path: "/api/v1/leads/{lead_id}/invoice" },
  "leads.invoices.create": { method: "POST", path: "/api/v1/leads/{lead_id}/subscription/create" },

  // Bloqs (knowledge bases)
  "bloqs.list": { method: "GET", path: "/api/v1/user/{userId}/bloqs", needsUserId: true },
  "bloqs.get": { method: "GET", path: "/api/v1/user/{userId}/bloqs/{id}", needsUserId: true },
  "bloqs.create": { method: "POST", path: "/api/v1/user/{userId}/bloqs", needsUserId: true },
  "bloqs.update": { method: "PUT", path: "/api/v1/user/{userId}/bloqs/{id}", needsUserId: true },
  "bloqs.delete": { method: "DELETE", path: "/api/v1/user/{userId}/bloqs/{id}", needsUserId: true },
  "bloqs.count": { method: "GET", path: "/api/v1/user/{userId}/bloqs/count", needsUserId: true },
  "bloqs.lists.all": { method: "GET", path: "/api/v1/user/{userId}/bloqs/{bloqId}/lists", needsUserId: true },
  "bloqs.lists.create": { method: "POST", path: "/api/v1/user/{userId}/bloqs/{bloqId}/lists", needsUserId: true },
  "bloqs.items.list": { method: "GET", path: "/api/v1/user/bloqs/lists/{listId}/items" },
  "bloqs.items.create": { method: "POST", path: "/api/v1/user/bloqs/lists/{listId}/items" },
  "bloqs.content.list": { method: "GET", path: "/api/v1/user/bloqs/{bloqId}/content" },
  "bloqs.content.create": { method: "POST", path: "/api/v1/user/bloqs/{bloqId}/content" },

  // Agents
  "agents.list": { method: "GET", path: "/api/v1/users/{userId}/bloqs/agents", needsUserId: true },
  "agents.get": { method: "GET", path: "/api/v1/users/{userId}/bloqs/agents/{id}", needsUserId: true },
  "agents.create": { method: "POST", path: "/api/v1/users/{userId}/bloqs/agents", needsUserId: true },
  "agents.update": { method: "PUT", path: "/api/v1/users/{userId}/bloqs/agents/{id}", needsUserId: true },
  "agents.delete": { method: "DELETE", path: "/api/v1/users/{userId}/bloqs/agents/{id}", needsUserId: true },
  "agents.skills.all": { method: "GET", path: "/api/v6/bloqs/agents/{agentId}/skills" },
  "agents.skills.create": { method: "POST", path: "/api/v6/bloqs/agents/{agentId}/skills" },
  "agents.skills.delete": { method: "DELETE", path: "/api/v6/bloqs/agents/{agentId}/skills/{skill_id}" },

  // Chat
  "chat.start": { method: "POST", path: "/api/chat/start" },
  "chat.status": { method: "GET", path: "/api/workflows/{workflow_id}" },
  "chat.resume": { method: "POST", path: "/api/chat/resume" },

  // Diary
  "diary.today": { method: "GET", path: "/api/v6/diary" },
  "diary.list": { method: "GET", path: "/api/v6/diary/list" },
  "diary.show": { method: "GET", path: "/api/v6/diary/{date}" },
  "diary.add": { method: "POST", path: "/api/v6/diary" },

  // Profiles
  "profiles.get": { method: "GET", path: "/api/v1/profile/{id}" },
  "profiles.update": { method: "PUT", path: "/api/v1/profile/{id}" },

  // Users
  "users.list": { method: "GET", path: "/api/v1/users" },
  "users.get": { method: "GET", path: "/api/v1/users/{id}" },
  "users.search": { method: "GET", path: "/api/v1/users/search" },
  "users.me": { method: "GET", path: "/api/v1/user/me" },

  // Phone
  "phone.list": { method: "GET", path: "/api/v1/phone/list" },
  "phone.get": { method: "GET", path: "/api/v1/phone/get" },
  "phone.search": { method: "GET", path: "/api/v1/phone/search" },
  "phone.buy": { method: "POST", path: "/api/v1/phone/buy" },
  "phone.delete": { method: "DELETE", path: "/api/v1/phone/delete" },
  "phone.providers": { method: "GET", path: "/api/v1/phone/providers" },

  // Voice
  "voice.list": { method: "GET", path: "/api/v1/voice/list" },
  "voice.get": { method: "GET", path: "/api/v1/voice/get" },
  "voice.set": { method: "POST", path: "/api/v1/voice/set" },
  "voice.providers": { method: "GET", path: "/api/v1/voice/providers" },

  // Payments / wallet (a2p)
  "payments.balance": { method: "GET", path: "/api/v1/a2p/wallets/{agent_id}/balance" },
  "payments.get": { method: "GET", path: "/api/v1/a2p/wallets/{agent_id}" },
  "payments.create": { method: "POST", path: "/api/v1/a2p/wallets" },
  "payments.fund": { method: "POST", path: "/api/v1/a2p/wallets/{agent_id}/fund" },
  "payments.transactions": { method: "GET", path: "/api/v1/a2p/wallets/{agent_id}/transactions" },

  // Tools
  "tools.list": { method: "GET", path: "/api/v1/tools" },
  "tools.invoke": { method: "POST", path: "/api/v1/tools/invoke" },

  // Bloq ingestion
  "bloqs.ingestFolder": { method: "POST", path: "/api/v1/bloqs/{bloqId}/ingest-folder" },
  "bloqs.ingestionJobs": { method: "GET", path: "/api/v1/bloqs/{bloqId}/ingestion-jobs" },
  "bloqs.ingestionStatus": { method: "GET", path: "/api/v1/ingestion-jobs/{job_id}/status" },
  "bloqs.shareList": { method: "GET", path: "/api/v1/user/bloqs/{bloqId}/shared-users" },
  "bloqs.share": { method: "POST", path: "/api/v1/user/bloqs/{bloqId}/share" },
  "bloqs.invite": { method: "POST", path: "/api/v1/user/bloqs/{bloqId}/invite" },
}

// Endpoint aliases — flatten common shortcuts to canonical routes
const ALIASES: Record<string, string> = {
  "leads.addTask": "leads.tasks.create",
  "leads.createTask": "leads.tasks.create",
  "leads.listTasks": "leads.tasks.all",
  "leads.getTasks": "leads.tasks.all",
  "leads.createNote": "leads.notes.create",
  "leads.listNotes": "leads.notes.all",
  "tasks.create": "leads.tasks.create",
  "tasks.list": "leads.tasks.all",
  "notes.create": "leads.notes.create",
  "notes.list": "leads.notes.all",
  "bloqs.listLists": "bloqs.lists.all",
  "bloqs.getLists": "bloqs.lists.all",
  "bloqs.createList": "bloqs.lists.create",
  "bloqs.listItems": "bloqs.items.list",
  "bloqs.getItems": "bloqs.items.list",
  "bloqs.createItem": "bloqs.items.create",
  "bloqs.addItem": "bloqs.items.create",
  "bloqLists.list": "bloqs.lists.all",
  "bloqLists.create": "bloqs.lists.create",
  "bloqItems.list": "bloqs.items.list",
  "bloqItems.create": "bloqs.items.create",
}

// Param-name aliases per endpoint
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  "leads.list": { query: "search" },
  "leads.search": { query: "search" },
}

function castValue(v: string): any {
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null") return null
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v)
  try {
    if (v.startsWith("{") || v.startsWith("[")) return JSON.parse(v)
  } catch {}
  return v
}

function parseParams(args: string[]): Record<string, any> {
  const out: Record<string, any> = {}
  let positional = 0
  for (const arg of args) {
    const eq = arg.indexOf("=")
    if (eq > 0) {
      out[arg.slice(0, eq)] = castValue(arg.slice(eq + 1))
    } else {
      out[String(positional++)] = castValue(arg)
    }
  }
  return out
}

function fillPath(path: string, params: Record<string, any>): { url: string; remaining: Record<string, any> } {
  const remaining = { ...params }
  let positionalIdx = 0
  const url = path.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key in remaining) {
      const v = remaining[key]
      delete remaining[key]
      return String(v)
    }
    // snake_case fallback (lead_id ↔ leadId)
    const snake = key.replace(/([A-Z])/g, "_$1").toLowerCase()
    if (snake in remaining) {
      const v = remaining[snake]
      delete remaining[snake]
      return String(v)
    }
    // Use positional argument
    if (String(positionalIdx) in remaining) {
      const v = remaining[String(positionalIdx)]
      delete remaining[String(positionalIdx)]
      positionalIdx++
      return String(v)
    }
    throw new Error(`Missing required param '${key}' for endpoint`)
  })
  return { url, remaining }
}

export const PlatformSdkCallCommand = cmd({
  command: "sdk:call [endpoint] [params..]",
  aliases: ["sdk-call"],
  describe: "dynamic SDK proxy — call any resource.method with key=value params",
  builder: (yargs) =>
    yargs
      .positional("endpoint", { describe: "resource.method (e.g. leads.list)", type: "string" })
      .positional("params", { describe: "params as key=value or positional", type: "string", array: true })
      .option("list", { describe: "list known endpoints", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: true })
      .option("raw", { describe: "raw output", type: "boolean", default: false }),
  async handler(args) {
    if (args.list || !args.endpoint) {
      UI.empty()
      prompts.intro("◈  SDK Endpoints")
      const grouped: Record<string, string[]> = {}
      for (const key of Object.keys(ROUTES)) {
        const [resource] = key.split(".")
        if (!grouped[resource]) grouped[resource] = []
        grouped[resource].push(key)
      }
      for (const [resource, keys] of Object.entries(grouped)) {
        console.log(`  ${bold(resource)}`)
        for (const k of keys) {
          const r = ROUTES[k]
          console.log(`    ${dim(r.method.padEnd(6))} ${k}  ${dim(r.path)}`)
        }
      }
      console.log()
      console.log(`  ${dim("Aliases:")}`)
      for (const [from, to] of Object.entries(ALIASES)) console.log(`    ${dim(from)} → ${to}`)
      prompts.outro(dim("iris sdk:call leads.list search=acme"))
      return
    }

    const token = await requireAuth(); if (!token) return
    let endpoint = String(args.endpoint)
    if (ALIASES[endpoint]) endpoint = ALIASES[endpoint]

    const route = ROUTES[endpoint]
    if (!route) {
      console.error(`Unknown endpoint: ${endpoint}`)
      console.error(`Run: iris sdk:call --list`)
      process.exit(1)
    }

    const params = parseParams((args.params as string[]) ?? [])

    // Apply param aliases
    const aliases = PARAM_ALIASES[endpoint]
    if (aliases) {
      for (const [from, to] of Object.entries(aliases)) {
        if (params[from] !== undefined && params[to] === undefined) {
          params[to] = params[from]
          delete params[from]
        }
      }
    }

    // Inject userId if needed
    if (route.needsUserId && !params.userId && !params.user_id) {
      const uid = await requireUserId()
      if (!uid) return
      params.userId = uid
    }

    // Fill path placeholders
    let urlAndRest: { url: string; remaining: Record<string, any> }
    try {
      urlAndRest = fillPath(route.path, params)
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    }
    const { url, remaining } = urlAndRest

    // Build request
    let finalUrl = url
    let body: string | undefined
    if (route.method === "GET" || route.method === "DELETE") {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(remaining)) {
        if (v === undefined || v === null) continue
        qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
      }
      const qstr = qs.toString()
      if (qstr) finalUrl += (finalUrl.includes("?") ? "&" : "?") + qstr
    } else {
      body = JSON.stringify(remaining)
    }

    const res = await irisFetch(finalUrl, {
      method: route.method,
      ...(body ? { body } : {}),
    })
    const ok = await handleApiError(res, `${route.method} ${endpoint}`)
    if (!ok) process.exit(1)

    const text = await res.text()
    if (args.raw) { console.log(text); return }
    try {
      const data = JSON.parse(text)
      console.log(JSON.stringify(data, null, 2))
    } catch {
      console.log(text)
    }
  },
})
