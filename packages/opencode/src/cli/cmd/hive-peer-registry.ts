import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { homedir } from "os"
import { basename, join } from "path"

/**
 * The registry of LIVE session servers on this machine, so one agent can address another by
 * name instead of by port.
 *
 * WHY A REGISTRY AND NOT A LOOKUP. Every session server on a machine shares one SQLite DB, so
 * `GET /session` on ANY port lists EVERY session. That makes every port look addressable when
 * only the process actually rendering a session can put text in front of a human — the event
 * bus is per-process, not shared. Measured 2026-09-12: injected on :4096 while subscribed to
 * :55087/event produced zero events there. So the question is never "where is session X", it
 * is "which PROCESS is this", and nothing answered that.
 *
 * WHY LIVENESS IS CHECKED AND NOT CACHED. Ports die. `:55087` answered at the start of that
 * same session and was gone twenty minutes later when its TUI closed. A registry that trusts
 * its own file reports ghosts.
 */
export interface PeerEntry {
  /** Addressable name. Defaults to the directory basename, overridable. */
  name: string
  port: number
  pid: number
  /** `server.url` as the process reported it — never reconstructed from host+port. */
  url: string
  directory: string
  /** ISO timestamp of the last write. */
  ts: string
}

export const REGISTRY_DIR = join(homedir(), ".iris", "run")

/**
 * A name for this process that a human would type. Directory basename, because that is what
 * people already call these panes ("frontend", "iris", "lexicon"). Empty/`/` falls back to the
 * pid so an entry is never nameless.
 */
export function deriveName(directory: string, pid: number): string {
  const base = basename(directory || "").trim()
  if (!base || base === "/" || base === ".") return `pid-${pid}`
  return base
}

/** Is this pid still running? `kill(pid, 0)` signals nothing and throws only if it is gone. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Parse one registry file's contents. Returns null rather than throwing on anything malformed. */
export function parseEntry(raw: string): PeerEntry | null {
  try {
    const d = JSON.parse(raw)
    if (typeof d?.name !== "string" || !d.name) return null
    if (!Number.isInteger(d?.port) || d.port <= 0) return null
    if (!Number.isInteger(d?.pid) || d.pid <= 0) return null
    return {
      name: d.name,
      port: d.port,
      pid: d.pid,
      url: typeof d.url === "string" ? d.url : `http://127.0.0.1:${d.port}`,
      directory: typeof d.directory === "string" ? d.directory : "",
      ts: typeof d.ts === "string" ? d.ts : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

function entryPath(pid: number): string {
  return join(REGISTRY_DIR, `${pid}.json`)
}

/** Announce this process. Called when the server starts and knows its real port. */
export function registerSelf(input: {
  port: number
  url: string
  directory: string
  name?: string
  pid?: number
}): PeerEntry {
  const pid = input.pid ?? process.pid
  const entry: PeerEntry = {
    name: input.name?.trim() || deriveName(input.directory, pid),
    port: input.port,
    pid,
    url: input.url,
    directory: input.directory,
    ts: new Date().toISOString(),
  }
  mkdirSync(REGISTRY_DIR, { recursive: true })
  writeFileSync(entryPath(pid), JSON.stringify(entry, null, 2))
  return entry
}

/** Withdraw this process. Best-effort: a crash leaves the file, which is why liveness is checked. */
export function unregisterSelf(pid: number = process.pid): void {
  try {
    const p = entryPath(pid)
    if (existsSync(p)) unlinkSync(p)
  } catch {
    /* a stale file is harmless — isPidAlive filters it */
  }
}

/** Every entry on disk, including dead ones. Use `livePeers` unless you want the ghosts. */
export function readRegistry(): PeerEntry[] {
  if (!existsSync(REGISTRY_DIR)) return []
  const out: PeerEntry[] = []
  for (const f of readdirSync(REGISTRY_DIR)) {
    if (!f.endsWith(".json")) continue
    const e = parseEntry(((): string => {
      try {
        return readFileSync(join(REGISTRY_DIR, f), "utf-8")
      } catch {
        return ""
      }
    })())
    if (e) out.push(e)
  }
  return out
}

/** Delete entries whose process is gone. Returns how many were swept. */
export function pruneDead(): number {
  let n = 0
  for (const e of readRegistry()) {
    if (!isPidAlive(e.pid)) {
      unregisterSelf(e.pid)
      n++
    }
  }
  return n
}

/**
 * Does this port answer as a SESSION SERVER?
 *
 * THE TRAP THIS EXISTS FOR. Unknown paths on these servers return HTTP **200** with the web
 * UI's HTML, because the SPA is a catch-all. `GET /tui/session` returns 200 and does not exist.
 * So a status-code check reports every endpoint you can imagine as present, and a port-is-open
 * check cannot tell a session server from anything else that grabbed the port. Assert on the
 * BODY: `/session` must parse as a JSON array.
 */
export async function probeSessionServer(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return false
    const body = await res.json()
    return Array.isArray(body)
  } catch {
    return false
  }
}

/** Entries whose pid is alive AND whose port answers as a session server. */
export async function livePeers(): Promise<PeerEntry[]> {
  const candidates = readRegistry().filter((e) => isPidAlive(e.pid))
  const checked = await Promise.all(
    candidates.map(async (e) => ((await probeSessionServer(e.port)) ? e : null)),
  )
  return checked.filter((e): e is PeerEntry => e !== null)
}

/**
 * Resolve a name to one live peer.
 *
 * Exact match first, then unique case-insensitive prefix. An ambiguous prefix is an ERROR, not
 * a coin flip — delivering an instruction to the wrong agent is worse than refusing to deliver.
 */
export function resolvePeer(
  peers: PeerEntry[],
  name: string,
): { peer: PeerEntry } | { error: string } {
  const want = name.trim()
  if (!want) return { error: "No name given." }

  const exact = peers.filter((p) => p.name === want)
  if (exact.length === 1) return { peer: exact[0] }
  if (exact.length > 1) {
    return {
      error: `"${want}" matches ${exact.length} live sessions (pids ${exact.map((p) => p.pid).join(", ")}). Rename one, or address it by pid.`,
    }
  }

  const lower = want.toLowerCase()
  const pre = peers.filter((p) => p.name.toLowerCase().startsWith(lower))
  if (pre.length === 1) return { peer: pre[0] }
  if (pre.length > 1) {
    return { error: `"${want}" is ambiguous: ${pre.map((p) => p.name).join(", ")}.` }
  }

  const known = peers.length ? peers.map((p) => p.name).join(", ") : "none live"
  return { error: `No live session named "${want}". Live: ${known}.` }
}
