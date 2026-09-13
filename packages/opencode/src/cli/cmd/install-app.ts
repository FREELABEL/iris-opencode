import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "./clack"
import { $ } from "bun"
import os from "os"
import fs from "fs/promises"
import { existsSync } from "fs"

export const InstallAppCommand = {
  command: "install-app",
  aliases: ["desktop"],
  describe: "install or update the IRIS desktop app",
  builder: (yargs: Argv) => {
    return yargs
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "reinstall even if already installed",
        default: false,
      })
  },
  handler: async (args: { force?: boolean }) => {
    UI.empty()
    prompts.intro("IRIS Desktop App")

    // Windows ships an NSIS installer (.exe), not a zip — a different flow with no
    // unzip-into-Applications step. Download it and hand off; silently running an
    // installer on someone's machine is not this command's call to make.
    // Uses fetch/Bun.write rather than the shell pipeline below, which is unix-only
    // (mktemp/unzip/xattr do not exist on Windows).
    if (process.platform === "win32") {
      // heyiris.io, not /releases/latest/download/. That URL has no fallback by asset name --
      // it resolves to whichever release holds the one repo-wide "latest" flag, which the CLI
      // series takes on every publish. It served the desktop build off `main` (version 1.1.3,
      // no 1.18 engine, no rebrand), and now that CLI releases carry no desktop assets it
      // would simply 404. heyiris.io selects the desktop-v* series by tag prefix.
      const setupUrl = "https://heyiris.io/download/windows"
      const dest = `${os.homedir()}\\Downloads\\IRIS-Setup.exe`
      const winSpinner = prompts.spinner()
      winSpinner.start("Downloading the IRIS installer...")
      try {
        const res = await fetch(setupUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await Bun.write(dest, res)
        winSpinner.stop("Installer downloaded")
        prompts.log.success(`Saved to ${dest}`)
        prompts.log.info("Run it to finish installing.")
        prompts.log.info("The build is unsigned, so SmartScreen will warn — click")
        prompts.log.info('  "More info" -> "Run anyway"')
      } catch (e) {
        winSpinner.stop("Download failed", 1)
        prompts.log.error(`Could not download the installer: ${e}`)
        prompts.log.info(`  ${setupUrl}`)
      }
      prompts.outro("Done")
      return
    }

    if (process.platform !== "darwin") {
      prompts.log.warn("No desktop build for this platform yet")
      prompts.log.info("macOS and Windows only. A Linux desktop build is not")
      prompts.log.info("produced by CI yet — tracked as bug:182262 / BG-182262.")
      prompts.log.info("The IRIS CLI itself does support Linux.")
      prompts.outro("Done")
      return
    }

    const home = os.homedir()
    const arch = process.arch === "arm64" ? "arm64" : "x64"
    const appDir = `${home}/Applications`
    const appPath = `${appDir}/IRIS.app`

    // Check if already installed
    const globalApp = await $`test -d "/Applications/IRIS.app" && echo "exists"`.nothrow().quiet().text()
    const localApp = await $`test -d "${appPath}" && echo "exists"`.nothrow().quiet().text()

    if ((globalApp.includes("exists") || localApp.includes("exists")) && !args.force) {
      const location = globalApp.includes("exists") ? "/Applications/IRIS.app" : `~/Applications/IRIS.app`
      prompts.log.success(`Already installed at ${location}`)
      prompts.log.info("Use --force to reinstall")
      prompts.outro("Done")
      return
    }

    // IRIS-app-darwin-* was the OLD Electron/SaaS-wrapper app. Its build job has been
    // dead for weeks (expired CROSS_REPO_PAT) so that asset 404s on every recent
    // release — this command was silently broken. The current desktop app is the
    // Tauri build in packages/desktop, published as IRIS-tauri-darwin-{arm64,x64}.zip
    // since v1.3.206. See item:182113 / IT-182113.
    // Same reason as the Windows path above: heyiris.io resolves desktop-v* by tag prefix.
    const appUrl = `https://heyiris.io/download/mac-${arch}-zip`

    const spinner = prompts.spinner()
    spinner.start("Downloading IRIS desktop app...")

    // NOT a multi-line `$` template. Bun's `$` is its own shell, not bash, and it cannot parse
    // a script opening with `tmpdir=$(mktemp -d) &&` across newlines. The throw happens at PARSE
    // time, before a single byte is downloaded, so `iris desktop` died on every macOS machine
    // with "expected a command or assignment" and never reached the network. Reproduced down to
    // a three-line probe: the same error, at the same BunShell offset.
    //
    // The Windows branch above already had the right shape — fetch + Bun.write, no shell at all
    // for the transfer — so this mirrors it. Shell is used only for unzip and xattr, as SINGLE
    // commands, which Bun's parser does handle.
    //
    // The old version also wrapped every step in `2>/dev/null` and `.nothrow()`, so a 404, a
    // full disk and a corrupt archive all produced the identical "Download failed". Each failure
    // now names itself; a disk with no space left is a real cause here, not a hypothetical.
    let installed = false
    let failure = ""
    try {
      const res = await fetch(appUrl)
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${appUrl}`)

      const tmpZip = `${os.tmpdir()}/IRIS-app-${process.pid}-${Date.now()}.zip`
      await Bun.write(tmpZip, res)

      await fs.rm(appPath, { recursive: true, force: true })
      await fs.mkdir(appDir, { recursive: true })

      const unzip = await $`unzip -q ${tmpZip} -d ${appDir}`.nothrow().quiet()
      if (unzip.exitCode !== 0) {
        throw new Error(`unzip failed (exit ${unzip.exitCode}) — ${unzip.stderr.toString().trim() || "no stderr"}`)
      }

      await $`xattr -cr ${appPath}`.nothrow().quiet()
      await fs.rm(tmpZip, { force: true })

      installed = existsSync(appPath)
      if (!installed) failure = `the archive unpacked but ${appPath} was not created`
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e)
    }

    if (installed) {
      spinner.stop("Desktop app installed")
      prompts.log.success(`Installed to ~/Applications/IRIS.app`)
      prompts.log.info("Launch from Spotlight or open ~/Applications/IRIS.app")
    } else {
      spinner.stop("Install failed", 1)
      prompts.log.error(`Could not install the desktop app: ${failure}`)
      prompts.log.info(`The release may not be published yet at:`)
      prompts.log.info(`  ${appUrl}`)
      prompts.log.info("")
      prompts.log.info("To build locally:")
      prompts.log.info("  cd packages/desktop")
      prompts.log.info("  bun run tauri build --config ./src-tauri/tauri.prod.conf.json")
    }

    prompts.outro("Done")
  },
}
