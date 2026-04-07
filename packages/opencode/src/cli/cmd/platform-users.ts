import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold } from "./iris-api"

// Endpoints (UsersResource):
//   GET /api/v1/users               — list with filters
//   GET /api/v1/users/search?q=     — search
//   GET /api/v1/users/{id}
//   GET /api/v1/user/me

const UsersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list users",
  builder: (yargs) =>
    yargs
      .option("limit", { type: "number", default: 20 })
      .option("page", { type: "number", default: 1 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Users")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams({ per_page: String(args.limit), page: String(args.page) })
    const res = await irisFetch(`/api/v1/users?${params}`)
    const ok = await handleApiError(res, "List users")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const users: any[] = data?.data ?? data?.users ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(users, null, 2)); prompts.outro("Done"); return }
    printDivider()
    for (const u of users) {
      const name = u.full_name ?? u.user_name ?? u.name ?? u.email ?? `User #${u.id}`
      console.log(`  ${bold(String(name))}  ${dim(`#${u.id}`)}  ${dim(String(u.email ?? ""))}`)
    }
    printDivider()
    prompts.outro(`${users.length} user(s)`)
  },
})

const UsersGetCommand = cmd({
  command: "get <id>",
  describe: "show user details",
  builder: (yargs) => yargs.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  User #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/users/${args.id}`)
    const ok = await handleApiError(res, "Get user")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    printKV("ID", data.id)
    printKV("Name", data.full_name ?? data.user_name ?? data.name)
    printKV("Email", data.email)
    printKV("Phone", data.phone)
    printKV("Created", data.created_at)
    printDivider()
    prompts.outro("Done")
  },
})

const UsersSearchCommand = cmd({
  command: "search <query>",
  describe: "search users",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", demandOption: true })
      .option("limit", { type: "number", default: 20 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Search: ${args.query}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams({ q: args.query, per_page: String(args.limit) })
    const res = await irisFetch(`/api/v1/users/search?${params}`)
    const ok = await handleApiError(res, "Search users")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const users: any[] = data?.data ?? data?.users ?? (Array.isArray(data) ? data : [])
    printDivider()
    for (const u of users) {
      const name = u.full_name ?? u.user_name ?? u.name ?? u.email ?? `User #${u.id}`
      console.log(`  ${bold(String(name))}  ${dim(`#${u.id}`)}  ${dim(String(u.email ?? ""))}`)
    }
    printDivider()
    prompts.outro(`${users.length} result(s)`)
  },
})

const UsersMeCommand = cmd({
  command: "me",
  describe: "show authenticated user",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Me")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/user/me`)
    const ok = await handleApiError(res, "Get me")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    printKV("ID", data.id)
    printKV("Name", data.full_name ?? data.user_name ?? data.name)
    printKV("Email", data.email)
    printDivider()
    prompts.outro("Done")
  },
})

export const PlatformUsersCommand = cmd({
  command: "users",
  describe: "manage users (list, get, search, me)",
  builder: (yargs) =>
    yargs
      .command(UsersListCommand)
      .command(UsersGetCommand)
      .command(UsersSearchCommand)
      .command(UsersMeCommand)
      .demandCommand(),
  async handler() {},
})
