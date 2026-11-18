/**
 * The "today" strip on Home (#192222): the operator numbers that already have a real source.
 *
 * Every tile comes from an endpoint that says whether it measured anything. Not measured renders
 * as a dash with the reason, never as zero: "0 machines online" and "could not reach the Hive"
 * call for different actions. Pipeline and memory health are not here yet because nothing on the
 * engine reports them; a tile with a made-up number is worse than no tile.
 */

export type HivePayload = {
  measured: boolean
  reason?: string
  nodes: { online: boolean; activeTasks?: number; maxConcurrent?: number; modelsServing?: readonly string[] }[]
}
export type AgentsPayload = { measured: boolean; reason?: string; agents: { id: number; name: string }[]; total?: number }

/** The engine returns one page of at most 200 agents. A full page without a total is "200+", not 200. */
export const AGENTS_PAGE = 200
function agentCount(a: AgentsPayload): string {
  if (typeof a.total === "number") return String(a.total)
  return a.agents.length >= AGENTS_PAGE ? `${AGENTS_PAGE}+` : String(a.agents.length)
}
export type InboxPayload = { measured: boolean; reason?: string; unread: number | null }

export type Tile = { key: "machines" | "agents" | "inbox"; label: string; value: string; detail: string; measured: boolean }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const why = (r?: string) => (r ? `Not measured — ${r}` : "Not measured")

export function todayOf(hive: HivePayload, agents: AgentsPayload, inbox: InboxPayload): Tile[] {
  const tiles: Tile[] = []

  if (!hive.measured) tiles.push({ key: "machines", label: "Machines", value: "—", detail: why(hive.reason), measured: false })
  else {
    const up = hive.nodes.filter((n) => n.online)
    const free = up.reduce((s, n) => s + Math.max(0, (n.maxConcurrent ?? 0) - (n.activeTasks ?? 0)), 0)
    const models = new Set(up.flatMap((n) => n.modelsServing ?? [])).size
    tiles.push({
      key: "machines",
      label: "Machines",
      value: hive.nodes.length ? `${up.length} of ${hive.nodes.length} online` : "None yet",
      detail: hive.nodes.length
        ? `${plural(free, "free slot")} · ${models ? `${plural(models, "model")} serving` : "no models serving"}`
        : "Connect one: iris how-to view hive-dispatch",
      measured: true,
    })
  }

  tiles.push(
    agents.measured
      ? { key: "agents", label: "Agents", value: agentCount(agents), detail: "you own, across your boards", measured: true }
      : { key: "agents", label: "Agents", value: "—", detail: why(agents.reason), measured: false },
  )

  tiles.push(
    inbox.measured && inbox.unread != null
      ? { key: "inbox", label: "Hive inbox", value: `${inbox.unread} unread`, detail: "work and messages sent to you", measured: true }
      : { key: "inbox", label: "Hive inbox", value: "—", detail: why(inbox.reason), measured: false },
  )

  return tiles
}
