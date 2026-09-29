import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, dim, bold, success, printDivider } from "./iris-api"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * Buzz (block/buzz) is a workspace where people and agents share channels. It runs agents over
 * ACP, and lets a user add any ACP agent by dropping a JSON "custom harness" into its app-data
 * folder. `iris buzz setup` writes that file so IRIS shows up in Buzz's agent picker.
 *
 * Two traps this exists to remove (both hit by hand on 2026-09-26, epic #186854):
 *  - A Dock-launched app does not see your shell PATH, so `"command": "iris"` never resolves.
 *    The harness must carry an ABSOLUTE path (#184675).
 *  - Nothing tells you that you are signed out until the agent fails its first reply inside
 *    Buzz. So setup checks sign-in up front, where the fix is one command away.
 */

/** Buzz's Tauri identifier; its app-data folder is named after it. */
export const BUZZ_APP_ID = "xyz.block.buzz.app"

/** Where Buzz reads custom harnesses: Tauri app_data_dir() + "custom_harnesses". */
export function buzzHarnessDir(platform: string, home: string, env: Record<string, string | undefined>): string {
  let base: string
  if (platform === "darwin") base = path.join(home, "Library", "Application Support")
  else if (platform === "win32") base = env.APPDATA || path.join(home, "AppData", "Roaming")
  else base = env.XDG_DATA_HOME || path.join(home, ".local", "share")
  return path.join(base, BUZZ_APP_ID, "custom_harnesses")
}

/** The harness definition Buzz loads. Buzz forbids install commands in custom entries, by design. */
export function irisHarness(irisPath: string) {
  if (!path.isAbsolute(irisPath)) {
    // A relative command is exactly the failure this command exists to prevent.
    throw new Error(`iris path must be absolute, got "${irisPath}"`)
  }
  return {
    id: "iris",
    label: "IRIS",
    command: irisPath,
    args: ["acp"],
    env: {},
    install_instructions_url: "https://heyiris.io",
    install_hint:
      "Install the IRIS CLI (curl -fsSL https://heyiris.io/install-code | bash) and sign in with: iris auth login",
  }
}

/**
 * The iris binary a Dock-launched Buzz should run. A compiled release IS process.execPath; from
 * source (bun run …) execPath is bun, so fall back to the installer's location, then PATH.
 */
export function resolveIrisPath(
  execPath: string,
  home: string,
  exists: (p: string) => boolean,
  pathEnv: string | undefined,
  platform: string,
): string | null {
  const exe = platform === "win32" ? "iris.exe" : "iris"
  if (path.basename(execPath).toLowerCase().startsWith("iris")) return execPath
  const installed = path.join(home, ".iris", "bin", exe)
  if (exists(installed)) return installed
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, exe)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Turn what a community admin shares into the link the Buzz desktop app acts on.
 * Accepts the relay's invite page (`https://<host>/invite/<code>`) or an existing
 * `buzz://join?...` link. Buzz joins via `buzz://join?relay=<ws(s)://host>&code=<code>`
 * (desktop/src-tauri/src/deep_link.rs at block/buzz @02753722). Returns null for anything
 * else, rather than guessing a relay.
 */
export function buzzJoinLink(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol === "buzz:") {
    return u.hostname === "join" && u.searchParams.get("relay") && u.searchParams.get("code") ? raw : null
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null
  const m = u.pathname.match(/^\/invite\/([^/]+)\/?$/)
  if (!m) return null
  const relay = `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`
  return `buzz://join?relay=${encodeURIComponent(relay)}&code=${encodeURIComponent(decodeURIComponent(m[1]))}`
}

function harnessFile() {
  return path.join(buzzHarnessDir(process.platform, os.homedir(), process.env), "iris.json")
}

const SetupCommand = cmd({
  command: "setup",
  describe: "register IRIS as an agent runtime in the Buzz desktop app",
  builder: (y) =>
    y
      .option("dry-run", { type: "boolean", default: false, describe: "print what would be written, write nothing" })
      .option("iris-path", { type: "string", describe: "absolute path to the iris binary Buzz should run" })
      .option("community", {
        type: "string",
        describe: "a Buzz community invite link (https://<host>/invite/<code>) to join after setup",
      }),
  handler: async (args) => {
    UI.empty()
    prompts.intro("◈  Buzz — add IRIS as an agent")

    const irisPath =
      (args["iris-path"] as string | undefined) ??
      resolveIrisPath(process.execPath, os.homedir(), fs.existsSync, process.env.PATH, process.platform)
    if (!irisPath) {
      prompts.log.error("Could not find the iris binary. Pass --iris-path /absolute/path/to/iris")
      process.exitCode = 1
      return
    }

    let def
    try {
      def = irisHarness(irisPath)
    } catch (e) {
      prompts.log.error(String((e as Error).message))
      process.exitCode = 1
      return
    }

    const communityArg = args.community as string | undefined
    const join = communityArg ? buzzJoinLink(communityArg) : null
    if (communityArg && !join) {
      prompts.log.error(`Not a Buzz invite link: ${communityArg}\n  Expected https://<community-host>/invite/<code>`)
      process.exitCode = 1
      return
    }

    const file = harnessFile()
    const body = JSON.stringify(def, null, 2) + "\n"

    if (args["dry-run"]) {
      prompts.log.info(`would write ${file}`)
      if (join) prompts.log.info(`would open ${join}`)
      console.log(body)
      prompts.outro(dim("dry run — nothing written"))
      return
    }

    // Signed out is the failure a user otherwise meets inside Buzz, as a silent agent.
    const token = await requireAuth()
    if (!token) {
      process.exitCode = 1
      return
    }

    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    // Read back: a write that printed success and changed nothing is not a write.
    if (fs.readFileSync(file, "utf8") !== body) {
      prompts.log.error(`wrote ${file} but it does not read back — check permissions`)
      process.exitCode = 1
      return
    }

    printDivider()
    prompts.log.success(`${before === body ? "Already set up" : before ? "Updated" : "Added"}: ${bold(file)}`)
    prompts.log.info(`Buzz will run: ${irisPath} acp`)
    prompts.log.info(
      [
        "Next:",
        "  1. Quit and reopen Buzz (it reads this folder at launch)",
        "  2. Agents → New agent → choose IRIS as the runtime",
        "  3. @mention it in a channel",
      ].join("\n"),
    )
    if (join) {
      // The desktop app registers the buzz:// scheme; opening it claims the invite and adds
      // the workspace. If nothing handles it (Buzz not installed), print it to click later.
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
      const r = Bun.spawnSync(process.platform === "win32" ? ["cmd", "/c", "start", "", join] : [opener, join])
      if (r.exitCode === 0) prompts.log.success("Opening Buzz to join the community…")
      else prompts.log.warn(`Could not open Buzz automatically. Open this link to join:\n  ${join}`)
    }
    prompts.outro(success("IRIS is ready for Buzz"))
  },
})

const StatusCommand = cmd({
  command: "status",
  describe: "show whether IRIS is registered in Buzz, and whether that registration still works",
  handler: async () => {
    const file = harnessFile()
    if (!fs.existsSync(file)) {
      console.log(`not set up — ${file} does not exist. Run: iris buzz setup`)
      process.exitCode = 1
      return
    }
    let def: { command?: string; args?: string[] }
    try {
      def = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      console.log(`${file} is not valid JSON — Buzz will skip it. Run: iris buzz setup`)
      process.exitCode = 1
      return
    }
    // Present is not the same as working: the binary it points at may have moved.
    const runnable = !!def.command && path.isAbsolute(def.command) && fs.existsSync(def.command)
    console.log(`${runnable ? "✓" : "✗"} ${file}`)
    console.log(`  runs: ${def.command ?? "(none)"} ${(def.args ?? []).join(" ")}`)
    if (!runnable) {
      console.log("  the command is missing or not an absolute path — Buzz cannot start it. Run: iris buzz setup")
      process.exitCode = 1
    }
  },
})

const RemoveCommand = cmd({
  command: "remove",
  describe: "remove IRIS from Buzz's agent runtimes",
  handler: async () => {
    const file = harnessFile()
    if (!fs.existsSync(file)) {
      console.log("nothing to remove")
      return
    }
    fs.unlinkSync(file)
    console.log(`removed ${file} — restart Buzz to drop it from the picker`)
  },
})

export const BuzzCommand = cmd({
  command: "buzz",
  describe: "use IRIS inside Buzz — the team workspace where people and agents share channels",
  builder: (y) => y.command(SetupCommand).command(StatusCommand).command(RemoveCommand).demandCommand(1),
  handler: () => {},
})
