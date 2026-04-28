import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// Helpers
// ============================================================================

function statusBadge(status: string): string {
  switch (status) {
    case "active": return `${UI.Style.TEXT_SUCCESS}active${UI.Style.TEXT_NORMAL}`
    case "error": return `${UI.Style.TEXT_DANGER}error${UI.Style.TEXT_NORMAL}`
    case "inactive": return dim("inactive")
    default: return dim(status)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const IntegrationsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list connected integrations",
  builder: (yargs) =>
    yargs
      .option("bloq", { alias: "b", describe: "filter by bloq ID (show bloq-shared integrations)", type: "number" })
      .option("all", { describe: "show all integrations (personal + bloq-shared)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  IRIS Integrations") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading integrations…")

    try {
      const params = new URLSearchParams()
      if (args.bloq) params.set("bloq_id", String(args.bloq))

      const res = await irisFetch(`/api/v1/users/${userId}/integrations?${params}`)
      const ok = await handleApiError(res, "List integrations")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const raw = (await res.json()) as Record<string, any>
      const integrations: any[] = raw?.data ?? raw ?? []

      if (spinner) spinner.stop(`${integrations.length} integration(s)`)

      if (args.json) {
        console.log(JSON.stringify(integrations, null, 2))
        return
      }

      if (integrations.length === 0) {
        prompts.log.warn("No integrations connected")
        prompts.outro(dim("iris integrations connect <type>"))
        return
      }

      // Group by scope
      const personal = integrations.filter((i: any) => !i.bloq_id)
      const shared = integrations.filter((i: any) => !!i.bloq_id)

      if (personal.length > 0) {
        console.log()
        console.log(`  ${bold("Personal")} ${dim("(your account only)")}`)
        printDivider()
        for (const i of personal) {
          console.log(`  ${bold(String(i.type))}  ${dim(`#${i.id}`)}  ${statusBadge(i.status)}  ${dim(i.category ?? "")}`)
        }
      }

      if (shared.length > 0) {
        console.log()
        console.log(`  ${bold("Shared")} ${dim("(bloq-level, accessible by all members)")}`)
        printDivider()
        for (const i of shared) {
          console.log(`  ${bold(String(i.type))}  ${dim(`#${i.id}`)}  ${statusBadge(i.status)}  ${dim(`bloq:${i.bloq_id}`)}`)
        }
      }

      console.log()
      printDivider()
      prompts.outro(dim("iris integrations connect <type> --bloq=<id>  — share with a bloq"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const IntegrationsConnectCommand = cmd({
  command: "connect <type>",
  describe: "connect an integration (optionally share with a bloq)",
  builder: (yargs) =>
    yargs
      .positional("type", { describe: "integration type (e.g., slack, google-drive, discord)", type: "string", demandOption: true })
      .option("bloq", { alias: "b", describe: "share this integration with a bloq", type: "number" })
      .option("api-key", { describe: "API key (for key-based integrations)", type: "string" })
      .option("token", { describe: "access token (for token-based integrations)", type: "string" })
      .option("webhook-url", { describe: "webhook URL (for webhook-based integrations)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Connect Integration: ${args.type}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    // Build credentials from flags
    const credentials: Record<string, string> = {}
    if (args["api-key"]) credentials.api_key = args["api-key"] as string
    if (args.token) credentials.token = args.token as string
    if (args["webhook-url"]) credentials.webhook_url = args["webhook-url"] as string

    // If no credentials provided and interactive, prompt
    if (Object.keys(credentials).length === 0 && process.stdin.isTTY && !args.json) {
      const credType = (await prompts.select({
        message: "Credential type",
        options: [
          { value: "api_key", label: "API Key" },
          { value: "token", label: "Access Token" },
          { value: "webhook_url", label: "Webhook URL" },
          { value: "oauth", label: "OAuth (open browser)" },
        ],
      })) as string
      if (prompts.isCancel(credType)) { prompts.outro("Cancelled"); return }

      if (credType === "oauth") {
        prompts.log.info("OAuth integrations must be connected via the web UI.")
        prompts.log.info(dim("Go to: Settings → Integrations → Connect"))
        prompts.outro("Done")
        return
      }

      const value = (await prompts.text({
        message: `Enter ${credType.replace("_", " ")}`,
        validate: (v) => (!v || v.length < 3 ? "Required (min 3 chars)" : undefined),
      })) as string
      if (prompts.isCancel(value)) { prompts.outro("Cancelled"); return }
      credentials[credType] = value
    }

    if (Object.keys(credentials).length === 0 && !args.json) {
      prompts.log.error("No credentials provided. Use --api-key, --token, or --webhook-url")
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Connecting…")

    try {
      const payload: Record<string, unknown> = {
        type: args.type,
        credentials,
        status: "active",
      }
      if (args.bloq) payload.bloq_id = args.bloq

      const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Connect integration")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); process.exitCode = 1; return }

      const data = (await res.json()) as Record<string, any>
      const integration = data?.data ?? data

      if (args.json) {
        console.log(JSON.stringify(integration, null, 2))
        return
      }

      spinner!.stop(`${success("✓")} Connected: ${bold(String(args.type))}`)
      printDivider()
      printKV("ID", integration.id)
      printKV("Type", integration.type)
      printKV("Status", integration.status)
      if (args.bloq) printKV("Shared with", `Bloq #${args.bloq}`)
      else printKV("Scope", "Personal")
      printDivider()

      prompts.outro(dim("iris integrations list"))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const IntegrationsShareCommand = cmd({
  command: "share <id> <bloq-id>",
  describe: "share an existing integration with a bloq",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "integration ID", type: "number", demandOption: true })
      .positional("bloq-id", { describe: "bloq ID to share with", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Share Integration #${args.id} → Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations/${args.id}`, {
        method: "PUT",
        body: JSON.stringify({ bloq_id: args["bloq-id"] }),
      })
      const ok = await handleApiError(res, "Share integration")
      if (!ok) { spinner.stop("Failed", 1); return }

      spinner.stop(`${success("✓")} Integration #${args.id} shared with Bloq #${args["bloq-id"]}`)
      prompts.log.info(dim("All agents and users in this bloq can now use this integration."))
      prompts.outro(dim("iris integrations list --bloq=" + args["bloq-id"]))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const IntegrationsUnshareCommand = cmd({
  command: "unshare <id>",
  describe: "remove bloq sharing from an integration (make personal again)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "integration ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Unshare Integration #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations/${args.id}`, {
        method: "PUT",
        body: JSON.stringify({ bloq_id: null }),
      })
      const ok = await handleApiError(res, "Unshare integration")
      if (!ok) { spinner.stop("Failed", 1); return }

      spinner.stop(`${success("✓")} Integration #${args.id} is now personal only`)
      prompts.outro(dim("iris integrations list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const IntegrationsDisconnectCommand = cmd({
  command: "disconnect <id>",
  aliases: ["rm", "delete"],
  describe: "disconnect an integration",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "integration ID", type: "number", demandOption: true })
      .option("force", { alias: "f", describe: "skip confirmation", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Disconnect Integration #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Disconnect integration #${args.id}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Disconnecting…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations/${args.id}`, {
        method: "DELETE",
      })
      const ok = await handleApiError(res, "Disconnect integration")
      if (!ok) { spinner.stop("Failed", 1); return }

      spinner.stop(`${success("✓")} Integration #${args.id} disconnected`)
      prompts.outro(dim("iris integrations list"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformIntegrationsCommand = cmd({
  command: "integrations",
  aliases: ["int"],
  describe: "manage integrations — connect, share, list, disconnect",
  builder: (yargs) =>
    yargs
      .command(IntegrationsListCommand)
      .command(IntegrationsConnectCommand)
      .command(IntegrationsShareCommand)
      .command(IntegrationsUnshareCommand)
      .command(IntegrationsDisconnectCommand)
      .demandCommand(),
  async handler() {},
})
