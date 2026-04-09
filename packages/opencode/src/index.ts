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
import { PlatformLeadsCommand } from "./cli/cmd/platform-leads"
import { PlatformWorkflowsCommand } from "./cli/cmd/platform-workflows"
import { PlatformBloqsCommand } from "./cli/cmd/platform-bloqs"
import { PlatformBrandsCommand } from "./cli/cmd/platform-brands"
import { PlatformCopycatCommand } from "./cli/cmd/platform-copycat"
import { PlatformGoodDealsCommand } from "./cli/cmd/platform-good-deals"
import { PlatformBloqContextCommand } from "./cli/cmd/platform-bloq-context"
import { PlatformSchedulesCommand } from "./cli/cmd/platform-schedules"
import { PlatformN8nCommand } from "./cli/cmd/platform-n8n"
import { PlatformBoardsCommand } from "./cli/cmd/platform-boards"
import { PlatformOpportunitiesCommand } from "./cli/cmd/platform-opportunities"
import { PlatformServicesCommand } from "./cli/cmd/platform-services"
import { PlatformProductsCommand } from "./cli/cmd/platform-products"
import { PlatformEventsCommand } from "./cli/cmd/platform-events"
import { PlatformVenuesCommand } from "./cli/cmd/platform-venues"
import { PlatformProgramsCommand } from "./cli/cmd/platform-programs"
import { PlatformRemotionCommand } from "./cli/cmd/platform-remotion"
import { PlatformHiveCommand } from "./cli/cmd/platform-hive"
import { PlatformOutreachCommand } from "./cli/cmd/platform-outreach"
import { PlatformOutreachStrategyCommand } from "./cli/cmd/platform-outreach-strategy"
import { PlatformOutreachCampaignCommand } from "./cli/cmd/platform-outreach-campaign"
import { PlatformOutreachSendCommand } from "./cli/cmd/platform-outreach-send"
import { PlatformSomCommand } from "./cli/cmd/platform-som"
import { PlatformMonitorCommand } from "./cli/cmd/platform-monitor"
import { PlatformInvoicesCommand } from "./cli/cmd/platform-invoices"
import { PlatformPaymentsCommand } from "./cli/cmd/platform-payments"
import { PlatformDeliverCommand } from "./cli/cmd/platform-deliver"
import { PlatformRunCommand, PlatformConnectCommand, PlatformListConnectedCommand, PlatformListAvailableCommand } from "./cli/cmd/platform-run"
import { PlatformTranscribeCommand } from "./cli/cmd/transcribe"
import { PlatformBugCommand } from "./cli/cmd/platform-bug"
import { PlatformAtlasMeetingsCommand } from "./cli/cmd/platform-atlas-meetings"
import { PlatformAtlasBrandKitCommand } from "./cli/cmd/platform-atlas-brand-kit"
import { PlatformLeadsMeetingCommand } from "./cli/cmd/platform-leads-meeting"
import { PlatformPagesCommand } from "./cli/cmd/platform-pages"
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
import { PlatformWalletCommand } from "./cli/cmd/platform-wallet"
import { PlatformConfigCommand } from "./cli/cmd/platform-config"
import { PlatformAppCommand } from "./cli/cmd/platform-app"
import { PlatformAutomationCommand } from "./cli/cmd/platform-automation"
import { PlatformAutomationTestCommand } from "./cli/cmd/platform-automation-test"

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

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("opencode")
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
  .command(AcpCommand)
  .command(McpCommand)
  .command(MarketplaceCommand)
  .command(TuiThreadCommand)
  .command(TuiSpawnCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(AuthCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  // IRIS Platform
  .command(PlatformChatCommand)
  .command(PlatformAgentsCommand)
  .command(PlatformLeadsCommand)
  .command(PlatformWorkflowsCommand)
  .command(PlatformBloqsCommand)
  .command(PlatformBrandsCommand)
  .command(PlatformCopycatCommand)
  .command(PlatformGoodDealsCommand)
  .command(PlatformBloqContextCommand)
  .command(PlatformSchedulesCommand)
  .command(PlatformN8nCommand)
  .command(PlatformBoardsCommand)
  .command(PlatformOpportunitiesCommand)
  .command(PlatformServicesCommand)
  .command(PlatformProductsCommand)
  .command(PlatformEventsCommand)
  .command(PlatformVenuesCommand)
  .command(PlatformProgramsCommand)
  .command(PlatformRemotionCommand)
  .command(PlatformHiveCommand)
  .command(PlatformOutreachCommand)
  .command(PlatformOutreachStrategyCommand)
  .command(PlatformOutreachCampaignCommand)
  .command(PlatformOutreachSendCommand)
  .command(PlatformSomCommand)
  .command(PlatformMonitorCommand)
  .command(PlatformInvoicesCommand)
  .command(PlatformPaymentsCommand)
  .command(PlatformDeliverCommand)
  .command(PlatformRunCommand)
  .command(PlatformTranscribeCommand)
  .command(PlatformConnectCommand)
  .command(PlatformListConnectedCommand)
  .command(PlatformListAvailableCommand)
  .command(PlatformBugCommand)
  .command(PlatformAtlasMeetingsCommand)
  .command(PlatformAtlasBrandKitCommand)
  .command(PlatformLeadsMeetingCommand)
  .command(PlatformPagesCommand)
  .command(PlatformPagesBatchCommand)
  .command(PlatformPartialsCommand)
  .command(PlatformCloudUploadCommand)
  .command(PlatformPackagesCommand)
  .command(PlatformMarketplaceCommand)
  .command(PlatformMemoryCommand)
  .command(PlatformProfileCommand)
  .command(PlatformBloqIngestCommand)
  .command(PlatformBloqMembersCommand)
  .command(PlatformEvalCommand)
  .command(PlatformSdkCallCommand)
  .command(PlatformDiaryCommand)
  .command(PlatformSkillsCommand)
  .command(PlatformSopCommand)
  .command(PlatformToolsCommand)
  .command(PlatformUsersCommand)
  .command(PlatformPhoneCommand)
  .command(PlatformVoiceCommand)
  .command(PlatformWalletCommand)
  // PHP-port commands — config, app, automation, automation:test
  // (integrations is owned by PlatformRunCommand in platform-run.ts)
  .command(PlatformConfigCommand)
  .command(PlatformAppCommand)
  .command(PlatformAutomationCommand)
  .command(PlatformAutomationTestCommand)
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
