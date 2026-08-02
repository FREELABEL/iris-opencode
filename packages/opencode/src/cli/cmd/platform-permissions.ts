import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, printDivider, printKV, success } from "./iris-api"
import * as Permissions from "../lib/permissions"

/**
 * `iris permissions` (#178283).
 *
 * Detection for these already existed in six places; what did not exist anywhere
 * in the repo was a way to OPEN the right System Settings pane — the deep link
 * appears zero times before this. So the friction the reporter described was
 * real: you were told "System Settings → Privacy → Full Disk Access" and left to
 * find it and guess which app to tick.
 *
 * What this cannot do, and says so rather than pretending: macOS has no API to
 * grant TCC permissions to a terminal process. Detect, open the exact pane,
 * re-check. Nothing more is possible from a CLI.
 */

function renderChecks(checks: Permissions.PermissionCheck[]) {
  for (const c of checks) {
    const mark = c.granted ? success("✓") : "✗"
    printKV(`${mark} ${c.name}`, c.granted ? "granted" : (c.detail ?? "not granted"))
    if (!c.granted) {
      prompts.log.info(`   ${dim(`unlocks: ${c.unlocks}`)}`)
    }
  }
}

function unsupported(json: boolean): boolean {
  if (Permissions.isSupported()) return false
  const msg = "macOS-only — these are macOS privacy (TCC) permissions."
  if (json) console.log(JSON.stringify({ success: false, error: msg, platform: process.platform }))
  else prompts.log.warn(msg)
  return true
}

const PermissionsCheckCommand = cmd({
  command: "check",
  aliases: ["list", "status"],
  describe: "show which macOS permissions IRIS has, and what each one unlocks",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (unsupported(args.json)) return

    const checks = Permissions.checkAll()

    if (args.json) {
      console.log(JSON.stringify({ success: true, host_app: Permissions.hostApp(), permissions: checks }, null, 2))
      return
    }

    UI.empty()
    prompts.intro("◈  macOS Permissions")
    printDivider()
    renderChecks(checks)
    printDivider()

    const missing = checks.filter((c) => !c.granted)
    if (missing.length === 0) {
      prompts.outro(dim("All set."))
      return
    }

    prompts.log.info(`Grant these to ${bold(Permissions.hostApp())} — that is the app macOS lists, not "iris".`)
    prompts.outro(dim(`Fix them: iris permissions grant`))
  },
})

const PermissionsGrantCommand = cmd({
  command: "grant [permission]",
  aliases: ["fix", "request"],
  describe: "open the right System Settings pane for a missing permission, then re-check",
  builder: (yargs) =>
    yargs
      .positional("permission", {
        describe: "which one (default: every missing one)",
        type: "string",
        choices: Permissions.ALL,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (unsupported(args.json)) return

    const targets = args.permission
      ? [Permissions.check(args.permission as Permissions.PermissionId)]
      : Permissions.checkAll().filter((c) => !c.granted)

    if (targets.length === 0) {
      if (args.json) console.log(JSON.stringify({ success: true, granted: true, message: "nothing missing" }))
      else { UI.empty(); prompts.log.info(`${success("✓")} Nothing to grant — all permissions are already in place.`) }
      return
    }

    // Non-interactive (scripts, MCP): open nothing, just report what to do.
    // Opening System Settings on a machine nobody is looking at is noise.
    if (args.json) {
      console.log(JSON.stringify({
        success: true,
        host_app: Permissions.hostApp(),
        needed: targets.map((t) => ({ id: t.id, name: t.name, settings_url: t.settingsUrl, unlocks: t.unlocks })),
      }, null, 2))
      return
    }

    UI.empty()
    prompts.intro("◈  Grant macOS Permissions")

    for (const t of targets) {
      printDivider()
      printKV("Permission", t.name)
      printKV("Unlocks", t.unlocks)
      printKV("Tick this app", Permissions.hostApp())

      const opened = Permissions.openSettings(t.id)
      if (opened) {
        prompts.log.info("Opened System Settings at the right pane.")
      } else {
        prompts.log.warn(`Could not open System Settings. Go to: ${t.settingsUrl}`)
      }

      const ready = await prompts.confirm({
        message: `Grant ${t.name} to ${Permissions.hostApp()}, then continue. Done?`,
      })
      if (prompts.isCancel(ready) || !ready) {
        prompts.outro(dim("Stopped. Re-run: iris permissions grant"))
        return
      }

      // Re-check. A grant usually needs the terminal RESTARTED before the
      // running process sees it — TCC decisions are cached per process — so a
      // still-denied result here is expected, not a failure.
      const after = Permissions.check(t.id)
      if (after.granted) {
        prompts.log.info(`${success("✓")} ${t.name} is now active.`)
      } else {
        prompts.log.warn(
          `${t.name} still reads as denied. macOS caches this per process — ` +
            `quit and reopen ${Permissions.hostApp()}, then run: iris permissions check`,
        )
      }
    }

    printDivider()
    prompts.outro(dim("iris permissions check   ·   iris doctor"))
  },
})

export const PlatformPermissionsCommand = cmd({
  command: "permissions",
  aliases: ["perms", "permission"],
  describe: "check and repair the macOS permissions IRIS needs (Full Disk Access, Contacts, Automation)",
  builder: (yargs) =>
    yargs
      .command(PermissionsCheckCommand)
      .command(PermissionsGrantCommand)
      // #178285 was the same complaint about `how-to`: a bare parent command
      // that errors instead of doing the obvious thing. Default to `check`.
      .command({
        command: "$0",
        describe: false as unknown as string,
        handler: (a: any) => (PermissionsCheckCommand as any).handler(a),
      }),
  async handler() {},
})
