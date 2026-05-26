import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "./clack"
import { Installation } from "../../installation"

export const UpgradeCommand = {
  command: "upgrade [target]",
  aliases: ["update"],
  describe: "upgrade IRIS CLI to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '1.1.8' or 'v1.1.8'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    const label = Installation.isIris() ? "IRIS CLI Update" : "Upgrade"
    prompts.intro(label)
    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`Installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }

    const methodLabel = Installation.isIris() ? "iris-installer" : method
    prompts.log.info("Using method: " + methodLabel)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (Installation.VERSION === target) {
      prompts.log.warn(`Already on latest: ${target}`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${Installation.VERSION} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start(Installation.isIris() ? "Updating IRIS CLI..." : "Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Update failed", 1)
      if (err instanceof Installation.UpgradeFailedError) prompts.log.error(err.data.stderr)
      else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop(Installation.isIris() ? "IRIS CLI updated" : "Upgrade complete")

    if (Installation.isIris()) {
      // Verify the update actually took effect
      const { $ } = await import("bun")
      const verifyResult = await $`${process.execPath} --version`.nothrow().quiet().text()
      const installedVersion = verifyResult.trim()
      if (installedVersion && installedVersion !== target) {
        prompts.log.warn(`Expected v${target} but binary reports v${installedVersion}`)
        prompts.log.info(`Your shell may cache the old binary path. Run: hash -r && iris --version`)
        prompts.log.info(`Or try: ${process.platform === "win32" ? 'irm https://heyiris.io/install-code.ps1 | iex' : 'curl -fsSL https://heyiris.io/install-code | bash'}`)
      } else {
        prompts.log.success(`Verified: v${installedVersion}`)
      }
      prompts.log.info(`If iris --version still shows old, run: hash -r`)

      // Also update SDK and bridge if present
      const home = process.env.HOME || process.env.USERPROFILE || ""

      const sdkDir = `${home}/.iris/sdk`
      const bridgeDir = `${home}/.iris/bridge`

      // Update SDK if it's a git repo and PHP is available
      const sdkResult = await $`test -d ${sdkDir}/.git && command -v php >/dev/null && command -v composer >/dev/null && cd ${sdkDir} && git pull --quiet && composer install --no-dev --quiet && echo "sdk-updated"`.nothrow().quiet().text()
      if (sdkResult.includes("sdk-updated")) {
        prompts.log.info("SDK updated")
      }

      // Update bridge if it's a git repo and Node is available
      try {
        const { execSync } = await import("child_process")
        const { existsSync } = await import("fs")
        if (existsSync(`${bridgeDir}/.git`)) {
          execSync("git pull --quiet && npm install --production --silent 2>/dev/null", { cwd: bridgeDir, timeout: 60000, stdio: "pipe" })
          prompts.log.info("Bridge updated")
          // Restart daemon so it picks up new bridge code
          const daemonCtl = `${home}/.iris/bin/iris-daemon`
          if (existsSync(daemonCtl)) {
            execSync(`"${daemonCtl}" restart`, { timeout: 10000, stdio: "pipe" })
            prompts.log.info("Daemon restarted")
          }
        }
      } catch { /* bridge update is non-critical */ }

      // Update desktop app if on macOS (non-critical — don't crash update if this fails)
      if (process.platform === "darwin") {
        try {
          const arch = process.arch === "arm64" ? "arm64" : "x64"
          const appDir = `${home}/Applications`
          const appPath = `${appDir}/IRIS.app`
          const appUrl = `https://github.com/FREELABEL/iris-opencode/releases/latest/download/IRIS-app-darwin-${arch}.zip`
          const updateApp = await $`tmpdir=$(mktemp -d) && curl -sL --fail -o "$tmpdir/IRIS-app.zip" "${appUrl}" 2>/dev/null && rm -rf "${appPath}" 2>/dev/null; mkdir -p "${appDir}" && unzip -q "$tmpdir/IRIS-app.zip" -d "${appDir}" 2>/dev/null && rm -rf "$tmpdir" && test -d "${appPath}" && echo "app-updated"`.nothrow().quiet().text()
          if (updateApp.includes("app-updated")) {
            prompts.log.info("Desktop app updated")
          }
        } catch {
          // Desktop app update is non-critical — continue with rest of update
        }
      }

      // Fix stale API URLs in daemon config (pre-Railway migration)
      const configFile = `${home}/.iris/config.json`
      const fixResult = await $`test -f ${configFile} && grep -qE 'ondigitalocean\\.app|main\\.heyiris\\.io|apiv2\\.heyiris\\.io' ${configFile} 2>/dev/null && sed -i.bak -e 's|https://[^"]*ondigitalocean\\.app[^"]*|https://freelabel.net|g' -e 's|https://main\\.heyiris\\.io[^"]*|https://freelabel.net|g' -e 's|https://apiv2\\.heyiris\\.io[^"]*|https://freelabel.net|g' ${configFile} && rm -f ${configFile}.bak && echo "config-fixed"`.nothrow().quiet().text()
      if (fixResult.includes("config-fixed")) {
        prompts.log.info("Fixed stale API URL → freelabel.net")
      }
    }

    prompts.outro("Done")
  },
}
