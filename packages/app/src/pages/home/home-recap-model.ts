/**
 * "Today · across your projects" (#194315): what changed on your boards today, as a sentence.
 *
 * Pure: the recent items Home already reads (/iris/recent) in, the parts of one sentence out.
 * It separates YOUR work from what your agents wrote (diaries, work logs, deliverables, auto
 * plans), because "23 things changed" hides that 15 of them were agents writing their diaries.
 */
import type { RecentItem } from "./home-dashboard-data"

/** Lists an agent writes into on its own. Matched on the list name, case-insensitively. */
const AGENT_LIST = /daily diary|agent work|agent deliverables|\(auto\)/i

export type Recap =
  | { empty: true }
  | {
      empty: false
      /** Items you (not an agent) created or edited today, and on how many projects. */
      mine: number
      mineProjects: number
      /** The project most of your work went into, with up to two of its item titles. */
      top: { name: string; count: number; titles: string[] } | null
      /** Items agents wrote today, and on how many projects. */
      agents: number
      agentProjects: number
    }

const short = (t: string, max = 64) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t)

export function recapOf(items: readonly RecentItem[], dayStart: number): Recap {
  const today = items.filter((i) => {
    const t = Date.parse(i.updatedAt ?? i.createdAt ?? "")
    return Number.isFinite(t) && t >= dayStart
  })
  if (!today.length) return { empty: true }
  const isAgent = (i: RecentItem) => AGENT_LIST.test(i.listName ?? "")
  const mine = today.filter((i) => !isAgent(i))
  const agents = today.filter(isAgent)
  const project = (i: RecentItem) => i.bloqName ?? `#${i.bloqId}`
  const byProject = new Map<string, RecentItem[]>()
  for (const i of mine) byProject.set(project(i), [...(byProject.get(project(i)) ?? []), i])
  // Most items first; a tie goes to the project touched most recently (items arrive newest first).
  const ranked = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)
  const first = ranked[0]
  return {
    empty: false,
    mine: mine.length,
    mineProjects: byProject.size,
    top: first ? { name: first[0], count: first[1].length, titles: first[1].slice(0, 2).map((i) => short(i.title)) } : null,
    agents: agents.length,
    agentProjects: new Set(agents.map(project)).size,
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
