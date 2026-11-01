import { cmd } from "./cmd"
import { UI } from "../ui"
import { IRIS_API, irisFetch, requireAuth, requireUserId, handleApiError, printDivider, dim, bold, writeJson } from "./iris-api"

// Endpoints (fl-iris-api GraphController, #183629 #192140):
//   GET  /api/v1/users/{userId}/graph/entity/{name}?depth=
//   GET  /api/v1/users/{userId}/graph/path?from=&to=&max_hops=
//   GET  /api/v1/users/{userId}/graph/whois/{name}
//   GET  /api/v1/users/{userId}/graph/predicates
//   POST /api/v1/users/{userId}/graph/assert
//
// There is deliberately no --role flag. The server derives the viewer from a verified atlas
// session, so a read from here is an untrusted one: PHI-derived edges are withheld and counted.

type Hop = {
  predicate: string
  entity: { id: number; name: string }
  evidence: { schema_id: number; record_id: number; field: string | null }
}

export type PathResult = {
  found: boolean
  missing?: string[]
  from?: { name: string }
  to?: { name: string }
  path?: Hop[] | null
  complete?: boolean
  max_hops?: number
  withheld: number
}

/** "No path" has three different meanings here, and each one has to read differently. */
export function describePath(r: PathResult): string[] {
  if (!r.found) return [`Not in the graph: ${(r.missing ?? []).join(" and ")}`]

  if (!r.path) {
    if (r.complete === false) return ["Search stopped at its limit, so this does NOT mean they are unconnected."]
    const none = `No connection within ${r.max_hops} hops.`
    return r.withheld > 0 ? [`${none} ${r.withheld} edge(s) withheld from this reader, so one may exist.`] : [none]
  }

  const lines = [r.from?.name ?? ""]
  for (const h of r.path) {
    lines.push(`  ${h.predicate} -> ${h.entity.name}  (record ${h.evidence.schema_id}/${h.evidence.record_id})`)
  }
  if (r.withheld > 0) lines.push(`${r.withheld} edge(s) withheld from this reader.`)
  return lines
}

async function graphGet(label: string, subpath: string, json: boolean): Promise<any | null> {
  const token = await requireAuth()
  if (!token) return null
  const userId = await requireUserId()
  if (!userId) return null
  const res = await irisFetch(`/api/v1/users/${userId}/graph/${subpath}`, {}, IRIS_API)
  if (!(await handleApiError(res, label))) return null
  const data = (await res.json()) as any
  if (json) await writeJson(data)
  return data
}

const QueryCommand = cmd({
  command: "query <name>",
  describe: "what an entity is related to, with the record behind each edge",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true })
      .option("depth", { type: "number", default: 1, describe: "hops to walk, 1 to 4" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) UI.empty()
    const data = await graphGet("Graph query", `entity/${encodeURIComponent(args.name)}?depth=${args.depth}`, args.json)
    if (!data || args.json) return
    printDivider()
    if (!data.found) console.log(`  ${dim(`Not in the graph: ${args.name}`)}`)
    else {
      console.log(`  ${bold(data.entity.name)}  ${dim(`#${data.entity.id}`)}`)
      for (const e of data.edges ?? []) {
        console.log(`  ${e.predicate} -> ${e.entity.name}  ${dim(`(record ${e.evidence.schema_id}/${e.evidence.record_id})`)}`)
      }
      if (data.withheld > 0) console.log(`  ${dim(`${data.withheld} edge(s) withheld from this reader.`)}`)
    }
    printDivider()
  },
})

const PathCommand = cmd({
  command: "path <from> <to>",
  describe: "how two entities are connected, hop by hop",
  builder: (y) =>
    y
      .positional("from", { type: "string", demandOption: true })
      .positional("to", { type: "string", demandOption: true })
      .option("max-hops", { type: "number", default: 3, describe: "longest path to accept, 1 to 4" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) UI.empty()
    const q = new URLSearchParams({ from: args.from, to: args.to, max_hops: String(args.maxHops) })
    const data = await graphGet("Graph path", `path?${q}`, args.json)
    if (!data || args.json) return
    printDivider()
    for (const line of describePath(data)) console.log(`  ${line}`)
    printDivider()
  },
})

const WhoisCommand = cmd({
  command: "whois <name>",
  describe: "who an entity is, in the system that owns people",
  builder: (y) => y.positional("name", { type: "string", demandOption: true }).option("json", { type: "boolean", default: true }),
  async handler(args) {
    await graphGet("Graph whois", `whois/${encodeURIComponent(args.name)}`, true)
  },
})

const PredicatesCommand = cmd({
  command: "predicates",
  describe: "the relationship vocabulary",
  builder: (y) => y.option("json", { type: "boolean", default: true }),
  async handler() {
    await graphGet("Graph predicates", "predicates", true)
  },
})

const AssertCommand = cmd({
  command: "assert <subject> <object>",
  describe: "state a relationship, keeping the sentence it came from",
  builder: (y) =>
    y
      .positional("subject", { type: "string", demandOption: true })
      .positional("object", { type: "string", demandOption: true })
      .option("predicate", { type: "string", demandOption: true })
      .option("type", { type: "string" })
      .option("object-type", { type: "string" })
      .option("note", { type: "string" })
      .option("stated-by", { type: "string" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return
    const res = await irisFetch(
      `/api/v1/users/${userId}/graph/assert`,
      {
        method: "POST",
        body: JSON.stringify({
          subject: args.subject,
          predicate: args.predicate,
          object: args.object,
          type: args.type,
          object_type: args.objectType,
          note: args.note,
          stated_by: args.statedBy,
        }),
      },
      IRIS_API,
    )
    if (!(await handleApiError(res, "Graph assert"))) return
    await writeJson(await res.json())
  },
})

export const PlatformAtlasGraphCommand = cmd({
  command: "atlas:graph",
  aliases: ["atlas-graph"],
  describe: "who and what is connected, with the record behind every edge",
  builder: (y) =>
    y
      .command(QueryCommand)
      .command(PathCommand)
      .command(WhoisCommand)
      .command(PredicatesCommand)
      .command(AssertCommand)
      .demandCommand(),
  async handler() {},
})

