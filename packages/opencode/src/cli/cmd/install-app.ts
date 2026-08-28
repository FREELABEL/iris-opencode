import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "./clack"
import { $ } from "bun"
import os from "os"

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

    const result = await $`
      tmpdir=$(mktemp -d) &&
      curl -sL --fail -o "$tmpdir/IRIS-app.zip" "${appUrl}" 2>/dev/null &&
      rm -rf "${appPath}" 2>/dev/null;
      mkdir -p "${appDir}" &&
      unzip -q "$tmpdir/IRIS-app.zip" -d "${appDir}" 2>/dev/null &&
      rm -rf "$tmpdir" &&
      xattr -cr "${appPath}" 2>/dev/null;
      test -d "${appPath}" && echo "installed"
    `.nothrow().quiet().text()

    if (result.includes("installed")) {
      spinner.stop("Desktop app installed")
      prompts.log.success(`Installed to ~/Applications/IRIS.app`)
      prompts.log.info("Launch from Spotlight or open ~/Applications/IRIS.app")
    } else {
      spinner.stop("Download failed", 1)
      prompts.log.error("Could not download the desktop app")
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
