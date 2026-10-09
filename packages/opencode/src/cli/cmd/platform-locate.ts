// `iris locate` — find a file on any machine you own (#188665).
//
// One command; each machine answers with the best search engine it has for its platform:
//   macOS   fsearch → Spotlight → home-folder scan
//   Linux   plocate → locate → home-folder scan
//   Windows Windows Search → home-folder scan
// The engines live in the node daemon (daemon/disk-search.js), so this command and
// `iris hive search --type files` cannot disagree about how a machine searches.
//
//   iris locate <what>              every machine
//   iris locate <what> --node mac   one machine
//   iris locate providers           which engine each machine uses, and what it is missing
//   iris locate setup [--node X]    install the better engine where one exists

import { hostname } from "os"
import { cmd } from "./cmd"
import { requireAuth, requireUserId, dim, bold, success, warn, highlight, isJsonMode } from "./iris-api"
import { hiveFetch, fetchNodes, type HiveNode } from "./platform-hive-nodes"
import { buildTaskPayload, pickResultPayload, TERMINAL_STATUSES } from "./hive-task-create"
import { searchLocalFiles, localProviders } from "./platform-hive-search"

export const PROVIDER_NAMES = ["fsearch", "spotlight", "plocate", "locate", "windows-search", "scan"] as const

type Hit = { source: string; match: string; preview?: string; date?: string | null; provider?: string; node_name: string }

const short = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/i, "~")

/** The node record's own word for its OS, or null if it never reported one. */
export function nodePlatform(n: Pick<HiveNode, "hardware_profile">): string | null {
  const os = (n.hardware_profile as any)?.os
  return (os?.platform as string) ?? null
}

/** Is `n` this machine? Its hostname is the daemon's, and node names usually start with it. */
export function isThisMachine(n: Pick<HiveNode, "name" | "hardware_profile">, host = hostname()): boolean {
  const h = host.replace(/\.local$/, "").toLowerCase()
  const reported = String((n.hardware_profile as any)?.hostname ?? "").replace(/\.local$/, "").toLowerCase()
  return reported === h || n.name.toLowerCase().startsWith(h)
}

/** Pick nodes by name or id, or every online node when no filter is given. */
export function selectNodes(nodes: HiveNode[], wanted?: string): HiveNode[] {
  const online = nodes.filter((n) => n.connection_status === "online")
  if (!wanted) return online
  const w = wanted.toLowerCase()
  return online.filter((n) => n.id === wanted || n.name.toLowerCase() === w || n.name.toLowerCase().startsWith(w))
}

async function runOnNode(userId: number, node: HiveNode, task: { type: string; prompt: string; config: Record<string, unknown>; title: string }, timeoutSec = 30): Promise<{ ok: boolean; text: string }> {
  const created = await hiveFetch("/api/v6/nodes/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildTaskPayload({ userId, type: task.type, nodeId: node.id, prompt: task.prompt, title: task.title, config: task.config, timeoutSec })),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as any)
  if (!created.ok) {
    const body = await created.text().catch(() => "")
    // The API used to reject hive_search outright (#188665). Say so instead of reporting "0 results".
    const why = /type.*invalid/i.test(body) ? "the IRIS API does not accept file-search tasks yet (needs fl-iris-api #100 deployed)" : `HTTP ${created.status}`
    return { ok: false, text: why }
  }
  const id = ((await created.json()) as any)?.task?.id
  const deadline = Date.now() + (timeoutSec + 20) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200))
    const r = await hiveFetch(`/api/v6/nodes/tasks/${id}?user_id=${userId}`).catch(() => null)
    if (!r || !r.ok) continue
    const t = ((await r.json()) as any)?.task ?? {}
    if (TERMINAL_STATUSES.has(String(t.status))) return { ok: t.status === "completed", text: pickResultPayload(t).text }
  }
  return { ok: false, text: "the machine did not answer in time" }
}

/** A node's JSON answer, or a sentence saying why there is none. */
export function parseNodeAnswer(text: string): { json: any } | { error: string } {
  const s = String(text ?? "").trim()
  const start = s.search(/[\[{]/)
  if (start < 0) return { error: s.slice(0, 160) || "no answer" }
  try {
    return { json: JSON.parse(s.slice(start)) }
  } catch {
    return { error: "the machine answered in a shape this version cannot read — run `iris node install` on it" }
  }
}

/**
 * A machine's hive_search rows → what to show. Diagnostic rows ("(no file results)") become the
 * note; a withheld answer ("(names withheld)", from a machine that handles patient data) becomes a
 * count and its sentence — never a file literally called "(names withheld)".
 */
export function readNodeRows(rows: any[]): { hits: any[]; note?: string; withheld: number } {
  const files = (Array.isArray(rows) ? rows : []).filter((x) => x && x.source === "files")
  const withheldRow = files.find((x) => x.match === "(names withheld)")
  const diag = files.find((x) => typeof x.match === "string" && x.match.startsWith("(") && x !== withheldRow)
  return {
    hits: files.filter((x) => typeof x.match === "string" && !x.match.startsWith("(")),
    note: withheldRow?.preview ?? diag?.preview,
    withheld: Number(withheldRow?.count ?? 0),
  }
}

// ── setup: the better engine, per platform ─────────────────────────────────────────────────────

/** Pinned so the installer builds the source we audited (MIT, no network code), not whatever is newest. */
export const FSEARCH_REPO = "https://github.com/noahdunnagan/fsearch"
export const FSEARCH_COMMIT = "af9476d"

/**
 * The script that installs the better engine on a node. Shell only (macOS and Linux); Windows
 * Search is built in and needs nothing. It refuses rather than half-installs: no admin rights,
 * no compiler, or too little disk each stop with the one thing to do about it.
 */
export function setupScript(platform: string): string | null {
  if (platform === "linux") {
    return [
      "set -u",
      'say(){ printf "%s\\n" "$*"; }',
      'if command -v plocate >/dev/null 2>&1 && [ -f /var/lib/plocate/plocate.db ]; then say "plocate is already installed and indexed."; exit 0; fi',
      'if ! sudo -n true 2>/dev/null; then say "NEEDS_ADMIN: this machine needs an administrator to install plocate — on it, run: sudo apt-get install -y plocate && sudo updatedb"; exit 3; fi',
      "if command -v apt-get >/dev/null 2>&1; then sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q plocate >/dev/null 2>&1 || { sudo -n apt-get update -q >/dev/null 2>&1; sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q plocate >/dev/null 2>&1; }",
      "elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y -q plocate >/dev/null 2>&1",
      "elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -S --noconfirm --needed plocate >/dev/null 2>&1",
      'else say "UNSUPPORTED: no apt, dnf or pacman here — install plocate by hand, then run updatedb"; exit 4; fi',
      'command -v plocate >/dev/null 2>&1 || { say "FAILED: the package manager did not install plocate"; exit 5; }',
      'say "plocate installed — indexing the disk (one time, about a minute)…"',
      "sudo -n updatedb || { say \"FAILED: updatedb did not finish\"; exit 6; }",
      'say "DONE: plocate is ready — whole-disk search on this machine."',
    ].join("\n")
  }
  if (platform === "darwin") {
    return [
      "set -u",
      'say(){ printf "%s\\n" "$*"; }',
      'F="$HOME/.local/bin/fsearch"',
      'if [ -x "$F" ]; then say "fsearch is already installed."; "$F" status >/dev/null 2>&1; exit 0; fi',
      // ~1 GB while building (toolchain + target), 3 MB after; refuse below 3 GB free.
      'FREE_KB=$(df -k "$HOME" | awk \'NR==2{print $4}\')',
      'if [ "${FREE_KB:-0}" -lt 3145728 ]; then say "LOW_DISK: building fsearch needs ~1 GB while it builds and this Mac has under 3 GB free — free some space, or keep using Spotlight"; exit 3; fi',
      'xcode-select -p >/dev/null 2>&1 || { say "NEEDS_TOOLS: install the Xcode command-line tools first: xcode-select --install"; exit 4; }',
      'W=$(mktemp -d /tmp/iris-fsearch.XXXXXX); trap \'rm -rf "$W"\' EXIT',
      'export RUSTUP_HOME="$W/rustup" CARGO_HOME="$W/cargo" PATH="$W/cargo/bin:$PATH"',
      'say "Building fsearch (a temporary toolchain, removed afterwards)…"',
      'curl -sSf https://sh.rustup.rs -o "$W/rustup.sh" && sh "$W/rustup.sh" -y --profile minimal --no-modify-path -q >/dev/null 2>&1 || { say "FAILED: could not fetch the Rust toolchain"; exit 5; }',
      `git clone -q ${FSEARCH_REPO} "$W/fsearch" && git -C "$W/fsearch" checkout -q ${FSEARCH_COMMIT} || { say "FAILED: could not fetch fsearch"; exit 5; }`,
      '(cd "$W/fsearch" && cargo build --release -q) || { say "FAILED: fsearch did not build"; exit 6; }',
      'mkdir -p "$HOME/.local/bin" && cp "$W/fsearch/target/release/fsearch" "$F"',
      '"$F" status >/dev/null 2>&1',
      'say "DONE: fsearch installed — indexing the disk now (one time, ~30 s). For protected folders, add ~/.local/bin/fsearch under System Settings → Privacy & Security → Full Disk Access."',
    ].join("\n")
  }
  return null
}

function setupMessage(platform: string | null): string {
  if (platform === "win32") return "Windows Search is built in — nothing to install. It covers your indexed folders; add more in Settings → Privacy & security → Searching Windows."
  return "this machine never reported its OS — update it with `iris node install`"
}

// ── the command ────────────────────────────────────────────────────────────────────────────────

const ProvidersCommand = cmd({
  command: "providers",
  describe: "which search engine each machine uses, what it covers, and what it is missing",
  builder: (y) => y.option("node", { type: "string", describe: "one machine, by name or id" }).option("json", { type: "boolean", default: false }),
  handler: async (args) => {
    const json = !!args.json || isJsonMode()
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return
    const nodes = selectNodes(await fetchNodes(userId), args.node as string | undefined)
    const out: any[] = []
    for (const n of nodes) {
      const local = isThisMachine(n) ? await localProviders() : null
      const ans = local ?? (await runOnNode(userId, n, { type: "hive_search", prompt: "providers", config: { op: "providers" }, title: "locate: providers" }, 20).then((r) => (r.ok ? parseNodeAnswer(r.text) : { error: r.text })))
      out.push({ node: n.name, ...("json" in (ans as any) ? (ans as any).json : { error: (ans as any).error ?? "no answer" }) })
    }
    if (json) return void console.log(JSON.stringify(out))
    for (const r of out) {
      console.log(`\n  ${bold(r.node)}  ${dim(r.platform ?? "")}`)
      if (r.error) {
        console.log(`    ${warn(r.error)}`)
        continue
      }
      for (const p of r.providers ?? []) {
        const mark = p.name === r.chosen ? success("● in use ") : p.available ? dim("○ ready  ") : dim("· missing")
        console.log(`    ${mark} ${p.name.padEnd(15)} ${dim(p.coverage)}${p.available ? "" : dim(`  — ${p.reason}`)}`)
      }
    }
    if (out.some((r) => r.providers?.some((p: any) => !p.available && p.name !== "locate")))
      console.log(dim("\n  Install the better engine: iris locate setup --node <name>"))
  },
})

const SetupCommand = cmd({
  command: "setup",
  describe: "install the faster search engine on a machine — fsearch on a Mac, plocate on Linux",
  builder: (y) =>
    y
      .option("node", { type: "string", describe: "the machine, by name or id (default: this one)" })
      .option("json", { type: "boolean", default: false })
      .example("iris locate setup --node macbook", "build fsearch on that Mac (needs ~1 GB free while building)")
      .example("iris locate setup --node iris-hive-001", "install plocate on that Linux machine"),
  handler: async (args) => {
    const json = !!args.json || isJsonMode()
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return
    const all = await fetchNodes(userId)
    const nodes = args.node ? selectNodes(all, args.node as string) : all.filter((n) => n.connection_status === "online" && isThisMachine(n))
    if (!nodes.length) {
      const msg = args.node ? `no online machine matches "${args.node}" — see iris hive nodes list` : "this machine is not a Hive node — run `iris node install`, or pass --node"
      return void console.log(json ? JSON.stringify({ ok: false, error: msg }) : warn(msg))
    }
    const results: any[] = []
    for (const n of nodes) {
      const platform = nodePlatform(n)
      const script = platform ? setupScript(platform) : null
      if (!script) {
        results.push({ node: n.name, ok: platform === "win32", message: setupMessage(platform) })
        continue
      }
      if (!json) console.log(dim(`  ${n.name}: installing… (Linux about a minute, a Mac a few minutes)`))
      const r = await runOnNode(userId, n, { type: "sandbox_execute", prompt: script, config: {}, title: "locate: setup" }, 900)
      const last = r.text.trim().split(/\r?\n/).filter(Boolean).pop() ?? ""
      results.push({ node: n.name, ok: r.ok && !/^(NEEDS_|LOW_DISK|FAILED|UNSUPPORTED)/.test(last), message: last.replace(/^(DONE|NEEDS_ADMIN|NEEDS_TOOLS|LOW_DISK|FAILED|UNSUPPORTED):\s*/, "") || r.text.slice(0, 200) })
    }
    if (json) return void console.log(JSON.stringify(results))
    for (const r of results) console.log(`  ${r.ok ? success("✓") : warn("✗")} ${bold(r.node)}  ${r.message}`)
  },
})

export const LocateCommand = cmd({
  command: "locate [query..]",
  describe: "find a file on any machine you own — each uses its best engine (fsearch, Spotlight, plocate, Windows Search)",
  builder: (y) =>
    y
      .command(ProvidersCommand)
      .command(SetupCommand)
      .positional("query", { type: "string", array: true, describe: "part of the file name; on fsearch also grep:text to search inside files" })
      .option("node", { type: "string", describe: "one machine, by name or id" })
      .option("provider", { type: "string", choices: PROVIDER_NAMES as unknown as string[], describe: "force one engine instead of the machine's best" })
      .option("limit", { type: "number", default: 10, describe: "results per machine" })
      .option("json", { type: "boolean", default: false })
      .example('iris locate "invoice march"', "search every machine you own")
      .example("iris locate brand-contract --node macbook", "just one machine")
      .example('iris locate "grep:applyDiscount ext:ts" --node macbook', "inside files (fsearch)")
      .example("iris locate providers", "which engine each machine uses")
      .epilog("File names go back to your IRIS account as the search result. Content stays on the machine."),
  handler: async (args) => {
    const json = !!args.json || isJsonMode()
    const query = ((args.query as string[] | undefined) ?? []).join(" ").trim()
    if (!query) {
      const msg = "say what to look for: iris locate <part of a file name>   ·   iris locate providers   ·   iris locate setup"
      return void console.log(json ? JSON.stringify({ ok: false, error: msg }) : msg)
    }
    const limit = Number(args.limit) || 10
    const provider = (args.provider as string | undefined) ?? null
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return
    const nodes = selectNodes(await fetchNodes(userId), args.node as string | undefined)
    if (!nodes.length) {
      const msg = args.node ? `no online machine matches "${args.node}" — see iris hive nodes list` : "no machines online — start one with iris node install"
      return void console.log(json ? JSON.stringify({ ok: false, error: msg }) : warn(msg))
    }
    const t0 = Date.now()
    const per = await Promise.all(
      nodes.map(async (n) => {
        const started = Date.now()
        if (isThisMachine(n)) {
          const r = await searchLocalFiles(query, limit, undefined, provider)
          return { node: n.name, hits: r.rows.map((x) => ({ ...x, node_name: n.name })) as Hit[], note: r.note, ms: Date.now() - started }
        }
        const r = await runOnNode(userId, n, { type: "hive_search", prompt: query, config: { search_type: "files", limit, provider, sender_name: hostname() }, title: `locate: ${query}` })
        if (!r.ok) return { node: n.name, hits: [] as Hit[], note: r.text, ms: Date.now() - started }
        const a = parseNodeAnswer(r.text)
        if ("error" in a) return { node: n.name, hits: [] as Hit[], note: a.error, ms: Date.now() - started }
        const read = readNodeRows(a.json)
        return { node: n.name, hits: read.hits.map((x: any) => ({ ...x, node_name: n.name })) as Hit[], note: read.note, withheld: read.withheld, ms: Date.now() - started }
      }),
    )
    if (json) return void console.log(JSON.stringify({ query, took_ms: Date.now() - t0, machines: per }))
    const total = per.reduce((a, p) => a + p.hits.length, 0)
    console.log(bold(`\n  ${total} file(s) matching "${query}" on ${per.length} machine(s)`) + dim(`  ·  ${Date.now() - t0} ms`))
    for (const p of per) {
      const engine = p.hits[0]?.provider ?? p.hits[0]?.preview?.split(" · ")[0] ?? ""
      const found = (p as any).withheld ? `${(p as any).withheld} found, names withheld` : `${p.hits.length} found`
      console.log(`\n  ${highlight(p.node)}  ${dim(`${found}${engine ? ` · ${engine}` : ""} · ${p.ms} ms`)}`)
      for (const h of p.hits) {
        console.log(`    ${short(h.match)}`)
        if (h.preview?.startsWith("line ")) console.log(`      ${dim(h.preview)}`)
      }
      if (!p.hits.length && p.note) console.log(`    ${dim(p.note)}`)
    }
    console.log()
  },
})
