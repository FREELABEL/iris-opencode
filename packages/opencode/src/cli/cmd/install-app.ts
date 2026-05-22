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

    if (process.platform !== "darwin") {
      prompts.log.warn("Desktop app is currently macOS only")
      prompts.log.info("Windows support coming soon")
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

    const appUrl = `https://github.com/FREELABEL/iris-opencode/releases/latest/download/IRIS-app-darwin-${arch}.zip`

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
      prompts.log.info("  cd fl-docker-dev/fl-elon-web-ui/electron")
      prompts.log.info("  ./build-desktop.sh --pack")
    }

    prompts.outro("Done")
  },
}
