import { BusEvent } from "@/bus/bus-event"
import path from "path"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { iife } from "@/util/iife"
import { Flag } from "../flag/flag"

declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export function isIris() {
    return (
      process.execPath.includes(path.join(".iris", "bin")) ||
      process.execPath.includes("iris") ||
      process.env.IRIS_MODE === "true"
    )
  }

  export async function method() {
    if (process.execPath.includes(path.join(".iris", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".opencode", "bin"))) return "curl"
    if (process.execPath.includes(path.join(".local", "bin"))) return "curl"
    const exec = process.execPath.toLowerCase()

    const checks = [
      {
        name: "npm" as const,
        command: () => $`npm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "yarn" as const,
        command: () => $`yarn global list`.throws(false).quiet().text(),
      },
      {
        name: "pnpm" as const,
        command: () => $`pnpm list -g --depth=0`.throws(false).quiet().text(),
      },
      {
        name: "bun" as const,
        command: () => $`bun pm ls -g`.throws(false).quiet().text(),
      },
      {
        name: "brew" as const,
        command: () => $`brew list --formula opencode`.throws(false).quiet().text(),
      },
    ]

    checks.sort((a, b) => {
      const aMatches = exec.includes(a.name)
      const bMatches = exec.includes(b.name)
      if (aMatches && !bMatches) return -1
      if (!aMatches && bMatches) return 1
      return 0
    })

    for (const check of checks) {
      const output = await check.command()
      if (output.includes(check.name === "brew" ? "opencode" : "opencode-ai")) {
        return check.name
      }
    }

    return "unknown"
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  async function getBrewFormula() {
    const tapFormula = await $`brew list --formula sst/tap/opencode`.throws(false).quiet().text()
    if (tapFormula.includes("opencode")) return "sst/tap/opencode"
    const coreFormula = await $`brew list --formula opencode`.throws(false).quiet().text()
    if (coreFormula.includes("opencode")) return "opencode"
    return "opencode"
  }

  export async function upgrade(method: Method, target: string) {
    let cmd

    if (isIris()) {
      // IRIS: download binary directly from GitHub release (don't re-run full installer)
      const platform = process.platform === "darwin" ? "darwin" : "linux"
      const arch = process.arch === "arm64" ? "arm64" : "x64"
      const ext = platform === "linux" ? "tar.gz" : "zip"
      const assetName = `iris-${platform}-${arch}.${ext}`
      const releaseUrl = `https://github.com/FREELABEL/iris-opencode/releases/download/v${target}/${assetName}`
      // Resolve symlinks to get the real binary path
      const realExecPath = await import("fs").then(fs => fs.realpathSync(process.execPath))
      const binDir = path.dirname(realExecPath)
      const tmpDir = path.join(binDir, ".iris-update-tmp")

      // Use a script file to avoid Bun template literal interpolation issues
      const script = `#!/bin/bash
set -e
mkdir -p "${tmpDir}"
cd "${tmpDir}"
curl -fsSL -o "${assetName}" "${releaseUrl}"
if [ "${ext}" = "tar.gz" ]; then
  tar -xzf "${assetName}"
else
  unzip -o "${assetName}"
fi
chmod +x iris
# Remove old binary first (avoids overwriting a running executable)
rm -f "${binDir}/iris"
mv iris "${binDir}/iris"
rm -rf "${tmpDir}"
# Verify the new binary works
"${binDir}/iris" --version
`
      const scriptPath = path.join(tmpDir + "-script.sh")
      await import("fs").then(fs => {
        fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
        fs.writeFileSync(scriptPath, script, { mode: 0o755 })
      })
      cmd = $`bash ${scriptPath} && rm -f ${scriptPath}`.env({ ...process.env })
    } else {
      switch (method) {
        case "curl":
          cmd = $`curl -fsSL https://opencode.ai/install | bash`.env({
            ...process.env,
            VERSION: target,
          })
          break
        case "npm":
          cmd = $`npm install -g opencode-ai@${target}`
          break
        case "pnpm":
          cmd = $`pnpm install -g opencode-ai@${target}`
          break
        case "bun":
          cmd = $`bun install -g opencode-ai@${target}`
          break
        case "brew": {
          const formula = await getBrewFormula()
          cmd = $`brew install ${formula}`.env({
            HOMEBREW_NO_AUTO_UPDATE: "1",
            ...process.env,
          })
          break
        }
        default:
          throw new Error(`Unknown method: ${method}`)
      }
    }

    const result = await cmd.quiet().throws(false)
    log.info("upgraded", {
      method: isIris() ? "iris-installer" : method,
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    if (result.exitCode !== 0)
      throw new UpgradeFailedError({
        stderr: result.stderr.toString("utf8"),
      })
    await $`${process.execPath} --version`.nothrow().quiet().text()
  }

  export const VERSION = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  export const CHANNEL = typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : "local"
  export const USER_AGENT = `opencode/${CHANNEL}/${VERSION}/${Flag.OPENCODE_CLIENT}`

  export async function latest(installMethod?: Method) {
    // IRIS: check our own GitHub releases
    if (isIris()) {
      return fetch("https://api.github.com/repos/FREELABEL/iris-opencode/releases/latest")
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.tag_name.replace(/^v/, ""))
    }

    const detectedMethod = installMethod || (await method())

    if (detectedMethod === "brew") {
      const formula = await getBrewFormula()
      if (formula === "opencode") {
        return fetch("https://formulae.brew.sh/api/formula/opencode.json")
          .then((res) => {
            if (!res.ok) throw new Error(res.statusText)
            return res.json()
          })
          .then((data: any) => data.versions.stable)
      }
    }

    if (detectedMethod === "npm" || detectedMethod === "bun" || detectedMethod === "pnpm") {
      const registry = await iife(async () => {
        const r = (await $`npm config get registry`.quiet().nothrow().text()).trim()
        const reg = r || "https://registry.npmjs.org"
        return reg.endsWith("/") ? reg.slice(0, -1) : reg
      })
      const channel = CHANNEL
      return fetch(`${registry}/opencode-ai/${channel}`)
        .then((res) => {
          if (!res.ok) throw new Error(res.statusText)
          return res.json()
        })
        .then((data: any) => data.version)
    }

    return fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.json()
      })
      .then((data: any) => data.tag_name.replace(/^v/, ""))
  }
}
