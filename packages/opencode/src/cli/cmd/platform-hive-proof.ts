// `iris hive proof` — record a page working and post the video on a pull request (#188292).
//
// The recording, upload and PR comment live in the Hive daemon (scripts/pr-proof.js), because
// that is where coding tasks run and where the rule "prove it on the PR" is injected. This command
// is the front door to the same script for a person: it checks the machine is ready, explains
// each missing piece in one line with the command that fixes it, runs the script, and turns its
// JSON result into a sentence.
//
// `--check` answers "will this work here?" without recording anything.

import { spawnSync } from "child_process"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { cmd } from "./cmd"
import { resolveToken, isJsonMode, dim, bold, success, warn } from "./iris-api"

export const PROOF_SCRIPT = join(homedir(), ".iris", "bridge", "scripts", "pr-proof.js")

export type Check = { name: string; ok: boolean; detail: string; fix?: string }

type Run = (cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
  status: number | null
  stdout: string
  stderr: string
}

const defaultRun: Run = (c, args, opts = {}) => {
  const r = spawnSync(c, args, { encoding: "utf-8", cwd: opts.cwd, env: opts.env ?? process.env, timeout: 600_000 })
  return { status: r.error ? null : r.status, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? (r.error?.message ?? "")) }
}

/** The GitHub token the daemon script will use: env first, then the user's own `gh` login. */
export function githubToken(env: NodeJS.ProcessEnv, run: Run): { token: string | null; source: string | null } {
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = env[k]?.trim()
    if (v) return { token: v, source: `${k} in your environment` }
  }
  const r = run("gh", ["auth", "token"])
  const t = r.status === 0 ? r.stdout.trim() : ""
  return t ? { token: t, source: "your gh login" } : { token: null, source: null }
}

/**
 * The script's failure text → the one thing the person should do next. The script's own wording
 * is kept underneath; this only adds the fix.
 */
export function fixFor(error: string): string | undefined {
  const e = error.toLowerCase()
  if (e.includes("no github token") || e.includes("token is missing, expired or revoked"))
    return "connect GitHub: run `gh auth login` (or set GITHUB_TOKEN), then `iris hive proof --check`"
  if (e.includes("lacks permission")) return "your GitHub login cannot comment on that repo — ask for write access, or use a token that has it"
  if (e.includes("pr does not exist") || e.includes("cannot see this repo")) return "check the PR number, and that your GitHub login can see the repo"
  if (e.includes("--pr is required")) return "say which PR: --pr owner/repo#12, a PR link, or just 12 inside the repo's folder"
  if (e.includes("upload produced no cdn url") || e.includes("could not run iris")) return "sign in to IRIS: run `iris login`, then try again"
  if (e.includes("playwright") || e.includes("executable doesn't exist") || e.includes("chromium"))
    return "the recorder's browser is missing: run `iris node install` to repair this machine"
  if (e.includes("err_connection_refused") || e.includes("net::")) return "the page did not load — is the app running at that address?"
  if (e.includes("rate limit")) return "GitHub is rate-limiting this login; wait until the reset time shown, then try again"
  return undefined
}

/** Everything that has to be true on this machine for a proof to post. Pure apart from `run`. */
export async function readiness(opts: { env?: NodeJS.ProcessEnv; run?: Run; scriptExists?: boolean; irisSignedIn?: boolean } = {}): Promise<Check[]> {
  const env = opts.env ?? process.env
  const run = opts.run ?? defaultRun
  const checks: Check[] = []

  const installed = opts.scriptExists ?? existsSync(PROOF_SCRIPT)
  checks.push(
    installed
      ? { name: "Recorder", ok: true, detail: "installed on this machine" }
      : { name: "Recorder", ok: false, detail: "this machine is not set up as a Hive node yet", fix: "run `iris node install`" },
  )

  if (installed) {
    const bridge = join(homedir(), ".iris", "bridge")
    const pw = run("node", ["-e", "require.resolve('playwright')"], { cwd: bridge })
    checks.push(
      pw.status === 0
        ? { name: "Browser", ok: true, detail: "headless recorder ready" }
        : { name: "Browser", ok: false, detail: "the recorder's browser library is missing", fix: "run `iris node install` to repair this machine" },
    )
  }

  const ff = run("ffmpeg", ["-version"])
  checks.push(
    ff.status === 0
      ? { name: "Video", ok: true, detail: "ffmpeg found — videos post as MP4" }
      : { name: "Video", ok: true, detail: "ffmpeg not found — videos post as WebM (plays in Chrome and Firefox, not Safari)", fix: "optional: install ffmpeg for MP4" },
  )

  const tok = githubToken(env, run)
  if (!tok.token) {
    checks.push({ name: "GitHub", ok: false, detail: "not connected", fix: "run `gh auth login`, or set GITHUB_TOKEN" })
  } else {
    // A stored login can be stale; `gh auth token` still prints it. Ask GitHub who it is.
    const who = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${tok.token}`, Accept: "application/vnd.github+json", "User-Agent": "iris-hive-proof" },
    })
      .then(async (r) => ({ status: r.status, login: r.ok ? ((await r.json()) as any)?.login : null }))
      .catch(() => ({ status: 0, login: null }))
    if (who.login) checks.push({ name: "GitHub", ok: true, detail: `signed in as ${who.login} (${tok.source})` })
    else if (who.status === 401)
      checks.push({ name: "GitHub", ok: false, detail: `the login from ${tok.source} has expired or was revoked`, fix: "run `gh auth login` again" })
    else checks.push({ name: "GitHub", ok: false, detail: "could not reach GitHub to check the login", fix: "check your connection, then `iris hive proof --check`" })
  }

  const signedIn = opts.irisSignedIn ?? !!(await resolveToken().catch(() => ""))
  checks.push(
    signedIn
      ? { name: "IRIS", ok: true, detail: "signed in — videos upload to your IRIS files" }
      : { name: "IRIS", ok: false, detail: "not signed in, so the video has nowhere to upload", fix: "run `iris login`" },
  )
  return checks
}

function printChecks(checks: Check[]) {
  for (const c of checks) {
    const mark = c.ok ? success("✓") : warn("✗")
    console.log(`  ${mark} ${bold(c.name.padEnd(9))}${c.detail}`)
    if (c.fix && !c.ok) console.log(`    ${dim("→ " + c.fix)}`)
    else if (c.fix) console.log(`    ${dim(c.fix)}`)
  }
}

/** The script prints one JSON line last; anything before it is progress noise. */
export function parseResult(stdout: string): any | null {
  const lines = stdout.trim().split(/\r?\n/).reverse()
  for (const l of lines) {
    const s = l.trim()
    if (!s.startsWith("{")) continue
    try {
      return JSON.parse(s)
    } catch {}
  }
  return null
}

export const HiveProofCommand = cmd({
  command: "proof [url]",
  describe: "record a page working and post the video on a pull request — --check to see if this machine is ready",
  builder: (y) =>
    y
      .positional("url", { type: "string", describe: "the page to record, e.g. http://localhost:3000/checkout" })
      .option("pr", { type: "string", describe: "the pull request: owner/repo#12, a PR link, or 12 inside the repo's folder" })
      .option("steps", { type: "string", describe: "a JSON file of clicks and typing to walk through, e.g. [{\"action\":\"click\",\"selector\":\"#buy\"}]" })
      .option("note", { type: "string", describe: "one line for the reviewer, shown above the video" })
      .option("video", { type: "string", describe: "post a video you already have instead of recording one" })
      .option("dry-run", { type: "boolean", default: false, describe: "record and upload, show the comment, post nothing" })
      .option("check", { type: "boolean", default: false, describe: "check this machine is ready, change nothing" })
      .option("json", { type: "boolean", default: false })
      .example("iris hive proof --check", "is this machine ready to post proof videos?")
      .example("iris hive proof http://localhost:3000 --pr acme/shop#128", "record the home page and post it on PR 128")
      .example("iris hive proof http://localhost:3000/cart --pr 128 --steps flow.json --note \"Fixes the buy button\"", "walk a flow, inside the repo's folder")
      .epilog(
        "Hive coding tasks do this on their own when they open a PR — this is the same recorder, by hand.\n" +
          "Turn it off for one task with config {\"proof_video\": false}. Tasks marked as holding patient data never upload a video.\n" +
          "How-to: iris how-to view hive-proof-video",
      ),
  handler: async (args) => {
    const json = !!args.json || isJsonMode()
    if (args.check || (!args.url && !args.video)) {
      const checks = await readiness()
      const ready = checks.every((c) => c.ok)
      if (json) {
        console.log(JSON.stringify({ ready, checks }))
      } else {
        console.log(bold(ready ? "Ready to post proof videos from this machine." : "Not ready yet — fix the ✗ lines below."))
        printChecks(checks)
        if (!args.check) console.log(dim("\n  Record one: iris hive proof <url> --pr <owner/repo#N>"))
      }
      process.exit(ready ? 0 : 1)
    }

    if (!existsSync(PROOF_SCRIPT)) {
      const msg = "this machine is not set up as a Hive node yet — run `iris node install`, then `iris hive proof --check`"
      console.log(json ? JSON.stringify({ ok: false, error: msg }) : warn(msg))
      process.exit(1)
    }

    const argv = [PROOF_SCRIPT]
    if (args.url) argv.push("--url", String(args.url))
    if (args.video) argv.push("--video", String(args.video))
    if (args.pr) argv.push("--pr", String(args.pr))
    if (args.steps) argv.push("--steps", String(args.steps))
    if (args.note) argv.push("--note", String(args.note))
    if (args["dry-run"]) argv.push("--dry-run")

    if (!json) console.log(dim(args.video ? "Uploading the video…" : `Recording ${args.url} …`))
    const r = defaultRun("node", argv)
    const res = parseResult(r.stdout) ?? { ok: false, error: (r.stderr || r.stdout || "the recorder exited without a result").trim().slice(-400) }
    if (!res.ok && res.error) res.fix = fixFor(String(res.error))

    if (json) {
      console.log(JSON.stringify(res))
    } else if (res.ok && res.dry_run) {
      console.log(success("✓ Recorded and uploaded — nothing posted (dry run)."))
      console.log(`  Video: ${res.cdn_url}`)
      console.log(dim("\n" + String(res.comment ?? "")))
    } else if (res.ok) {
      console.log(success(`✓ Video posted on ${res.pr}`))
      if (res.comment_url) console.log(`  Comment: ${res.comment_url}`)
      console.log(`  Video:   ${res.cdn_url}`)
      if (res.warning) console.log(warn(`  ${res.warning}`))
    } else {
      console.log(warn(`✗ ${res.error}`))
      if (res.fix) console.log(`  → ${res.fix}`)
    }
    process.exit(res.ok ? 0 : r.status === 3 ? 3 : 1)
  },
})
