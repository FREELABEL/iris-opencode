/**
 * Prove the platform layer works ON THIS BRANCH, against the live account.
 *
 *   bun run packages/opencode/src/iris/probe.ts
 *
 * Run by hand, not in CI: it needs a signed-in machine. It exists because the question this
 * module answers — "can the branch that builds the desktop app reach IRIS data at all?" — is
 * not answerable by a typecheck, and was answered wrongly once already by reading `main`'s
 * source and calling it the product.
 *
 * The last check is the important one. A bloq id that cannot exist must come back
 * `measured=false`, NOT as an empty Atlas. If that line ever prints `measured=true lists=0`
 * the module has started reporting "nothing here" for "I could not look", and every UI built
 * on it inherits a reassuring lie.
 */
import { fetchAtlas, fetchHiveNodes, resolveUserId, tokenSource } from "./platform"

const bloqId = Number(process.argv[2] ?? 674)

console.log("token source :", tokenSource())
console.log("user id      :", await resolveUserId())

const atlas = await fetchAtlas(bloqId)
console.log(`\natlas bloq ${bloqId} -> measured=${atlas.measured}${atlas.reason ? " reason=" + atlas.reason : ""}`)
for (const l of atlas.data.lists) console.log(`   ${l.name}  (${l.items.length} items)`)

const hive = await fetchHiveNodes()
console.log(`\nhive nodes -> measured=${hive.measured}${hive.reason ? " reason=" + hive.reason : ""}`)
for (const n of hive.data.nodes) console.log(`   ${n.online ? "●" : "○"} ${n.name}  ${n.activeTasks}/${n.maxConcurrent}`)

const bogus = await fetchAtlas(99999999)
console.log(`\nCONTROL bloq 99999999 -> measured=${bogus.measured} reason=${bogus.reason} lists=${bogus.data.lists.length}`)
if (bogus.measured) {
  console.error("\nFAIL: an impossible bloq reported measured=true. absent and unmeasured have collapsed.")
  process.exit(1)
}
