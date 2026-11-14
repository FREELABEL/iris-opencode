import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, FL_API, writeJson } from "./iris-api"
import { rejectBadPagination, listEnvelope, listFooter, normalizeListResponse } from "./pagination-args"

// Endpoints (UsersResource):
//   GET /api/v1/users               — list with filters
//   GET /api/v1/users/search?q=     — search
//   GET /api/v1/users/{id}
//   GET /api/v1/user/me
//
// --json is the list contract {data, meta, links} (#191863). Before it, `users list --json`
// printed [] for an account with 3,606 users: the server wraps its paginator as
// {success, data:{data:[...], total, ...}} and the CLI looked for an array at `data`.

/** CLI ceiling for `users list --limit` (the server takes any per_page; keep pages sane). */
export const USERS_LIST_MAX_LIMIT = 500
/** fl-api /users/search returns at most 15 rows, with no total and no paging. */
export const USERS_SEARCH_MAX_LIMIT = 15

const UsersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list users",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: `results per page (1-${USERS_LIST_MAX_LIMIT})`, type: "number", default: 20 })
      .option("page", { alias: "p", describe: "page number (1-based)", type: "number", default: 1 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (rejectBadPagination(args, { maxLimit: USERS_LIST_MAX_LIMIT })) return
    if (!args.json) { UI.empty(); prompts.intro("◈  Users") }
    const token = await requireAuth(); if (!token) { if (!args.json) prompts.outro("Done"); return }
    const params = new URLSearchParams({ per_page: String(args.limit), page: String(args.page) })
    const res = await irisFetch(`/api/v1/users?${params}`)
    const ok = await handleApiError(res, "List users")
    if (!ok) { process.exitCode = 1; if (!args.json) prompts.outro("Done"); return }
    const env = listEnvelope<any>(normalizeListResponse((await res.json()) as any, { key: "users" }), {
      resource: "users",
      command: "users list",
      page: args.page,
      limit: args.limit,
      search: "iris users search <term>",
    })
    if (args.json) { await writeJson(env); return }
    const users = env.data
    if (users.length > 0) {
      printDivider()
      for (const u of users) {
        const name = u.full_name || u.name || u.user_name || u.email || `User #${u.id}`
        console.log(`  ${bold(String(name))}  ${dim(`#${u.id}`)}  ${dim(String(u.email ?? ""))}`)
      }
      printDivider()
    }
    prompts.outro(listFooter(env.meta, "users"))
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
    if (args.json) { await writeJson(data); prompts.outro("Done"); return }
    printDivider()
    printKV("ID", data.id)
    printKV("Name", data.full_name || data.name || data.user_name) // #189717: name before handle
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
      .option("limit", { describe: `max results (1-${USERS_SEARCH_MAX_LIMIT}; the server returns at most ${USERS_SEARCH_MAX_LIMIT})`, type: "number", default: USERS_SEARCH_MAX_LIMIT })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (rejectBadPagination(args, { maxLimit: USERS_SEARCH_MAX_LIMIT })) return
    if (!args.json) { UI.empty(); prompts.intro(`◈  Search: ${args.query}`) }
    const token = await requireAuth(); if (!token) { if (!args.json) prompts.outro("Done"); return }
    const params = new URLSearchParams({ q: args.query, per_page: String(args.limit) })

    // User search lives on fl-api (raichu.heyiris.io), not iris-api
    // The endpoint may return 500 but still include valid data in the body
    const res = await irisFetch(`/api/v1/users/search?${params}`, {}, FL_API)
    const data = await res.json().catch(() => ({})) as any
    const page = normalizeListResponse<any>(data, { key: "users" })
    const users: any[] = page.rows

    if (users.length === 0 && !res.ok) {
      process.exitCode = 1
      if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
      await handleApiError(res, "Search users")
      prompts.outro("Done")
      return
    }

    // No total, no paging: a full page means "there may be more" — narrow the query.
    const env = listEnvelope<any>(page, {
      resource: "users",
      limit: Math.min(args.limit, USERS_SEARCH_MAX_LIMIT),
    })
    if (env.meta.truncated) {
      env.meta.hint = `Showing the first ${env.meta.returned} users matching "${args.query}"; the server returns at most ${USERS_SEARCH_MAX_LIMIT} and does not count matches. This is NOT necessarily every match — narrow the query, or page everyone with: iris users list --page <n>.`
    }
    if (args.json) { await writeJson(env); return }

    printDivider()
    if (users.length === 0) {
      prompts.log.warn(`No users matching "${args.query}".`)
    } else {
      for (const u of users) {
        const name = u.full_name || u.name || u.user_name || u.email || `User #${u.id}`
        console.log(`  ${bold(String(name))}  ${dim(`#${u.id}`)}  ${dim(String(u.email ?? ""))}`)
      }
    }
    printDivider()
    prompts.outro(listFooter(env.meta, "users", { more: "narrow the query for more" }))
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
    if (args.json) { await writeJson(data); prompts.outro("Done"); return }
    printDivider()
    printKV("ID", data.id)
    printKV("Name", data.full_name || data.name || data.user_name) // #189717: name before handle
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
