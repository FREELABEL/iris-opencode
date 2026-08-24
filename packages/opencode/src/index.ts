import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { InstallAppCommand } from "./cli/cmd/install-app"
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
import { PlatformLeadsCommand, PlatformDealsCommand, PlatformPulseCommand } from "./cli/cmd/platform-leads"
import { PlatformDialerCommand } from "./cli/cmd/platform-dialer"
import { PlatformWorkflowsCommand } from "./cli/cmd/platform-workflows"
import { PlatformBloqsCommand, PlatformSearchCommand } from "./cli/cmd/platform-bloqs"
import { PlatformBloqSyncCommand } from "./cli/cmd/platform-bloq-sync"
import { PlatformWorkspaceCommand } from "./cli/cmd/platform-workspace"
import { PlatformTeamsCommand } from "./cli/cmd/platform-teams"
import { PlatformBrandsCommand } from "./cli/cmd/platform-brands"
import { OkfCommand } from "./cli/cmd/platform-okf"
import { PlatformLearnCommand } from "./cli/cmd/platform-learn"
import { PlatformCopycatCommand } from "./cli/cmd/platform-copycat"
import { PlatformContentCommand } from "./cli/cmd/platform-content"
import { PlatformGoodDealsCommand } from "./cli/cmd/platform-good-deals"
import { PlatformLinkedInCommand } from "./cli/cmd/platform-linkedin"
import { PlatformBloqContextCommand } from "./cli/cmd/platform-bloq-context"
import { PlatformAtlasLedgerCommand } from "./cli/cmd/platform-atlas-ledger"
import { PlatformMintCommand } from "./cli/cmd/platform-mint"
import { PlatformOkrCommand, PlatformKpiCommand } from "./cli/cmd/platform-okr"
import { PlatformAtlasStaffCommand } from "./cli/cmd/platform-atlas-staff"
import { PlatformAtlasInventoryCommand } from "./cli/cmd/platform-atlas-inventory"
import { PlatformAtlasDatasetsCommand } from "./cli/cmd/platform-atlas-datasets"
import { PlatformOnboardingCommand } from "./cli/cmd/platform-onboarding"
import { PlatformAtlasItemCommand } from "./cli/cmd/platform-atlas-item"
import { PlatformAtlasProjectionsCommand } from "./cli/cmd/platform-atlas-projections"
import { PlatformSchedulesCommand } from "./cli/cmd/platform-schedules"
import { PlatformN8nCommand } from "./cli/cmd/platform-n8n"
import { PlatformBoardsCommand } from "./cli/cmd/platform-boards"
import { PlatformDiscoverCommand } from "./cli/cmd/platform-discover"
import { PlatformOpportunitiesCommand } from "./cli/cmd/platform-opportunities"
import { PlatformBountiesCommand } from "./cli/cmd/platform-bounties"
import { PlatformBookingsCommand } from "./cli/cmd/platform-bookings"
import { PlatformTutorialsCommand } from "./cli/cmd/platform-tutorials"
import { PlatformServicesCommand } from "./cli/cmd/platform-services"
import { PlatformProductsCommand } from "./cli/cmd/platform-products"
import { PlatformEventsCommand } from "./cli/cmd/platform-events"
import { PlatformVenuesCommand } from "./cli/cmd/platform-venues"
import { PlatformGeoCommand } from "./cli/cmd/platform-geo"
import { PlatformProgramsCommand } from "./cli/cmd/platform-programs"
import { PlatformMagazineCommand } from "./cli/cmd/platform-magazine"
import { PlatformRemotionCommand } from "./cli/cmd/platform-remotion"
import { PlatformReleaseCommand } from "./cli/cmd/platform-release"
import { PlatformAnnounceCommand } from "./cli/cmd/platform-announce"
import { PlatformBroadcastCommand } from "./cli/cmd/platform-broadcast"
import { PlatformHiveCommand } from "./cli/cmd/platform-hive"
import { VaultCommandExport } from "./cli/cmd/platform-vault"
import { PlatformClipsCommand } from "./cli/cmd/platform-clips"
import { PlatformPostCommand } from "./cli/cmd/platform-post"
import { XCommand } from "./cli/cmd/platform-x"
import { PlatformOutreachCommand } from "./cli/cmd/platform-outreach"
import { PlatformOutreachCampaignCommand } from "./cli/cmd/platform-outreach-campaign"
import { PlatformOutreachSendCommand } from "./cli/cmd/platform-outreach-send"
import { PlatformSomCommand } from "./cli/cmd/platform-som"
import { PlatformEventCommand } from "./cli/cmd/platform-event"
import { PlatformMonitorCommand } from "./cli/cmd/platform-monitor"
import { PlatformCommonsCommand } from "./cli/cmd/platform-commons"
import { PlatformLexiconCommand } from "./cli/cmd/platform-lexicon"
import { PlatformInvoicesCommand } from "./cli/cmd/platform-invoices"
import { PlatformPaymentsCommand } from "./cli/cmd/platform-payments"
import { PlatformRevenueCommand } from "./cli/cmd/platform-revenue"
import { PlatformDeliverCommand, DeliverCarouselCommand } from "./cli/cmd/platform-deliver"
import { PlatformRunCommand, PlatformConnectCommand, PlatformListConnectedCommand, PlatformListAvailableCommand, PlatformExecCommand, PlatformListToolsCommand, PlatformListIntegrationsCommand } from "./cli/cmd/platform-run"
import { PlatformListenCommand } from "./cli/cmd/listen"
import { PlatformTranscribeCommand } from "./cli/cmd/transcribe"
import { PlatformDownloadCommand } from "./cli/cmd/download"
import { PlatformBugCommand } from "./cli/cmd/platform-bug"
import { DeviceCommand } from "./cli/cmd/platform-device"
import { PlatformCameraCommand } from "./cli/cmd/platform-camera"
import { PlatformAtlasMeetingsCommand } from "./cli/cmd/platform-atlas-meetings"
import { PlatformAtlasBrandKitCommand } from "./cli/cmd/platform-atlas-brand-kit"
import { PlatformAgreementsCommand } from "./cli/cmd/platform-agreements"
import { PlatformAtlasCommsCommand } from "./cli/cmd/platform-atlas-comms"
import { PlatformLeadsMeetingCommand } from "./cli/cmd/platform-leads-meeting"
import { PlatformMeetingsCommand } from "./cli/cmd/platform-meetings"
import { PlatformCampaignCommand } from "./cli/cmd/platform-campaign"
import { PlatformDaemonCommand } from "./cli/cmd/platform-daemon"
import { PlatformChannelsCommand } from "./cli/cmd/platform-channels"
import { PlatformObsCommand } from "./cli/cmd/platform-obs"
import { PlatformDoctorCommand } from "./cli/cmd/platform-doctor"
import { PlatformSessionsCommand } from "./cli/cmd/platform-sessions"
import { PlatformProdCommand } from "./cli/cmd/platform-prod"
import { PlatformPermissionsCommand } from "./cli/cmd/platform-permissions"
import { PlatformIdentityCommand } from "./cli/cmd/platform-identity"
import { PlatformSystemAppsScanCommand } from "./cli/cmd/platform-system-apps-scan"
import { PlatformIdeasCommand } from "./cli/cmd/platform-ideas"
import { PlatformOnboardCommand } from "./cli/cmd/platform-onboard"
import { PlatformInitCommand } from "./cli/cmd/platform-init"
import { PlatformOnboardFlowsCommand } from "./cli/cmd/platform-onboard-flows"
import { PlatformProposalsCommand } from "./cli/cmd/platform-proposals"
import { PlatformContractsCommand } from "./cli/cmd/platform-contracts"
import { PlatformPagesCommand } from "./cli/cmd/platform-pages"
import { PlatformFindCommand } from "./cli/cmd/platform-find"
import { PlatformDashboardCommand } from "./cli/cmd/platform-dashboard"
import { PlatformContentEngineCommand } from "./cli/cmd/platform-content-engine"
import { PlatformSitesCommand } from "./cli/cmd/platform-sites"
import { PlatformDomainsCommand } from "./cli/cmd/platform-domains"
import { PlatformPagesBatchCommand } from "./cli/cmd/platform-pages-batch"
import { PlatformPartialsCommand } from "./cli/cmd/platform-partials"
import { PlatformScriptsCommand } from "./cli/cmd/platform-scripts"
import { PlatformCloudUploadCommand } from "./cli/cmd/platform-cloud-upload"
import { PlatformDriveCommand } from "./cli/cmd/platform-drive"
import { PlatformObsidianCommand } from "./cli/cmd/platform-obsidian"
import { PlatformCreativeCommand } from "./cli/cmd/platform-creative"
import { PlatformPackagesCommand } from "./cli/cmd/platform-packages"
import { PlatformMarketplaceCommand } from "./cli/cmd/platform-marketplace"
import { PlatformMemoryCommand } from "./cli/cmd/platform-memory"
import { PlatformProfileCommand } from "./cli/cmd/platform-profile"
import { PlatformBloqIngestCommand } from "./cli/cmd/platform-bloq-ingest"
import { PlatformDataSourcesCommand } from "./cli/cmd/platform-data-sources"
import { PlatformBloqMembersCommand } from "./cli/cmd/platform-bloq-members"
import { PlatformWisprCommand } from "./cli/cmd/platform-wispr"
import { PlatformEvalCommand } from "./cli/cmd/platform-eval"
import { PlatformSdkCallCommand } from "./cli/cmd/platform-sdk-call"
import { PlatformDiaryCommand } from "./cli/cmd/platform-diary"
import { TimelineCommands } from "./cli/cmd/platform-timeline"
// PlatformSkillsCommand (plural) is now merged into PlatformSkillCommand (singular)
// Keep the old "skills" command as an alias that points to "skill remote"
import { PlatformSkillsCommand } from "./cli/cmd/platform-skills"
import { PlatformSopCommand } from "./cli/cmd/platform-sop"
import { PlatformCourseCommand } from "./cli/cmd/platform-course"
import { PlatformToolsCommand } from "./cli/cmd/platform-tools"
import { PlatformUsersCommand } from "./cli/cmd/platform-users"
import { PlatformPhoneCommand } from "./cli/cmd/platform-phone"
import { PlatformVoiceCommand } from "./cli/cmd/platform-voice"
import { PlatformRecallCommand } from "./cli/cmd/platform-recall"
import { PlatformPersonalityCommand } from "./cli/cmd/platform-personality"
import { PlatformMailCommand } from "./cli/cmd/platform-mail"
import { PlatformSendersCommand } from "./cli/cmd/platform-senders"
import { PlatformImessageCommand } from "./cli/cmd/platform-imessage"
import { PlatformWhatsappCommand } from "./cli/cmd/platform-whatsapp"
import { PlatformDiscordCommand } from "./cli/cmd/platform-discord"
import { PlatformSlackCommand } from "./cli/cmd/platform-slack"
import { PlatformGmailCommand } from "./cli/cmd/platform-gmail"
import { PlatformTelegramCommand } from "./cli/cmd/platform-telegram"
import { PlatformInstagramCommand } from "./cli/cmd/platform-instagram"
import { PlatformInstagramFeedCommand } from "./cli/cmd/platform-instagram-feed"
import { PlatformCalendarCommand } from "./cli/cmd/platform-calendar"
import { PlatformHeartbeatCommand } from "./cli/cmd/platform-heartbeat"
import { PlatformInboxCommand } from "./cli/cmd/platform-inbox"
import { PlatformDocsCommand } from "./cli/cmd/platform-docs"
import { PlatformWalletCommand } from "./cli/cmd/platform-wallet"
import { PlatformConfigCommand } from "./cli/cmd/platform-config"
import { PlatformAppCommand } from "./cli/cmd/platform-app"
import { PlatformAutomationAliasCommand } from "./cli/cmd/platform-automation"
import { PlatformAutomationTestCommand } from "./cli/cmd/platform-automation-test"
import { HowToCommand } from "./cli/cmd/platform-howto"
import { PlatformClaudeCommand } from "./cli/cmd/platform-claude"
import { PlatformArticleQaCommand } from "./cli/cmd/platform-article-qa"
import { PlatformMsgCommand } from "./cli/cmd/platform-msg"
import { PlatformAffiliatesCommand } from "./cli/cmd/platform-affiliates"
import { PlatformPlaybookCommand, PlatformSkillCommand } from "./cli/cmd/platform-playbook"
import { PlatformLoopCommand } from "./cli/cmd/platform-loop"
import { PlatformUsageCommand, PlatformTracesCommand } from "./cli/cmd/platform-usage"
import { GuideCommand } from "./cli/cmd/guide"
import { registerCommand, getRegistry } from "./cli/cmd/command-groups"
import { renderGroupedHelp, renderNamespacedHelp } from "./cli/help-renderer"
import { Beacon } from "./telemetry/beacon"

// Register a command in the grouped help registry and return it unchanged
function reg<T>(commandModule: T): T {
  registerCommand(commandModule)
  return commandModule
}

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
  void Beacon.report("cli_uncaught", {
    message: e instanceof Error ? e.message : String(e),
    context: { kind: "unhandledRejection" },
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
  void Beacon.report("cli_uncaught", {
    message: e instanceof Error ? e.message : String(e),
    context: { kind: "uncaughtException" },
  })
})

const rawArgs = hideBin(process.argv)

const cli = yargs(rawArgs)
  // boolean-negation OFF: many commands register literal `--no-*` flags
  // (--no-rag, --no-publish, --no-commit, …). With yargs' default negation on,
  // `--no-rag` was parsed as `rag=false`, then strict() rejected it as an
  // "Unknown argument: rag" (#146915). Disabling negation makes `--no-x` a
  // literal flag, which is what every `.option("no-x")` here intends.
  .parserConfiguration({ "populate--": true, "boolean-negation": false })
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
  .command(reg(PlatformFindCommand))
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
  .command(reg(InstallAppCommand))
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
  .command(reg(PlatformPulseCommand))
  .command(reg(PlatformDialerCommand))
  .command(reg(PlatformWorkflowsCommand))
  .command(reg(PlatformBloqsCommand))
  .command(reg(PlatformSearchCommand))
  .command(reg(PlatformBloqSyncCommand))
  .command(reg(PlatformWorkspaceCommand))
  .command(reg(PlatformTeamsCommand))
  .command(reg(PlatformBrandsCommand))
  .command(reg(OkfCommand))
  .command(reg(PlatformLearnCommand))
  .command(reg(PlatformCopycatCommand))
  .command(reg(PlatformContentCommand))
  .command(reg(PlatformGoodDealsCommand))
  .command(reg(PlatformLinkedInCommand))
  .command(reg(PlatformBloqContextCommand))
  .command(reg(PlatformAtlasLedgerCommand))
  .command(reg(PlatformMintCommand))
  .command(reg(PlatformOkrCommand))
  .command(reg(PlatformKpiCommand))
  .command(reg(PlatformAtlasStaffCommand))
  .command(reg(PlatformAtlasInventoryCommand))
  .command(reg(PlatformAtlasDatasetsCommand))
  .command(reg(PlatformOnboardingCommand))
  .command(reg(PlatformAtlasItemCommand))
  .command(reg(PlatformAtlasProjectionsCommand))
  .command(reg(PlatformSchedulesCommand))
  .command(reg(PlatformN8nCommand))
  .command(reg(PlatformBoardsCommand))
  .command(reg(PlatformDiscoverCommand))
  .command(reg(PlatformOpportunitiesCommand))
  .command(reg(PlatformBountiesCommand))
  .command(reg(PlatformBookingsCommand))
  .command(reg(PlatformTutorialsCommand))
  .command(reg(PlatformServicesCommand))
  .command(reg(PlatformProductsCommand))
  .command(reg(PlatformEventsCommand))
  .command(reg(PlatformVenuesCommand))
  .command(reg(PlatformGeoCommand))
  .command(reg(PlatformProgramsCommand))
  .command(reg(PlatformMagazineCommand))
  .command(reg(PlatformRemotionCommand))
  .command(reg(PlatformReleaseCommand))
  .command(reg(PlatformAnnounceCommand))
  .command(reg(PlatformBroadcastCommand))
  .command(reg(PlatformHiveCommand))
  .command(reg(VaultCommandExport))
  .command(reg(PlatformClipsCommand))
  .command(reg(PlatformPostCommand))
  .command(reg(XCommand))
  .command(reg(PlatformOutreachCommand))
  .command(reg(PlatformOutreachCampaignCommand))
  .command(reg(PlatformOutreachSendCommand))
  .command(reg(PlatformSomCommand))
  .command(reg(PlatformEventCommand))
  .command(reg(PlatformMonitorCommand))
  .command(reg(PlatformCommonsCommand))
  .command(reg(PlatformLexiconCommand))
  .command(reg(PlatformInboxCommand))

  .command(reg(PlatformInvoicesCommand))
  .command(reg(PlatformPaymentsCommand))
  .command(reg(PlatformRevenueCommand))
  .command(reg(DeliverCarouselCommand))
  .command(reg(PlatformDeliverCommand))
  .command(reg(PlatformRunCommand))
  .command(reg(PlatformExecCommand))
  .command(reg(PlatformListToolsCommand))
  .command(reg(PlatformListIntegrationsCommand))
  .command(reg(PlatformTranscribeCommand))
  .command(reg(PlatformListenCommand))
  .command(reg(PlatformDownloadCommand))
  .command(reg(PlatformConnectCommand))
  .command(reg(PlatformListConnectedCommand))
  .command(reg(PlatformListAvailableCommand))
  .command(reg(PlatformBugCommand))
  .command(reg(DeviceCommand))
  .command(reg(PlatformAtlasMeetingsCommand))
  .command(reg(PlatformAtlasBrandKitCommand))
  .command(reg(PlatformAgreementsCommand))
  .command(reg(PlatformAtlasCommsCommand))
  .command(reg(PlatformLeadsMeetingCommand))
  .command(reg(PlatformMeetingsCommand))
  .command(reg(PlatformCampaignCommand))
  .command(reg(PlatformDaemonCommand))
  .command(reg(PlatformChannelsCommand))
  .command(reg(PlatformDiscordCommand))
  .command(reg(PlatformSlackCommand))
  .command(reg(PlatformGmailCommand))
  .command(reg(PlatformTelegramCommand))
  .command(reg(PlatformInstagramCommand))
  .command(reg(PlatformInstagramFeedCommand))
  .command(reg(PlatformDoctorCommand))
  .command(reg(PlatformSessionsCommand))
  .command(reg(PlatformProdCommand))
  .command(reg(PlatformPermissionsCommand))
  .command(reg(PlatformIdentityCommand))
  .command(reg(PlatformSystemAppsScanCommand))
  .command(reg(PlatformIdeasCommand))
  .command(reg(PlatformObsCommand))
  .command(reg(PlatformCameraCommand))
  .command(reg(PlatformOnboardCommand))
  .command(reg(PlatformInitCommand))
  .command(reg(PlatformOnboardFlowsCommand))
  .command(reg(PlatformProposalsCommand))
  .command(reg(PlatformContractsCommand))
  .command(reg(PlatformPagesCommand))
  .command(reg(PlatformDashboardCommand))
  .command(reg(PlatformContentEngineCommand))
  .command(reg(PlatformSitesCommand))
  .command(reg(PlatformDomainsCommand))
  .command(reg(PlatformPagesBatchCommand))
  .command(reg(PlatformPartialsCommand))
  .command(reg(PlatformScriptsCommand))
  .command(reg(PlatformCloudUploadCommand))
  .command(reg(PlatformDriveCommand))
  .command(reg(PlatformObsidianCommand))
  .command(reg(PlatformCreativeCommand))
  .command(reg(PlatformPackagesCommand))
  .command(reg(PlatformMarketplaceCommand))
  .command(reg(PlatformMemoryCommand))
  .command(reg(PlatformProfileCommand))
  .command(reg(PlatformBloqIngestCommand))
  .command(reg(PlatformDataSourcesCommand))
  .command(reg(PlatformBloqMembersCommand))
  .command(reg(PlatformWisprCommand))
  .command(reg(PlatformEvalCommand))
  .command(reg(PlatformSdkCallCommand))
  .command(reg(PlatformDiaryCommand))
  .command(reg(TimelineCommands[0]))
  .command(reg(PlatformSkillsCommand))
  .command(reg(PlatformSopCommand))
  .command(reg(PlatformCourseCommand))
  .command(reg(PlatformToolsCommand))
  .command(reg(PlatformUsersCommand))
  .command(reg(PlatformPhoneCommand))
  .command(reg(PlatformVoiceCommand))
  .command(reg(PlatformRecallCommand))
  .command(reg(PlatformPersonalityCommand))
  .command(reg(PlatformMailCommand))
  .command(reg(PlatformSendersCommand))
  .command(reg(PlatformImessageCommand))
  .command(reg(PlatformWhatsappCommand))
  .command(reg(PlatformCalendarCommand))
  .command(reg(PlatformHeartbeatCommand))
  .command(reg(PlatformDocsCommand))
  .command(reg(PlatformWalletCommand))
  // PHP-port commands — config, app, automation, automation:test
  // (integrations is owned by PlatformRunCommand in platform-run.ts)
  .command(reg(PlatformConfigCommand))
  .command(reg(PlatformAppCommand))
  .command(reg(PlatformAutomationAliasCommand))
  .command(reg(PlatformAutomationTestCommand))
  .command(reg(HowToCommand))
  .command(reg(PlatformClaudeCommand))
  .command(reg(PlatformArticleQaCommand))
  .command(reg(PlatformMsgCommand))
  .command(reg(PlatformAffiliatesCommand))
  .command(reg(PlatformLoopCommand))
  .command(reg(PlatformUsageCommand))
  .command(reg(PlatformTracesCommand))
  .command(reg(PlatformPlaybookCommand))
  .command(PlatformSkillCommand) // hidden alias for backward compat
  .fail((msg, err) => {
    // A thrown error from inside a command handler — let the outer catch format it.
    if (err) throw err
    // Validation failures (missing required args, unknown flags, bad values, etc.):
    // always surface the message and the command usage so the user knows what went
    // wrong. Previously only three message prefixes triggered help, so failures like
    // "Missing required argument: board" exited silently with no output (#119560).
    if (msg) UI.error(msg)
    cli.showHelp("log")
    process.exit(1)
  })
  .strict()
  // Turn "Unknown argument: sceduals" into "Did you mean schedules?". strict() already
  // rejects the typo, but rejection plus a 60-line command dump leaves the reader to
  // spot the near-match themselves. Costs nothing when the input is not close to anything.
  .recommendCommands()

// Intercept top-level --help after all commands are registered
const hasHelp = rawArgs.includes("--help") || rawArgs.includes("-h")
const hasNoCommand = rawArgs.every((a) => a.startsWith("-"))
if (hasHelp && hasNoCommand) {
  console.log(renderGroupedHelp())
  process.exit(0)
}

// Intercept `iris <parent> --help` to surface `<parent>:*` namespaced commands, which
// yargs registers as separate top-level commands and never lists under the parent
// (#137271 atlas, #137272 all 14 colon-namespaced commands). Print the namespaced
// suite first, then fall through to yargs for the parent's own native help. If the
// parent is ONLY a namespace (e.g. `cloud`, `sdk` — no bare command), strict() would
// reject it, so we print the suite and exit cleanly instead.
if (hasHelp) {
  const firstArg = rawArgs.find((a) => !a.startsWith("-"))
  if (firstArg && !firstArg.includes(":")) {
    const block = renderNamespacedHelp(firstArg)
    if (block) {
      console.log(block)
      const registry = getRegistry()
      const isRealCommand = registry.some(
        (c) => c.name === firstArg || c.aliases.includes(firstArg),
      )
      if (!isRealCommand) process.exit(0)
    }
  }
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

// COMMAND-LEVEL TRACE (#178533 follow-up). Until now the only spans that existed
// came from session/processor.ts — the agent loop. But `iris <cmd>` never goes near
// that loop, and `iris <cmd>` is 100% of what the MCP connector executes: iris-exec
// spawns the binary with one command and reads stdout. So the surface we shipped the
// beta on produced no run_start, no run_end, no successes — only a cli_command_error
// when something threw.
//
// That is an error log without a denominator, which is the exact failure the trace
// spine was built to end: "0 errors" and "nobody ran anything" were the same reading.
// A run_start/run_end pair per invocation is what makes `iris usage` able to say a
// command was run 40 times and failed twice, instead of only ever knowing about the two.
// Beacon owns the id, not this file — the model provider stamps the same one on spend so
// cost can be joined to this run (#179797), and it is built lazily, so whoever asks first
// must get the same answer.
const commandTraceId = Beacon.traceId()
const commandSpanId = Beacon.newSpanId()
const commandStartedAt = Date.now()

// The command WORD only (`leads`, `pages`, `bug`) — never argv. Flags and positionals
// carry search terms, names and record ids, and this table is metadata-only.
const commandName = rawArgs.find((a) => !a.startsWith("-"))

Beacon.span("run_start", {
  trace_id: commandTraceId,
  span_id: commandSpanId,
  command: commandName,
})

try {
  await cli.parse()

  Beacon.span("run_end", {
    trace_id: commandTraceId,
    span_id: Beacon.newSpanId(),
    parent_span_id: commandSpanId,
    command: commandName,
    outcome: "ok",
    duration_ms: Date.now() - commandStartedAt,
  })

  // ACTIVATION (#179077 follow-up). Fires once, ever, on the first command run
  // after authenticating — the step that separates "installed" from "actually
  // used". Deliberately after parse() succeeds: a command that threw is not
  // activation. Awaited so it flushes before the finally{} exit, and internally
  // silent, so it can neither delay nor break the command that triggered it.
  await Beacon.firstCommand(rawArgs[0])
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

  // Close the trace on the failure path too. A run_start with no run_end reads as
  // "died without reporting", and a command that threw cleanly is not that — it is a
  // known outcome, and conflating the two hides the crashes that genuinely vanish.
  Beacon.span("run_end", {
    trace_id: commandTraceId,
    span_id: Beacon.newSpanId(),
    parent_span_id: commandSpanId,
    command: commandName,
    outcome: "error",
    duration_ms: Date.now() - commandStartedAt,
  })

  // Beacon the fatal command error to telemetry. Awaited so the POST flushes
  // before the finally{} process.exit() — reliable client error visibility.
  await Beacon.report("cli_command_error", {
    message: e instanceof Error ? e.message : String(e),
    command: rawArgs[0],
    context: { name: e instanceof Error ? e.name : undefined },
  })
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e)
  }
  process.exitCode = 1
} finally {
  // Spans are buffered and coalesced on a 2s unref'd timer, which a CLI process
  // never lives long enough to reach — and process.exit() below discards the
  // buffer. Without this await, run_end is written for every invocation and sent
  // for none, which is worse than not recording it: every run would look abandoned.
  // Capped at 800ms rather than the 3s default: this await is the last thing
  // between the user and their prompt. It never throws.
  await Beacon.flush(800)

  // FLUSH BEFORE EXITING. When stdout is a PIPE (`iris ... --json | jq`, or any
  // scripted use) Node's writes are asynchronous, and process.exit() discards
  // whatever is still buffered — silently truncating the output mid-string.
  //
  // The symptom is a JSON payload that ends partway through a value, so the
  // consumer reports "Unterminated string" and it reads like corrupt data rather
  // than a lost write. It only bites past the pipe buffer (~64KB), which makes it
  // look content-dependent and intermittent: `iris bug list --limit 20 --json`
  // failed, then the identical command succeeded minutes later, because the byte
  // size depends on which records land on the page. A terminal never shows it —
  // TTY writes are synchronous — so it is invisible interactively and only
  // breaks scripts.
  //
  // The explicit exit below still has to stay: some docker-container-based MCP
  // servers don't react to SIGTERM unless run with `docker run --init`, and
  // without it the CLI hangs. So drain first, then exit.
  // NOTE (large --json payloads): this exit truncates anything still buffered on
  // stdout when stdout is a pipe. Do NOT try to fix that here — letting the
  // process exit naturally instead HANGS, because the exit exists precisely to
  // kill subprocesses that ignore SIGTERM (some docker-based MCP servers unless
  // run with `docker run --init`). Tried and reverted.
  //
  // The fix belongs at the write site: emit large payloads with `writeJson()`
  // from cli/cmd/iris-api.ts, which AWAITS the flush before the handler returns,
  // so the bytes are gone by the time we get here. See the note on that function.
  process.exit()
}
