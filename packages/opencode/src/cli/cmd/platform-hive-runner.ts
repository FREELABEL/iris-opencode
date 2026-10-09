// `iris hive runner` — turn your own Hive nodes into self-hosted GitHub Actions runners.
//
// Hosted macOS / Windows / Linux minutes are what people pay for; a Hive node is already a
// machine you own, online, running the iris-daemon and accepting tasks. The only missing piece
// was the GitHub side: a registration token, the actions-runner binary, and a service that
// keeps it alive. This command does exactly that, and nothing on the daemon changes — the
// install runs as an ordinary `sandbox_execute` task on the node.
//
// The token rules, because they are the part that would leak:
//  - your GitHub login is read on THIS machine (env, else `gh auth token`), never a .env file,
//    and never leaves this machine;
//  - the node gets only a registration / remove token — single-purpose, ~1h — inside the task
//    script, held in a shell variable and never echoed (the tests assert no echo line holds it).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { cmd } from "./cmd"
import { requireAuth, requireUserId, resolveUserId, dim, bold, success, warn, writeJson } from "./iris-api"
import { fetchNodes, dispatchTaskAndWait, type HiveNode } from "./platform-hive-nodes"
import { buildTaskPayload, pickResultPayload } from "./hive-task-create"

// ── pure parts (tested in platform-hive-runner.test.ts) ─────────────────────

const REPO_PART = /^[A-Za-z0-9_.-]+$/
const LABEL_TEXT = /^[A-Za-z0-9_.,-]+$/

/** Single-quote for POSIX sh. Everything interpolated into a node script goes through this. */
export const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`

export function parseRepo(raw: unknown): { ok: true; owner: string; repo: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "")
  const parts = v.split("/")
  if (parts.length !== 2 || !parts[0] || !parts[1])
    return { ok: false, error: `--repo must be owner/repo (e.g. acme/website), got "${raw ?? ""}"` }
  const [owner, repo] = parts
  if (!REPO_PART.test(owner) || !REPO_PART.test(repo) || owner === "." || owner === ".." || repo === "." || repo === "..")
    return { ok: false, error: `"${v}" is not a GitHub repo name — letters, digits, '.', '_' and '-' only` }
  return { ok: true, owner, repo }
}

/** Extra labels → the full list. `iris-hive` always comes first; duplicates are dropped. */
export function parseLabels(raw: unknown): { ok: true; labels: string[] } | { ok: false; error: string } {
  const v = raw === undefined || raw === null ? "" : String(raw).trim()
  if (v && !LABEL_TEXT.test(v)) return { ok: false, error: `--labels "${v}" — use letters, digits, '.', '_' and '-', separated by commas` }
  const extra = v.split(",").map((s) => s.trim()).filter(Boolean)
  return { ok: true, labels: [...new Set(["iris-hive", ...extra])] }
}

export function validateRunnerName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const v = String(raw ?? "").trim()
  if (!v || !LABEL_TEXT.test(v) || v.includes(",")) return { ok: false, error: `--name "${v}" — use letters, digits, '.', '_' and '-' only` }
  if (v.length > 64) return { ok: false, error: `--name is ${v.length} characters; GitHub allows 64` }
  return { ok: true, name: v }
}

/** `iris-<node>` with anything GitHub would refuse turned into '-' (no `iris-iris-…` doubling). */
export function defaultRunnerName(nodeName: string): string {
  const s = String(nodeName).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "")
  return (/^iris-/i.test(s) ? s : `iris-${s || "node"}`).slice(0, 64)
}

/** Which Hive node a runner lives on: what `add` recorded, else the node whose default name it has. */
export function nodeForRunner(runnerName: string, repo: string, registry: RunnerRecord[], nodeNames: string[]): string | null {
  const rec = registry.find((r) => r.repo.toLowerCase() === repo.toLowerCase() && r.name === runnerName)
  if (rec) return rec.node
  return nodeNames.find((n) => defaultRunnerName(n) === runnerName) ?? null
}

/** The folder on the node, relative to $HOME. Built only from validated parts. */
export function runnerFolder(owner: string, repo: string, name: string): string {
  return `.iris/runners/${owner}-${repo}-${name}`
}

export type NodeOs = "darwin" | "linux" | "win32" | "unknown"
export function nodeOs(node: Pick<HiveNode, "hardware_profile">): NodeOs {
  const p = String((node.hardware_profile as any)?.os?.platform ?? "").toLowerCase()
  if (p === "darwin" || p === "linux" || p === "win32") return p
  return "unknown"
}

/**
 * Name → node. A name can be registered twice (a re-enrolled machine keeps its old row), so
 * among equal names the ONLINE one wins — otherwise the first, stale row gets the task and it
 * sits queued forever.
 */
export function pickNode(nodes: HiveNode[], target: string): HiveNode | null {
  const t = target.toLowerCase()
  const online = (xs: HiveNode[]) => xs.find((n) => n.connection_status === "online") ?? xs[0] ?? null
  const byId = nodes.find((n) => n.id === target)
  if (byId) return byId
  const exact = nodes.filter((n) => n.name.toLowerCase() === t)
  if (exact.length) return online(exact)
  const prefix = nodes.filter((n) => n.id.startsWith(target) || n.name.toLowerCase().startsWith(t))
  return online(prefix)
}

export interface InstallScriptInput {
  owner: string
  repo: string
  name: string
  labels: string[]
  version: string
  token: string
}

// Shared head: strict-ish shell, a fail() that prints a marker line the CLI parses, the folder.
function scriptHead(i: { owner: string; repo: string; name: string; token: string }): string[] {
  return [
    "#!/bin/bash",
    "# iris hive runner — generated. The token below is single-purpose and expires in about an hour.",
    "set -u",
    "umask 077",
    `RUNNER_TOKEN=${shq(i.token)}`,
    `OWNER=${shq(i.owner)}`,
    `REPO=${shq(i.repo)}`,
    `NAME=${shq(i.name)}`,
    'fail() { echo "IRIS_RUNNER_ERROR $*"; exit 1; }',
    'DIR="$HOME/.iris/runners/$OWNER-$REPO-$NAME"',
    'case "$(uname -s)" in Darwin) OS=osx ;; Linux) OS=linux ;; *) fail "this node runs $(uname -s); hive runners support macOS and Linux for now" ;; esac',
    // A Node built for x64 under Rosetta makes uname -m say x86_64 on Apple silicon; ask the
    // hardware instead, or an M-series Mac gets the slow translated runner.
    'M="$(uname -m)"',
    'if [ "$OS" = osx ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then M=arm64; fi',
    'case "$M" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) fail "unsupported CPU $M (need x64 or arm64)" ;; esac',
    // Stop whatever this folder runs: the service, or the background run.sh we started.
    "stop_runner() {",
    '  if [ -f .service ]; then',
    // svc.sh uninstall leaves ~/Library/Logs/<service> behind on macOS; .service names the plist.
    '    if [ "$OS" = osx ]; then SVC="$(basename "$(cat .service)" .plist)"; ./svc.sh stop >/dev/null 2>&1; ./svc.sh uninstall >/dev/null 2>&1; case "$SVC" in actions.runner.?*) rm -rf "$HOME/Library/Logs/$SVC" ;; esac',
    '    else sudo -n ./svc.sh stop >/dev/null 2>&1; sudo -n ./svc.sh uninstall >/dev/null 2>&1; fi',
    "  fi",
    '  if [ -f .iris-run.pid ]; then P="$(cat .iris-run.pid)"; kill -TERM -- "-$P" 2>/dev/null || kill -TERM "$P" 2>/dev/null; rm -f .iris-run.pid; fi',
    '  pkill -f "$DIR/bin/Runner.Listener" 2>/dev/null',
    "  return 0",
    "}",
  ]
}

/** The script the node runs for `runner add`. Pure; the token lives only in RUNNER_TOKEN. */
export function buildInstallScript(i: InstallScriptInput): string {
  return [
    ...scriptHead(i),
    `LABELS=${shq(i.labels.join(","))}`,
    `VERSION=${shq(i.version)}`,
    'mkdir -p "$DIR" && cd "$DIR" || fail "could not create $DIR"',
    'if [ ! -x ./config.sh ] || [ "$(cat .iris-version 2>/dev/null)" != "$VERSION-$OS-$ARCH" ]; then',
    '  URL="https://github.com/actions/runner/releases/download/v$VERSION/actions-runner-$OS-$ARCH-$VERSION.tar.gz"',
    '  echo "Downloading actions-runner $VERSION for $OS-$ARCH"',
    '  if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL" -o runner.tgz || fail "download failed: $URL"',
    '  elif command -v wget >/dev/null 2>&1; then wget -q "$URL" -O runner.tgz || fail "download failed: $URL"',
    '  else fail "this node has neither curl nor wget"; fi',
    '  tar xzf runner.tgz || fail "could not unpack the runner"',
    "  rm -f runner.tgz",
    '  echo "$VERSION-$OS-$ARCH" > .iris-version',
    "else",
    '  echo "actions-runner $VERSION already present"',
    "fi",
    // Re-adding to the same folder: stop the old one and forget its registration first.
    'if [ -f .runner ]; then echo "Replacing the runner already configured in this folder"; stop_runner; rm -f .runner .credentials .credentials_rsaparams .service; fi',
    // A daemon's PATH often lacks /sbin, where ldconfig lives — without the fallback every node
    // looks like it is missing libicu.
    'if [ "$OS" = linux ] && ! { ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null; } | grep -q libicu; then',
    '  if sudo -n true 2>/dev/null; then echo "Installing runner dependencies (libicu)"; sudo -n ./bin/installdependencies.sh >deps.log 2>&1 || echo "dependency install reported a problem; see $DIR/deps.log"',
    '  else echo "libicu not found and no passwordless sudo; if config fails, run: sudo $DIR/bin/installdependencies.sh"; fi',
    "fi",
    'echo "Registering $NAME with github.com/$OWNER/$REPO"',
    './config.sh --unattended --url "https://github.com/$OWNER/$REPO" --token "$RUNNER_TOKEN" --name "$NAME" --labels "$LABELS" --replace >config.log 2>&1',
    "RC=$?",
    "unset RUNNER_TOKEN",
    'if [ "$RC" != 0 ]; then tail -n 15 config.log | grep -v "^ *$"; fail "config.sh exited $RC"; fi',
    "MODE=",
    'if [ "$OS" = osx ]; then',
    '  ./svc.sh install >svc.log 2>&1 && ./svc.sh start >>svc.log 2>&1 && MODE=service',
    "else",
    '  if sudo -n true 2>/dev/null; then sudo -n ./svc.sh install "$(id -un)" >svc.log 2>&1 && sudo -n ./svc.sh start >>svc.log 2>&1 && MODE=service',
    '  else echo "No passwordless sudo on this node, so the runner cannot be a system service."; fi',
    "fi",
    'if [ -z "$MODE" ]; then',
    '  [ -s svc.log ] && { echo "Service install did not work:"; tail -n 5 svc.log; }',
    '  echo "Starting it in the background instead (nohup). It will NOT come back after a reboot."',
    '  if command -v setsid >/dev/null 2>&1; then setsid nohup ./run.sh >run.log 2>&1 </dev/null & else nohup ./run.sh >run.log 2>&1 </dev/null & fi',
    '  echo $! > .iris-run.pid',
    "  MODE=background",
    "fi",
    "sleep 3",
    'echo "IRIS_RUNNER_RESULT mode=$MODE os=$OS arch=$ARCH dir=$DIR"',
  ].join("\n") + "\n"
}

/** The script the node runs for `runner remove`. Deletes only its own folder under ~/.iris/runners. */
export function buildRemoveScript(i: { owner: string; repo: string; name: string; token: string }): string {
  return [
    ...scriptHead(i),
    'if [ ! -d "$DIR" ]; then echo "IRIS_RUNNER_RESULT removed=absent dir=$DIR"; exit 0; fi',
    'cd "$DIR" || fail "could not enter $DIR"',
    "stop_runner",
    "DEREG=no",
    'if [ -f .runner ]; then ./config.sh remove --token "$RUNNER_TOKEN" >remove.log 2>&1 && DEREG=yes; fi',
    "unset RUNNER_TOKEN",
    'cd "$HOME" && rm -rf "$DIR"',
    'echo "IRIS_RUNNER_RESULT removed=yes deregistered=$DEREG dir=$DIR"',
  ].join("\n") + "\n"
}

export interface ScriptResult {
  ok: boolean
  error?: string
  fields: Record<string, string>
  /** Output with the marker lines taken out — what a person reads. */
  log: string
}

export function parseScriptOutput(text: string): ScriptResult {
  const lines = String(text ?? "").split(/\r?\n/)
  const err = lines.find((l) => l.startsWith("IRIS_RUNNER_ERROR "))
  const res = lines.find((l) => l.startsWith("IRIS_RUNNER_RESULT "))
  const fields: Record<string, string> = {}
  if (res) for (const m of res.slice("IRIS_RUNNER_RESULT ".length).matchAll(/(\w+)=(\S+)/g)) fields[m[1]] = m[2]
  const log = lines.filter((l) => !l.startsWith("IRIS_RUNNER_")).join("\n").trim()
  if (err) return { ok: false, error: err.slice("IRIS_RUNNER_ERROR ".length).trim(), fields, log }
  if (!res) return { ok: false, error: "the node finished without reporting a result", fields, log }
  return { ok: true, fields, log }
}

export interface RunnerView {
  id: number
  name: string
  status: string
  busy: boolean
  labels: string[]
  os?: string
}

export function parseRunners(body: unknown): RunnerView[] {
  const list = (body as any)?.runners
  if (!Array.isArray(list)) return []
  return list.map((r: any) => ({
    id: Number(r.id),
    name: String(r.name ?? ""),
    status: String(r.status ?? "unknown"),
    busy: Boolean(r.busy),
    labels: Array.isArray(r.labels) ? r.labels.map((l: any) => String(l?.name ?? l)).filter(Boolean) : [],
    os: r.os ? String(r.os) : undefined,
  }))
}

/** What GitHub's status codes mean for THIS command, with the fix. */
export function githubErrorHint(status: number, what: string): string {
  if (status === 401) return `GitHub rejected your login (401) while ${what}. Fix: gh auth login (or set GITHUB_TOKEN).`
  if (status === 403 || status === 404)
    return `GitHub said ${status} while ${what}. Your GitHub login needs admin on that repo (and a token with the "repo" scope) — or the repo name is wrong. Fix: check the name, then gh auth refresh -s repo.`
  return `GitHub returned HTTP ${status} while ${what}.`
}

// ── the local record of what we registered ───────────────────────────────────

export interface RunnerRecord {
  repo: string
  name: string
  node: string
  node_id: string
  labels: string[]
  mode?: string
  os?: string
  arch?: string
  added_at: string
}

export const registryPath = (home: string = os.homedir()) => path.join(home, ".iris", "runners.json")

export function readRegistry(file: string = registryPath()): RunnerRecord[] {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    return Array.isArray(j?.runners) ? j.runners : []
  } catch {
    return []
  }
}

export function upsertRecord(list: RunnerRecord[], rec: RunnerRecord): RunnerRecord[] {
  return [...list.filter((r) => !(r.repo.toLowerCase() === rec.repo.toLowerCase() && r.name === rec.name)), rec]
}

export function dropRecord(list: RunnerRecord[], repo: string, name: string): RunnerRecord[] {
  return list.filter((r) => !(r.repo.toLowerCase() === repo.toLowerCase() && r.name === name))
}

function writeRegistry(list: RunnerRecord[], file: string = registryPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ runners: list }, null, 2) + "\n", { mode: 0o600 })
}

// ── GitHub (from THIS machine) ───────────────────────────────────────────────

async function githubToken(): Promise<string | null> {
  const env = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim()
  if (env) return env
  try {
    const p = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" })
    const t = p.stdout.toString().trim()
    return p.exitCode === 0 && t ? t : null
  } catch {
    return null
  }
}

async function gh(token: string, method: string, url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "iris-hive-runner",
    },
  })
  const text = await res.text().catch(() => "")
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

// ── shared command plumbing ──────────────────────────────────────────────────

class Stop extends Error {
  constructor(message: string, public code = 1) { super(message) }
}

async function setup(nodeArg: string | undefined) {
  if (!(await requireAuth())) throw new Stop("Not signed in to IRIS. Fix: iris auth login")
  const userId = await requireUserId(undefined)
  if (!userId) throw new Stop("Could not work out your IRIS user id. Fix: iris auth login")
  const token = await githubToken()
  if (!token) throw new Stop("No GitHub login on this machine. Fix: gh auth login (or export GITHUB_TOKEN=…)")
  if (nodeArg === undefined) return { userId, token, node: null as HiveNode | null }
  const nodes = await fetchNodes(userId)
  const node = pickNode(nodes, nodeArg)
  if (!node)
    throw new Stop(`No Hive node called "${nodeArg}". See your nodes with: iris hive nodes list — or add this machine with: iris node install`, 2)
  return { userId, token, node }
}

function requireOnlineUnix(node: HiveNode) {
  const os = nodeOs(node)
  if (os === "win32")
    throw new Stop(`${node.name} is a Windows machine. Hive runners support macOS and Linux for now — Windows is not built yet.`, 2)
  if (node.connection_status !== "online")
    throw new Stop(`${node.name} is ${node.connection_status}, so it cannot take the task. Start its daemon (iris-daemon start, or iris node install on that machine) and retry.`, 1)
}

async function runOnNode(userId: number, node: HiveNode, title: string, script: string, timeoutSec: number, say: (s: string) => void) {
  const payload = buildTaskPayload({ userId, type: "sandbox_execute", nodeId: node.id, prompt: script, title, config: {}, timeoutSec })
  const { taskId, final } = await dispatchTaskAndWait(userId, payload, (st) => say(dim(`  task ${st}`)))
  if (!final) throw new Stop(`${node.name} did not finish within ${timeoutSec + 30}s (task ${taskId}). It may still be working — check: iris hive tasks ${taskId}`)
  const view = pickResultPayload(final)
  const parsed = parseScriptOutput([view.text, view.stderr ?? ""].join("\n"))
  const finishedOk = final.status === "completed" || final.status === "succeeded"
  if (!finishedOk && (parsed.ok || !parsed.log))
    return { ...parsed, ok: false, error: parsed.ok ? `task ended ${final.status}` : `task ended ${final.status}: ${parsed.error}`, taskId }
  return { ...parsed, taskId }
}

function finish(err: unknown, json: boolean) {
  const msg = err instanceof Error ? err.message : String(err)
  const code = err instanceof Stop ? err.code : 1
  if (json) console.log(JSON.stringify({ ok: false, error: msg }))
  else console.error(msg)
  process.exitCode = code
}

// ── add ──────────────────────────────────────────────────────────────────────

const RunnerAddCommand = cmd({
  command: "add <node>",
  describe: "make a Hive node a self-hosted GitHub Actions runner for a repo",
  builder: (y) =>
    y
      .positional("node", { type: "string", demandOption: true, describe: "Hive node name or id (iris hive nodes list)" })
      .option("repo", { type: "string", demandOption: true, describe: "GitHub repo, owner/repo" })
      .option("labels", { type: "string", describe: "extra runner labels, comma separated (iris-hive is always added)" })
      .option("name", { type: "string", describe: "runner name shown on GitHub (default: iris-<node>)" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" })
      .example("iris hive runner add iris-hive-001 --repo acme/website", "register a Linux node as a runner")
      .example("iris hive runner add my-mac --repo acme/app --labels macos-build", "a Mac runner with an extra label")
      .example("iris hive runner add my-mac --repo acme/app --name build-mac-1 --json", "custom name, JSON output"),
  async handler(args) {
    const json = Boolean(args.json)
    const say = (s: string) => { if (!json) console.log(s) }
    try {
      const r = parseRepo(args.repo)
      if (!r.ok) throw new Stop(r.error, 2)
      const l = parseLabels(args.labels)
      if (!l.ok) throw new Stop(l.error, 2)
      const { userId, token, node } = await setup(String(args.node))
      requireOnlineUnix(node!)
      const n = validateRunnerName(args.name ? String(args.name) : defaultRunnerName(node!.name))
      if (!n.ok) throw new Stop(n.error, 2)
      const repo = `${r.owner}/${r.repo}`

      const rel = await gh(token, "GET", "/repos/actions/runner/releases/latest")
      const version = String(rel.body?.tag_name ?? "").replace(/^v/, "")
      if (rel.status !== 200 || !/^\d+\.\d+\.\d+$/.test(version))
        throw new Stop(`Could not find the latest actions-runner release (${githubErrorHint(rel.status, "reading actions/runner releases")})`)

      const reg = await gh(token, "POST", `/repos/${repo}/actions/runners/registration-token`)
      if (reg.status !== 201 || !reg.body?.token) throw new Stop(githubErrorHint(reg.status, `asking ${repo} for a runner registration token`))

      say(`Installing GitHub Actions runner ${bold(n.name)} for ${bold(repo)} on ${bold(node!.name)} ${dim(`(actions-runner ${version})`)}`)
      const script = buildInstallScript({ owner: r.owner, repo: r.repo, name: n.name, labels: l.labels, version, token: reg.body.token })
      const out = await runOnNode(userId, node!, `hive runner: add ${repo}`, script, 900, say)
      if (!out.ok) {
        if (!json && out.log) console.error(dim(out.log))
        throw new Stop(`The install on ${node!.name} failed: ${out.error}. Nothing was left running; fix the cause and run the same command again.`)
      }

      // Confirm from GitHub's side, not the node's: the runner is only useful if GitHub sees it.
      let seen: RunnerView | undefined
      for (let i = 0; i < 10 && !(seen && seen.status === "online"); i++) {
        const lst = await gh(token, "GET", `/repos/${repo}/actions/runners?per_page=100`)
        seen = parseRunners(lst.body).find((x) => x.name === n.name)
        if (!(seen && seen.status === "online")) await new Promise((res) => setTimeout(res, 3000))
      }

      const rec: RunnerRecord = {
        repo, name: n.name, node: node!.name, node_id: node!.id, labels: l.labels,
        mode: out.fields.mode, os: out.fields.os, arch: out.fields.arch, added_at: new Date().toISOString(),
      }
      writeRegistry(upsertRecord(readRegistry(), rec))

      if (json) {
        await writeJson({ ok: true, ...rec, github_status: seen?.status ?? "not_visible", task_id: out.taskId })
        return
      }
      if (out.log) console.log(dim(out.log.split("\n").map((x) => "  " + x).join("\n")))
      const where = `${out.fields.os ?? "?"}-${out.fields.arch ?? "?"}`
      if (seen?.status === "online") console.log(success(`${n.name} is online on GitHub.`) + ` It runs on ${node!.name} (${where}).`)
      else console.log(warn(`${n.name} was installed on ${node!.name}, but GitHub does not show it online yet (${seen?.status ?? "not listed"}). Check again with: iris hive runner list --repo ${repo}`))
      if (out.fields.mode === "background")
        console.log(warn("It is running in the background, not as a service, so it will stop if that machine reboots.") + " Give the node passwordless sudo and run add again to make it a service.")
      console.log(`Use it in a workflow with:  ${bold(`runs-on: [self-hosted, ${l.labels.join(", ")}]`)}`)
    } catch (e) {
      finish(e, json)
    }
  },
})

// ── list ─────────────────────────────────────────────────────────────────────

const RunnerListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show the runners on a repo (or every repo you added runners to) and which Hive node each lives on",
  builder: (y) =>
    y
      .option("repo", { type: "string", describe: "GitHub repo, owner/repo (default: every repo in ~/.iris/runners.json)" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" })
      .example("iris hive runner list", "every repo you have added Hive runners to")
      .example("iris hive runner list --repo acme/website", "all runners on one repo")
      .example("iris hive runner list --json", "for scripts"),
  async handler(args) {
    const json = Boolean(args.json)
    try {
      const token = await githubToken()
      if (!token) throw new Stop("No GitHub login on this machine. Fix: gh auth login (or export GITHUB_TOKEN=…)")
      const registry = readRegistry()
      let repos: string[]
      if (args.repo) {
        const r = parseRepo(args.repo)
        if (!r.ok) throw new Stop(r.error, 2)
        repos = [`${r.owner}/${r.repo}`]
      } else {
        repos = [...new Set(registry.map((x) => x.repo))]
        if (!repos.length) {
          if (json) await writeJson({ ok: true, repos: [] })
          else console.log("You have not added any Hive runners from this machine yet. Start with: iris hive runner add <node> --repo owner/repo")
          return
        }
      }
      // Node names let a runner someone else's `add` created still be placed. Optional: listing
      // GitHub runners does not need an IRIS login.
      let nodeNames: string[] = []
      try {
        const uid = await resolveUserId()
        if (uid) nodeNames = (await fetchNodes(uid)).map((n) => n.name)
      } catch {}
      const out: Array<{ repo: string; error?: string; runners: Array<RunnerView & { node: string | null }> }> = []
      for (const repo of repos) {
        const res = await gh(token, "GET", `/repos/${repo}/actions/runners?per_page=100`)
        if (res.status !== 200) { out.push({ repo, error: githubErrorHint(res.status, `listing runners on ${repo}`), runners: [] }); continue }
        out.push({
          repo,
          runners: parseRunners(res.body).map((x) => ({
            ...x,
            node: nodeForRunner(x.name, repo, registry, nodeNames),
          })),
        })
      }
      if (json) { await writeJson({ ok: true, repos: out }); return }
      for (const r of out) {
        console.log(bold(r.repo))
        if (r.error) { console.log("  " + warn(r.error)); continue }
        if (!r.runners.length) { console.log(dim("  no self-hosted runners")); continue }
        for (const x of r.runners) {
          const st = x.status === "online" ? success("● online") : dim(`○ ${x.status}`)
          const busy = x.busy ? warn(" busy") : ""
          const node = x.node ? `on ${x.node}` : dim("not a Hive runner")
          console.log(`  ${st}${busy}  ${bold(x.name)}  ${node}  ${dim(x.labels.join(", "))}`)
        }
      }
      if (out.some((r) => r.error)) process.exitCode = 1
    } catch (e) {
      finish(e, json)
    }
  },
})

// ── remove ───────────────────────────────────────────────────────────────────

const RunnerRemoveCommand = cmd({
  command: "remove <node>",
  aliases: ["rm"],
  describe: "stop and unregister a Hive node's runner for a repo, and delete its folder",
  builder: (y) =>
    y
      .positional("node", { type: "string", demandOption: true, describe: "Hive node name or id" })
      .option("repo", { type: "string", demandOption: true, describe: "GitHub repo, owner/repo" })
      .option("name", { type: "string", describe: "runner name, if you chose one with add --name (default: iris-<node>)" })
      .option("json", { type: "boolean", default: false, describe: "machine-readable output" })
      .example("iris hive runner remove iris-hive-001 --repo acme/website", "remove the runner add created")
      .example("iris hive runner remove my-mac --repo acme/app --name build-mac-1", "one you named yourself"),
  async handler(args) {
    const json = Boolean(args.json)
    const say = (s: string) => { if (!json) console.log(s) }
    try {
      const r = parseRepo(args.repo)
      if (!r.ok) throw new Stop(r.error, 2)
      const { userId, token, node } = await setup(String(args.node))
      requireOnlineUnix(node!)
      const repo = `${r.owner}/${r.repo}`
      const recorded = readRegistry().find((x) => x.repo.toLowerCase() === repo.toLowerCase() && (x.node_id === node!.id || x.node === node!.name))
      const n = validateRunnerName(args.name ? String(args.name) : recorded?.name ?? defaultRunnerName(node!.name))
      if (!n.ok) throw new Stop(n.error, 2)

      const rt = await gh(token, "POST", `/repos/${repo}/actions/runners/remove-token`)
      if (rt.status !== 201 || !rt.body?.token) throw new Stop(githubErrorHint(rt.status, `asking ${repo} for a runner remove token`))

      say(`Removing ${bold(n.name)} from ${bold(repo)} on ${bold(node!.name)}`)
      const out = await runOnNode(userId, node!, `hive runner: remove ${repo}`, buildRemoveScript({ owner: r.owner, repo: r.repo, name: n.name, token: rt.body.token }), 300, say)
      if (!out.ok) {
        if (!json && out.log) console.error(dim(out.log))
        throw new Stop(`Removing on ${node!.name} failed: ${out.error}`)
      }

      // If the node could not deregister (folder already gone, config remove refused), make sure
      // GitHub does not keep an orphan that jobs would queue for.
      let githubDeleted = false
      const lst = await gh(token, "GET", `/repos/${repo}/actions/runners?per_page=100`)
      const left = parseRunners(lst.body).find((x) => x.name === n.name)
      if (left) {
        const d = await gh(token, "DELETE", `/repos/${repo}/actions/runners/${left.id}`)
        githubDeleted = d.status === 204
        if (!githubDeleted) say(warn(githubErrorHint(d.status, `deleting runner ${n.name} from ${repo}`)))
      }
      writeRegistry(dropRecord(readRegistry(), repo, n.name))

      if (json) { await writeJson({ ok: true, repo, name: n.name, node: node!.name, ...out.fields, github_cleanup: githubDeleted, task_id: out.taskId }); return }
      if (out.fields.removed === "absent") console.log(`There was no runner folder for ${n.name} on ${node!.name}.`)
      else console.log(success(`Removed.`) + ` ${n.name} is stopped, unregistered and its folder on ${node!.name} is deleted.`)
      if (left && !githubDeleted) process.exitCode = 1
    } catch (e) {
      finish(e, json)
    }
  },
})

export const HiveRunnerCommand = cmd({
  command: "runner",
  aliases: ["runners"],
  describe: "use your Hive nodes as self-hosted GitHub Actions runners",
  builder: (y) =>
    y
      .command(RunnerAddCommand)
      .command(RunnerListCommand)
      .command(RunnerRemoveCommand)
      .demandCommand(1)
      .example("iris hive runner add iris-hive-001 --repo acme/website", "register a node")
      .example("iris hive runner list", "see them, online or not")
      .example("iris hive runner remove iris-hive-001 --repo acme/website", "take it back"),
  async handler() {},
})
