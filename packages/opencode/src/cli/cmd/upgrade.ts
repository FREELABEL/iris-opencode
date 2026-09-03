import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "./clack"
import { Installation } from "../../installation"

/**
 * Refresh the on-demand how-to recipes — #180295.
 *
 * Called on BOTH update paths, including "already on latest". Recipes are fetched from the
 * scaffold on `main` and change independently of the binary, so gating them on a version
 * bump means anybody already current never gets new documentation — which is the state that
 * left the mandatory Genesis design audit installed on zero machines.
 *
 * Driven by the same scaffold/manifest.json the installer reads, so there is ONE list rather
 * than a second copy that drifts. Best-effort: a docs refresh must never be the reason an
 * upgrade reports failure, and one unreachable recipe must not abandon the rest. It does
 * report WHY it failed, though — the first version swallowed everything and was
 * indistinguishable from not running at all.
 */
async function refreshHowTos(home: string): Promise<void> {
  const base =
    process.env["IRIS_SCAFFOLD_BASE_URL"] ??
    "https://raw.githubusercontent.com/FREELABEL/iris-opencode/main/scaffold"
  try {
    const res = await fetch(`${base}/manifest.json`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      prompts.log.warn(`How-to recipes not refreshed (manifest ${res.status})`)
      return
    }
    const manifest = (await res.json()) as { files?: Array<{ src: string; dest: string }> }
    const recipes = (manifest.files ?? []).filter((f) => f.src.startsWith("how-to/"))
    const { mkdirSync, writeFileSync } = await import("fs")
    mkdirSync(`${home}/.iris/how-to`, { recursive: true })

    let written = 0
    for (const f of recipes) {
      try {
        const r = await fetch(`${base}/${f.src}`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) continue
        writeFileSync(`${home}/.iris/${f.dest}`, await r.text())
        written++
      } catch {
        // one bad recipe must not abandon the rest
      }
    }
    if (written > 0) prompts.log.info(`How-to recipes refreshed (${written})`)
    else prompts.log.warn("How-to recipes not refreshed (no recipe could be fetched)")
  } catch (e) {
    prompts.log.warn(`How-to recipes not refreshed (${e instanceof Error ? e.message : "offline"})`)
  }
}

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
      // Still refresh the docs. Recipes live on `main` and move independently of releases,
      // so an up-to-date binary is not evidence of up-to-date documentation.
      await refreshHowTos(process.env.HOME || process.env.USERPROFILE || "")
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
          // Pin the bridge to main and self-heal branch drift (#133629). A node
          // stranded on a stale/feature branch would `git pull` old code forever
          // (the exact reason finished features never reached client machines).
          // `checkout -B main origin/main` force-tracks main from any state;
          // untracked runtime files (sessions, .som-campaigns-cache.json) survive.
          execSync("git fetch origin --quiet && git checkout -B main origin/main --quiet && npm install --production --silent 2>/dev/null", { cwd: bridgeDir, timeout: 60000, stdio: "pipe" })
          prompts.log.info("Bridge updated (pinned to main)")
          // Restart daemon so it picks up new bridge code
          const daemonCtl = `${home}/.iris/bin/iris-daemon`
          if (existsSync(daemonCtl)) {
            execSync(`"${daemonCtl}" restart`, { timeout: 10000, stdio: "pipe" })
            prompts.log.info("Daemon restarted")
          }
        }
      } catch { /* bridge update is non-critical */ }

      // Update the desktop app if one is actually installed (macOS only).
      // Non-critical — never fail the CLI update over this.
      //
      // This pointed at IRIS-app-darwin-*.zip: the old Electron app, whose build job has
      // been dead for weeks, so that URL 404s. `curl --fail` then short-circuited the &&
      // chain, meaning this silently no-opped on EVERY update rather than erroring. Not
      // destructive (the rm -rf sits behind the download succeeding) but entirely useless.
      // Now points at the Tauri app published since v1.3.206.
      if (process.platform === "darwin") {
        try {
          const arch = process.arch === "arm64" ? "arm64" : "x64"
          // Update in place, wherever it actually lives. Unconditionally unpacking into
          // ~/Applications when the app is in /Applications would leave two IRIS.app
          // copies silently drifting apart — so only touch an install that exists, and
          // do not install one here (that is `iris install-app`'s job, not update's).
          const candidates = [
            { dir: "/Applications", app: "/Applications/IRIS.app" },
            { dir: `${home}/Applications`, app: `${home}/Applications/IRIS.app` },
          ]
          let installed: { dir: string; app: string } | undefined
          for (const c of candidates) {
            const exists = await $`test -d ${c.app} && echo yes`.nothrow().quiet().text()
            if (exists.includes("yes")) {
              installed = c
              break
            }
          }
          if (installed) {
            // NOT /releases/latest/download/. That URL resolves to whichever release holds the
            // single repo-wide "latest" flag, with no fallback by asset name — and CLI releases
            // (cut far more often than desktop ones) held it essentially always. So this
            // silently replaced the user's app with the desktop build off `main`: version 1.1.3,
            // no 1.18 engine, no rebrand. It is the reason "I re-downloaded and it is still the
            // old opencode" kept being true no matter how many desktop releases were promoted.
            // heyiris.io resolves the desktop-v* series by tag prefix instead.
            const appUrl = `https://heyiris.io/download/mac-${arch}-zip`
            const updateApp =
              await $`tmpdir=$(mktemp -d) && curl -sL --fail -o "$tmpdir/IRIS-app.zip" "${appUrl}" 2>/dev/null && rm -rf "${installed.app}" 2>/dev/null; mkdir -p "${installed.dir}" && unzip -q "$tmpdir/IRIS-app.zip" -d "${installed.dir}" 2>/dev/null && rm -rf "$tmpdir" && xattr -cr "${installed.app}" 2>/dev/null; test -d "${installed.app}" && echo "app-updated"`
                .nothrow()
                .quiet()
                .text()
            if (updateApp.includes("app-updated")) {
              prompts.log.info(`Desktop app updated (${installed.app})`)
            }
          }
        } catch {
          // Desktop app update is non-critical — continue with rest of update
        }
      }

      await refreshHowTos(home)

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
