import { existsSync, readFileSync } from "fs"
import { homedir, networkInterfaces } from "os"
import { join } from "path"

/**
 * Hive › Computers (#192608): the facts only THIS computer can give about itself.
 *
 * The node list (`/iris/hive`) says what every machine reported to IRIS. Three things a
 * "which computer, how do I reach it, what's running there" view needs are not on it:
 *
 *  1. Which of those machines is this one. The running daemon knows its own node id and says so
 *     on /health (the CLI's hive-local-node rule: the daemon first, never a hostname match).
 *  2. Whether this computer is on a tailnet. A machine advertising a Tailscale address can only be
 *     reached that way from a computer that is on one too — read from this machine's own network
 *     interfaces, not guessed from the other side.
 *  3. The shell panes Hive started here. The daemon bridge lists the tmux sessions it owns (the
 *     data behind `iris hive panes` and the `hive_panes` tool). It is local-only: no machine
 *     reports its panes to IRIS, so other computers' shells are NOT measured — and panes Hive did
 *     not start are not in this list either. The UI says both; it never renders them as zero.
 *
 * Nothing here is shown raw: no node ids, keys or session names reach the screen.
 */

const BRIDGE_URL = process.env.IRIS_BRIDGE_URL ?? "http://127.0.0.1:3200"

export interface HereShells {
  measured: boolean
  reason?: string
  /** One row per Hive workspace (a tmux session the daemon started), with how many panes it has. */
  workspaces: Array<{ panes: number; kind: string | null }>
}

export interface Here {
  /** This computer's Hive record, from the daemon. Null when no daemon answered. */
  nodeId: string | null
  /** true / false from this computer's interfaces. */
  onTailnet: boolean
  shells: HereShells
}

/** Tailscale hands out 100.64.0.0/10 (CGNAT) — the same bound fl-iris-api validates before storing one. */
export function isTailnetIp(ip: string | null | undefined): boolean {
  if (!ip) return false
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return /^fd7a:115c:a1e0:/i.test(ip.trim())
  const o = m.slice(1).map(Number)
  if (o.some((n) => n > 255)) return false
  return o[0] === 100 && o[1] >= 64 && o[1] <= 127
}

/** Does any interface on this computer hold a tailnet address? */
export function onTailnetOf(ifaces: Record<string, Array<{ address: string }> | undefined>): boolean {
  return Object.values(ifaces).some((list) => (list ?? []).some((a) => isTailnetIp(a.address)))
}

/** The bridge's /daemon/tmux/sessions → pane counts. Pure. */
export function shellsOf(status: number, json: any): HereShells {
  if (status === 401 || status === 403) return { measured: false, reason: "Hive on this computer did not let IRIS read its shells", workspaces: [] }
  if (status !== 200) return { measured: false, reason: "Hive on this computer did not answer", workspaces: [] }
  if (json?.tmux_available === false) return { measured: true, workspaces: [] }
  const list: any[] = Array.isArray(json?.sessions) ? json.sessions : []
  return {
    measured: true,
    workspaces: list.map((s) => ({
      panes: Array.isArray(s?.panes) ? s.panes.length : 0,
      kind: typeof s?.type === "string" && s.type ? s.type : null,
    })),
  }
}

function bridgeKey(): string | undefined {
  try {
    const p = join(homedir(), ".iris", "bridge-token")
    return existsSync(p) ? readFileSync(p, "utf-8").trim() || undefined : undefined
  } catch {
    return undefined
  }
}

export async function fetchHere(): Promise<Here> {
  let nodeId: string | null = null
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const j: any = await res.json()
      const id = j?.node_id ?? j?.daemon?.node_id
      nodeId = typeof id === "string" && id ? id : null
    }
  } catch {}

  let shells: HereShells
  try {
    const key = bridgeKey()
    const res = await fetch(`${BRIDGE_URL}/daemon/tmux/sessions`, {
      headers: key ? { "X-Bridge-Key": key } : {},
      signal: AbortSignal.timeout(4000),
    })
    shells = shellsOf(res.status, res.ok ? await res.json().catch(() => null) : null)
  } catch {
    shells = { measured: false, reason: "Hive is not running on this computer", workspaces: [] }
  }

  let onTailnet = false
  try {
    onTailnet = onTailnetOf(networkInterfaces())
  } catch {}

  return { nodeId, onTailnet, shells }
}
