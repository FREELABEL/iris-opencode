import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/**
 * An outward action must never be the default (#189999).
 *
 * `iris leads collect <id> --amount 500` read like bookkeeping and emailed a live Stripe
 * payment link to the client, because `--send` defaulted to true. Nothing in the command
 * name warned you. The first person to try it billed someone by accident, and nothing
 * can un-send it.
 *
 * Every other command in this tree already gets this right — `commons --send`,
 * `newsroom --send`, `venues --email`, `delivery --notify`, `bloqs --notify` all default
 * to false and say "actually send" in the describe line. `collect` was the one exception,
 * which is why this is a scan and not a one-line fix: the next outward flag someone adds
 * should have to argue with a red test.
 *
 * The rule: a flag that causes a message to leave the machine must be opt-in. Creating
 * the thing locally may be the default; telling a client about it may not.
 *
 * Source scan rather than a runtime probe, for the same reason as negated-flags.test.ts:
 * the failure is a property of the registered option, the file set is what we can hold at
 * once, and probing every command would mean invoking every command. It under-reports
 * (a flag named something we do not recognise), and never over-reports, which is the right
 * direction for a lint.
 */

/** Flag names that mean "a message leaves this machine". */
const OUTWARD = new Set(["send", "send-email", "notify", "email", "remind", "reminder", "sms"])

/**
 * `--text` and `--mail` are deliberately absent. `iris download --text` extracts post text
 * as markdown into your own terminal — output formatting, not a message to anyone. A lint
 * that cannot tell those apart spends its credibility on false alarms.
 */

type Hit = { flag: string; file: string }

/** Every outward option registered `default: true` in this source. */
export function outwardDefaultsTrue(src: string, file = "sample.ts"): Hit[] {
  const hits: Hit[] = []
  const start = /\.option\(\s*["']([a-z0-9-]+)["']\s*,\s*\{/g

  for (const m of src.matchAll(start)) {
    const flag = m[1]
    if (!OUTWARD.has(flag)) continue

    // Bound the option's own object. Without a bound, a `default: true` belonging to the
    // NEXT option lands in this one's window and reports a flag that is actually false.
    const rest = src.slice(m.index! + m[0].length)
    const end = rest.search(/\.option\(\s*["']|\.positional\(\s*["']|\.example\(|\.epilogue\(/)
    const body = end === -1 ? rest : rest.slice(0, end)

    if (/default\s*:\s*true/.test(body)) hits.push({ flag, file })
  }
  return hits
}

describe("an outgoing message is opt-in, never the default", () => {
  const CMD_DIR = join(import.meta.dir)
  const files = readdirSync(CMD_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

  test("the scan actually reads the command surface — not zero files", () => {
    // A lint that cannot fail is the thing it prevents. This catches a bad path.
    expect(files.length).toBeGreaterThan(50)
  })

  test("the scan can still detect the real defect — the old collect flag fails it", () => {
    const broken = `.option("send", { describe: "send payment link via email", type: "boolean", default: true })`
    expect(outwardDefaultsTrue(broken).map((h) => h.flag)).toEqual(["send"])
  })

  test("the scan does not flag an opt-in flag, nor a default belonging to its neighbour", () => {
    const fine = [
      `.option("send", { describe: "actually send", type: "boolean", default: false })`,
      `.option("json", { type: "boolean", default: true })`,
      `.option("notify", { type: "boolean", default: false, describe: "email them (opt-in)" })`,
    ].join("\n")
    expect(outwardDefaultsTrue(fine)).toEqual([])
  })

  test("no command lets an outgoing message happen because a flag was omitted", () => {
    const hits = files.flatMap((f) => outwardDefaultsTrue(readFileSync(join(CMD_DIR, f), "utf8"), f))
    expect(hits).toEqual([])
  })
})
