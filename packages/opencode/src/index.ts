import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { MarketplaceCommand } from "./cli/cmd/marketplace"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { TuiSpawnCommand } from "./cli/cmd/tui/spawn"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"
// IRIS Platform commands
import { PlatformChatCommand } from "./cli/cmd/platform-chat"
import { PlatformAgentsCommand } from "./cli/cmd/platform-agents"
import { PlatformLeadsCommand, PlatformDealsCommand } from "./cli/cmd/platform-leads"
import { PlatformWorkflowsCommand } from "./cli/cmd/platform-workflows"
import { PlatformBloqsCommand } from "./cli/cmd/platform-bloqs"
import { PlatformBrandsCommand } from "./cli/cmd/platform-brands"
import { PlatformCopycatCommand } from "./cli/cmd/platform-copycat"
import { PlatformGoodDealsCommand } from "./cli/cmd/platform-good-deals"
import { PlatformBloqContextCommand } from "./cli/cmd/platform-bloq-context"
import { PlatformAtlasLedgerCommand } from "./cli/cmd/platform-atlas-ledger"
import { PlatformAtlasStaffCommand } from "./cli/cmd/platform-atlas-staff"
import { PlatformAtlasInventoryCommand } from "./cli/cmd/platform-atlas-inventory"
import { PlatformAtlasDatasetsCommand } from "./cli/cmd/platform-atlas-datasets"
import { PlatformIntegrationsCommand } from "./cli/cmd/platform-integrations"
import { PlatformSchedulesCommand } from "./cli/cmd/platform-schedules"
import { PlatformN8nCommand } from "./cli/cmd/platform-n8n"
import { PlatformBoardsCommand } from "./cli/cmd/platform-boards"
import { PlatformDiscoverCommand } from "./cli/cmd/platform-discover"
import { PlatformOpportunitiesCommand } from "./cli/cmd/platform-opportunities"
import { PlatformServicesCommand } from "./cli/cmd/platform-services"
import { PlatformProductsCommand } from "./cli/cmd/platform-products"
import { PlatformEventsCommand } from "./cli/cmd/platform-events"
import { PlatformVenuesCommand } from "./cli/cmd/platform-venues"
import { PlatformProgramsCommand } from "./cli/cmd/platform-programs"
import { PlatformRemotionCommand } from "./cli/cmd/platform-remotion"
import { PlatformHiveCommand } from "./cli/cmd/platform-hive"
import { PlatformClipsCommand } from "./cli/cmd/platform-clips"
import { PlatformOutreachCommand } from "./cli/cmd/platform-outreach"
import { PlatformOutreachStrategyCommand } from "./cli/cmd/platform-outreach-strategy"
import { PlatformOutreachCampaignCommand } from "./cli/cmd/platform-outreach-campaign"
import { PlatformOutreachSendCommand } from "./cli/cmd/platform-outreach-send"
import { PlatformSomCommand } from "./cli/cmd/platform-som"
import { PlatformMonitorCommand } from "./cli/cmd/platform-monitor"
import { PlatformInvoicesCommand } from "./cli/cmd/platform-invoices"
import { PlatformPaymentsCommand } from "./cli/cmd/platform-payments"
import { PlatformRevenueCommand } from "./cli/cmd/platform-revenue"
import { PlatformDeliverCommand } from "./cli/cmd/platform-deliver"
import { PlatformRunCommand, PlatformConnectCommand, PlatformListConnectedCommand, PlatformListAvailableCommand } from "./cli/cmd/platform-run"
import { PlatformTranscribeCommand } from "./cli/cmd/transcribe"
import { PlatformBugCommand } from "./cli/cmd/platform-bug"
import { PlatformAtlasMeetingsCommand } from "./cli/cmd/platform-atlas-meetings"
import { PlatformAtlasBrandKitCommand } from "./cli/cmd/platform-atlas-brand-kit"
import { PlatformAtlasCommsCommand } from "./cli/cmd/platform-atlas-comms"
import { PlatformLeadsMeetingCommand } from "./cli/cmd/platform-leads-meeting"
import { PlatformCampaignCommand } from "./cli/cmd/platform-campaign"
import { PlatformDaemonCommand } from "./cli/cmd/platform-daemon"
import { PlatformChannelsCommand } from "./cli/cmd/platform-channels"
import { PlatformObsCommand } from "./cli/cmd/platform-obs"
import { PlatformDoctorCommand } from "./cli/cmd/platform-doctor"
import { PlatformOnboardCommand } from "./cli/cmd/platform-onboard"
import { PlatformProposalsCommand } from "./cli/cmd/platform-proposals"
import { PlatformContractsCommand } from "./cli/cmd/platform-contracts"
import { PlatformPagesCommand } from "./cli/cmd/platform-pages"
import { PlatformDomainsCommand } from "./cli/cmd/platform-domains"
import { PlatformPagesBatchCommand } from "./cli/cmd/platform-pages-batch"
import { PlatformPartialsCommand } from "./cli/cmd/platform-partials"
import { PlatformCloudUploadCommand } from "./cli/cmd/platform-cloud-upload"
import { PlatformPackagesCommand } from "./cli/cmd/platform-packages"
import { PlatformMarketplaceCommand } from "./cli/cmd/platform-marketplace"
import { PlatformMemoryCommand } from "./cli/cmd/platform-memory"
import { PlatformProfileCommand } from "./cli/cmd/platform-profile"
import { PlatformBloqIngestCommand } from "./cli/cmd/platform-bloq-ingest"
import { PlatformBloqMembersCommand } from "./cli/cmd/platform-bloq-members"
import { PlatformEvalCommand } from "./cli/cmd/platform-eval"
import { PlatformSdkCallCommand } from "./cli/cmd/platform-sdk-call"
import { PlatformDiaryCommand } from "./cli/cmd/platform-diary"
import { PlatformSkillsCommand } from "./cli/cmd/platform-skills"
import { PlatformSopCommand } from "./cli/cmd/platform-sop"
import { PlatformToolsCommand } from "./cli/cmd/platform-tools"
import { PlatformUsersCommand } from "./cli/cmd/platform-users"
import { PlatformPhoneCommand } from "./cli/cmd/platform-phone"
import { PlatformVoiceCommand } from "./cli/cmd/platform-voice"
import { PlatformMailCommand } from "./cli/cmd/platform-mail"
import { PlatformImessageCommand } from "./cli/cmd/platform-imessage"
import { PlatformCalendarCommand } from "./cli/cmd/platform-calendar"
import { PlatformDocsCommand } from "./cli/cmd/platform-docs"
import { PlatformWalletCommand } from "./cli/cmd/platform-wallet"
import { PlatformConfigCommand } from "./cli/cmd/platform-config"
import { PlatformAppCommand } from "./cli/cmd/platform-app"
import { PlatformAutomationCommand } from "./cli/cmd/platform-automation"
import { PlatformAutomationTestCommand } from "./cli/cmd/platform-automation-test"
import { HowToCommand } from "./cli/cmd/platform-howto"
import { GuideCommand } from "./cli/cmd/guide"
import { registerCommand } from "./cli/cmd/command-groups"
import { renderGroupedHelp } from "./cli/help-renderer"

// Register a command in the grouped help registry and return it unchanged
function reg<T>(commandModule: T): T {
  registerCommand(commandModule)
  return commandModule
}

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

const rawArgs = hideBin(process.argv)

const cli = yargs(rawArgs)
  .parserConfiguration({ "populate--": true })
  .scriptName("iris")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.VERSION)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .middleware(async (opts) => {
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"

    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  .usage("\n" + UI.logo())
  .completion("completion", "generate shell completion script")
  // Guide / discoverability (must be before TuiThreadCommand's $0 [project])
  .command(reg(GuideCommand))
  // Core CLI commands
  .command(reg(AcpCommand))
  .command(reg(McpCommand))
  .command(reg(MarketplaceCommand))
  .command(TuiThreadCommand)
  .command(TuiSpawnCommand)
  .command(reg(AttachCommand))
  .command(reg(RunCommand))
  .command(reg(GenerateCommand))
  .command(reg(DebugCommand))
  .command(reg(AuthCommand))
  .command(reg(AgentCommand))
  .command(reg(UpgradeCommand))
  .command(reg(UninstallCommand))
  .command(reg(ServeCommand))
  .command(reg(WebCommand))
  .command(reg(ModelsCommand))
  .command(reg(StatsCommand))
  .command(reg(ExportCommand))
  .command(reg(ImportCommand))
  .command(reg(GithubCommand))
  .command(reg(PrCommand))
  .command(reg(SessionCommand))
  // IRIS Platform
  .command(reg(PlatformChatCommand))
  .command(reg(PlatformAgentsCommand))
  .command(reg(PlatformLeadsCommand))
  .command(reg(PlatformDealsCommand))
  .command(reg(PlatformWorkflowsCommand))
  .command(reg(PlatformBloqsCommand))
  .command(reg(PlatformBrandsCommand))
  .command(reg(PlatformCopycatCommand))
  .command(reg(PlatformGoodDealsCommand))
  .command(reg(PlatformBloqContextCommand))
  .command(reg(PlatformAtlasLedgerCommand))
  .command(reg(PlatformAtlasStaffCommand))
  .command(reg(PlatformAtlasInventoryCommand))
  .command(reg(PlatformAtlasDatasetsCommand))
  .command(reg(PlatformIntegrationsCommand))
  .command(reg(PlatformSchedulesCommand))
  .command(reg(PlatformN8nCommand))
  .command(reg(PlatformBoardsCommand))
  .command(reg(PlatformDiscoverCommand))
  .command(reg(PlatformOpportunitiesCommand))
  .command(reg(PlatformServicesCommand))
  .command(reg(PlatformProductsCommand))
  .command(reg(PlatformEventsCommand))
  .command(reg(PlatformVenuesCommand))
  .command(reg(PlatformProgramsCommand))
  .command(reg(PlatformRemotionCommand))
  .command(reg(PlatformHiveCommand))
  .command(reg(PlatformClipsCommand))
  .command(reg(PlatformOutreachCommand))
  .command(reg(PlatformOutreachStrategyCommand))
  .command(reg(PlatformOutreachCampaignCommand))
  .command(reg(PlatformOutreachSendCommand))
  .command(reg(PlatformSomCommand))
  .command(reg(PlatformMonitorCommand))

  .command(reg(PlatformInvoicesCommand))
  .command(reg(PlatformPaymentsCommand))
  .command(reg(PlatformRevenueCommand))
  .command(reg(PlatformDeliverCommand))
  .command(reg(PlatformRunCommand))
  .command(reg(PlatformTranscribeCommand))
  .command(reg(PlatformConnectCommand))
  .command(reg(PlatformListConnectedCommand))
  .command(reg(PlatformListAvailableCommand))
  .command(reg(PlatformBugCommand))
  .command(reg(PlatformAtlasMeetingsCommand))
  .command(reg(PlatformAtlasBrandKitCommand))
  .command(reg(PlatformAtlasCommsCommand))
  .command(reg(PlatformLeadsMeetingCommand))
  .command(reg(PlatformCampaignCommand))
  .command(reg(PlatformDaemonCommand))
  .command(reg(PlatformChannelsCommand))
  .command(reg(PlatformDoctorCommand))
  .command(reg(PlatformObsCommand))
  .command(reg(PlatformOnboardCommand))
  .command(reg(PlatformProposalsCommand))
  .command(reg(PlatformContractsCommand))
  .command(reg(PlatformPagesCommand))
  .command(reg(PlatformDomainsCommand))
  .command(reg(PlatformPagesBatchCommand))
  .command(reg(PlatformPartialsCommand))
  .command(reg(PlatformCloudUploadCommand))
  .command(reg(PlatformPackagesCommand))
  .command(reg(PlatformMarketplaceCommand))
  .command(reg(PlatformMemoryCommand))
  .command(reg(PlatformProfileCommand))
  .command(reg(PlatformBloqIngestCommand))
  .command(reg(PlatformBloqMembersCommand))
  .command(reg(PlatformEvalCommand))
  .command(reg(PlatformSdkCallCommand))
  .command(reg(PlatformDiaryCommand))
  .command(reg(PlatformSkillsCommand))
  .command(reg(PlatformSopCommand))
  .command(reg(PlatformToolsCommand))
  .command(reg(PlatformUsersCommand))
  .command(reg(PlatformPhoneCommand))
  .command(reg(PlatformVoiceCommand))
  .command(reg(PlatformMailCommand))
  .command(reg(PlatformImessageCommand))
  .command(reg(PlatformCalendarCommand))
  .command(reg(PlatformDocsCommand))
  .command(reg(PlatformWalletCommand))
  // PHP-port commands — config, app, automation, automation:test
  // (integrations is owned by PlatformRunCommand in platform-run.ts)
  .command(reg(PlatformConfigCommand))
  .command(reg(PlatformAppCommand))
  .command(reg(PlatformAutomationCommand))
  .command(reg(PlatformAutomationTestCommand))
  .command(reg(HowToCommand))
  .fail((msg) => {
    if (
      msg.startsWith("Unknown argument") ||
      msg.startsWith("Not enough non-option arguments") ||
      msg.startsWith("Invalid values:")
    ) {
      cli.showHelp("log")
    }
    process.exit(1)
  })
  .strict()

// Intercept top-level --help after all commands are registered
const hasHelp = rawArgs.includes("--help") || rawArgs.includes("-h")
const hasNoCommand = rawArgs.every((a) => a.startsWith("-"))
if (hasHelp && hasNoCommand) {
  console.log(renderGroupedHelp())
  process.exit(0)
}

// Auto-start bridge+daemon if not running (silent, non-blocking)
// Prefers iris-bridge (full bridge: express + Discord + iMessage + embedded daemon)
// Falls back to iris-daemon (daemon only, no messaging bots)
try {
  const { join: pathJoin } = await import("path")
  const { homedir: osHome } = await import("os")
  const { existsSync } = await import("fs")
  const bridgeCtl = pathJoin(osHome(), ".iris", "bin", "iris-bridge")
  const daemonCtl = pathJoin(osHome(), ".iris", "bin", "iris-daemon")
  const ctl = existsSync(bridgeCtl) ? bridgeCtl : existsSync(daemonCtl) ? daemonCtl : null
  if (ctl) {
    const health = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(500) }).catch(() => null)
    if (!health?.ok) {
      const { spawn } = await import("child_process")
      spawn(ctl, ["start"], { detached: true, stdio: "ignore" }).unref()
    }
  }
} catch {}

try {
  await cli.parse()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
