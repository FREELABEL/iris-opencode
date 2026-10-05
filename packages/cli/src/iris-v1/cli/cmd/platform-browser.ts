import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { cmd } from "./cmd"
import * as prompts from "./clack"

import { printDivider, printKV, dim, writeJson } from "./iris-api"
import { productCommand } from "./product-command"

// Every report line on STDOUT. UI.println writes to stderr while printKV/printDivider write to
// stdout, so mixing them scrambled the order whenever output was piped or saved — a person's
// details printed before their name.
const out = (...parts: string[]) => console.log(parts.join(""))

/**
 * `iris browser` — drive a real browser from the command line.
 *
 * WHY A COMMAND AND NOT ONLY A SKILL. The render check shipped as a playbook skill plus a
 * script, which means an agent can run it and a person cannot — `iris browser check <url>` is
 * the same capability without a model in the loop, and it is what CI, a pre-publish gate or a
 * person on a terminal actually reaches for. The skill now documents this command rather than a
 * path into someone's home directory.
 *
 * ONE IMPLEMENTATION, NOT A COPY. The work is done by render-check.sh, which ships with the IRIS
 * bridge (iris-daemon) and is the SAME file the V6 `hiveBrowserUse` tool runs on a Hive node and
 * the browser-use skill runs by hand. Re-implementing it here would give us three behaviours to
 * keep in agreement; instead this resolves the script and execs it. When it cannot be found,
 * `iris browser doctor` says which piece is missing rather than failing as if the page were bad.
 *
 * THE EXIT CODE IS THE PRODUCT. Three states, never two:
 *   0  rendered, no findings
 *   1  rendered, findings (listed)
 *   2  COULD NOT MEASURE — unreachable, no Chrome, no browser-use. Not a pass.
 * A checker that cannot say "I did not measure" reports a broken deploy as a clean page.
 */

/**
 * Find one of the bridge's browser-use scripts. Exported so `iris reachr scrape` resolves its
 * extractor the same way — one lookup rule, so "not found" means the same thing everywhere.
 * IRIS_BROWSER_USE_DIR points at a checkout; IRIS_BROWSER_USE_SCRIPT (render-check only) is kept
 * for anyone who already set it.
 */
export function resolveBrowserUseScript(file: string): string | null {
  const candidates = [
    file === "render-check.sh" ? process.env.IRIS_BROWSER_USE_SCRIPT : undefined,
    process.env.IRIS_BROWSER_USE_DIR ? path.join(process.env.IRIS_BROWSER_USE_DIR, file) : undefined,
    path.join(os.homedir(), ".iris", "bridge", "scripts", "browser-use", file),
    // Running from a source checkout that sits next to the daemon repo.
    path.join(process.cwd(), "scripts", "browser-use", file),
  ]
  for (const p of candidates) if (p && fs.existsSync(p)) return p
  return null
}

function resolveScript(): string | null {
  return resolveBrowserUseScript("render-check.sh")
}

const MISSING_SCRIPT =
  "render-check.sh not found. It ships with the IRIS bridge — install or update it (`iris hive doctor`), " +
  "or point IRIS_BROWSER_USE_SCRIPT at a checkout. `iris browser doctor` checks every piece."

function which(bin: string): string | null {
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ]
  for (const d of dirs) {
    if (!d) continue
    const p = path.join(d, bin)
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* unreadable dir */
    }
  }
  return null
}

const CHROMES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
]

function findChrome(): string | null {
  for (const c of CHROMES) if (c && fs.existsSync(c)) return c
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const p = which(c)
    if (p) return p
  }
  return null
}

/** Run the script, streaming nothing: it prints exactly one JSON line and we own the rendering. */
export function runBrowserUseScript(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      env: { ...process.env, BH_TELEMETRY: "0" },
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => resolve({ code: code ?? 2, stdout, stderr }))
    child.on("error", (e) => resolve({ code: 2, stdout, stderr: String(e) }))
  })
}

const CheckCmd = cmd({
  command: "check <url>",
  aliases: ["render-check"],
  describe:
    "render-verify a page in a real browser — screenshot, mobile/responsive widths, status, fonts that fall back, horizontal overflow, cut-off content, JS errors",
  builder: (y: any) =>
    y
      .positional("url", { describe: "full http(s) URL of the page to check", type: "string" })
      .option("viewports", {
        describe: 'comma-separated name:WIDTHxHEIGHT, up to 4 (e.g. "desktop:1280x900,mobile:390x844")',
        type: "string",
      })
      .option("schemes", { describe: "emulated colour scheme: light, dark, or light,dark", type: "string" })
      .option("out", { describe: "directory for screenshots", type: "string" })
      .option("json", { describe: "JSON output (the raw result)", type: "boolean", default: false }),
  async handler(args: any) {
    const script = resolveScript()
    if (!script) {
      if (args.json) {
        writeJson({ ok: false, measured: false, error: MISSING_SCRIPT })
      } else {
        prompts.log.error(MISSING_SCRIPT)
      }
      process.exitCode = 2
      return
    }

    const argv: string[] = [args.url]
    if (args.out) argv.push("--out", args.out)
    if (args.viewports) argv.push("--viewports", args.viewports)
    if (args.schemes) argv.push("--schemes", args.schemes)

    const { code, stdout, stderr } = await runBrowserUseScript(script, argv)
    const line = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop()

    if (!line) {
      const why = stderr.trim().split("\n").slice(-2).join(" ").slice(-300) || `exit ${code}`
      if (args.json) writeJson({ ok: false, measured: false, url: args.url, error: why })
      else prompts.log.error(`could not measure ${args.url}: ${why}`)
      process.exitCode = 2
      return
    }

    let data: any
    try {
      data = JSON.parse(line)
    } catch {
      if (args.json) writeJson({ ok: false, measured: false, url: args.url, error: "unreadable result" })
      else prompts.log.error("could not read the check's result")
      process.exitCode = 2
      return
    }

    if (args.json) {
      writeJson(data)
      process.exitCode = data.measured === false ? 2 : data.ok ? 0 : 1
      return
    }

    // A measured page with findings and an unmeasured one are different answers, and the
    // renderer keeps them apart — the whole point of the third state.
    if (data.measured === false) {
      prompts.log.error(`could not measure ${data.url ?? args.url}`)
      out(dim(`  ${data.error ?? "no reason given"}`))
      process.exitCode = 2
      return
    }

    printDivider()
    printKV("url", String(data.url ?? args.url))
    printKV("status", String(data.status ?? "—"))
    printKV("title", String(data.title ?? "—"))
    for (const [name, v] of Object.entries<any>(data.viewports ?? {})) {
      printKV(name, `${v.viewport_width}px  ${v.overflow_x ? `OVERFLOW to ${v.scroll_width}px` : "no overflow"}`)
    }
    printDivider()

    if (data.ok) {
      prompts.log.success(`no findings — ${data.screenshots?.length ?? 0} screenshot(s)`)
    } else {
      prompts.log.warn(`${data.failures.length} finding(s):`)
      for (const f of data.failures) out(`  • ${f}`)
    }
    for (const e of (data.console_errors ?? []).slice(0, 5)) out(dim(`  console: ${e}`))
    for (const s of data.screenshots ?? []) out(dim(`  ${typeof s === "string" ? s : s.url ?? s.filename}`))

    prompts.outro(dim(data.ok ? "look at the screenshots — a clean verdict is not a visual check" : "exit 1 = findings"))
    process.exitCode = data.ok ? 0 : 1
  },
})

const DoctorCmd = cmd({
  command: "doctor",
  describe: "can this machine drive a browser? (script, Chrome, browser-use)",
  builder: (y: any) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const script = resolveScript()
    const chrome = findChrome()
    const bu = which("browser-use") ?? which("uvx")
    const ok = Boolean(script && chrome && bu)
    const report = {
      ok,
      script: script ?? null,
      chrome: chrome ?? null,
      browser_use: bu ?? null,
      platform: process.platform,
    }

    if (args.json) {
      writeJson(report)
      process.exitCode = ok ? 0 : 2
      return
    }

    printDivider()
    printKV("script", script ?? "MISSING — install/update the IRIS bridge")
    printKV("chrome", chrome ?? "MISSING — install Google Chrome, or set CHROME_BIN")
    printKV("browser-use", bu ?? "MISSING — `brew install uv && uv tool install browser-use`")
    printDivider()
    if (ok) prompts.log.success("this machine can run browser checks")
    else prompts.log.error("this machine cannot run browser checks — see the missing piece above")
    process.exitCode = ok ? 0 : 2
  },
})

export const BrowserCommand = productCommand({
  name: "browser",
  aliases: ["render", "render-check"],
  // The purpose line carries the search terms on purpose: build-capabilities.ts indexes a
  // command's name, aliases, describe and options — it never reads `keywords`, so the keyword
  // set below reaches `--help` and nothing else. Until that is fixed, words people would search
  // for ("screenshot", "mobile", "responsive") have to live in text the index actually reads.
  purpose:
    "Drive a real browser — render-verify a page before you call it shipped: screenshot it, check it on mobile, catch fonts that silently fall back and content cut off",
  keywords: [
    "browser",
    "render",
    "render check",
    "screenshot",
    "mobile",
    "responsive",
    "overflow",
    "font",
    "webfont",
    "clipped",
    "cut off",
    "visual",
    "verify page",
    "does it render",
  ],
  howtos: [],
  playbooks: ["browser-use"],
  subcommands: [CheckCmd, DoctorCmd],
})
