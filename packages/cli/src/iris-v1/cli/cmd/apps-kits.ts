// ── iris apps create "<need>" — the pure half ───────────────────────────────────────────────
//
// IRIS Hive Apps (EPIC #188312, board bloq #736): a person names a job they pay software for,
// a kit from the public `hive-app-kits` dataset replaces it, and it runs on one of their own
// Hive machines. This module holds every decision that does not need a network — matching a
// need to a kit, deciding whether a kit is runnable in one command, and the exact shell the
// node will run — so each can be tested on its own. The command (platform-app.ts) only wires
// these to the API.
//
// The matching rules are the iris-hive-apps playbook's, ported unchanged in spirit:
//   * whole words, against what a kit IS (name) and what it REPLACES — never its verdict prose,
//     where "book" matched "playbooks" and sent a haircut booking to a skills scanner
//     (2026-10-07);
//   * a prefix either way handles plurals and stems: "pdfs"~"pdf", "edit"~"editors";
//   * only kinds `app` and `capability` are candidates (`have` means IRIS already does it).

export interface Kit {
  external_id?: string
  name: string
  kind?: string
  replaces?: string
  image?: string
  port?: string | number
  licence?: string
  verdict?: string
  run?: string
  repo?: string
  order?: string | number
  proven?: string
}

export interface KitMatch {
  kit: Kit
  score: number
  /** The words of the NEED that matched — shown so a match can be judged, not just trusted. */
  matched: string[]
}

/** Words that carry no meaning about the job. Same list as the playbook's match step. */
export const STOP_WORDS = new Set([
  "and", "the", "for", "with", "like", "that", "this", "from", "into", "our", "your", "my",
  "a", "an", "to", "of", "app", "tool", "software", "something", "want", "need", "help",
])

/** Lowercase words of three or more letters/digits, minus stop words. */
export function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of String(text ?? "").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
    if (!STOP_WORDS.has(w)) out.add(w)
  }
  return out
}

/** Does need-word `w` match kit-word `t`? Whole words, with a prefix either way for stems. */
function wordMatches(w: string, t: string): boolean {
  return t.startsWith(w) || w.startsWith(t)
}

/** Score one kit against a need. 0 means "not a candidate". */
export function scoreKit(need: string, kit: Kit): KitMatch {
  if (kit.kind !== "app" && kit.kind !== "capability") return { kit, score: 0, matched: [] }
  // name + replaces ONLY. Not verdict, not run, not repo.
  const toks = words(`${kit.name ?? ""} ${kit.replaces ?? ""}`)
  const matched: string[] = []
  for (const w of words(need)) {
    for (const t of toks) {
      if (wordMatches(w, t)) {
        matched.push(w)
        break
      }
    }
  }
  return { kit, score: matched.length, matched }
}

function orderOf(k: Kit): number {
  const n = Number(k.order)
  return Number.isFinite(n) ? n : 99
}

/**
 * Rank kits for a need. With `kitName`, matching is skipped and the kit is chosen by name
 * (case-insensitive prefix), which is how a person overrides a match they disagree with.
 * Ties break on the catalogue's own `order` (lower = more proven).
 */
export function matchKits(need: string, kits: Kit[], kitName?: string): KitMatch[] {
  const pinned = (kitName ?? "").trim().toLowerCase()
  const scored = kits.map((k) => {
    if (pinned) {
      const hit = String(k.name ?? "").toLowerCase().startsWith(pinned) || String(k.external_id ?? "").toLowerCase() === `kit-${pinned}`
      return { kit: k, score: hit ? 100 : 0, matched: hit ? [pinned] : [] }
    }
    return scoreKit(need, k)
  })
  return scored
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || orderOf(a.kit) - orderOf(b.kit))
}

/** Docker image reference, strictly: no spaces, no shell metacharacters. */
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]*$/i

/**
 * Can this kit be run in one command? It must be an app with a single container image and the
 * port that image listens on. AppFlowy's image field reads "appflowyinc/appflowy_cloud
 * (self-host stack)" — a multi-service stack, which is exactly what this check must refuse.
 */
export function runnableReason(kit: Kit): { ok: true; image: string; port: number } | { ok: false; reason: string } {
  if (kit.kind !== "app") {
    return { ok: false, reason: `${kit.name} is a ${kit.kind ?? "catalogue"} entry, not an app you run — ${kit.verdict ?? "see the catalogue"}` }
  }
  const image = String(kit.image ?? "").trim()
  if (!image) return { ok: false, reason: `${kit.name} has no single container image yet (run: ${kit.run || "unknown"})` }
  if (!IMAGE_RE.test(image)) return { ok: false, reason: `${kit.name} is not a single image ("${image}") — it needs its own setup` }
  const port = Number(kit.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `${kit.name} does not say which port its container listens on` }
  }
  return { ok: true, image, port }
}

/** "Stirling-PDF" → "stirling-pdf"; "openrig / agenticSeek" → "openrig". */
export function kitSlug(kit: Kit): string {
  const first = String(kit.name ?? "").trim().split(/\s+/)[0] ?? ""
  const slug = first.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "")
  return slug || "app"
}

/** A container-name-safe instance name, or null when it cannot be made one. */
export function safeInstanceName(raw: string): string | null {
  const s = String(raw ?? "").trim().toLowerCase()
  return /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(s) ? s : null
}

export function containerName(instance: string): string {
  return `hiveapp-${instance}`
}

export function parsePort(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : null
}

/** Single-quote for POSIX sh. Every interpolated value goes through this. */
export function shq(s: string | number): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** Exit codes the run script uses, so the command can say what happened without parsing prose. */
export const RUN_EXIT = {
  NO_DOCKER: 3,
  EXISTS: 4,
} as const

export interface RunScriptInput {
  container: string
  image: string
  hostPort: number
  containerPort: number
  slug: string
  replace: boolean
}

/**
 * The script the node runs. Localhost-only binding is not an option here: many kits have no
 * login and a Hive node can have a public IP, so `-p 127.0.0.1:H:C` is the only form produced.
 *
 * Unlike the playbook's first version, it does NOT `docker rm -f` an existing container of the
 * same name unless asked (--replace): running "edit PDFs" twice must not silently kill the
 * instance someone is already using.
 */
export function buildRunScript(i: RunScriptInput): string {
  const name = shq(i.container)
  return [
    "set -u",
    `command -v docker >/dev/null 2>&1 || { echo "NO-DOCKER: this machine has no docker on PATH"; exit ${RUN_EXIT.NO_DOCKER}; }`,
    `if docker inspect ${name} >/dev/null 2>&1; then`,
    i.replace
      ? `  echo "REPLACING existing container ${i.container}"; docker rm -f ${name} >/dev/null`
      : `  echo "EXISTS: a container named ${i.container} is already on this machine:"; docker ps -a --filter name=^/${i.container}$ --format '{{.Status}}  {{.Ports}}'; exit ${RUN_EXIT.EXISTS}`,
    "fi",
    `docker run -d --name ${name} --restart unless-stopped --label iris.hive-app=${shq(i.slug)} -p ${shq(`127.0.0.1:${i.hostPort}:${i.containerPort}`)} ${shq(i.image)} || exit $?`,
    `docker ps --filter name=^/${i.container}$ --format 'STARTED {{.Names}}  {{.Status}}  {{.Ports}}'`,
  ].join("\n")
}

/**
 * Prove it answers, on the node (the app listens on the NODE's localhost). Any HTTP status
 * from 200 to 399 is an answer; a container that started but serves nothing is not.
 */
export function buildVerifyScript(hostPort: number, waitSec: number): string {
  const tries = Math.max(1, Math.ceil(waitSec / 2))
  return [
    "c=000",
    `for i in $(seq 1 ${tries}); do`,
    `  c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${hostPort}/ || true)`,
    `  case "$c" in 2??|3??) echo "READY http=$c after $((i*2))s"; exit 0;; esac`,
    "  sleep 2",
    "done",
    `echo "NOT-READY last http=$c after ${tries * 2}s"`,
    "exit 1",
  ].join("\n")
}

/** "READY http=200 after 6s" → { http: 200, afterSec: 6 }. */
export function parseVerifyOutput(out: string): { ready: boolean; http?: number; afterSec?: number } {
  const m = /READY http=(\d{3}) after (\d+)s/.exec(out)
  if (m && !/NOT-READY/.test(out)) return { ready: true, http: Number(m[1]), afterSec: Number(m[2]) }
  const n = /NOT-READY last http=(\d{3})/.exec(out)
  return { ready: false, http: n ? Number(n[1]) : undefined }
}

export function stopCommand(node: string, container: string): string {
  return `iris hive run ${node} "docker rm -f ${container}"`
}

export function reachHint(node: string, port: number): string {
  return `ssh -L ${port}:127.0.0.1:${port} <${node}>   then open http://localhost:${port}`
}

export function recordTitle(kit: Kit, node: string, port: number, need: string): string {
  // Atlas item titles are capped at 191 characters.
  return `RUNNING: ${kit.name} on ${node} (127.0.0.1:${port}) — for: ${need}`.slice(0, 191)
}

export function recordText(kit: Kit, node: string, port: number, container: string, whenIso: string, verified: string): string {
  return [
    `Started by \`iris apps create\` on ${whenIso}. Container ${container} on ${node}, bound to 127.0.0.1:${port} (local only).`,
    `Verified: ${verified}.`,
    `Reach it: ${reachHint(node, port)}`,
    `Stop it: ${stopCommand(node, container)}`,
    `Licence: ${kit.licence ?? "unknown"}.`,
  ].join("\n")
}

/**
 * What to say when nothing in the catalogue fits. Honest, and useful: the three real paths,
 * plus what the catalogue CAN run today so the person sees whether they phrased it oddly.
 */
export function noKitAdvice(need: string, kits: Kit[]): string[] {
  const runnable = kits
    .filter((k) => runnableReason(k).ok)
    .sort((a, b) => orderOf(a) - orderOf(b))
    .map((k) => `  - ${k.name} — replaces ${k.replaces ?? "?"}`)
  const lines = [
    `No kit in the catalogue replaces "${need}" yet. Nothing was run.`,
    "",
    "Three honest paths, cheapest first:",
    "  1. A WEBSITE you'd rebuild: open-lovable recreates a site as a React app; publish it with Genesis.",
    "  2. An APP with no API you need to drive: CLI-Anything wraps desktop software as a CLI;",
    "     web2mcp generates an MCP server for a web app. Both run on a Hive node.",
    "  3. NEW software: iris hive create <name> starts a repo; Atlas holds its data, Genesis is its screen (#188312).",
  ]
  if (runnable.length) {
    lines.push("", "What the catalogue runs in one command today:", ...runnable)
  }
  lines.push(
    "",
    "Add what you found so the next person gets a kit:",
    `  iris bloqs add-item 736 2733 --title "KIT IDEA: <app> replaces <paid product>"`,
  )
  return lines
}
