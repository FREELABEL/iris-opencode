import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
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
        prompts.log.info(`Or try: curl -fsSL https://heyiris.io/install-iris.sh | bash`)
      } else {
        prompts.log.success(`Verified: v${installedVersion}`)
      }
      prompts.log.info(`If iris --version still shows old, run: hash -r`)

      // Also update SDK and bridge if present
      const home = process.env.HOME || ""

      const sdkDir = `${home}/.iris/sdk`
      const bridgeDir = `${home}/.iris/bridge`

      // Update SDK if it's a git repo and PHP is available
      const sdkResult = await $`test -d ${sdkDir}/.git && command -v php >/dev/null && command -v composer >/dev/null && cd ${sdkDir} && git pull --quiet && composer install --no-dev --quiet && echo "sdk-updated"`.nothrow().quiet().text()
      if (sdkResult.includes("sdk-updated")) {
        prompts.log.info("SDK updated")
      }

      // Update bridge if it's a git repo and Node is available
      const bridgeResult = await $`test -d ${bridgeDir}/.git && cd ${bridgeDir} && git pull --quiet && npm install --production --silent 2>/dev/null && echo "bridge-updated"`.nothrow().quiet().text()
      if (bridgeResult.includes("bridge-updated")) {
        prompts.log.info("Bridge updated")
      }
    }

    prompts.outro("Done")
  },
}
